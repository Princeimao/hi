"""Hi agent gateway — wires the real uAgents bureau to the Hi backend.

Run:
    python -m hi_agents.gateway

Environment (see .env.example at the repo root):
    HI_BACKEND_URL   ws://localhost:8787/ws
    AGENT_TOKEN      matches the AGENT_TOKEN of the Hi server
    ASI_ONE_API_KEY  your ASI:ONE key (https://asi1.ai/dashboard/api-keys)

What it does
- starts the four uAgents (coordinator + researcher + planner + insight) inside
  a single uAgents Bureau;
- opens one persistent WebSocket to the backend relay as the `coordinator`
  (AGENT_TOKEN authenticated), publishing progress/steps/streamed text/results;
- on `task.assign`, pushes the assignment into the coordinator uAgent, which
  routes it through genuine uAgents messages to the right specialist.

If you prefer serving the specialists from Agentverse hosting (not a local
process), see `agents/hosted/` — the same handlers run there in pull mode.
"""
from __future__ import annotations

import asyncio
import logging
import os
from typing import Any, Dict

from . import config
from .agents import AgentRuntime, build_bureau
from .backend import BackendLink


async def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="[%(asctime)s] %(name)s %(levelname)s %(message)s",
    )
    log = logging.getLogger("hi.gateway")

    if not config.AGENT_TOKEN:
        log.error("AGENT_TOKEN is not set — copy server/.env.example to server/.env first")
        raise SystemExit(2)

    capabilities = ["chat", "research", "plan", "memory", "friend", "custom"]
    runtime_holder: list[Any] = []

    async def on_frame(frame: Dict[str, Any]) -> None:
        if frame.get("type") == "task.assign":
            runtime = runtime_holder[0]
            task = frame["task"]
            if task.get("kind") == "friend":
                payload = task.get("payload", {})
                await runtime.dispatch_friend(
                    str(task.get("id", "")),
                    str(payload.get("address", "")),
                    str(payload.get("text", "")),
                )
            else:
                await runtime.dispatch(task, frame.get("context", {"kind": "generic"}))
        elif frame.get("type") == "task.input":
            log.info("user answered task %s — specialists keep working; the answer is recorded server-side", frame.get("taskId"))

    link = BackendLink(name="coordinator", capabilities=capabilities, on_frame=on_frame)
    runtime = AgentRuntime(link)
    runtime_holder.append(runtime)
    bureau = build_bureau(runtime)
    coordinator = runtime.coordinator
    assert coordinator is not None

    link_task = asyncio.create_task(link.run(), name="hi-backend-link")

    async def connect_mailbox() -> None:
        """Register the coordinator's mailbox on Agentverse with the user
        token, so hosted agents can reply to us without a public endpoint."""
        if not config.AGENTVERSE_TOKEN:
            log.warning("AGENTVERSE not set — hosted friends cannot reply; Inbox stays empty")
            return
        import aiohttp

        url = f"http://{config.AGENT_HOST}:{config.AGENT_BASE_PORT}/connect"
        for _ in range(20):
            try:
                async with aiohttp.ClientSession() as session:
                    async with session.post(
                        url,
                        json={
                            "user_token": config.AGENTVERSE_TOKEN,
                            "agent_type": "agent",
                            "endpoint": None,
                        },
                    ) as resp:
                        body = await resp.text()
                        log.info("agentverse connect (%s): %s", resp.status, body[:160])
                        return
            except aiohttp.ClientError:
                pass
            await asyncio.sleep(1)

    async def mailbox_runner() -> None:
        try:
            await coordinator.run_async()
        except Exception:  # noqa: BLE001
            log.exception("coordinator task failed")

    log.info("starting uAgents bureau (coordinator + 3 specialists)…")
    coordinator_task = asyncio.create_task(mailbox_runner(), name="hi-coordinator")
    connect_task = asyncio.create_task(connect_mailbox(), name="hi-mailbox-connect")
    try:
        if hasattr(bureau, "run_async"):
            await bureau.run_async()
        else:
            bureau.run()
    finally:
        connect_task.cancel()
        coordinator_task.cancel()
        await link.stop()
        try:
            await link_task
        except asyncio.CancelledError:
            pass


if __name__ == "__main__":
    asyncio.run(main())
