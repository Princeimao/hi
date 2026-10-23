"""Async client for the ASI:ONE developer API (verified, https://docs.asi1.ai).

OpenAI-compatible endpoint: https://api.asi1.ai/v1, Authorization: Bearer key,
models: asi1 | asi1-ultra | asi1-mini. Streaming = SSE (`data: …` / `[DONE]`).
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, AsyncIterator, Dict, List, Optional

import aiohttp

from . import config


class NotConfigured(Exception):
    """Raised when ASI_ONE_API_KEY is missing."""


class ApiError(Exception):
    def __init__(self, status: int, detail: str) -> None:
        super().__init__(f"ASI:ONE error {status}: {detail[:300]}")
        self.status = status


@dataclass
class ChatResult:
    content: str
    reasoning: Optional[str]
    model: str
    usage: Dict[str, Any] | None


def headers() -> Dict[str, str]:
    if not config.ASI_API_KEY:
        raise NotConfigured("ASI_ONE_API_KEY is not set — create one at https://asi1.ai/dashboard/api-keys")
    return {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {config.ASI_API_KEY}",
    }


async def chat(
    messages: List[Dict[str, str]],
    *,
    model: Optional[str] = None,
    temperature: Optional[float] = None,
    max_tokens: Optional[int] = None,
    web_search: bool = False,
) -> ChatResult:
    body: Dict[str, Any] = {"model": model or config.ASI_MODEL, "messages": messages}
    if temperature is not None:
        body["temperature"] = temperature
    if max_tokens is not None:
        body["max_tokens"] = max_tokens
    if web_search:
        body["web_search_options"] = {"search_context_size": "medium"}
    async with aiohttp.ClientSession() as session:
        async with session.post(
            f"{config.ASI_BASE_URL}/chat/completions",
            json=body,
            headers=headers(),
            timeout=aiohttp.ClientTimeout(total=180),
        ) as resp:
            if resp.status != 200:
                raise ApiError(resp.status, await resp.text())
            data = await resp.json()
    choice = (data.get("choices") or [{}])[0].get("message") or {}
    return ChatResult(
        content=choice.get("content", ""),
        reasoning=choice.get("reasoning_content"),
        model=data.get("model", body["model"]),
        usage=data.get("usage"),
    )


async def chat_stream(
    messages: List[Dict[str, str]],
    *,
    model: Optional[str] = None,
    temperature: Optional[float] = None,
) -> AsyncIterator[Dict[str, str]]:
    body: Dict[str, Any] = {"model": model or config.ASI_MODEL, "messages": messages, "stream": True}
    if temperature is not None:
        body["temperature"] = temperature
    async with aiohttp.ClientSession() as session:
        async with session.post(
            f"{config.ASI_BASE_URL}/chat/completions",
            json=body,
            headers=headers(),
            timeout=aiohttp.ClientTimeout(total=300),
        ) as resp:
            if resp.status != 200:
                raise ApiError(resp.status, await resp.text())
            buffer = ""
            async for chunk, _end_of_message in resp.content.iter_chunks():
                buffer += chunk.decode("utf-8", errors="replace")
                while "\n" in buffer:
                    line, buffer = buffer.split("\n", 1)
                    line = line.strip()
                    if not line.startswith("data:"):
                        continue
                    payload = line[5:].strip()
                    if not payload or payload == "[DONE]":
                        continue
                    event = json.loads(payload)
                    delta = ((event.get("choices") or [{}])[0].get("delta") or {})
                    if delta.get("reasoning_content"):
                        yield {"type": "reasoning", "delta": delta["reasoning_content"]}
                    if delta.get("content"):
                        yield {"type": "delta", "delta": delta["content"]}


async def chat_json(
    messages: List[Dict[str, str]],
    *,
    model: Optional[str] = None,
    temperature: float = 0.3,
) -> Dict[str, Any]:
    body: Dict[str, Any] = {
        "model": model or config.ASI_MINI_MODEL,
        "messages": messages,
        "response_format": {"type": "json_object"},
        "temperature": temperature,
    }
    async with aiohttp.ClientSession() as session:
        async with session.post(
            f"{config.ASI_BASE_URL}/chat/completions",
            json=body,
            headers=headers(),
            timeout=aiohttp.ClientTimeout(total=120),
        ) as resp:
            if resp.status != 200:
                raise ApiError(resp.status, await resp.text())
            data = await resp.json()
    raw = ((data.get("choices") or [{}])[0].get("message") or {}).get("content", "{}")
    cleaned = re.sub(r"^```(?:json)?\s*", "", raw.strip(), flags=re.IGNORECASE)
    cleaned = re.sub(r"\s*```$", "", cleaned)
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError as err:
        raise ApiError(200, f"invalid JSON from ASI:ONE: {cleaned[:200]}") from err
