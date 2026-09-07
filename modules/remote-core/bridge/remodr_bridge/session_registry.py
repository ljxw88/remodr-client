"""Session-owned state, independent of bridge I/O and runtime publication.

Methods synchronize their own memory and never acquire bridge locks or perform
I/O. Multi-step refresh/read/retune operations still hold Bridge.refresh_lock.
When locks are nested, the order is refresh_lock -> state_lock -> registry lock;
callers must not acquire a bridge lock while holding the registry lock.
"""
from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass, field
import threading
from typing import Any, Mapping


CacheVersion = tuple[int, int, int, int]


@dataclass(frozen=True)
class SessionKey:
    agent_id: str
    provider: str | None
    session_id: str | None

    @classmethod
    def from_agent(cls, agent: Mapping[str, Any]) -> SessionKey:
        return cls(agent["id"], agent.get("provider"), agent.get("providerSessionId"))


@dataclass(frozen=True)
class SessionBinding:
    key: SessionKey
    pane_id: str

    @classmethod
    def from_agent(cls, agent: Mapping[str, Any]) -> SessionBinding:
        return cls(SessionKey.from_agent(agent), str(agent.get("paneId") or ""))


@dataclass(frozen=True)
class PendingQuestion:
    key: SessionKey
    request: dict[str, Any]


@dataclass
class _PaneState:
    launched_session: str | None = None
    observed: bool = False
    process_bound: bool = False
    identity_error: str | None = None
    diagnostic: str | None = None
    tuning: dict[str, Any] = field(default_factory=dict)
    bypass: bool | None = None


class SessionRegistry:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._panes: dict[str, _PaneState] = {}
        self._bindings: dict[str, SessionBinding] = {}
        self._tuning_cache: dict[str, tuple[int, dict[str, Any]]] = {}
        self._conversations: dict[SessionKey, tuple[CacheVersion, dict[str, Any]]] = {}
        self._questions: dict[str, PendingQuestion] = {}

    def binding(self, agent_id: str) -> SessionBinding | None:
        with self._lock:
            return self._bindings.get(agent_id)

    def bind(self, binding: SessionBinding, *, reported: bool) -> bool:
        """Install an effective identity and invalidate a replaced session.

        A first discovery must retain launch tuning. An observed missing identity
        must not fall back to a stale launch ID, even before a new ID is known.
        The caller invalidates external activity caches when this returns True.
        """
        with self._lock:
            state = self._panes.setdefault(binding.pane_id, _PaneState())
            previous = self._bindings.get(binding.key.agent_id)
            previous_session = previous.key.session_id if previous else None
            if previous_session is None and not state.observed:
                previous_session = state.launched_session
            had_identity = state.observed or previous_session is not None
            changed = (previous is not None or state.launched_session is not None) and (
                (had_identity and previous_session != binding.key.session_id)
                or (previous is not None and previous.key.provider != binding.key.provider)
            )
            if changed:
                self._invalidate(binding.key.agent_id, binding.pane_id, previous_session)
            if reported:
                state.observed = True
            self._bindings[binding.key.agent_id] = binding
            return changed

    def record_launch(
        self, pane_id: str, session_id: str | None,
        tuning: Mapping[str, Any], bypass: bool,
    ) -> None:
        with self._lock:
            state = self._panes.setdefault(pane_id, _PaneState())
            state.launched_session = session_id
            state.tuning = deepcopy(dict(tuning))
            state.bypass = bypass

    def remember_launch_session(self, pane_id: str, session_id: str) -> None:
        with self._lock:
            self._panes.setdefault(pane_id, _PaneState()).launched_session = session_id

    def forget_launch_session(self, pane_id: str) -> None:
        with self._lock:
            state = self._panes.get(pane_id)
            if state:
                state.launched_session = None

    def launched_session(self, pane_id: str) -> str | None:
        with self._lock:
            state = self._panes.get(pane_id)
            return state.launched_session if state else None

    def was_observed(self, pane_id: str) -> bool:
        with self._lock:
            state = self._panes.get(pane_id)
            return bool(state and state.observed)

    def is_process_bound(self, pane_id: str) -> bool:
        with self._lock:
            state = self._panes.get(pane_id)
            return bool(state and state.process_bound)

    def record_identity(
        self, pane_id: str, *, error: str | None, diagnostic: str | None,
        process_bound: bool, observed: bool = False,
    ) -> bool:
        """Atomically replace inspection state; report whether the diagnostic changed."""
        with self._lock:
            state = self._panes.setdefault(pane_id, _PaneState())
            changed = state.diagnostic != diagnostic
            state.identity_error = error
            state.diagnostic = diagnostic
            state.process_bound = process_bound
            state.observed |= observed
            return changed

    def clear_identity(self, pane_id: str) -> None:
        self.record_identity(pane_id, error=None, diagnostic=None, process_bound=False)

    def forget_process_binding(self, pane_id: str) -> None:
        with self._lock:
            state = self._panes.get(pane_id)
            if state:
                state.process_bound = False

    def identity_error(self, pane_id: str | None) -> str | None:
        with self._lock:
            state = self._panes.get(pane_id) if pane_id is not None else None
            return state.identity_error if state else None

    def set_tuning(self, pane_id: str, tuning: Mapping[str, Any]) -> None:
        with self._lock:
            self._panes.setdefault(pane_id, _PaneState()).tuning = deepcopy(dict(tuning))

    def tuning(self, pane_id: str) -> dict[str, Any]:
        with self._lock:
            state = self._panes.get(pane_id)
            return deepcopy(state.tuning) if state else {}

    def bypass(self, pane_id: str) -> bool:
        with self._lock:
            state = self._panes.get(pane_id)
            return state.bypass if state and state.bypass is not None else True

    def cached_tuning(self, session_id: str) -> tuple[int, dict[str, Any]] | None:
        with self._lock:
            return deepcopy(self._tuning_cache.get(session_id))

    def cache_tuning(self, session_id: str, offset: int, tuning: Mapping[str, Any]) -> None:
        with self._lock:
            self._tuning_cache[session_id] = (offset, deepcopy(dict(tuning)))

    def conversation(self, key: SessionKey, version: CacheVersion) -> dict[str, Any] | None:
        with self._lock:
            cached = self._conversations.get(key)
            return deepcopy(cached[1]) if cached and cached[0] == version else None

    def cache_conversation(
        self, key: SessionKey, version: CacheVersion, conversation: dict[str, Any],
    ) -> None:
        with self._lock:
            self._conversations[key] = (version, deepcopy(conversation))

    def conversation_keys(self) -> frozenset[SessionKey]:
        with self._lock:
            return frozenset(self._conversations)

    def remember_question(self, key: SessionKey, request: dict[str, Any]) -> None:
        with self._lock:
            self._questions[request["id"]] = PendingQuestion(key, deepcopy(request))

    def question(self, request_id: str) -> PendingQuestion | None:
        with self._lock:
            return deepcopy(self._questions.get(request_id))

    def forget_question(self, request_id: str) -> None:
        with self._lock:
            self._questions.pop(request_id, None)

    def question_ids(self) -> frozenset[str]:
        with self._lock:
            return frozenset(self._questions)

    def invalidate(self, agent_id: str, pane_id: str, session_id: str | None) -> None:
        with self._lock:
            self._invalidate(agent_id, pane_id, session_id)

    def _invalidate(self, agent_id: str, pane_id: str | None, session_id: str | None) -> None:
        """Caller holds the registry lock."""
        state = self._panes.get(pane_id) if pane_id is not None else None
        if state:
            state.tuning = {}
        if session_id is not None:
            self._tuning_cache.pop(session_id, None)
        self._conversations = {
            key: value for key, value in self._conversations.items() if key.agent_id != agent_id
        }
        self._questions = {
            key: value for key, value in self._questions.items() if value.key.agent_id != agent_id
        }

    def remove_agent(self, agent_id: str) -> None:
        with self._lock:
            binding = self._bindings.pop(agent_id, None)
            self._invalidate(
                agent_id, binding.pane_id if binding else None,
                binding.key.session_id if binding else None,
            )

    def forget_pane(self, pane_id: str) -> None:
        with self._lock:
            for agent_id, binding in list(self._bindings.items()):
                if binding.pane_id == pane_id:
                    self.remove_agent(agent_id)
            self._panes.pop(pane_id, None)

    def prune(self, live_panes: set[str], live_sessions: set[str], live_agents: set[str]) -> None:
        with self._lock:
            for agent_id in list(self._bindings):
                if agent_id not in live_agents:
                    self.remove_agent(agent_id)
            self._panes = {pane: state for pane, state in self._panes.items() if pane in live_panes}
            self._tuning_cache = {
                session: value for session, value in self._tuning_cache.items() if session in live_sessions
            }
            self._conversations = {
                key: value for key, value in self._conversations.items() if key.agent_id in live_agents
            }
            self._questions = {
                key: value for key, value in self._questions.items() if value.key.agent_id in live_agents
            }
