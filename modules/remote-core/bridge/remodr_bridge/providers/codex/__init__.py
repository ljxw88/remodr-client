"""Codex adapter: live thread identity and indexed rollout conversations."""
from __future__ import annotations

import json
from typing import Any

from ..base import ProviderAdapter
from . import sessions, transcript
from .settings import CODEX_STATUS_CONFIG, SPEC


class CodexAdapter(ProviderAdapter):
    spec = SPEC

    @staticmethod
    def format_tuning_value(key: str, value: str) -> str:
        return f"model_reasoning_effort={json.dumps(value)}" if key == "effort" else value

    @staticmethod
    def new_session_arguments(label: str, args: list[str]) -> None:
        # SessionStart hooks are delayed until input; the footer is live sooner.
        args.extend(["-c", CODEX_STATUS_CONFIG])

    def resolve_session(
        self, raw: dict[str, Any], native_session_id: str | None, *, inspect: bool
    ) -> str | None:
        self.host.process_bound_panes.discard(str(raw.get("pane_id") or ""))
        return sessions.effective_session(self.host, raw, native_session_id)

    def load_conversation(self, agent: dict[str, Any]) -> dict[str, Any] | None:
        return transcript.load_conversation(self.host, agent)

    def identity_error(self, reason: str) -> str:
        return reason
