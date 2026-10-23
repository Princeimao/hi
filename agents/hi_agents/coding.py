"""Client for the Hi coding-task API.

The agent cannot reach the user's PC, so it asks the Hi desktop island to run
Claude Code / OpenCode / Antigravity on its behalf:

    POST /api/agent/tasks   {kind: "coding", prompt, agent, cwd?, timeoutMs?, wait?}
    GET  /api/agent/tasks/:id?wait=30
    DELETE /api/agent/tasks/:id

Authentication is the agent token (`AGENT_TOKEN`) over `Authorization: Bearer`.
The backend targets the pinned `HI_AGENT_USER_ID`, or the single online desktop.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
from typing import Any, Dict, Optional

import aiohttp

from . import config

CODING_AGENTS = ("claude", "opencode", "antigravity")
DEFAULT_AGENT = "claude"

_AGENT_HINTS = (
    ("opencode", re.compile(r"\bopencode\b", re.IGNORECASE)),
    ("antigravity", re.compile(r"\bantigravity\b", re.IGNORECASE)),
    ("claude", re.compile(r"\bclaude(?:\s+code)?\b", re.IGNORECASE)),
)

# Explicit code work only: chatty requests must keep using the normal model.
CODING_INTENT = re.compile(
    r"\b("
    r"implement|refactor|"
    r"fix (?:the )?(?:bug|build|tests?|type ?errors?)|"
    r"write (?:a |the )?(?:script|function|component|feature|test)|"
    r"add (?:a |the )?(?:feature|function|component|test)|"
    r"run (?:the )?tests|"
    r"use (?:claude code|opencode|antigravity)"
    r")\b",
    re.IGNORECASE,
)


class CodingError(RuntimeError):
    """The backend could not start or read a coding task."""


def backend_http() -> str:
    """HTTP origin for the REST API; `HI_BACKEND_HTTP` wins over the WS URL."""
    url = os.environ.get("HI_BACKEND_HTTP") or config.HI_BACKEND_URL
    if url.startswith("wss://"):
        url = "https://" + url[len("wss://") :]
    elif url.startswith("ws://"):
        url = "http://" + url[len("ws://") :]
    url = url.rstrip("/")
    return url[: -len("/ws")] if url.endswith("/ws") else url


def pick_agent(text: str, default: str = DEFAULT_AGENT) -> str:
    for agent, pattern in _AGENT_HINTS:
        if pattern.search(text):
            return agent
    return default


def wants_coding(text: str) -> bool:
    return bool(CODING_INTENT.search(text))


def _headers() -> Dict[str, str]:
    token = os.environ.get("AGENT_TOKEN") or config.AGENT_TOKEN
    if not token:
        raise CodingError("AGENT_TOKEN is not set; the backend will refuse the request")
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


async def _call(
    method: str,
    path: str,
    *,
    body: Optional[Dict[str, Any]] = None,
    timeout: float = 40,
) -> Dict[str, Any]:
    async with aiohttp.ClientSession() as session:
        async with session.request(
            method,
            f"{backend_http()}{path}",
            json=body,
            headers=_headers(),
            timeout=aiohttp.ClientTimeout(total=timeout),
        ) as resp:
            text = await resp.text()
            try:
                data = json.loads(text) if text else {}
            except json.JSONDecodeError:
                data = {"error": text[:300]}
            if resp.status >= 400:
                message = data.get("message") or data.get("error") or f"HTTP {resp.status}"
                raise CodingError(str(message))
            return data


async def start_coding_task(
    prompt: str,
    *,
    agent: str = DEFAULT_AGENT,
    cwd: Optional[str] = None,
    user_id: Optional[str] = None,
    timeout_ms: Optional[int] = None,
) -> Dict[str, Any]:
    """Queue a coding task on the user's desktop; returns the task snapshot."""
    if agent not in CODING_AGENTS:
        raise CodingError(f"agent must be one of {', '.join(CODING_AGENTS)}")
    body: Dict[str, Any] = {"kind": "coding", "prompt": prompt, "agent": agent}
    if cwd:
        body["cwd"] = cwd
    if user_id:
        body["userId"] = user_id
    if timeout_ms:
        body["timeoutMs"] = timeout_ms
    return await _call("POST", "/api/agent/tasks", body=body)


async def get_task(task_id: str, *, wait: int = 0) -> Dict[str, Any]:
    return await _call("GET", f"/api/agent/tasks/{task_id}?wait={max(0, min(300, wait))}")


async def wait_for_task(task_id: str, *, timeout: float = 240, poll: float = 2.0) -> Dict[str, Any]:
    """Poll until the task is terminal or `timeout` seconds pass."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + max(0.0, timeout)
    snapshot: Dict[str, Any] = {}
    while True:
        snapshot = await get_task(task_id, wait=0)
        status = str((snapshot.get("task") or {}).get("status") or "")
        if status in ("completed", "failed", "cancelled") or loop.time() >= deadline:
            return snapshot
        await asyncio.sleep(poll)


def task_id_of(snapshot: Dict[str, Any]) -> str:
    task = snapshot.get("task") or {}
    return str(task.get("id") or snapshot.get("taskId") or "")


def task_status_of(snapshot: Dict[str, Any]) -> str:
    return str((snapshot.get("task") or {}).get("status") or "")


def result_text(snapshot: Dict[str, Any]) -> str:
    """Best-effort assistant-facing text for a finished coding task."""
    task = snapshot.get("task") or {}
    result = task.get("result") or {}
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except json.JSONDecodeError:
            return result
    if not isinstance(result, dict):
        result = {}
    output = result.get("output") or result.get("content") or result.get("summary")
    if isinstance(output, str) and output.strip():
        return output.strip()
    steps = snapshot.get("steps") or []
    for step in reversed(steps):
        message = step.get("message") if isinstance(step, dict) else None
        if isinstance(message, str) and message.strip():
            return message.strip()
    return str(task.get("summary") or "").strip()


async def cancel_task(task_id: str) -> Dict[str, Any]:
    return await _call("DELETE", f"/api/agent/tasks/{task_id}")
