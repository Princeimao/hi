"""Real uAgents wiring for Hi.

Four agents (uAgents framework, https://uagents.fetch.ai/examples) run inside
one Bureau:

  hi-coordinator   receives every task from the backend gateway, routes it
  hi-researcher    research analyst (ASI:ONE live web search)
  hi-planner       plan author (structured JSON plans)
  hi-insight       long-term memory curator (structured JSON extraction)

The coordinator uses genuine uAgents point-to-point messaging (`ctx.send`) to
delegate work to specialists. Frames stream back to the Hi backend (and then
to your devices) through the BackendLink WebSocket.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Awaitable, Callable, Dict, List, Optional

from uagents import Agent, Bureau, Context, Model
from uagents_core.contrib.protocols.chat import ChatAcknowledgement, ChatMessage

from . import config, friends, handlers
from .handlers import Emit

log = logging.getLogger("hi.agent.bureau")


class TaskRequest(Model):
    """A task assignment; the dict payload rides as JSON for model safety."""

    taskId: str
    kind: str
    payloadJson: str


class FriendMessageRequest(Model):
    """A message the user wants delivered to an external (Agentverse) agent."""

    taskId: str
    address: str
    text: str


def _make_agent(name: str, seed: str, port: int, mailbox: bool = False) -> Agent:
    return Agent(
        name=name,
        seed=seed,
        port=port,
        endpoint=None if mailbox else [f"http://{config.AGENT_HOST}:{port}/submit"],
        mailbox=mailbox,
    )


class AgentRuntime:
    """Builds the 4 uAgents and runs every task through the shared handlers."""

    def __init__(self, link: Any) -> None:
        self.link = link
        self.agents: Dict[str, Agent] = {}
        self.coordinator: Optional[Agent] = None

    def emitter(self) -> Emit:
        async def emit(frame: Dict[str, Any]) -> None:
            await self.link.send(frame)

        return emit

    def build(self) -> List[Agent]:
        emit = self.emitter()

        def make_specialist(kind: str, name: str, seed: str, port: int) -> Agent:
            agent = _make_agent(name, seed, port)
            handler = {
                "research": handlers.handle_research,
                "plan": handlers.handle_plan,
                "memory": handlers.handle_memory,
            }.get(kind, handlers.handle_custom)

            @agent.on_message(model=TaskRequest, replies=set())
            async def on_specialist_task(ctx: Context, sender: str, msg: TaskRequest) -> None:  # noqa: ANN001
                payload = json.loads(msg.payloadJson)
                await handler(payload["task"], emit, payload.get("context", {"kind": "generic"}))

            log.info("built specialist agent %s (handles %s)", name, kind)
            return agent

        researcher = make_specialist("research", "hi-researcher", config.RESEARCHER_SEED, config.AGENT_BASE_PORT + 1)
        planner = make_specialist("plan", "hi-planner", config.PLANNER_SEED, config.AGENT_BASE_PORT + 2)
        insight = make_specialist("memory", "hi-insight", config.INSIGHT_SEED, config.AGENT_BASE_PORT + 3)

        coordinator = _make_agent("hi-coordinator", config.COORDINATOR_SEED, config.AGENT_BASE_PORT, mailbox=True)
        self.coordinator = coordinator
        self.friends = friends.FriendCoordinator()
        self.friends.bind(emit)

        @coordinator.on_message(model=TaskRequest, replies=set())
        async def on_coordinator_task(ctx: Context, sender: str, msg: TaskRequest) -> None:  # noqa: ANN001
            payload = json.loads(msg.payloadJson)
            task, context = payload["task"], payload.get("context", {"kind": "generic"})
            kind = msg.kind
            specialist = {"research": researcher, "plan": planner, "memory": insight}.get(kind)
            if specialist is not None and sender != "self":
                log.info("coordinator delegates %s task %s -> %s", kind, task.get("id"), specialist.name)
                await ctx.send(specialist.address, msg)
                return
            await handlers.run_task(task, emit, context)

        @coordinator.on_message(model=FriendMessageRequest, replies=set())
        async def on_friend_message(ctx: Context, sender: str, msg: FriendMessageRequest) -> None:  # noqa: ANN001
            await self.friends.dispatch_send(ctx, msg.taskId, msg.address, msg.text)

        @coordinator.on_message(model=ChatAcknowledgement)
        async def on_chat_ack(ctx: Context, sender: str, msg: ChatAcknowledgement) -> None:  # noqa: ANN001
            await self.friends.on_ack(ctx, sender, msg)

        # ChatMessage covers BOTH external-agent replies and specialist chatter;
        # only replies for a pending friend slot are surfaced.
        @coordinator.on_message(model=ChatMessage)
        async def on_chat_message(ctx: Context, sender: str, msg: ChatMessage) -> None:  # noqa: ANN001
            await self.friends.on_reply(ctx, sender, msg)

        @coordinator.on_event("startup")
        async def on_startup(ctx: Context) -> None:  # noqa: ANN001
            log.info("coordinator up: %s", ctx.agent.address)

        for agent in (coordinator, researcher, planner, insight):
            self.agents[agent.name] = agent
        return [coordinator, researcher, planner, insight]

    async def dispatch(self, task: Dict[str, Any], context: Dict[str, Any]) -> None:
        """Push a hub assignment into the running coordinator via the
        framework's internal dispatcher (same path the mailbox uses)."""
        await self._dispatch_model(
            TaskRequest,
            {"taskId": str(task.get("id", "")), "kind": str(task.get("kind", "custom")),
             "payloadJson": json.dumps({"task": task, "context": context}, default=str)},
        )

    async def dispatch_friend(self, task_id: str, address: str, text: str) -> None:
        await self._dispatch_model(
            FriendMessageRequest,
            {"taskId": task_id, "address": address, "text": text},
        )

    async def _dispatch_model(self, model: type, payload: Dict[str, Any]) -> None:
        from uagents.dispatch import dispatcher as core_dispatcher
        from uuid import uuid4

        coordinator = self.coordinator
        if coordinator is None:
            raise RuntimeError("agents not built")
        message = json.dumps(payload, default=str)
        await core_dispatcher.dispatch_msg(
            sender="hub",
            destination=coordinator.address,
            schema_digest=model.build_schema_digest(model),
            message=message,
            session=uuid4(),
        )


def build_bureau(runtime: AgentRuntime) -> Bureau:
    """The specialists run in a Bureau; the coordinator runs on its own so its
    mailbox endpoint survives (Bureau without endpoints strips them)."""
    bureau = Bureau()
    for agent in runtime.build()[1:]:
        bureau.add(agent)
    return bureau
