"""Copilot adapter composed from process, session, transcript and tuning owners."""
from __future__ import annotations

from pathlib import Path
from typing import Any
import uuid

from ..base import ProviderAdapter, ProviderHost
from . import sessions, transcript
from .processes import CopilotProcesses
from .settings import SPEC
from .tuning import CopilotTuning


class CopilotAdapter(ProviderAdapter):
    spec = SPEC

    def __init__(self, host: ProviderHost) -> None:
        super().__init__(host)
        self.processes = CopilotProcesses(host)
        self.tuning = CopilotTuning(host)

    @staticmethod
    def new_session_arguments(label: str, args: list[str]) -> str:
        # An explicit new ID avoids Copilot's restore picker consuming input.
        session_id = str(uuid.uuid4())
        args.extend(["--session-id", session_id])
        if label:
            args.extend(["--name", label])
        return session_id

    def resolve_session(
        self, raw: dict[str, Any], native_session_id: str | None, *, inspect: bool
    ) -> str | None:
        pane_id = str(raw.get("pane_id") or "")
        if inspect:
            return sessions.effective_session(self.host, self.processes, pane_id, native_session_id)
        if pane_id in self.host.process_bound_panes:
            # Event hints neither rescan processes nor restore stale native IDs.
            previous = self.host.raw_agents.get(self.host._stable_agent_id(pane_id))
            return (
                previous.get("providerSessionId")
                if previous and previous.get("provider") == self.spec.name
                and previous.get("terminal_id") == raw.get("terminal_id")
                else None
            )
        return native_session_id

    def session_hint(self, pane_id: str, reported_session_id: str | None) -> str | None:
        if not reported_session_id and pane_id not in self.host.observed_session_panes:
            return self.host.started_sessions.get(pane_id)
        return reported_session_id

    def remember_session(self, pane_id: str, reported_session_id: str | None) -> None:
        if reported_session_id and self.host.started_sessions.get(pane_id) is not None:
            self.host.started_sessions[pane_id] = reported_session_id
        elif not reported_session_id and pane_id in self.host.observed_session_panes:
            self.host.started_sessions.pop(pane_id, None)

    def load_conversation(self, agent: dict[str, Any]) -> dict[str, Any] | None:
        return transcript.load_conversation(self.host, agent)

    def output_path(self, agent: dict[str, Any]) -> Path | None:
        session_id = agent.get("providerSessionId")
        if not isinstance(session_id, str) or not session_id:
            return None
        path = Path.home() / ".copilot" / "session-state" / session_id / "events.jsonl"
        return path if path.is_file() else None

    def session_tuning(self, session_id: Any) -> dict[str, Any]:
        return self.tuning.session_tuning(session_id)

    def retune(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self.tuning.retune_current_agent(payload)

    def has_semantic_session(self, session_id: Any) -> bool:
        return isinstance(session_id, str) and (
            Path.home() / ".copilot" / "session-state" / session_id / "events.jsonl"
        ).is_file()
