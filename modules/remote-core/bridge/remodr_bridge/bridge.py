"""Protocol-one orchestration; provider behavior is selected through the registry."""
from __future__ import annotations

import json
import os
import queue
import sys
import threading
from typing import Any
from . import commands, conversation, formatting, lifecycle, questions, runtime, subscriptions, transport
from .constants import BRIDGE_VERSION, PROTOCOL, ORDERED_TUNING
from .errors import BridgeError
from .activity import OutputActivity
from .ledger import CommandLedger
from .session_registry import SessionKey, SessionRegistry
from .providers.base import ProviderAdapter
from .providers import SUPPORTED_PROVIDERS, create_registry, provider_type, normalize_provider, provider_label

class Bridge:
    def __init__(self) -> None:
        self.herdr_socket = os.path.expanduser(
            os.environ.get("HERDR_SOCKET", "~/.config/herdr/herdr.sock")
        )
        self.session_name = os.environ.get("HERDR_SESSION", "default")
        self.device_id = os.environ.get("REMOTE_WORKSPACE_DEVICE_ID", "device")
        # How long the agent's question dialog is given to redraw between
        # keystroke batches. An attribute so tests can drive it at zero.
        self.dialog_settle_seconds = 0.25
        self.sessions = SessionRegistry()
        self.output_lock = threading.Lock()
        self.state_lock = threading.Lock()
        self.refresh_lock = threading.RLock()
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
            "providers": [],
        }
        self.runtime_revision = 0
        self.agent_catalog: list[dict[str, Any]] | None = None
        self.raw_agents: dict[str, dict[str, Any]] = {}
        self.pending_agents: dict[str, dict[str, Any]] = {}
        self.command_context = threading.local()
        self.command_store_error: BridgeError | None = None
        self.providers = create_registry(self)
        self.output_activity = OutputActivity(self)

    def provider_adapter(self, provider: str) -> ProviderAdapter:
        return self.providers.get(provider, self.providers["unknown"])

    def run(self) -> None:
        capabilities = self._capabilities()
        if self.command_store_error is not None:
            error = self.command_store_error
            self.write(
                {
                    "protocol": PROTOCOL,
                    "type": "hello",
                    "bridgeVersion": BRIDGE_VERSION,
                    "herdrVersion": "unknown",
                    "herdrProtocol": None,
                    "runtimeReady": False,
                    "capabilities": capabilities,
                    "fatal": True,
                    "error": {"code": error.code, "message": str(error)},
                }
            )
            self.running = False
            return
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
            capabilities = self._capabilities(check_store=False)
            herdr_version = self.runtime.get("herdrVersion", "unknown")
            self.write(
                {
                    "protocol": PROTOCOL,
                    "type": "hello",
                    "bridgeVersion": BRIDGE_VERSION,
                    "herdrVersion": herdr_version,
                    "herdrProtocol": self.runtime.get("herdrProtocol"),
                    "runtimeReady": True,
                    "capabilities": capabilities,
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
                    "herdrProtocol": None,
                    "runtimeReady": False,
                    "capabilities": capabilities,
                    "warning": str(error),
                    "error": {"code": "HERDR_UNAVAILABLE", "message": "Herdr is unavailable."},
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
            if "commandId" in message:
                response = self._durable_command(message["commandId"], action, payload)
                self.write({**response, "id": request_id})
                return
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
        if action == "bridge.ping":
            return {"alive": True}
        if action == "command.status":
            command_id = self._command_id(payload.get("commandId"))
            record = self._command_ledger().status(command_id)
            result: dict[str, Any] = {
                "commandId": command_id,
                "state": "unknown" if record is None else (
                    "in_progress" if record["state"] == "reserved" else record["state"]
                ),
            }
            if record and record["response"]:
                result["response"] = self._stored_response(record)
            return result
        if action == "runtime.snapshot":
            if payload.get("includeActivity") is True:
                self._refresh_runtime(include_activity=True)
            else:
                self._refresh_runtime()
            return self.runtime
        if action == "agent.conversation":
            with self.refresh_lock:
                self._refresh_runtime_and_publish()
                agent = self._require_agent(payload)
                return self._load_conversation(agent)
        if action == "agent.send_message":
            agent = self._require_agent(payload)
            text = payload.get("text")
            if not isinstance(text, str) or not text.strip():
                raise BridgeError("INVALID_MESSAGE", "Message cannot be empty.")
            self._herdr_mutation(
                "agent.prompt",
                {"target": agent["paneId"], "text": text},
            )
            return {"accepted": True}
        if action == "agent.create":
            return self._create_agent(payload)
        if action == "agent.rename":
            return self._rename_agent(payload)
        if action == "agent.close":
            return self._close_agent(payload)
        if action == "agent.retune":
            return self._retune_agent(payload)
        if action == "workspace.create":
            return self._create_workspace(payload)
        if action == "workspace.close":
            return self._close_workspace(payload)
        if action == "human_request.answer":
            return self._answer_human_request(payload)
        if action == "agent.interrupt":
            agent = self._require_agent(payload)
            self._herdr_mutation(
                "agent.send_keys",
                {
                    "target": agent["paneId"],
                    "keys": list(self.provider_adapter(agent["provider"]).spec.interrupt_keys),
                },
            )
            return {"accepted": True}
        raise BridgeError("UNKNOWN_ACTION", f"Unsupported action: {action}")

    def _remember_human_request(
        self, request: dict[str, Any], agent: dict[str, Any]
    ) -> None:
        self.sessions.remember_question(SessionKey.from_agent(agent), request)

    def _require_agent(self, payload: dict[str, Any]) -> dict[str, Any]:
        agent_id = payload.get("agentId")
        if not isinstance(agent_id, str):
            raise BridgeError("INVALID_AGENT", "Agent ID is required.")
        with self.state_lock:
            agent = self.raw_agents.get(agent_id)
        if agent is None:
            raise BridgeError("AGENT_NOT_FOUND", "Agent is no longer available.")
        bound = getattr(self.command_context, "agent", None)
        if bound is not None:
            fields = ("id", "provider", "providerSessionId", "paneId")
            if any(bound.get(field) != agent.get(field) for field in fields):
                raise BridgeError(
                    "COMMAND_PRECONDITION_FAILED", "The command target has changed."
                )
            return bound
        return agent

    def _refresh_runtime(self, *, inspect_copilot: bool = True, include_activity: bool = False) -> None:
        with self.refresh_lock:
            result = self._herdr_request("session.snapshot", {})
            snapshot = result.get("snapshot")
            if not isinstance(snapshot, dict):
                raise BridgeError(
                    "INVALID_HERDR_RESPONSE", "Herdr snapshot is missing."
                )
            self._agent_catalog_snapshot()
            normalized = self._normalize_snapshot(
                snapshot, inspect_copilot=inspect_copilot, include_activity=include_activity,
            )
            self.runtime_revision += 1
            normalized["runtimeRevision"] = self.runtime_revision
            with self.state_lock:
                self.runtime = normalized
            self._ensure_pane_subscriptions()

    def _refresh_runtime_and_publish(self) -> None:
        with self.refresh_lock:
            before = {
                key: value for key, value in self.runtime.items()
                if key not in ("lastRuntimeEvent", "runtimeRevision")
            }
            self._refresh_runtime()
            after = {
                key: value for key, value in self.runtime.items()
                if key not in ("lastRuntimeEvent", "runtimeRevision")
            }
            if before != after:
                self.write_event("runtime.snapshot", self.runtime)

    def _invalidate_agent_session(
        self, agent_id: str, pane_id: str, session_id: Any
    ) -> None:
        self.output_activity.invalidate(agent_id)
        self.sessions.invalidate(agent_id, pane_id, session_id)

    @staticmethod
    def _new_session_arguments(
        provider: Any, label: str, args: list[str]
    ) -> str | None:
        return provider_type(str(provider)).new_session_arguments(label, args)

    @staticmethod
    def _tuning_arguments(provider: Any, payload: dict[str, Any]) -> list[str]:
        return provider_type(str(provider)).tuning_arguments(payload)

    @staticmethod
    def _tuning_of(payload: dict[str, Any]) -> dict[str, Any]:
        """The three settings, normalised, with absent meaning "let the CLI pick"."""
        return {
            key: (
                payload.get(key).strip()
                if isinstance(payload.get(key), str) and payload.get(key).strip()
                else None
            )
            for key in ORDERED_TUNING
        }

    def _retune_agent(self, payload: dict[str, Any]) -> dict[str, Any]:
        with self.refresh_lock:
            self._refresh_runtime_and_publish()
            return self._retune_current_agent(payload)

    def _retune_current_agent(self, payload: dict[str, Any]) -> dict[str, Any]:
        agent = self._require_agent(payload)
        if self.sessions.identity_error(agent.get("paneId")) is not None:
            raise BridgeError(
                "SESSION_IDENTITY_UNRESOLVED", "The active provider session cannot be verified."
            )
        return self.provider_adapter(agent.get("provider")).retune(payload)

    def _reported_tuning(
        self, pane_id: str, provider_session_id: Any, provider: str
    ) -> dict[str, Any]:
        """What the agent is actually running, as far as we can tell.

        What this app last set wins field by field, because that is what the
        agent will use next: the log can be a moment behind a change made from
        here.

        For Copilot, everything not set from here comes from its session log.
        Other providers' session formats are not read for tuning, so settings
        not remembered from creation remain unknown.
        """
        ours = self.sessions.tuning(pane_id)
        logged = self.provider_adapter(provider).session_tuning(provider_session_id)
        return {key: ours.get(key) or logged.get(key) for key in ORDERED_TUNING}

    def _load_conversation(self, agent: dict[str, Any]) -> dict[str, Any]:
        with self.refresh_lock:
            current = self.raw_agents.get(agent["id"])
            if current is not None and any(
                current.get(field) != agent.get(field)
                for field in ("provider", "providerSessionId", "paneId")
            ):
                raise BridgeError(
                    "COMMAND_PRECONDITION_FAILED", "The target session has changed."
                )
            return self._load_bound_conversation(agent)

    def _load_bound_conversation(self, agent: dict[str, Any]) -> dict[str, Any]:
        provider = agent["provider"]
        adapter = self.provider_adapter(provider)
        identity_error = self.sessions.identity_error(agent.get("paneId"))
        if identity_error is not None:
            reason = adapter.identity_error(identity_error)
            raise BridgeError("SESSION_IDENTITY_UNRESOLVED", reason)
        try:
            conversation = adapter.load_conversation(agent)
            if conversation is not None:
                return conversation
        except Exception as error:
            self._diagnostic(f"PROVIDER_{provider.upper()}", repr(error))
            raise BridgeError(
                "CONVERSATION_UNAVAILABLE", "The current session transcript could not be read."
            ) from error
        return self._load_fallback(agent)

    def _capabilities(self, *, check_store: bool = True) -> dict[str, Any]:
        if check_store:
            try:
                self._command_ledger().check_available()
                self.command_store_error = None
            except BridgeError as error:
                self.command_store_error = error
        availability = {
            item.get("provider"): item.get("available") is True
            for item in self.agent_catalog or []
        }
        provider_capabilities = {}
        for provider in SUPPORTED_PROVIDERS:
            provider_capabilities[provider] = self.providers[provider].provider_capabilities(
                availability.get(provider, False)
            )
        return {
            "durableCommands": self.command_store_error is None,
            "durableCommandsRequireSessionIdentity": True,
            "durableInterruptReplay": False,
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
        return self.provider_adapter(provider).agent_capabilities(provider_session_id)

    @staticmethod
    def _provider(value: Any) -> str:
        return normalize_provider(value)

    @staticmethod
    def _provider_label(provider: str) -> str:
        return provider_label(provider)

    @staticmethod
    def _status(value: Any) -> str:
        return formatting.status(value)

    @staticmethod
    def _content_text(value: Any) -> str:
        return formatting.content_text(value)

    @staticmethod
    def _tool_title(tool: str) -> str:
        return formatting.tool_title(tool)

    @staticmethod
    def _tool_detail(arguments: Any) -> str | None:
        return formatting.tool_detail(arguments)

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

    @staticmethod
    def _command_id(value: Any) -> str:
        return commands.command_id(value)

    def _command_ledger(self) -> CommandLedger:
        return commands.command_ledger(self)

    @staticmethod
    def _command_error(code: str, message: str) -> dict[str, Any]:
        return commands.command_error(code, message)

    @staticmethod
    def _stored_response(record: dict[str, Any]) -> dict[str, Any]:
        return commands.stored_response(record)

    def _durable_command(
        self, value: Any, action: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        return commands.durable_command(self, value, action, payload)

    def _prepare_command(self, action: str, payload: dict[str, Any]) -> None:
        return commands.prepare_command(self, action, payload)

    def _herdr_mutation(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        return commands.herdr_mutation(self, method, params)

    def _create_workspace(self, payload: dict[str, Any]) -> dict[str, Any]:
        return lifecycle.create_workspace(self, payload)

    def _install_created_workspace(
        self,
        workspace_id: str,
        label: str | None,
        cwd: str,
    ) -> None:
        return lifecycle.install_created_workspace(self, workspace_id, label, cwd)

    def _close_workspace(self, payload: dict[str, Any]) -> dict[str, Any]:
        return lifecycle.close_workspace(self, payload)

    def _remove_workspace_from_runtime(self, workspace_id: str) -> None:
        return lifecycle.remove_workspace_from_runtime(self, workspace_id)

    def _create_agent(self, payload: dict[str, Any]) -> dict[str, Any]:
        return lifecycle.create_agent(self, payload)

    def _rename_agent(self, payload: dict[str, Any]) -> dict[str, Any]:
        return lifecycle.rename_agent(self, payload)

    def _close_agent(self, payload: dict[str, Any]) -> dict[str, Any]:
        return lifecycle.close_agent(self, payload)

    def _remove_agent_from_runtime(self, agent_id: str) -> None:
        return lifecycle.remove_agent_from_runtime(self, agent_id)

    def _install_pending_agent(
        self,
        agent_id: str,
        name: str,
        provider: str,
        workspace_id: str,
        pane_id: str,
    ) -> None:
        return lifecycle.install_pending_agent(self, agent_id, name, provider, workspace_id, pane_id)

    def _stable_agent_id(self, pane_id: str) -> str:
        return lifecycle.stable_agent_id(self, pane_id)

    def _start_agent(
        self,
        name: str,
        provider: str,
        pane_id: str,
        args: list[str],
    ) -> None:
        return lifecycle.start_agent(self, name, provider, pane_id, args)

    def _pane_terminal_id(self, pane_id: str) -> str | None:
        return lifecycle.pane_terminal_id(self, pane_id)

    def _pane_terminal_unchanged(self, pane_id: str, pinned_terminal_id: str) -> bool:
        return lifecycle.pane_terminal_unchanged(self, pane_id, pinned_terminal_id)

    def _normalize_snapshot(
        self, snapshot: dict[str, Any], *, inspect_copilot: bool = True, include_activity: bool = False
    ) -> dict[str, Any]:
        with self.refresh_lock:
            return runtime.normalize_snapshot(
                self, snapshot, inspect_copilot=inspect_copilot, include_activity=include_activity,
            )

    def _agent_catalog_snapshot(self, force: bool = False) -> list[dict[str, Any]]:
        return runtime.agent_catalog_snapshot(self, force)

    @staticmethod
    def _fallback_agent_catalog() -> list[dict[str, Any]]:
        return runtime.fallback_agent_catalog()

    def _agent_display_title(
        self,
        raw: dict[str, Any],
        provider: str,
        tab_label: Any,
    ) -> str:
        return runtime.agent_display_title(self, raw, provider, tab_label)

    @classmethod
    def _without_provider_suffix(cls, title: str, provider: str) -> str:
        return runtime.without_provider_suffix(title, provider)

    @staticmethod
    def _is_generic_agent_name(value: str, provider: str) -> bool:
        return runtime.is_generic_agent_name(value, provider)

    def _is_generic_agent_title(self, value: str, provider: str) -> bool:
        return runtime.is_generic_agent_title(self, value, provider)

    def _answer_human_request(self, payload: dict[str, Any]) -> dict[str, Any]:
        return questions.answer_human_request(self, payload)

    @staticmethod
    def _agent_is_blocked(agent: dict[str, Any]) -> bool:
        return questions.agent_is_blocked(agent)

    def _send_keys(self, agent: dict[str, Any], keys: list[str]) -> None:
        return questions.send_keys(self, agent, keys)

    def _answer_blocked_dialog(
        self,
        agent: dict[str, Any],
        request: dict[str, Any] | None,
        selected_ids: list[Any],
        text: str,
    ) -> None:
        return questions.answer_blocked_dialog(self, agent, request, selected_ids, text)

    @staticmethod
    def _text_keys(text: str) -> list[str]:
        return questions.text_keys(text)

    def _subscription_loop(self) -> None:
        return subscriptions.subscription_loop(self)

    def _read_global_subscription(self, resynchronize: bool = False) -> None:
        return subscriptions.read_global_subscription(self, resynchronize)

    def _ensure_pane_subscriptions(self) -> None:
        return subscriptions.ensure_pane_subscriptions(self)

    def _pane_subscription_loop(self, pane_id: str) -> None:
        return subscriptions.pane_subscription_loop(self, pane_id)

    def _read_pane_subscription(self, pane_id: str) -> None:
        return subscriptions.read_pane_subscription(self, pane_id)

    def _pane_is_active(self, pane_id: str) -> bool:
        return subscriptions.pane_is_active(self, pane_id)

    def _wait_for_subscription_retry(self, delay: float) -> None:
        return subscriptions.wait_for_subscription_retry(self, delay)

    def _handle_herdr_event(self, event: dict[str, Any]) -> None:
        return subscriptions.handle_herdr_event(self, event)

    def _handle_locked_herdr_event(self, event: dict[str, Any]) -> None:
        return subscriptions.handle_locked_herdr_event(self, event)

    def _herdr_request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        return transport.herdr_request(self, method, params)

    def _load_fallback(self, agent: dict[str, Any]) -> dict[str, Any]:
        return conversation.load_fallback(self, agent)
