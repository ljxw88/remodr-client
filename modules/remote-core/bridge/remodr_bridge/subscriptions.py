"""Reconnectable global/pane event streams and cheap conversation hints."""
from __future__ import annotations

import json
import socket
import threading
import time
import uuid
from typing import Any, TYPE_CHECKING
from .constants import SUBSCRIPTIONS, SUBSCRIPTION_RETRY_INITIAL, SUBSCRIPTION_RETRY_MAX
from .errors import BridgeError

if TYPE_CHECKING:
    from .bridge import Bridge

def subscription_loop(host: Bridge) -> None:
    retry_delay = SUBSCRIPTION_RETRY_INITIAL
    while host.running:
        resynchronize = host.subscribed.is_set()
        try:
            host._read_global_subscription(resynchronize)
        except Exception as error:
            host._diagnostic("HERDR_EVENT", repr(error))
        finally:
            host.subscribed.set()
        if not host.running:
            return
        if host.live.is_set():
            host.write_event(
                "connection.warning",
                {
                    "code": "EVENT_STREAM_CLOSED",
                    "message": "Herdr events are reconnecting.",
                },
            )
        host._wait_for_subscription_retry(retry_delay)
        retry_delay = min(retry_delay * 2, SUBSCRIPTION_RETRY_MAX)


def read_global_subscription(host: Bridge, resynchronize: bool = False) -> None:
    with socket.socket(socket.AF_UNIX) as connection:
        connection.connect(host.herdr_socket)
        request = {
            "id": "mobile-subscription",
            "method": "events.subscribe",
            "params": {
                "subscriptions": [{"type": item} for item in SUBSCRIPTIONS]
            },
        }
        connection.sendall((json.dumps(request) + "\n").encode())
        stream = connection.makefile("r", encoding="utf-8")
        acknowledgement = json.loads(stream.readline())
        if acknowledgement.get("error"):
            raise BridgeError(
                "SUBSCRIPTION_FAILED",
                str(acknowledgement["error"].get("message", "Unknown error")),
            )
        host.subscribed.set()
        if resynchronize:
            with host.refresh_lock:
                host._refresh_runtime()
                host.write_event("runtime.snapshot", host.runtime)
        while host.running:
            line = stream.readline()
            if not line:
                return
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not host.live.is_set():
                host.buffered_events.put(event)
            else:
                host._handle_herdr_event(event)


def ensure_pane_subscriptions(host: Bridge) -> None:
    with host.state_lock:
        pane_ids = {
            str(agent.get("paneId"))
            for agent in host.raw_agents.values()
            if agent.get("paneId")
        }
    for pane_id in pane_ids:
        with host.pane_subscription_lock:
            if pane_id in host.pane_subscriptions:
                continue
            host.pane_subscriptions.add(pane_id)
        threading.Thread(
            target=host._pane_subscription_loop,
            args=(pane_id,),
            name=f"herdr-status-{pane_id}",
            daemon=True,
        ).start()


def pane_subscription_loop(host: Bridge, pane_id: str) -> None:
    retry_delay = SUBSCRIPTION_RETRY_INITIAL
    try:
        while host.running and host._pane_is_active(pane_id):
            try:
                host._read_pane_subscription(pane_id)
            except Exception as error:
                host._diagnostic("HERDR_EVENT", f"{pane_id}: {error!r}")
            if not host.running or not host._pane_is_active(pane_id):
                return
            host._wait_for_subscription_retry(retry_delay)
            retry_delay = min(retry_delay * 2, SUBSCRIPTION_RETRY_MAX)
    finally:
        with host.pane_subscription_lock:
            host.pane_subscriptions.discard(pane_id)


def read_pane_subscription(host: Bridge, pane_id: str) -> None:
    with socket.socket(socket.AF_UNIX) as connection:
        connection.connect(host.herdr_socket)
        request = {
            "id": "mobile-status-" + uuid.uuid4().hex,
            "method": "events.subscribe",
            "params": {
                "subscriptions": [
                    {
                        "type": "pane.agent_status_changed",
                        "pane_id": pane_id,
                    }
                ]
            },
        }
        connection.sendall((json.dumps(request) + "\n").encode())
        stream = connection.makefile("r", encoding="utf-8")
        acknowledgement = json.loads(stream.readline())
        if acknowledgement.get("error"):
            raise BridgeError(
                "SUBSCRIPTION_FAILED",
                str(acknowledgement["error"].get("message", "Unknown error")),
            )
        while host.running and host._pane_is_active(pane_id):
            line = stream.readline()
            if not line:
                return
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not host.live.is_set():
                host.buffered_events.put(event)
            else:
                host._handle_herdr_event(event)


def pane_is_active(host: Bridge, pane_id: str) -> bool:
    with host.state_lock:
        return any(
            agent.get("paneId") == pane_id for agent in host.raw_agents.values()
        )


def wait_for_subscription_retry(host: Bridge, delay: float) -> None:
    deadline = time.monotonic() + delay
    while host.running:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return
        time.sleep(min(0.1, remaining))


def handle_herdr_event(host: Bridge, event: dict[str, Any]) -> None:
    with host.refresh_lock:
        host._handle_locked_herdr_event(event)


def handle_locked_herdr_event(host: Bridge, event: dict[str, Any]) -> None:
    try:
        host._refresh_runtime(inspect_copilot=False)
        host.write_event("runtime.snapshot", host.runtime)
        data = event.get("data")
        if isinstance(data, dict) and data.get("type") in (
            "pane_output_changed",
            "pane_agent_status_changed",
            "pane_agent_detected",
        ):
            pane_id = data.get("pane_id")
            agent = next(
                (
                    item
                    for item in host.raw_agents.values()
                    if item.get("paneId") == pane_id
                ),
                None,
            )
            if agent:
                host.write_event(
                    "conversation.changed", {"agentId": agent["id"]}
                )
    except Exception as error:
        host._diagnostic("HERDR_EVENT", repr(error))
