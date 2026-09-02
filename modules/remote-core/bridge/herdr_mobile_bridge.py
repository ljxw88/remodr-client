#!/usr/bin/env python3
"""Herdr mobile bridge.

stdin/stdout use Remote Workspace protocol 1 as NDJSON.
stderr is reserved for diagnostics. The Herdr socket never leaves the server.
"""

from __future__ import annotations

import hashlib
import json
import os
import queue
import shutil
import socket
import sqlite3
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any

BRIDGE_VERSION = "0.1.0"
PROTOCOL = 1
HERDR_PROTOCOL = 20
SUPPORTED_PROVIDERS = ("copilot", "claude", "codex", "opencode")
SUBSCRIPTION_RETRY_INITIAL = 0.25
SUBSCRIPTION_RETRY_MAX = 2.0
SUBSCRIPTIONS = (
    "workspace.created",
    "workspace.updated",
    "workspace.metadata_updated",
    "workspace.renamed",
    "workspace.moved",
    "workspace.reordered",
    "workspace.closed",
    "workspace.focused",
    "tab.created",
    "tab.closed",
    "tab.focused",
    "tab.renamed",
    "tab.moved",
    "pane.created",
    "pane.closed",
    "pane.updated",
    "pane.focused",
    "pane.moved",
    "pane.exited",
    "pane.agent_detected",
    "layout.updated",
)


class BridgeError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class Bridge:
    def __init__(self) -> None:
        self.herdr_socket = os.path.expanduser(
            os.environ.get("HERDR_SOCKET", "~/.config/herdr/herdr.sock")
        )
        self.session_name = os.environ.get("HERDR_SESSION", "default")
        self.output_lock = threading.Lock()
        self.state_lock = threading.Lock()
        self.buffered_events: queue.Queue[dict[str, Any]] = queue.Queue()
        self.pane_subscriptions: set[str] = set()
        self.pane_subscription_lock = threading.Lock()
        self.subscribed = threading.Event()
        self.live = threading.Event()
        self.running = True
        self.runtime: dict[str, Any] = {
            "connectionState": "starting_bridge",
            "workspaces": [],
            "agents": [],
        }
        self.raw_agents: dict[str, dict[str, Any]] = {}
        self.pending_human_requests: dict[str, dict[str, Any]] = {}
        self.conversation_cache: dict[
            str, tuple[tuple[int, int, int, int], dict[str, Any]]
        ] = {}

    def run(self) -> None:
        subscription = threading.Thread(
            target=self._subscription_loop,
            name="herdr-events",
            daemon=True,
        )
        subscription.start()

        if not self.subscribed.wait(timeout=8):
            self._diagnostic("HERDR_EVENT", "subscription did not acknowledge")

        try:
            self._refresh_runtime()
            herdr_version = self.runtime.get("herdrVersion", "unknown")
            self.write(
                {
                    "protocol": PROTOCOL,
                    "type": "hello",
                    "bridgeVersion": BRIDGE_VERSION,
                    "herdrVersion": herdr_version,
                    "herdrProtocol": HERDR_PROTOCOL,
                    "capabilities": self._capabilities(),
                }
            )
            self.write_event("runtime.snapshot", self.runtime)
        except Exception as error:
            self.write(
                {
                    "protocol": PROTOCOL,
                    "type": "hello",
                    "bridgeVersion": BRIDGE_VERSION,
                    "herdrVersion": "unknown",
                    "herdrProtocol": HERDR_PROTOCOL,
                    "capabilities": self._capabilities(),
                    "warning": str(error),
                }
            )
            self.write_event(
                "connection.warning",
                {"code": "HERDR_UNAVAILABLE", "message": "Herdr is unavailable."},
            )

        self.live.set()
        while not self.buffered_events.empty():
            self._handle_herdr_event(self.buffered_events.get_nowait())

        for line in sys.stdin:
            if not self.running:
                break
            self._handle_request_line(line)

        self.running = False

    def _handle_request_line(self, line: str) -> None:
        request_id: str | None = None
        try:
            message = json.loads(line)
            if not isinstance(message, dict):
                raise BridgeError("INVALID_REQUEST", "Request must be an object.")
            request_id = message.get("id")
            if message.get("protocol") != PROTOCOL:
                raise BridgeError("UNSUPPORTED_PROTOCOL", "Unsupported bridge protocol.")
            if message.get("type") != "request" or not isinstance(request_id, str):
                raise BridgeError("INVALID_REQUEST", "Invalid request envelope.")
            action = message.get("action")
            payload = message.get("payload") or {}
            if not isinstance(action, str) or not isinstance(payload, dict):
                raise BridgeError("INVALID_REQUEST", "Invalid action or payload.")
            result = self._dispatch(action, payload)
            self.write(
                {
                    "protocol": PROTOCOL,
                    "id": request_id,
                    "type": "response",
                    "ok": True,
                    "payload": result,
                }
            )
        except BridgeError as error:
            self._write_error(request_id, error.code, str(error))
        except json.JSONDecodeError:
            self._write_error(request_id, "INVALID_JSON", "Request is not valid JSON.")
        except Exception as error:
            self._diagnostic("HERDR_BRIDGE", repr(error))
            self._write_error(request_id, "BRIDGE_ERROR", "The bridge request failed.")

    def _dispatch(self, action: str, payload: dict[str, Any]) -> dict[str, Any]:
        if action == "runtime.snapshot":
            self._refresh_runtime()
            return self.runtime
        if action == "agent.conversation":
            agent = self._require_agent(payload)
            return self._load_conversation(agent)
        if action == "agent.send_message":
            agent = self._require_agent(payload)
            text = payload.get("text")
            if not isinstance(text, str) or not text.strip():
                raise BridgeError("INVALID_MESSAGE", "Message cannot be empty.")
            self._herdr_request(
                "agent.prompt",
                {"target": agent["paneId"], "text": text},
            )
            return {"accepted": True}
        if action == "human_request.answer":
            return self._answer_human_request(payload)
        if action == "agent.interrupt":
            agent = self._require_agent(payload)
            self._herdr_request(
                "agent.send_keys",
                {"target": agent["paneId"], "keys": ["ctrl-c"]},
            )
            return {"accepted": True}
        raise BridgeError("UNKNOWN_ACTION", f"Unsupported action: {action}")

    def _answer_human_request(self, payload: dict[str, Any]) -> dict[str, Any]:
        request_id = payload.get("requestId")
        agent = self._require_agent(payload)
        if not isinstance(request_id, str):
            raise BridgeError("INVALID_REQUEST", "Human request ID is required.")
        request = self.pending_human_requests.get(request_id)
        answer = payload.get("answer") or {}
        if not isinstance(answer, dict):
            raise BridgeError("INVALID_ANSWER", "Answer must be an object.")
        custom_text = answer.get("customText")
        selected_ids = answer.get("selectedOptionIds") or []
        text = custom_text.strip() if isinstance(custom_text, str) else ""
        if not text and request:
            labels = {
                option["id"]: option["label"]
                for option in request.get("options", [])
                if isinstance(option, dict)
            }
            text = ", ".join(
                labels[option_id]
                for option_id in selected_ids
                if option_id in labels
            )
        if not text:
            raise BridgeError("INVALID_ANSWER", "An answer is required.")
        self._herdr_request(
            "agent.prompt",
            {"target": agent["paneId"], "text": text},
        )
        self.pending_human_requests.pop(request_id, None)
        return {"accepted": True}

    def _require_agent(self, payload: dict[str, Any]) -> dict[str, Any]:
        agent_id = payload.get("agentId")
        if not isinstance(agent_id, str):
            raise BridgeError("INVALID_AGENT", "Agent ID is required.")
        with self.state_lock:
            agent = self.raw_agents.get(agent_id)
        if agent is None:
            raise BridgeError("AGENT_NOT_FOUND", "Agent is no longer available.")
        return agent

    def _refresh_runtime(self) -> None:
        result = self._herdr_request("session.snapshot", {})
        snapshot = result.get("snapshot")
        if not isinstance(snapshot, dict):
            raise BridgeError("INVALID_HERDR_RESPONSE", "Herdr snapshot is missing.")
        normalized = self._normalize_snapshot(snapshot)
        with self.state_lock:
            self.runtime = normalized
        self._ensure_pane_subscriptions()

    def _normalize_snapshot(self, snapshot: dict[str, Any]) -> dict[str, Any]:
        workspace_labels = {
            item.get("workspace_id"): item.get("label") or "Workspace"
            for item in snapshot.get("workspaces", [])
            if isinstance(item, dict)
        }
        normalized_agents: list[dict[str, Any]] = []
        raw_agents: dict[str, dict[str, Any]] = {}
        for raw in snapshot.get("agents", []):
            if not isinstance(raw, dict):
                continue
            provider = self._provider(raw.get("agent"))
            session = raw.get("agent_session")
            provider_session_id = (
                session.get("value") if isinstance(session, dict) else None
            )
            identity = "|".join(
                (
                    self.session_name,
                    str(raw.get("pane_id") or ""),
                    provider,
                    str(provider_session_id or raw.get("terminal_id") or ""),
                )
            )
            agent_id = "agent_" + hashlib.sha256(identity.encode()).hexdigest()[:20]
            workspace_id = str(raw.get("workspace_id") or "")
            capabilities = self._agent_capabilities(provider, provider_session_id)
            agent = {
                "id": agent_id,
                "provider": provider,
                "providerSessionId": provider_session_id,
                "herdrSessionId": self.session_name,
                "workspaceId": workspace_id,
                "workspaceName": workspace_labels.get(workspace_id, "Workspace"),
                "tabId": raw.get("tab_id"),
                "paneId": raw.get("pane_id"),
                "cwd": raw.get("foreground_cwd") or raw.get("cwd"),
                "status": self._status(raw.get("agent_status")),
                "title": raw.get("terminal_title_stripped")
                or raw.get("name")
                or self._provider_label(provider),
                "focused": bool(raw.get("focused")),
                "capabilities": capabilities,
            }
            normalized_agents.append(agent)
            raw_agents[agent_id] = {**raw, **agent}

        with self.state_lock:
            self.raw_agents = raw_agents
        return {
            "connectionState": "connected",
            "herdrVersion": snapshot.get("version", "unknown"),
            "herdrProtocol": snapshot.get("protocol"),
            "herdrSession": self.session_name,
            "socketPath": self.herdr_socket,
            "workspaces": [
                {
                    "id": str(item.get("workspace_id") or ""),
                    "name": item.get("label") or "Workspace",
                    "status": self._status(item.get("agent_status")),
                }
                for item in snapshot.get("workspaces", [])
                if isinstance(item, dict)
            ],
            "agents": normalized_agents,
            "lastRuntimeEvent": time.time(),
        }

    def _load_conversation(self, agent: dict[str, Any]) -> dict[str, Any]:
        provider = agent["provider"]
        try:
            if provider == "copilot":
                conversation = self._load_copilot(agent)
            elif provider == "claude":
                conversation = self._load_claude(agent)
            elif provider == "codex":
                conversation = self._load_codex(agent)
            elif provider == "opencode":
                conversation = self._load_opencode(agent)
            else:
                conversation = None
            if conversation and conversation.get("items"):
                return conversation
        except Exception as error:
            self._diagnostic(f"PROVIDER_{provider.upper()}", repr(error))
        return self._load_fallback(agent)

    def _load_copilot(self, agent: dict[str, Any]) -> dict[str, Any] | None:
        session_id = agent.get("providerSessionId")
        if not isinstance(session_id, str):
            return None
        session_dir = Path.home() / ".copilot" / "session-state" / session_id
        events_path = session_dir / "events.jsonl"
        if not events_path.is_file():
            return None
        database = session_dir / "session.db"
        event_stat = events_path.stat()
        database_stat = database.stat() if database.is_file() else None
        cache_version = (
            event_stat.st_size,
            event_stat.st_mtime_ns,
            database_stat.st_size if database_stat else 0,
            database_stat.st_mtime_ns if database_stat else 0,
        )
        cached = self.conversation_cache.get(session_id)
        if cached and cached[0] == cache_version:
            return cached[1]

        records: dict[str, dict[str, Any]] = {}
        order: list[str] = []
        chunks: dict[str, dict[int, str]] = {}
        human_tool_ids: dict[str, str] = {}

        def upsert(item_id: str, item: dict[str, Any]) -> None:
            if item_id not in records:
                order.append(item_id)
                records[item_id] = item
            else:
                records[item_id].update(item)

        with events_path.open("r", encoding="utf-8", errors="replace") as events:
            for line in events:
                try:
                    event = json.loads(line)
                except (json.JSONDecodeError, ValueError):
                    continue
                if not isinstance(event, dict):
                    continue
                event_type = event.get("type")
                data = event.get("data") if isinstance(event.get("data"), dict) else {}
                event_id = str(event.get("id") or uuid.uuid4())
                timestamp = event.get("timestamp")

                if event_type == "user.message":
                    content = data.get("content")
                    if (
                        isinstance(content, str)
                        and content.strip()
                        and not content.lstrip().startswith("<system_notification>")
                    ):
                        upsert(
                            event_id,
                            {
                                "id": event_id,
                                "kind": "user_message",
                                "text": content,
                                "timestamp": timestamp,
                            },
                        )
                elif event_type == "assistant.message":
                    content = data.get("content")
                    if not isinstance(content, str) or not content:
                        continue
                    message_id = str(data.get("messageId") or event_id)
                    chunk_index = data.get("chunkIndex")
                    if isinstance(chunk_index, int):
                        chunks.setdefault(message_id, {})[chunk_index] = content
                        content = "".join(
                            chunks[message_id][index]
                            for index in sorted(chunks[message_id])
                        )
                    upsert(
                        message_id,
                        {
                            "id": message_id,
                            "kind": "assistant_message",
                            "markdown": content,
                            "timestamp": timestamp,
                        },
                    )
                elif event_type == "session.task_complete":
                    summary = data.get("summary")
                    previous = records.get(order[-1]) if order else None
                    if (
                        isinstance(summary, str)
                        and summary.strip()
                        and not (
                            previous
                            and previous.get("kind") == "assistant_message"
                            and previous.get("markdown") == summary
                        )
                    ):
                        upsert(
                            "completion:" + event_id,
                            {
                                "id": "completion:" + event_id,
                                "kind": "assistant_message",
                                "markdown": summary,
                                "timestamp": timestamp,
                            },
                        )
                elif event_type == "tool.execution_start":
                    tool_name = str(data.get("toolName") or "Tool")
                    tool_call_id = str(data.get("toolCallId") or event_id)
                    arguments = data.get("arguments")
                    if tool_name == "task_complete":
                        continue
                    if tool_name in ("ask_user", "AskUserQuestion"):
                        request = self._normalize_copilot_question(
                            tool_call_id,
                            arguments if isinstance(arguments, dict) else {},
                        )
                        if request:
                            self.pending_human_requests[request["id"]] = request
                            human_tool_ids[tool_call_id] = request["id"]
                            upsert(
                                "human:" + request["id"],
                                {
                                    "id": "human:" + request["id"],
                                    "kind": "human_request",
                                    "request": request,
                                    "timestamp": timestamp,
                                },
                            )
                        continue
                    upsert(
                        "tool:" + tool_call_id,
                        {
                            "id": "tool:" + tool_call_id,
                            "kind": "tool_activity",
                            "tool": tool_name,
                            "title": self._tool_title(tool_name),
                            "detail": self._tool_detail(arguments),
                            "state": "running",
                            "timestamp": timestamp,
                        },
                    )
                elif event_type == "tool.execution_complete":
                    tool_call_id = str(data.get("toolCallId") or event_id)
                    if tool_call_id in human_tool_ids:
                        request_id = human_tool_ids[tool_call_id]
                        self.pending_human_requests.pop(request_id, None)
                        current = records.get("human:" + request_id)
                        if current:
                            current["resolved"] = True
                        continue
                    existing = records.get("tool:" + tool_call_id)
                    if existing:
                        existing["state"] = (
                            "completed" if data.get("success") is True else "failed"
                        )

        items = [records[item_id] for item_id in order][-200:]
        todo_item = self._copilot_todos(session_dir)
        if todo_item:
            items.append(todo_item)
        conversation = {
            "agentId": agent["id"],
            "provider": "copilot",
            "semantic": True,
            "items": items,
            "activeHumanRequest": next(
                (
                    item["request"]
                    for item in reversed(items)
                    if item.get("kind") == "human_request"
                    and not item.get("resolved")
                ),
                None,
            ),
        }
        self.conversation_cache[session_id] = (cache_version, conversation)
        return conversation

    def _normalize_copilot_question(
        self, request_id: str, arguments: dict[str, Any]
    ) -> dict[str, Any] | None:
        message = arguments.get("message")
        schema = arguments.get("requestedSchema")
        properties = (
            schema.get("properties")
            if isinstance(schema, dict) and isinstance(schema.get("properties"), dict)
            else {}
        )
        if not properties:
            if isinstance(message, str):
                return {
                    "id": request_id,
                    "kind": "text",
                    "question": message,
                    "allowCustomAnswer": True,
                    "multiSelect": False,
                    "options": [],
                }
            return None
        field_name, field = next(iter(properties.items()))
        if not isinstance(field, dict):
            return None
        question = (
            field.get("title")
            or field.get("description")
            or message
            or str(field_name)
        )
        options: list[dict[str, str]] = []
        values = field.get("enum")
        if isinstance(values, list):
            names = field.get("enumNames")
            for index, value in enumerate(values):
                label = (
                    names[index]
                    if isinstance(names, list) and index < len(names)
                    else str(value)
                )
                options.append({"id": str(value), "label": str(label)})
        choices = field.get("oneOf")
        if isinstance(choices, list):
            for choice in choices:
                if isinstance(choice, dict) and "const" in choice:
                    options.append(
                        {
                            "id": str(choice["const"]),
                            "label": str(choice.get("title") or choice["const"]),
                        }
                    )
        field_type = field.get("type")
        kind = "choice" if options else "confirmation" if field_type == "boolean" else "text"
        return {
            "id": request_id,
            "kind": kind,
            "question": str(question),
            "options": options,
            "allowCustomAnswer": True,
            "multiSelect": field_type == "array",
        }

    def _copilot_todos(self, session_dir: Path) -> dict[str, Any] | None:
        database = session_dir / "session.db"
        if not database.is_file():
            return None
        try:
            connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
            rows = connection.execute(
                "select id, title, status from todos order by created_at"
            ).fetchall()
            connection.close()
            if not rows:
                return None
            if all(row[2] == "done" for row in rows):
                return None
            return {
                "id": "todos",
                "kind": "todo_update",
                "todos": [
                    {"id": row[0], "text": row[1], "state": row[2]}
                    for row in rows
                ],
            }
        except (sqlite3.Error, OSError):
            return None

    def _load_claude(self, agent: dict[str, Any]) -> dict[str, Any] | None:
        session_id = agent.get("providerSessionId")
        if not isinstance(session_id, str):
            return None
        candidates = list((Path.home() / ".claude" / "projects").glob("**/*.jsonl"))
        path = next((item for item in candidates if session_id in item.name), None)
        return self._load_role_jsonl(agent, path, "claude") if path else None

    def _load_codex(self, agent: dict[str, Any]) -> dict[str, Any] | None:
        session_id = agent.get("providerSessionId")
        if not isinstance(session_id, str):
            return None
        candidates = list((Path.home() / ".codex" / "sessions").glob("**/*.jsonl"))
        path = next((item for item in candidates if session_id in item.name), None)
        return self._load_role_jsonl(agent, path, "codex") if path else None

    def _load_opencode(self, agent: dict[str, Any]) -> dict[str, Any] | None:
        return None

    def _load_role_jsonl(
        self, agent: dict[str, Any], path: Path, provider: str
    ) -> dict[str, Any] | None:
        items: list[dict[str, Any]] = []
        with path.open("r", encoding="utf-8", errors="replace") as transcript:
            for line in transcript:
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(event, dict):
                    continue
                role = event.get("role") or event.get("type")
                message = event.get("message") or event.get("content")
                if isinstance(message, dict):
                    role = message.get("role") or role
                    message = message.get("content")
                text = self._content_text(message)
                if not text:
                    continue
                event_id = str(event.get("id") or uuid.uuid4())
                if role in ("user", "user_message"):
                    items.append(
                        {"id": event_id, "kind": "user_message", "text": text}
                    )
                elif role in ("assistant", "assistant_message"):
                    items.append(
                        {
                            "id": event_id,
                            "kind": "assistant_message",
                            "markdown": text,
                        }
                    )
        if not items:
            return None
        return {
            "agentId": agent["id"],
            "provider": provider,
            "semantic": True,
            "items": items,
            "activeHumanRequest": None,
        }

    def _load_fallback(self, agent: dict[str, Any]) -> dict[str, Any]:
        result = self._herdr_request(
            "agent.read",
            {
                "target": agent["paneId"],
                "source": "recent_unwrapped",
                "format": "text",
                "strip_ansi": True,
                "lines": 240,
            },
        )
        read = result.get("read") if isinstance(result, dict) else None
        text = read.get("text") if isinstance(read, dict) else ""
        return {
            "agentId": agent["id"],
            "provider": agent["provider"],
            "semantic": False,
            "items": [
                {
                    "id": f"raw:{agent['paneId']}:{read.get('revision', 0) if isinstance(read, dict) else 0}",
                    "kind": "raw_output",
                    "text": text or "No agent output is available.",
                }
            ],
            "activeHumanRequest": None,
        }

    def _subscription_loop(self) -> None:
        retry_delay = SUBSCRIPTION_RETRY_INITIAL
        while self.running:
            resynchronize = self.subscribed.is_set()
            try:
                self._read_global_subscription(resynchronize)
            except Exception as error:
                self._diagnostic("HERDR_EVENT", repr(error))
            finally:
                self.subscribed.set()
            if not self.running:
                return
            if self.live.is_set():
                self.write_event(
                    "connection.warning",
                    {
                        "code": "EVENT_STREAM_CLOSED",
                        "message": "Herdr events are reconnecting.",
                    },
                )
            self._wait_for_subscription_retry(retry_delay)
            retry_delay = min(retry_delay * 2, SUBSCRIPTION_RETRY_MAX)

    def _read_global_subscription(self, resynchronize: bool = False) -> None:
        with socket.socket(socket.AF_UNIX) as connection:
            connection.connect(self.herdr_socket)
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
            self.subscribed.set()
            if resynchronize:
                self._refresh_runtime()
                self.write_event("runtime.snapshot", self.runtime)
            while self.running:
                line = stream.readline()
                if not line:
                    return
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not self.live.is_set():
                    self.buffered_events.put(event)
                else:
                    self._handle_herdr_event(event)

    def _ensure_pane_subscriptions(self) -> None:
        with self.state_lock:
            pane_ids = {
                str(agent.get("paneId"))
                for agent in self.raw_agents.values()
                if agent.get("paneId")
            }
        for pane_id in pane_ids:
            with self.pane_subscription_lock:
                if pane_id in self.pane_subscriptions:
                    continue
                self.pane_subscriptions.add(pane_id)
            threading.Thread(
                target=self._pane_subscription_loop,
                args=(pane_id,),
                name=f"herdr-status-{pane_id}",
                daemon=True,
            ).start()

    def _pane_subscription_loop(self, pane_id: str) -> None:
        retry_delay = SUBSCRIPTION_RETRY_INITIAL
        try:
            while self.running and self._pane_is_active(pane_id):
                try:
                    self._read_pane_subscription(pane_id)
                except Exception as error:
                    self._diagnostic("HERDR_EVENT", f"{pane_id}: {error!r}")
                if not self.running or not self._pane_is_active(pane_id):
                    return
                self._wait_for_subscription_retry(retry_delay)
                retry_delay = min(retry_delay * 2, SUBSCRIPTION_RETRY_MAX)
        finally:
            with self.pane_subscription_lock:
                self.pane_subscriptions.discard(pane_id)

    def _read_pane_subscription(self, pane_id: str) -> None:
        with socket.socket(socket.AF_UNIX) as connection:
            connection.connect(self.herdr_socket)
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
            while self.running and self._pane_is_active(pane_id):
                line = stream.readline()
                if not line:
                    return
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not self.live.is_set():
                    self.buffered_events.put(event)
                else:
                    self._handle_herdr_event(event)

    def _pane_is_active(self, pane_id: str) -> bool:
        with self.state_lock:
            return any(
                agent.get("paneId") == pane_id for agent in self.raw_agents.values()
            )

    def _wait_for_subscription_retry(self, delay: float) -> None:
        deadline = time.monotonic() + delay
        while self.running:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return
            time.sleep(min(0.1, remaining))

    def _handle_herdr_event(self, event: dict[str, Any]) -> None:
        try:
            self._refresh_runtime()
            self.write_event("runtime.snapshot", self.runtime)
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
                        for item in self.raw_agents.values()
                        if item.get("paneId") == pane_id
                    ),
                    None,
                )
                if agent:
                    self.write_event(
                        "conversation.changed", {"agentId": agent["id"]}
                    )
        except Exception as error:
            self._diagnostic("HERDR_EVENT", repr(error))

    def _herdr_request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        request_id = "mobile-" + uuid.uuid4().hex
        with socket.socket(socket.AF_UNIX) as connection:
            connection.settimeout(12)
            connection.connect(self.herdr_socket)
            connection.sendall(
                (
                    json.dumps(
                        {"id": request_id, "method": method, "params": params},
                        separators=(",", ":"),
                    )
                    + "\n"
                ).encode()
            )
            stream = connection.makefile("r", encoding="utf-8")
            line = stream.readline()
        if not line:
            raise BridgeError("HERDR_DISCONNECTED", "Herdr closed the connection.")
        response = json.loads(line)
        if "error" in response:
            error = response["error"]
            raise BridgeError(
                str(error.get("code") or "HERDR_ERROR"),
                str(error.get("message") or "Herdr request failed."),
            )
        result = response.get("result")
        if not isinstance(result, dict):
            raise BridgeError("INVALID_HERDR_RESPONSE", "Herdr result is invalid.")
        return result

    def _capabilities(self) -> dict[str, Any]:
        provider_capabilities = {}
        for provider in SUPPORTED_PROVIDERS:
            executable = shutil.which(provider)
            provider_capabilities[provider] = {
                "installed": executable is not None,
                "structuredConversation": provider in ("copilot", "claude", "codex"),
                "streamingConversation": provider == "copilot",
                "structuredQuestions": provider == "copilot",
                "permissions": False,
                "todos": provider == "copilot",
                "fallback": True,
            }
        return {
            "providers": list(SUPPORTED_PROVIDERS),
            "providerCapabilities": provider_capabilities,
            "humanRequests": True,
            "toolActivity": True,
            "todos": True,
            "editAndResend": True,
        }

    def _agent_capabilities(
        self, provider: str, provider_session_id: Any
    ) -> dict[str, bool]:
        semantic = False
        if provider == "copilot" and isinstance(provider_session_id, str):
            semantic = (
                Path.home()
                / ".copilot"
                / "session-state"
                / provider_session_id
                / "events.jsonl"
            ).is_file()
        return {
            "structuredConversation": semantic,
            "streamingConversation": semantic and provider == "copilot",
            "structuredQuestions": semantic and provider == "copilot",
            "toolActivity": semantic and provider == "copilot",
            "todos": semantic and provider == "copilot",
            "fallback": True,
        }

    @staticmethod
    def _provider(value: Any) -> str:
        normalized = str(value or "").lower().replace("-", "").replace("_", "")
        if "copilot" in normalized:
            return "copilot"
        if "claude" in normalized:
            return "claude"
        if "codex" in normalized:
            return "codex"
        if "opencode" in normalized:
            return "opencode"
        return "unknown"

    @staticmethod
    def _provider_label(provider: str) -> str:
        return {
            "copilot": "GitHub Copilot",
            "claude": "Claude Code",
            "codex": "Codex",
            "opencode": "OpenCode",
        }.get(provider, "Agent")

    @staticmethod
    def _status(value: Any) -> str:
        status = str(value or "unknown").lower()
        return status if status in ("idle", "working", "blocked", "done") else "unknown"

    @staticmethod
    def _content_text(value: Any) -> str:
        if isinstance(value, str):
            return value
        if isinstance(value, list):
            parts = []
            for item in value:
                if isinstance(item, str):
                    parts.append(item)
                elif isinstance(item, dict) and isinstance(item.get("text"), str):
                    parts.append(item["text"])
            return "\n".join(parts)
        return ""

    @staticmethod
    def _tool_title(tool: str) -> str:
        return {
            "view": "Reading",
            "read": "Reading",
            "apply_patch": "Editing",
            "edit": "Editing",
            "create": "Creating",
            "bash": "Running",
            "rg": "Searching",
            "grep": "Searching",
            "glob": "Finding files",
            "task": "Delegating",
            "sql": "SQL",
            "task_complete": "Task complete",
        }.get(tool, tool.replace("_", " ").title())

    @staticmethod
    def _tool_detail(arguments: Any) -> str | None:
        if not isinstance(arguments, dict):
            return None
        for key in ("path", "file_path", "query", "pattern", "description", "command"):
            value = arguments.get(key)
            if isinstance(value, str) and value:
                return value[:240]
        return None

    def write_event(self, event: str, data: dict[str, Any]) -> None:
        self.write(
            {
                "protocol": PROTOCOL,
                "type": "event",
                "event": event,
                "data": data,
            }
        )

    def _write_error(self, request_id: str | None, code: str, message: str) -> None:
        self.write(
            {
                "protocol": PROTOCOL,
                "id": request_id,
                "type": "response",
                "ok": False,
                "error": {"code": code, "message": message},
            }
        )

    def write(self, message: dict[str, Any]) -> None:
        encoded = json.dumps(message, separators=(",", ":"), ensure_ascii=False)
        with self.output_lock:
            sys.stdout.write(encoded + "\n")
            sys.stdout.flush()

    @staticmethod
    def _diagnostic(tag: str, message: str) -> None:
        print(f"[{tag}] {message}", file=sys.stderr, flush=True)


if __name__ == "__main__":
    Bridge().run()
