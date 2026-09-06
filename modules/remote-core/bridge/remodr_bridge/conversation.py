"""Raw-terminal fallback for unavailable or unsupported semantic transcripts."""
from __future__ import annotations

from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    from .bridge import Bridge

def load_fallback(host: Bridge, agent: dict[str, Any]) -> dict[str, Any]:
    source = "visible" if agent.get("status") == "working" else "recent_unwrapped"
    result = host._herdr_request(
        "agent.read",
        {
            "target": agent["paneId"],
            "source": source,
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
        "providerSessionId": agent.get("providerSessionId"),
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
