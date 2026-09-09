"""Scoped human answers and Herdr terminal-dialog keystrokes."""
from __future__ import annotations

import time
from typing import Any, TYPE_CHECKING
from .errors import BridgeError
from .formatting import status

if TYPE_CHECKING:
    from .bridge import Bridge

def answer_human_request(host: Bridge, payload: dict[str, Any]) -> dict[str, Any]:
    request_id = payload.get("requestId")
    agent = host._require_agent(payload)
    if not isinstance(request_id, str):
        raise BridgeError("INVALID_REQUEST", "Human request ID is required.")
    pending = host.sessions.question(request_id)
    request = pending.request if pending else None
    if pending is not None and (pending.key.provider, pending.key.session_id) != (
        agent.get("provider"), agent.get("providerSessionId")
    ):
        raise BridgeError("INVALID_REQUEST", "The question belongs to another session.")
    answer = payload.get("answer") or {}
    if not isinstance(answer, dict):
        raise BridgeError("INVALID_ANSWER", "Answer must be an object.")
    custom_text = answer.get("customText")
    selected_ids = answer.get("selectedOptionIds") or []
    text = custom_text.strip() if isinstance(custom_text, str) else ""
    if not text and request:
        labels = {
            option["id"]: option["label"]
            for option in request.get("options", [])
            if isinstance(option, dict)
        }
        text = ", ".join(
            labels[option_id]
            for option_id in selected_ids
            if option_id in labels
        )
    if not text:
        raise BridgeError("INVALID_ANSWER", "An answer is required.")
    # OpenCode's question lives in the TUI even when Herdr still reports
    # idle/working. Prompting then types into the focused first row and
    # Enter submits that instead of the chosen answer. Copilot only needs
    # the dialog path while blocked; a stale idle status still refuses
    # `agent.prompt` with `agent_blocked`.
    if agent.get("provider") == "opencode" or host._agent_is_blocked(agent):
        host._answer_blocked_dialog(agent, request, selected_ids, text)
    else:
        try:
            host._herdr_mutation(
                "agent.prompt",
                {"target": agent["paneId"], "text": text},
            )
        except BridgeError as error:
            if error.code != "agent_blocked":
                raise
            host._answer_blocked_dialog(agent, request, selected_ids, text)
    host.sessions.forget_question(request_id)
    return {"accepted": True}


def agent_is_blocked(agent: dict[str, Any]) -> bool:
    return status(agent.get("agent_status")) == "blocked"


def send_keys(host: Bridge, agent: dict[str, Any], keys: list[str]) -> None:
    if keys:
        host._herdr_mutation(
            "agent.send_keys", {"target": agent["paneId"], "keys": keys}
        )


def answer_blocked_dialog(
    host: Bridge,
    agent: dict[str, Any],
    request: dict[str, Any] | None,
    selected_ids: list[Any],
    text: str,
) -> None:
    """Drive the agent's own question dialog."""
    if agent.get("provider") == "opencode":
        from .providers.opencode.questions import answer_dialog
        answer_dialog(host, agent, request, selected_ids, text)
        return
    _answer_copilot_dialog(host, agent, request, selected_ids, text)


def _answer_copilot_dialog(
    host: Bridge,
    agent: dict[str, Any],
    request: dict[str, Any] | None,
    selected_ids: list[Any],
    text: str,
) -> None:
    """Copilot's list clamps at both ends and opens on the schema default.

    Over-travelling past the first row makes the position certain without
    reading the screen back. Enter stays in the same batch as the move.
    """
    options = list(request.get("options", [])) if request else []
    span = len(options) + 2

    index = None
    if len(selected_ids) == 1:
        index = next(
            (
                position
                for position, option in enumerate(options)
                if isinstance(option, dict) and option.get("id") == selected_ids[0]
            ),
            None,
        )

    if index is not None:
        # Anchor on the first row, then step down to the wanted one.
        host._send_keys(agent, ["up"] * span + ["down"] * index + ["enter"])
        return

    # Anything the offered answers do not cover — a typed reply, a
    # synthesised yes/no, or several answers at once — goes through the
    # freeform row at the bottom. Reaching that row swaps the list for a
    # text field, and characters sent before it has drawn are dropped, so
    # each stage is given a moment to settle. Herdr's own prompt does the
    # same thing, sending Enter after a short delay.
    host._send_keys(agent, ["down"] * span)
    time.sleep(host.dialog_settle_seconds)
    host._send_keys(agent, host._text_keys(text))
    time.sleep(host.dialog_settle_seconds)
    host._send_keys(agent, ["enter"])


def text_keys(text: str) -> list[str]:
    # Herdr takes one key per character and rejects a literal space.
    return ["space" if character == " " else character for character in text]
