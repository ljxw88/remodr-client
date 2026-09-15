"""Coalesced SSE invalidations for one owned OpenCode TUI server per pane."""
from __future__ import annotations

import contextlib
from dataclasses import dataclass
import json
import threading
import time
from typing import Any, Iterator
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler, Request, build_opener

from ...errors import BridgeError
from .api import NoRedirect, REQUEST_TIMEOUT, ServerBinding

MAX_EVENT_LINE = 1024 * 1024
MAX_EVENT = 2 * 1024 * 1024
COALESCE_SECONDS = 0.35
RETRY_INITIAL = 0.5
RETRY_MAX = 8.0

IMMEDIATE_EVENTS = {
    "server.connected",
    "question.asked",
    "question.replied",
    "question.rejected",
    "permission.asked",
    "permission.updated",
    "permission.replied",
    "todo.updated",
    "session.created",
    "session.updated",
    "session.deleted",
    "session.idle",
    "session.status",
    "session.error",
}
COALESCED_EVENTS = {
    "message.updated",
    "message.removed",
    "message.part.updated",
    "message.part.delta",
    "message.part.removed",
}


def open_stream(binding: ServerBinding):
    request = Request(
        binding.base_url + "/event",
        headers={
            "Accept": "text/event-stream",
            "Authorization": binding.credential.authorization(),
            "x-opencode-directory": binding.cwd,
        },
        method="GET",
    )
    opener = build_opener(ProxyHandler({}), NoRedirect())
    try:
        response = opener.open(request, timeout=max(REQUEST_TIMEOUT, 15.0))
    except HTTPError as error:
        with contextlib.suppress(Exception):
            error.close()
        raise BridgeError(
            "OPENCODE_EVENT_UNAVAILABLE",
            "The OpenCode event stream was refused.",
        ) from error
    except (OSError, URLError, ValueError) as error:
        raise BridgeError(
            "OPENCODE_EVENT_UNAVAILABLE",
            "The OpenCode event stream could not be reached.",
        ) from error
    if getattr(response, "status", None) != 200:
        response.close()
        raise BridgeError(
            "OPENCODE_EVENT_UNAVAILABLE",
            "The OpenCode event stream returned an unexpected response.",
        )
    return response


def iter_events(stream: Any, stop: threading.Event) -> Iterator[dict[str, Any]]:
    data: list[bytes] = []
    size = 0
    while not stop.is_set():
        line = stream.readline(MAX_EVENT_LINE + 1)
        if not line:
            return
        if len(line) > MAX_EVENT_LINE:
            raise BridgeError(
                "OPENCODE_EVENT_UNAVAILABLE",
                "The OpenCode event stream returned an oversized line.",
            )
        line = line.rstrip(b"\r\n")
        if not line:
            if not data:
                continue
            try:
                event = json.loads(b"\n".join(data))
            except (UnicodeDecodeError, ValueError) as error:
                raise BridgeError(
                    "OPENCODE_EVENT_UNAVAILABLE",
                    "The OpenCode event stream returned an unreadable event.",
                ) from error
            data = []
            size = 0
            if isinstance(event, dict):
                yield event
            continue
        if line.startswith(b"data:"):
            chunk = line[5:].lstrip(b" ")
            size += len(chunk)
            if size > MAX_EVENT:
                raise BridgeError(
                    "OPENCODE_EVENT_UNAVAILABLE",
                    "The OpenCode event stream returned an oversized event.",
                )
            data.append(chunk)


@dataclass
class _Subscription:
    agent_id: str
    session_id: str
    binding: ServerBinding
    stop: threading.Event
    thread: threading.Thread
    timer: threading.Timer | None = None


class EventManager:
    def __init__(self, host: Any) -> None:
        self.host = host
        self.lock = threading.Lock()
        self.subscriptions: dict[str, _Subscription] = {}
        self.revisions: dict[str, int] = {}

    @staticmethod
    def _key(binding: ServerBinding) -> tuple[Any, ...]:
        return (
            binding.pid, binding.port, binding.cwd, binding.session_id,
            binding.credential.username, binding.credential.password,
        )

    def ensure(self, agent: dict[str, Any], binding: ServerBinding) -> None:
        pane_id = binding.pane_id
        with self.lock:
            current = self.subscriptions.get(pane_id)
            if (
                current is not None
                and current.agent_id == agent["id"]
                and self._key(current.binding) == self._key(binding)
                and current.thread.is_alive()
            ):
                return
        self.stop_pane(pane_id)
        stop = threading.Event()
        subscription = _Subscription(
            agent_id=agent["id"],
            session_id=binding.session_id,
            binding=binding,
            stop=stop,
            thread=threading.Thread(),
        )
        thread = threading.Thread(
            target=self._run,
            args=(pane_id, subscription),
            name=f"opencode-events-{pane_id}",
            daemon=True,
        )
        subscription.thread = thread
        with self.lock:
            self.subscriptions[pane_id] = subscription
        thread.start()

    def stop_pane(self, pane_id: str) -> None:
        with self.lock:
            subscription = self.subscriptions.pop(pane_id, None)
            if subscription is not None:
                subscription.stop.set()
                if subscription.timer is not None:
                    subscription.timer.cancel()

    def prune(self, live_panes: set[str]) -> None:
        with self.lock:
            stale = [
                pane_id for pane_id in self.subscriptions
                if pane_id not in live_panes
            ]
        for pane_id in stale:
            self.stop_pane(pane_id)

    def _current(self, pane_id: str, subscription: _Subscription) -> bool:
        with self.lock:
            return (
                self.subscriptions.get(pane_id) is subscription
                and not subscription.stop.is_set()
            )

    def _publish(self, pane_id: str, subscription: _Subscription) -> None:
        with self.lock:
            if (
                self.subscriptions.get(pane_id) is not subscription
                or subscription.stop.is_set()
            ):
                return
            subscription.timer = None
            revision = self.revisions.get(subscription.agent_id, 0) + 1
            self.revisions[subscription.agent_id] = revision
        self.host.write_event(
            "conversation.changed",
            {
                "agentId": subscription.agent_id,
                "conversationRevision": revision,
            },
        )

    def _notify(
        self, pane_id: str, subscription: _Subscription, *, immediate: bool,
    ) -> None:
        with self.lock:
            if (
                self.subscriptions.get(pane_id) is not subscription
                or subscription.stop.is_set()
            ):
                return
            if immediate:
                if subscription.timer is not None:
                    subscription.timer.cancel()
                    subscription.timer = None
            elif subscription.timer is None:
                timer = threading.Timer(
                    COALESCE_SECONDS, self._publish,
                    args=(pane_id, subscription),
                )
                timer.daemon = True
                subscription.timer = timer
                timer.start()
                return
            else:
                return
        self._publish(pane_id, subscription)

    def _run(self, pane_id: str, subscription: _Subscription) -> None:
        delay = RETRY_INITIAL
        while self.host.running and self._current(pane_id, subscription):
            try:
                with open_stream(subscription.binding) as stream:
                    delay = RETRY_INITIAL
                    for event in iter_events(stream, subscription.stop):
                        kind = event.get("type")
                        if kind == "server.heartbeat":
                            continue
                        if kind in IMMEDIATE_EVENTS:
                            self._notify(
                                pane_id, subscription, immediate=True,
                            )
                        elif kind in COALESCED_EVENTS:
                            self._notify(
                                pane_id, subscription, immediate=False,
                            )
            except Exception as error:
                self.host._diagnostic(
                    "OPENCODE_EVENT", getattr(error, "code", type(error).__name__),
                )
            if not self.host.running or not self._current(pane_id, subscription):
                return
            subscription.stop.wait(delay)
            delay = min(delay * 2, RETRY_MAX)
