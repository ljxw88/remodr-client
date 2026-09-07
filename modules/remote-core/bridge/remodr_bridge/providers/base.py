"""Provider contract and shared launch-setting validation.

Adapters own identity resolution, transcripts and provider-specific mutations.
The host owns runtime publication and Herdr I/O; SessionRegistry owns session
identity and scoped caches. Callers hold
the host's refresh lock when binding sessions or reading conversations; adapters
must not treat an event/display hint as durable-command authority.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping, Protocol

from ..constants import CONTEXT_TIERS, ORDERED_TUNING
from ..errors import BridgeError
from ..session_registry import SessionRegistry


class ProviderHost(Protocol):
    @property
    def sessions(self) -> SessionRegistry: ...
    @property
    def raw_agents(self) -> Mapping[str, Mapping[str, Any]]: ...
    @property
    def runtime(self) -> Mapping[str, Any]: ...

    def _herdr_request(self, method: str, params: dict[str, Any]) -> dict[str, Any]: ...
    def _diagnostic(self, tag: str, message: str) -> None: ...
    def _stable_agent_id(self, pane_id: str) -> str: ...
    def _remember_human_request(self, request: dict[str, Any], agent: dict[str, Any]) -> None: ...
    def _require_agent(self, payload: dict[str, Any]) -> dict[str, Any]: ...
    def _tuning_arguments(self, provider: Any, payload: dict[str, Any]) -> list[str]: ...
    def _tuning_of(self, payload: dict[str, Any]) -> dict[str, Any]: ...
    def _reported_tuning(self, pane_id: str, session_id: Any, provider: str) -> dict[str, Any]: ...
    def _refresh_runtime(self, *, inspect_copilot: bool = True) -> None: ...
    def _start_agent(self, name: str, provider: str, pane_id: str, args: list[str]) -> None: ...


@dataclass(frozen=True)
class ProviderSpec:
    name: str
    label: str
    aliases: tuple[str, ...] = ()
    substring_match: bool = False
    bypass_arguments: tuple[str, ...] = ()
    tuning_flags: dict[str, str] = field(default_factory=dict)
    efforts: tuple[str, ...] = ()
    retunable: bool = False
    structured_conversation: bool = False
    streaming: bool = False
    tool_activity: bool = False
    questions: bool = False
    todos: bool = False
    wait_for_session: bool = False

    def matches(self, normalized: str) -> bool:
        return (
            self.name in normalized if self.substring_match
            else normalized == self.name or normalized in self.aliases
        )


class ProviderAdapter:
    """Default native-session/raw-output behavior, including unknown providers."""

    spec = ProviderSpec("unknown", "Agent")

    def __init__(self, host: ProviderHost) -> None:
        self.host = host

    @classmethod
    def tuning_arguments(cls, payload: dict[str, Any]) -> list[str]:
        if cls.spec.name == "unknown":
            raise BridgeError("INVALID_PROVIDER", "Unsupported agent provider.")
        arguments: list[str] = []
        for key in ORDERED_TUNING:
            value = payload.get(key)
            if value is None:
                continue
            if not isinstance(value, str):
                raise BridgeError(f"INVALID_{key.upper()}", f"Invalid {key} setting.")
            value = value.strip()
            if not value:
                continue
            if key not in cls.spec.tuning_flags:
                raise BridgeError(
                    "UNSUPPORTED_TUNING",
                    f"{cls.spec.label} does not support the {key} setting from here.",
                )
            if key == "effort" and value not in cls.spec.efforts:
                raise BridgeError("INVALID_EFFORT", "Unsupported reasoning effort.")
            if key == "context" and value not in CONTEXT_TIERS:
                raise BridgeError("INVALID_CONTEXT", "Unsupported context window.")
            if key == "model" and any(ord(char) < 32 or ord(char) == 127 for char in value):
                raise BridgeError("INVALID_MODEL", "Invalid model setting.")
            arguments.extend([cls.spec.tuning_flags[key], cls.format_tuning_value(key, value)])
        return arguments

    @staticmethod
    def format_tuning_value(key: str, value: str) -> str:
        return value

    @staticmethod
    def new_session_arguments(label: str, args: list[str]) -> str | None:
        return None

    def resolve_session(
        self, raw: dict[str, Any], native_session_id: str | None, *, inspect: bool
    ) -> str | None:
        pane_id = str(raw.get("pane_id") or "")
        self.host.sessions.clear_identity(pane_id)
        return native_session_id

    def session_hint(self, pane_id: str, reported_session_id: str | None) -> str | None:
        return reported_session_id

    def remember_session(self, pane_id: str, reported_session_id: str | None) -> None:
        self.host.sessions.forget_launch_session(pane_id)

    def load_conversation(self, agent: dict[str, Any]) -> dict[str, Any] | None:
        return None

    def output_path(self, agent: dict[str, Any]) -> Path | None:
        """Current session's transcript source, or terminal observation if absent."""
        return None

    def session_tuning(self, session_id: Any) -> dict[str, Any]:
        return {}

    def retune(self, payload: dict[str, Any]) -> dict[str, Any]:
        raise BridgeError(
            "PROVIDER_NOT_TUNABLE", f"{self.spec.label} cannot be tuned from here."
        )

    def identity_error(self, reason: str) -> str:
        return "The active provider session cannot be verified: " + reason

    def has_semantic_session(self, session_id: Any) -> bool:
        return False

    def provider_capabilities(self, installed: bool) -> dict[str, bool]:
        return {
            "installed": installed,
            "supportsRetuning": self.spec.retunable,
            "structuredConversation": self.spec.structured_conversation,
            "streamingConversation": self.spec.streaming,
            "structuredQuestions": self.spec.questions,
            "permissions": False,
            "todos": self.spec.todos,
            "fallback": True,
        }

    def agent_capabilities(self, session_id: Any) -> dict[str, bool]:
        # Preserve the wire contract: only Copilot advertises per-session
        # semantic capabilities; Claude/Codex can still return semantic reads.
        semantic = self.has_semantic_session(session_id)
        return {
            "supportsRetuning": self.spec.retunable,
            "structuredConversation": semantic,
            "streamingConversation": semantic and self.spec.streaming,
            "structuredQuestions": semantic and self.spec.questions,
            "toolActivity": semantic and self.spec.tool_activity,
            "todos": semantic and self.spec.todos,
            "fallback": True,
        }
