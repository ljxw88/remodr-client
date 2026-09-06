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
    request = host.pending_human_requests.get(request_id)
    scope = host.human_request_scopes.get(request_id)
    if scope is not None and scope[1:] != (
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
    # A question puts the agent's own selection UI on screen, and Herdr
    # refuses `agent.prompt` while that is up — it answers with
    # `agent_blocked` before sending anything. The dialog has to be driven
    # the way a person would drive it. The status can be a moment stale, so
    # a refusal is also taken as proof the dialog is up.
    if host._agent_is_blocked(agent):
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
    host.pending_human_requests.pop(request_id, None)
    host.human_request_scopes.pop(request_id, None)
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
    """Drive the agent's own question dialog.

    The dialog is a list of the offered answers followed by a synthesised
    "Other (type your answer)" row, and the cursor opens on the schema's
    default rather than the top. Both ends of the list clamp, so moving
    further than the list is long is what makes a position certain without
    having to read the screen back.
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
