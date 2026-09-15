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

API_CAPABILITIES = (
    "apiConversation",
    "apiPrompt",
    "apiAbort",
    "nativeQuestions",
    "nativePermissions",
    "apiModelSelection",
)


class ProviderHost(Protocol):
    @property
    def sessions(self) -> SessionRegistry: ...
    @property
    def raw_agents(self) -> Mapping[str, Mapping[str, Any]]: ...
    @property
    def runtime(self) -> Mapping[str, Any]: ...
    device_id: str
    session_name: str
    herdr_socket: str

    def _herdr_request(self, method: str, params: dict[str, Any]) -> dict[str, Any]: ...
    def _herdr_mutation(self, method: str, params: dict[str, Any]) -> dict[str, Any]: ...
    def _provider_mutation(self, agent: dict[str, Any]) -> None: ...
    def _provider_rejected(self) -> None: ...
    def _active_command_id(self) -> str | None: ...
    def _diagnostic(self, tag: str, message: str) -> None: ...
    def _stable_agent_id(self, pane_id: str) -> str: ...
    def _remember_human_request(self, request: dict[str, Any], agent: dict[str, Any]) -> None: ...
    def _require_agent(self, payload: dict[str, Any]) -> dict[str, Any]: ...
    def _tuning_arguments(self, provider: Any, payload: dict[str, Any]) -> list[str]: ...
    def _tuning_of(self, payload: dict[str, Any]) -> dict[str, Any]: ...
    def _reported_tuning(self, pane_id: str, session_id: Any, provider: str) -> dict[str, Any]: ...
    def _refresh_runtime(self, *, inspect_copilot: bool = True) -> None: ...
    def _refresh_runtime_and_publish(self) -> None: ...
    def _start_agent(self, name: str, provider: str, pane_id: str, args: list[str]) -> None: ...


@dataclass(frozen=True)
class AgentLaunch:
    """What a provider needs in place before and after its agent is started.

    The launch is prepared before the pane exists, because the process
    environment can only be handed over when the pane's shell is created:
    Herdr's ``agent.start`` takes arguments but no environment, so anything
    secret has to travel through ``tab.create``. Adapters that need nothing
    beyond a session identifier return the default, and the lifecycle then has
    no provider to know about.

    ``binding`` is adapter-private; the lifecycle only hands it back on commit
    or discard so a half-created agent leaves nothing behind.
    """

    session_id: str | None = None
    env: Mapping[str, str] = field(default_factory=dict)
    binding: Any = None


@dataclass(frozen=True)
class ProviderSpec:
    name: str
    label: str
    aliases: tuple[str, ...] = ()
    substring_match: bool = False
    bypass_arguments: tuple[str, ...] = ()
    interrupt_keys: tuple[str, ...] = ("ctrl-c",)
    tuning_flags: dict[str, str] = field(default_factory=dict)
    efforts: tuple[str, ...] = ()
    retunable: bool = False
    structured_conversation: bool = False
    streaming: bool = False
    tool_activity: bool = False
    questions: bool = False
    todos: bool = False

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

    def prepare_launch(self, label: str, args: list[str], cwd: str | None) -> AgentLaunch:
        return AgentLaunch(session_id=self.new_session_arguments(label, args))

    def open_session(
        self, pane_id: str, label: str, args: list[str], launch: AgentLaunch
    ) -> AgentLaunch:
        """Create durable provider state, now that there is a pane to own it.

        Split from prepare_launch so that nothing which outlives a failure is
        created before the pane exists: if the pane is never made, there is
        nothing to orphan and nothing to clean up.
        """
        return launch

    def commit_launch(self, pane_id: str, launch: AgentLaunch) -> None:
        """Make the prepared launch durable once the agent is actually running."""

    def discard_launch(
        self, pane_id: str | None, launch: AgentLaunch, *, started: bool = False
    ) -> None:
        """Undo a failed creation.

        ``pane_id`` is None when no pane was ever named, and ``started`` says
        whether the agent process was launched, because a session the agent may
        have written to is not the same thing as one nothing ever touched.
        """

    def prune_bindings(self, live_panes: set[str]) -> None:
        """Drop cached, snapshot-scoped verification for panes that are gone."""

    def prune_launches(self, live_panes: set[str]) -> None:
        """Reclaim durable launch state for panes an authoritative snapshot lacks.

        Only ever called with a pane list the host is willing to treat as
        complete for this bridge's Herdr session. A failed or partial snapshot
        is not proof that an agent is gone, and must not reach this.
        """

    def forget_pane(self, pane_id: str) -> None:
        """Drop pane-scoped launch state when the pane or agent is closed.

        Called for a closed pane, never for a bridge shutdown or a dropped
        connection: an agent outliving this bridge must still be reachable
        when it reconnects.
        """

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

    def prepare_conversation(self, agent: dict[str, Any]) -> None:
        """Perform provider I/O needed before the host takes its read lock."""

    def send_message(self, agent: dict[str, Any], text: str) -> None:
        self.host._herdr_mutation(
            "agent.prompt", {"target": agent["paneId"], "text": text},
        )

    def answer_request(
        self, agent: dict[str, Any], request: dict[str, Any], answer: dict[str, Any],
    ) -> bool:
        return False

    def prepare_request(self, agent: dict[str, Any], origin: Any) -> None:
        """Revalidate a provider-owned request before its authoritative read."""

    def interrupt(self, agent: dict[str, Any]) -> None:
        self.host._herdr_mutation(
            "agent.send_keys",
            {
                "target": agent["paneId"],
                "keys": list(self.spec.interrupt_keys),
            },
        )

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
            **self.api_capabilities(None, None),
        }

    def api_capabilities(
        self, session_id: Any, pane_id: str | None
    ) -> dict[str, bool]:
        """What this provider's own API offers, for this agent, right now.

        Every one of these is false unless a live binding to the provider's own
        server has been verified for this exact pane and session. Provider-level
        answers describe installed potential only and are never a promise about
        any particular agent; an adapter without a server API answers false
        everywhere, which is why the default lives here.
        """
        return {name: False for name in API_CAPABILITIES}

    def agent_capabilities(
        self, session_id: Any, pane_id: str | None = None
    ) -> dict[str, bool]:
        semantic = self.has_semantic_session(session_id)
        capabilities = {
            "supportsRetuning": self.spec.retunable,
            "structuredConversation": semantic,
            "streamingConversation": semantic and self.spec.streaming,
            "structuredQuestions": semantic and self.spec.questions,
            "toolActivity": semantic and self.spec.tool_activity,
            "todos": semantic and self.spec.todos,
            "fallback": True,
        }
        # Additive by omission: an agent with no verified API binding reports
        # exactly what earlier bridges reported, and a client that has never
        # heard of these keys sees no change at all.
        capabilities.update(
            {
                name: value
                for name, value in self.api_capabilities(session_id, pane_id).items()
                if value
            }
        )
        return capabilities
