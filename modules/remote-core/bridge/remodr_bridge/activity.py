"""Cheap output recency without loading every agent's full conversation."""
from __future__ import annotations

import hashlib
import time
from pathlib import Path
from typing import Any, TYPE_CHECKING

from .errors import BridgeError

if TYPE_CHECKING:
    from .bridge import Bridge
    from .providers.base import ProviderAdapter


class OutputActivity:
    def __init__(self, host: Bridge) -> None:
        self.host = host
        self.entries: dict[str, tuple[tuple[Any, ...], str | None, int | None]] = {}
        self.sources: dict[str, tuple[tuple[Any, ...], Path]] = {}
        self.errors: dict[str, str] = {}

    @staticmethod
    def binding(agent: dict[str, Any], terminal_id: Any) -> tuple[Any, ...]:
        return agent["provider"], agent.get("providerSessionId"), terminal_id

    def cached(self, agent: dict[str, Any], terminal_id: Any) -> int | None:
        entry = self.entries.get(agent["id"])
        return entry[2] if entry and entry[0] == self.binding(agent, terminal_id) else None

    def observe(self, agent: dict[str, Any], terminal_id: Any, adapter: ProviderAdapter) -> int | None:
        key = agent["id"]
        binding = self.binding(agent, terminal_id)
        previous = self.entries.get(key)
        if previous and previous[0] != binding:
            previous = None
        source = self.sources.get(key)
        if source and source[0] != binding:
            source = None
        try:
            if source:
                path = source[1]
            else:
                path = adapter.output_path(agent)
                if path is not None:
                    self.sources[key] = (binding, path)
            if path is not None:
                timestamp = path.stat().st_mtime_ns // 1_000_000
                signature = None
            else:
                result = self.host._herdr_request("agent.read", {
                    "target": agent["paneId"], "source": "recent_unwrapped",
                    "format": "text", "strip_ansi": True, "lines": 40,
                })
                read = result.get("read")
                if not isinstance(read, dict) or not isinstance(read.get("text"), str):
                    raise BridgeError("INVALID_HERDR_RESPONSE", "Output activity text is unavailable.")
                signature = hashlib.sha256(read["text"].encode("utf-8")).hexdigest()
                timestamp = previous[2] if previous else None
                # The first read is a baseline, not evidence of new output.
                if previous and previous[1] is not None and previous[1] != signature:
                    timestamp = max(time.time_ns() // 1_000_000, (timestamp or 0) + 1)
            if previous and previous[2] is not None and timestamp is not None:
                timestamp = max(timestamp, previous[2])
            self.entries[key] = (binding, signature, timestamp)
            self.errors.pop(key, None)
            return timestamp
        except (OSError, BridgeError) as error:
            message = str(error)
            if self.errors.get(key) != message:
                self.host._diagnostic("OUTPUT_ACTIVITY", f"{key}: {message}")
                self.errors[key] = message
            return previous[2] if previous else None

    def invalidate(self, agent_id: str) -> None:
        self.entries.pop(agent_id, None)
        self.sources.pop(agent_id, None)
        self.errors.pop(agent_id, None)

    def prune(self, agent_ids: set[str]) -> None:
        for agent_id in set(self.entries) | set(self.errors):
            if agent_id not in agent_ids:
                self.invalidate(agent_id)
