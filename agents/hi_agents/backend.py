"""BackendLink — persistent WebSocket client to the Hi backend relay.

Frames follow `shared/src/index.ts`:

  outgoing (agent): agent.hello, task.claim, task.update, task.step,
                    task.result, task.error, task.await, text.delta, agent.log
  incoming  (hub):  task.assign (TaskAssignment), task.input, pong
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Awaitable, Callable, Dict, List, Optional

import aiohttp

from . import config

log = logging.getLogger("hi.agent.link")

Incoming = Callable[[Dict[str, Any]], Awaitable[None]]


class BackendLink:
    """Connects to ``/ws?role=agent&token=…`` and exchanges agent frames."""

    def __init__(
        self,
        name: str,
        capabilities: List[str],
        on_frame: Incoming,
        *,
        url: Optional[str] = None,
        token: Optional[str] = None,
    ) -> None:
        self.name = name
        self.capabilities = capabilities
        self.on_frame = on_frame
        self.url = url or config.HI_BACKEND_URL
        self.token = token or config.AGENT_TOKEN
        self.session: Optional[aiohttp.ClientSession] = None
        self._queue: asyncio.Queue[Dict[str, Any] | None] = asyncio.Queue()
        self._closed = False

    async def send(self, frame: Dict[str, Any]) -> None:
        await self._queue.put({"__send__": True, **frame})

    # ── internal ────────────────────────────────────────────────────────────

    def _handshake(self) -> Dict[str, Any]:
        return {
            "type": "agent.hello",
            "agent": self.name,
            "modes": ["ws", "pull"],
            "capabilities": self.capabilities,
        }

    async def stop(self) -> None:
        self._closed = True
        await self._queue.put(None)

    async def run(self) -> None:
        """Reconnecting loop; hands every incoming frame to `on_frame`."""
        backoff = 1.0
        while not self._closed:
            try:
                self.session = aiohttp.ClientSession()
                ws = await self.session.ws_connect(
                    self.url,
                    params={"role": "agent", "token": self.token, "agent": self.name},
                    heartbeat=25,
                )
                log.info("connected to %s as %s", self.url, self.name)
                backoff = 1.0
                hello = self._handshake()
                await ws.send_str(json.dumps(hello))

                async def sender() -> None:
                    while True:
                        frame = await self._queue.get()
                        if frame is None:
                            break
                        payload = {k: v for k, v in frame.items() if k != "__send__"}
                        await ws.send_str(json.dumps(payload))

                send_task = asyncio.create_task(sender())
                try:
                    async for msg in ws:
                        if msg.type is aiohttp.WSMsgType.TEXT:
                            try:
                                frame = json.loads(msg.data)
                            except json.JSONDecodeError:
                                continue
                            if frame.get("type") == "hello":
                                log.info("hub ready; agents online: %s", frame.get("hello", {}).get("agentsOnline"))
                                continue
                            await self.on_frame(frame)
                        elif msg.type is aiohttp.WSMsgType.ERROR:
                            break
                finally:
                    send_task.cancel()
                    try:
                        await send_task
                    except asyncio.CancelledError:
                        pass
            except Exception as err:  # noqa: BLE001
                if self._closed:
                    return
                log.warning("gateway dropped (%s); retrying in %.1fs", err, backoff)
            finally:
                if self.session:
                    await self.session.close()
                    self.session = None
            if self._closed:
                return
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)
