"""Shared message and display normalization."""
from __future__ import annotations

from typing import Any

def status(value: Any) -> str:
    status = str(value or "unknown").lower()
    return status if status in ("idle", "working", "blocked", "done") else "unknown"


def content_text(value: Any) -> str:
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


def tool_title(tool: str) -> str:
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


def tool_detail(arguments: Any) -> str | None:
    if not isinstance(arguments, dict):
        return None
    for key in ("path", "file_path", "query", "pattern", "description", "command"):
        value = arguments.get(key)
        if isinstance(value, str) and value:
            return value[:240]
    return None
