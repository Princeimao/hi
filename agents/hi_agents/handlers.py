"""Task handlers — the actual agent work.

Each handler receives
  task:     dict      (the AgentTask row)
  emit:     callable  async (frame: dict) -> None   (updates → backend)
  context:  dict      (assignment context: chat history, memories, ...)
and is shared between the WebSocket gateway (local agents) and the
Agentverse-hosted pull-mode agents.
"""
from __future__ import annotations

import json
import re
from typing import Any, Awaitable, Callable, Dict, List

from . import asi

Emit = Callable[[Dict[str, Any]], Awaitable[None]]


def _prompt(context: Dict[str, Any]) -> str:
    if context.get("kind") == "chat":
        return str(context.get("text", ""))
    task = context.get("task") or {}
    payload = task.get("payload") or {}
    return str(payload.get("prompt") or payload.get("text") or "")


async def handle_chat(task: Dict[str, Any], emit: Emit, context: Dict[str, Any]) -> None:
    """Reply conversationally: memory-aware, streamed to every device."""
    if context.get("kind") != "chat":
        await emit({"type": "task.error", "taskId": task["id"], "error": "chat task without chat context"})
        return

    memories: List[Dict[str, str]] = context.get("memories") or []
    history: List[Dict[str, str]] = context.get("history") or []
    text = str(context.get("text", ""))

    system_parts = [
        "You are Hi, a warm, quick, slightly playful personal AI companion living in a little "
        "floating purple character on the user's desktop.",
        "Keep answers tight and useful; use light markdown. Use what you remember about the person "
        "but never enumerate memories unless asked.",
        "When the user asks you to add/todo/remember something actionable (e.g. \"add a todo to call "
        "mom\"), append a marker line like [todo: call mom] to your reply exactly once per item; "
        "never mention the marker itself.",
        "When the user asks for a timer or countdown (\"set a 10 minute timer\"), append "
        "[timer: 10m] to your reply; never mention the marker.",
        "If the request clearly needed a connected agent (flight, map, search) and you also have "
        "Cal.com or Notion connected, end with a short follow-up offer like: 'Want me to put this "
        "trip on your Cal.com calendar or save it to Notion?' — only when it genuinely fits, never "
        "as a generic closer.",
        "Local file, directory and coding work is handled by the Pi agent running on the user's PC. "
        "When a tool result is provided below, that is Pi's real output from their machine — "
        "present it clearly, credit Pi, never invent tool data, and NEVER claim you ran a command "
        "yourself.",
        "NEVER fabricate tool calls or say a command failed unless the tool result below says so. "
        "If no tool result is provided, you have no local access — answer from conversation only.",
    ]
    if memories:
        memory_lines = "\n".join(f"- ({m.get('kind')}) {m.get('content')}" for m in memories)
        system_parts.append("Things you remember about the person:\n" + memory_lines)
    tools = str(context.get("tools") or "")
    if tools:
        system_parts.append(
            "A tool was run for this request — its result is below. Use it, credit "
            "the source, never invent tool data. NEVER paste raw command output, dir "
            "listings, or <local.exec> blocks into your reply — the tool result is shown "
            "to the user as a structured card automatically. Just summarize what it means "
            "in one or two sentences:\n" + tools
        )

    messages: List[Dict[str, str]] = [{"role": "system", "content": " ".join(system_parts)}]
    for turn in history:
        role = turn.get("role", "user")
        if role in ("user", "assistant"):
            messages.append({"role": role, "content": str(turn.get("content", ""))})
    messages.append({"role": "user", "content": text})

    full = ""
    last_flush = ""
    try:
        async for ev in asi.chat_stream(messages):
            if ev.get("type") != "delta":
                continue
            full += ev["delta"]
            if len(full) - len(last_flush) >= 24 or "\n" in ev["delta"]:
                last_flush = full
                await emit({"type": "text.delta", "taskId": task["id"], "text": full})
        if not full:
            raise RuntimeError("ASI:ONE returned an empty answer")
    except asi.NotConfigured as err:
        await emit({"type": "task.error", "taskId": task["id"], "error": str(err)})
        return
    except Exception as err:  # noqa: BLE001 — surfaced to the user via task.failed
        await emit({"type": "task.error", "taskId": task["id"], "error": f"chat failed: {err}"})
        return

    await emit({"type": "text.delta", "taskId": task["id"], "text": full})
    await emit(
        {
            "type": "task.result",
            "taskId": task["id"],
            "summary": full[:140],
            "result": {"content": full, "messageId": context.get("messageId")},
        }
    )


INTENT_RESEARCH = re.compile(r"\b(research|look up|find out|search|compare|latest|news about)\b", re.IGNORECASE)
INTENT_PLAN = re.compile(r"\b(plan|roadmap|steps to|how do i start|schedule|itinerary)\b", re.IGNORECASE)


async def handle_research(task: Dict[str, Any], emit: Emit, context: Dict[str, Any]) -> None:
    query = _prompt(context) or "Research the request."
    await emit({"type": "task.step", "taskId": task["id"], "label": "Searching the live web with ASI:ONE"})
    await emit({"type": "task.update", "taskId": task["id"], "status": "running", "progress": 30})
    try:
        result = await asi.chat(
            [
                {
                    "role": "system",
                    "content": (
                        "You are the Researcher agent in the Hi companion. Research the request with "
                        "live web search and give: a short synthesis (3-6 sentences), then 3-8 bullet "
                        "findings, then a `Sources:` list of the URLs you relied on."
                    ),
                },
                {"role": "user", "content": query},
            ],
            web_search=True,
        )
    except Exception as err:  # noqa: BLE001
        await emit({"type": "task.error", "taskId": task["id"], "error": f"research failed: {err}"})
        return
    await emit({"type": "task.step", "taskId": task["id"], "label": "Synthesizing findings"})
    urls = ", ".join(sorted(set(re.findall(r"https?://[^\s)\]]+", result.content)))[:12])
    await emit(
        {
            "type": "task.result",
            "taskId": task["id"],
            "summary": result.content.split("\n")[0][:140],
            "result": {"report": result.content, "citedUrls": urls, "query": query},
        }
    )


async def handle_plan(task: Dict[str, Any], emit: Emit, context: Dict[str, Any]) -> None:
    goal = _prompt(context) or "Plan this."
    await emit({"type": "task.step", "taskId": task["id"], "label": "Drafting a plan"})
    try:
        plan = await asi.chat_json(
            [
                {
                    "role": "system",
                    "content": (
                        'You are the Planner agent of the Hi companion. Return pure JSON: '
                        '{"title": string, "steps": [{"label": string, "detail"?: string}]} '
                        "with 3-9 concise, concrete steps."
                    ),
                },
                {"role": "user", "content": goal},
            ]
        )
    except Exception as err:  # noqa: BLE001
        await emit({"type": "task.error", "taskId": task["id"], "error": f"planning failed: {err}"})
        return
    steps = [s.get("label", "") for s in plan.get("steps", []) if s.get("label")]
    await emit(
        {
            "type": "task.result",
            "taskId": task["id"],
            "summary": f"Plan: {plan.get('title', '')}"[:140],
            "result": {"plan": plan, "steps": steps},
        }
    )


EXTRACT_SYSTEM = """You maintain the long-term memory of a personal AI companion called Hi.
From the conversation excerpt, extract durable facts about the user that should be remembered
across future conversations: preferences, goals, people they mention, routines, projects,
and important facts.
Rules:
- Only truly durable, useful facts. Exclude one-off chat or small talk.
- One concise self-contained third-person sentence about the user ("The user ...")."
- kind one of: fact, preference, goal, person, routine, project
- importance 1-5, confidence 0-100
- pure JSON: {"memories": [{"kind":..., "content":..., "confidence":..., "importance":...}]}
"""


async def handle_memory(task: Dict[str, Any], emit: Emit, context: Dict[str, Any]) -> None:
    conversation_id = context.get("conversationId") or (context.get("task", {}).get("payload", {}) or {}).get("conversationId")
    history = context.get("history") or []
    last_user = next((t["content"] for t in reversed(history) if t.get("role") == "user"), "")
    last_reply = next((t["content"] for t in reversed(history) if t.get("role") == "assistant"), "")
    await emit({"type": "task.step", "taskId": task["id"], "label": "Extracting durable memories"})
    try:
        parsed = await asi.chat_json(
            [
                {"role": "system", "content": EXTRACT_SYSTEM},
                {
                    "role": "user",
                    "content": f"USER SAID:\n{last_user}\n\nASSISTANT REPLIED:\n{(last_reply or '')[:1200]}",
                },
            ],
            model=asi.config.ASI_MINI_MODEL,
            temperature=0.2,
        )
    except Exception as err:  # noqa: BLE001
        await emit({"type": "task.error", "taskId": task["id"], "error": f"memory extraction failed: {err}"})
        return
    await emit(
        {
            "type": "task.result",
            "taskId": task["id"],
            "summary": f"Remembered {len(parsed.get('memories', []))} new items",
            "result": {
                "memories": parsed.get("memories", []),
                "conversationId": conversation_id,
                "count": len(parsed.get("memories", [])),
            },
        }
    )


async def handle_custom(task: Dict[str, Any], emit: Emit, context: Dict[str, Any]) -> None:
    prompt = _prompt(context) or "Complete the task."
    await emit({"type": "task.update", "taskId": task["id"], "status": "running", "progress": 20})
    try:
        result = await asi.chat(
            [
                {"role": "system", "content": "You are a specialist agent in the Hi companion. Complete the task crisply."},
                {"role": "user", "content": prompt},
            ],
            temperature=0.5,
        )
    except Exception as err:  # noqa: BLE001
        await emit({"type": "task.error", "taskId": task["id"], "error": f"failed: {err}"})
        return
    await emit({"type": "task.result", "taskId": task["id"], "summary": result.content[:140], "result": {"output": result.content}})


HANDLERS = {
    "chat": handle_chat,
    "research": handle_research,
    "plan": handle_plan,
    "memory": handle_memory,
    "custom": handle_custom,
}


async def run_task(task: Dict[str, Any], emit: Emit, context: Dict[str, Any] | None = None) -> None:
    kind = task.get("kind", "custom")
    handler = HANDLERS.get(kind, handle_custom)
    await handler(task, emit, context or {"kind": "generic", "task": task})


def route_on_text(text: str) -> str:
    """Best-effort single-shot routing for the coordinator when it runs chat tasks."""
    if INTENT_RESEARCH.search(text):
        return "research"
    if INTENT_PLAN.search(text):
        return "plan"
    return "chat"


def dumps(value: Any) -> str:
    return json.dumps(value)
