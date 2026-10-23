"""FriendLink — talking to external agents over the standard Agentverse chat
protocol (AgentChatProtocol v0.3.0: ChatMessage/ChatAcknowledgement with typed
content parts). The coordinator keeps one pending outbound message per friend
address: the acknowledgement confirms delivery, the next ChatMessage from that
address is their reply. Liveness timeouts surface honest errors — nothing is
pretended to be delivered when it wasn't.
"""
from __future__ import annotations

import asyncio
import datetime
import logging
import uuid
from typing import Any, Dict, Optional

from uagents_core.contrib.protocols.chat import (
    ChatAcknowledgement,
    ChatMessage,
    TextContent,
    chat_protocol_spec,
)

log = logging.getLogger("hi.agent.friends")

CHAT_PROTOCOL = chat_protocol_spec.digest
ACK_TIMEOUT_S = 30.0
REPLY_TIMEOUT_S = 150.0


class FriendCoordinator:
    """Owned by the coordinator agent: outbound friend messaging + inbound
    replies/acks. `emit` pushes agent frames to the Hi backend."""

    def __init__(self) -> None:
        # address -> pending outbound
        self.pending: Dict[str, Dict[str, Any]] = {}
        self.timers: Dict[str, asyncio.Task] = {}
        self.emit: Optional[Any] = None

    def bind(self, emit: Any) -> None:
        self.emit = emit

    def build_chat_message(self, text: str) -> ChatMessage:
        now = datetime.datetime.now(datetime.timezone.utc)
        return ChatMessage(timestamp=now, msg_id=uuid.uuid4(), content=[TextContent(type="text", text=text)])

    def reply_text(self, msg: ChatMessage) -> str:
        parts = [c.text for c in msg.content if isinstance(c, TextContent)]
        return "\n".join(parts).strip()

    async def dispatch_send(self, ctx: Any, task_id: str, address: str, text: str) -> None:
        event = {
            "type": "friend.error",
            "taskId": task_id,
            "address": address,
            "detail": "",
        }
        if not address.startswith("agent1q") or len(address) < 40:
            event["detail"] = "not a valid agent address"
            if self.emit:
                await self.emit(event)
            return
        if address in self.pending:
            event["detail"] = "a message to this agent is still in flight"
            if self.emit:
                await self.emit(event)
            return
        self.pending[address] = {"taskId": task_id, "text": text, "delivery": "pending"}
        try:
            await ctx.send(address, self.build_chat_message(text))
            self.timers[address] = asyncio.create_task(self.watchdog(address))
            log.info("friend message to %s (task %s)", address[:12], task_id)
        except Exception as err:  # noqa: BLE001
            self.clear(address)
            event["detail"] = str(err)
            log.warning("friend send failed: %s", err)
            if self.emit:
                await self.emit(event)

    def clear(self, address: str) -> None:
        self.pending.pop(address, None)
        timer = self.timers.pop(address, None)
        if timer is not None:
            timer.cancel()

    async def watchdog(self, address: str) -> None:
        """Deliver or reply must land in time; otherwise report the truth."""
        try:
            await asyncio.sleep(ACK_TIMEOUT_S)
            slot = self.pending.get(address)
            if slot is None:
                return
            if slot.get("delivery") == "pending" and self.emit:
                await self.emit({
                    "type": "friend.error",
                    "taskId": slot["taskId"],
                    "address": address,
                    "detail": "no acknowledgement from the agent within 30s (offline or unreachable)",
                })
                self.timers[address] = asyncio.create_task(self.watchdog_reply(address))
        except asyncio.CancelledError:
            return

    async def watchdog_reply(self, address: str) -> None:
        slot = self.pending.get(address)
        if slot is None:
            return
        try:
            await asyncio.sleep(REPLY_TIMEOUT_S - ACK_TIMEOUT_S)
            slot = self.pending.get(address)
            if slot is not None and self.emit:
                await self.emit({
                    "type": "friend.error",
                    "taskId": slot["taskId"],
                    "address": address,
                    "detail": "delivered but no reply within 150s",
                })
                self.clear(address)
        except asyncio.CancelledError:
            return

    async def on_ack(self, ctx: Any, sender: str, ack: ChatAcknowledgement) -> None:
        slot = self.pending.get(sender)
        if slot is None:
            return
        slot["delivery"] = "acknowledged"
        if self.emit:
            await self.emit({
                "type": "friend.delivered",
                "taskId": slot["taskId"],
                "address": sender,
                "ackId": str(ack.acknowledged_msg_id),
            })

    async def on_reply(self, ctx: Any, sender: str, msg: ChatMessage) -> None:
        slot = self.pending.get(sender)
        reply = self.reply_text(msg)
        if slot is None:
            log.info("unprompted chat from %s: %s", sender[:12], reply[:80])
            return
        if self.emit:
            await self.emit({
                "type": "friend.reply",
                "taskId": slot["taskId"],
                "address": sender,
                "text": reply,
            })
        self.clear(sender)
