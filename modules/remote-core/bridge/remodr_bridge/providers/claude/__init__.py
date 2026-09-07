"""Claude native-session identity and JSONL transcript adapter."""
from __future__ import annotations

from typing import Any
from pathlib import Path

from ..base import ProviderAdapter
from . import transcript
from .settings import SPEC


class ClaudeAdapter(ProviderAdapter):
    spec = SPEC

    def load_conversation(self, agent: dict[str, Any]) -> dict[str, Any] | None:
        return transcript.load_conversation(agent)

    def output_path(self, agent: dict[str, Any]) -> Path | None:
        return transcript.transcript_path(agent.get("providerSessionId"))
