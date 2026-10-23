"""
Agentverse-hosted coordinator for Hi (pull mode, single-file).

Agentverse hosting accepts ONE Python file per agent. Everything the agent
needs lives below — it is the same logic as `hi_agents/handlers.py` (ASI:ONE
calls in pull mode) so local and hosted agents behave identically.

Copy this file into agentverse.ai (My Agents → New Agent → paste → Upload).

The agent polls your Hi backend for queued tasks over HTTPS and posts every
update/result back:

  GET  /api/agent/tasks?kinds=chat,research&agent=hosted-coordinator
  POST /api/agent/events          (one frame per call)

Authentication: HTTP header `Authorization: Bearer <AGENT_TOKEN>`.

Configure BACKEND_URL (the public URL of your backend) and AGENT_TOKEN below
or leave them to the environment; Agentverse exposes env vars set in the UI.
"""

from os import getenv

import requests

# ── Configuration ────────────────────────────────────────────────────────────
BACKEND_URL = getenv("HI_BACKEND_HTTP", "https://your-backend.example.com")
AGENT_TOKEN = getenv("AGENT_TOKEN", "")  # same value as the server's AGENT_TOKEN

ASI_API_KEY = getenv("ASI_ONE_API_KEY", "")
ASI_BASE_URL = getenv("ASI_ONE_BASE_URL", "https://api.asi1.ai/v1")
ASI_MODEL = getenv("ASI_ONE_MODEL", "asi1")
ASI_MINI_MODEL = getenv("ASI_ONE_MINI_MODEL", "asi1-mini")


def _headers() -> dict:
    return {"Authorization": f"Bearer {AGENT_TOKEN}", "Content-Type": "application/json"}


def emit(frame: dict) -> None:
    requests.post(
        f"{BACKEND_URL}/api/agent/events", json=frame, headers=_headers(), timeout=25
    )


def poll_tasks(kinds: str) -> list:
    resp = requests.get(
        f"{BACKEND_URL}/api/agent/tasks",
        params={"kinds": kinds, "agent": "hosted-coordinator"},
        headers=_headers(),
        timeout=25,
    )
    if resp.status_code == 200:
        return resp.json()
    return []


# ── ASI:ONE (verified OpenAI-compatible API) ─────────────────────────────────


def _asi_chat(messages, *, model=None, temperature=None, web_search=False):
    body = {"model": model or ASI_MODEL, "messages": messages}
    if temperature is not None:
        body["temperature"] = temperature
    if web_search:
        body["web_search_options"] = {"search_context_size": "medium"}
    resp = requests.post(
        f"{ASI_BASE_URL}/chat/completions", json=body, headers=_headers(), timeout=180
    )
    if resp.status_code != 200:
        raise RuntimeError(f"ASI:ONE error {resp.status_code}: {resp.text[:200]}")
    data = resp.json()
    choice = (data.get("choices") or [{}])[0].get("message") or {}
    return choice.get("content", "")


def _asi_json(messages, *, model=None, temperature=0.3):
    import json as _json

    body = {
        "model": model or ASI_MINI_MODEL,
        "messages": messages,
        "response_format": {"type": "json_object"},
        "temperature": temperature,
    }
    resp = requests.post(
        f"{ASI_BASE_URL}/chat/completions", json=body, headers=_headers(), timeout=120
    )
    if resp.status_code != 200:
        raise RuntimeError(f"ASI:ONE error {resp.status_code}: {resp.text[:200]}")
    raw = ((resp.json().get("choices") or [{}])[0].get("message") or {}).get(
        "content", "{}"
    )
    raw = raw.strip().removeprefix("```json").removeprefix("```").removesuffix("```")
    return _json.loads(raw)


CHAT_SYSTEM = (
    "You are Hi, a warm, quick, slightly playful personal AI companion living in a "
    "little floating purple character on the user's desktop. Keep answers tight "
    "and useful; use light markdown."
)


def handle_chat(task, context) -> None:
    if context.get("kind") != "chat":
        return
    memories = context.get("memories") or []
    history = context.get("history") or []
    text = context.get("text", "")
    system = CHAT_SYSTEM
    if memories:
        system += "\n\nThings you remember about the person:\n" + "\n".join(
            f"- ({m.get('kind')}) {m.get('content')}" for m in memories
        )
    messages = [{"role": "system", "content": system}] + [
        {"role": t.get("role", "user"), "content": t.get("content", "")} for t in history
    ] + [{"role": "user", "content": text}]
    try:
        content = _asi_chat(messages)
    except Exception as err:  # noqa: BLE001
        emit({"type": "task.error", "taskId": task["id"], "error": f"chat failed: {err}"})
        return
    emit({"type": "text.delta", "taskId": task["id"], "text": content})
    emit(
        {
            "type": "task.result",
            "taskId": task["id"],
            "summary": content[:140],
            "result": {"content": content, "messageId": context.get("messageId")},
        }
    )


def handle_research(task, context) -> None:
    payload = (context.get("task") or {}).get("payload") or {}
    query = payload.get("prompt") or payload.get("text") or "Research the request."
    emit({"type": "task.step", "taskId": task["id"], "label": "Searching the live web"})
    try:
        report = _asi_chat(
            [
                {
                    "role": "system",
                    "content": (
                        "You are the Researcher agent in the Hi companion. Research the request "
                        "with live web search and give: a short synthesis, 3-8 bullets, then a "
                        "`Sources:` list of URLs."
                    ),
                },
                {"role": "user", "content": query},
            ],
            web_search=True,
        )
    except Exception as err:  # noqa: BLE001
        emit({"type": "task.error", "taskId": task["id"], "error": f"research failed: {err}"})
        return
    emit(
        {
            "type": "task.result",
            "taskId": task["id"],
            "summary": report.split("\n")[0][:140],
            "result": {"report": report, "query": query},
        }
    )


def handle_plan(task, context) -> None:
    payload = (context.get("task") or {}).get("payload") or {}
    goal = payload.get("prompt") or payload.get("text") or "Plan this."
    emit({"type": "task.step", "taskId": task["id"], "label": "Drafting a plan"})
    try:
        plan = _asi_json(
            [
                {
                    "role": "system",
                    "content": (
                        "You are the Planner agent of the Hi companion. Return pure JSON: "
                        '{"title": string, "steps": [{"label": string}]}.'
                    ),
                },
                {"role": "user", "content": goal},
            ]
        )
    except Exception as err:  # noqa: BLE001
        emit({"type": "task.error", "taskId": task["id"], "error": f"planning failed: {err}"})
        return
    steps = [s.get("label", "") for s in plan.get("steps", []) if s.get("label")]
    emit(
        {
            "type": "task.result",
            "taskId": task["id"],
            "summary": f"Plan: {plan.get('title', '')}"[:140],
            "result": {"plan": plan, "steps": steps},
        }
    )


def handle_memory(task, context) -> None:
    emit({"type": "task.step", "taskId": task["id"], "label": "Extracting durable memories"})
    payload = (context.get("task") or {}).get("payload") or {}
    history = context.get("history") or []
    last_user = next(
        (t["content"] for t in reversed(history) if t.get("role") == "user"), ""
    )
    last_reply = next(
        (t["content"] for t in reversed(history) if t.get("role") == "assistant"), ""
    )
    try:
        parsed = _asi_json(
            [
                {
                    "role": "system",
                    "content": (
                        'You maintain the long-term memory of the Hi companion. Only durable, '
                        "useful facts about the user. kind in fact|preference|goal|person|"
                        "routine|project; importance 1-5; confidence 0-100; pure JSON "
                        '{"memories": [...]}.'
                    ),
                },
                {
                    "role": "user",
                    "content": f"USER SAID:\n{last_user}\n\nASSISTANT REPLIED:\n{(last_reply or '')[:1200]}",
                },
            ]
        )
    except Exception as err:  # noqa: BLE001
        emit({"type": "task.error", "taskId": task["id"], "error": f"memory extraction failed: {err}"})
        return
    emit(
        {
            "type": "task.result",
            "taskId": task["id"],
            "summary": f"Remembered {len(parsed.get('memories', []))} new items",
            "result": {
                "memories": parsed.get("memories", []),
                "count": len(parsed.get("memories", [])),
                "conversationId": (payload.get("conversationId")),
            },
        }
    )


def handle_custom(task, context) -> None:
    payload = (context.get("task") or {}).get("payload") or {}
    prompt = payload.get("prompt") or payload.get("text") or "Complete the task."
    try:
        output = _asi_chat(
            [
                {
                    "role": "system",
                    "content": "You are a specialist agent in the Hi companion. Complete the task crisply.",
                },
                {"role": "user", "content": prompt},
            ],
            temperature=0.5,
        )
    except Exception as err:  # noqa: BLE001
        emit({"type": "task.error", "taskId": task["id"], "error": f"failed: {err}"})
        return
    emit(
        {
            "type": "task.result",
            "taskId": task["id"],
            "summary": output[:140],
            "result": {"output": output},
        }
    )


HANDLERS = {
    "chat": handle_chat,
    "research": handle_research,
    "plan": handle_plan,
    "memory": handle_memory,
    "custom": handle_custom,
}


# ── Agentverse loop ──────────────────────────────────────────────────────────

from uagents import Agent, Context, Model  # noqa: E402


class Tick(Model):
    pass


agent = Agent(
    name="hi-coordinator-hosted",
    seed=getenv("HI_COORDINATOR_SEED", "hi hosted coordinator recovery phrase"),
    mailbox=True,
)


@agent.on_interval(period=6.0)
async def poll(ctx: Context) -> None:
    if not AGENT_TOKEN:
        ctx.logger.info("AGENT_TOKEN not set; configure it in the hosting UI")
        return
    assigned = poll_tasks("chat,research,plan,memory,custom")
    for frame in assigned:
        task = frame.get("task", {})
        context = frame.get("context", {"kind": "generic"})
        kind = task.get("kind", "custom")
        ctx.logger.info(f"pulled {kind} task {task.get('id')}")
        try:
            HANDLERS.get(kind, handle_custom)(task, context)
        except Exception as err:  # noqa: BLE001
            emit({"type": "task.error", "taskId": task.get("id", ""), "error": str(err)})


@agent.on_event("startup")
async def start(ctx: Context) -> None:
    ctx.logger.info(f"hosted coordinator up: {agent.address}")
