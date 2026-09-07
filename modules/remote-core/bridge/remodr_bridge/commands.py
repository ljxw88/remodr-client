"""Durable command reservations, preflight binding and mutation accounting."""
from __future__ import annotations

import hashlib
import json
import os
import uuid
from typing import Any, TYPE_CHECKING
from .constants import DURABLE_ACTIONS, PROTOCOL
from .errors import BridgeError
from .ledger import CommandLedger

if TYPE_CHECKING:
    from .bridge import Bridge

def command_id(value: Any) -> str:
    try:
        if not isinstance(value, str) or str(uuid.UUID(value)) != value.lower():
            raise ValueError
        return value.lower()
    except (ValueError, AttributeError):
        raise BridgeError("INVALID_COMMAND_ID", "Command ID must be a canonical UUID.")


def command_ledger(host: Bridge) -> CommandLedger:
    scope = json.dumps(
        [os.getuid(), host.device_id, host.session_name, os.path.abspath(host.herdr_socket)],
        separators=(",", ":"),
    )
    return CommandLedger(hashlib.sha256(scope.encode()).hexdigest())


def command_error(code: str, message: str) -> dict[str, Any]:
    return {
        "protocol": PROTOCOL, "type": "response", "ok": False,
        "error": {"code": code, "message": message},
    }


def stored_response(record: dict[str, Any]) -> dict[str, Any]:
    try:
        response = json.loads(record["response"])
        if (
            not isinstance(response, dict)
            or response.get("protocol") != PROTOCOL
            or response.get("type") != "response"
            or not isinstance(response.get("ok"), bool)
            or (response["ok"] and not isinstance(response.get("payload"), dict))
            or (not response["ok"] and not isinstance(response.get("error"), dict))
        ):
            raise ValueError
        return response
    except (ValueError, TypeError):
        raise BridgeError("COMMAND_STORE_UNAVAILABLE", "Stored command result is invalid.")


def durable_command(
    host: Bridge, value: Any, action: str, payload: dict[str, Any]
) -> dict[str, Any]:
    command_id = host._command_id(value)
    if action not in DURABLE_ACTIONS:
        raise BridgeError(
            "COMMAND_ACTION_UNSUPPORTED", "This action does not support durable commands."
        )
    try:
        encoded = json.dumps(
            [action, payload], sort_keys=True, separators=(",", ":"),
            ensure_ascii=True, allow_nan=False,
        )
    except (ValueError, TypeError):
        raise BridgeError("INVALID_REQUEST", "Command must contain valid JSON values.")
    ledger = host._command_ledger()
    record = ledger.reserve(command_id, hashlib.sha256(encoded.encode()).hexdigest())
    if record is not None:
        if record["state"] == "reserved":
            raise BridgeError("COMMAND_IN_PROGRESS", "Command is still in progress.")
        if record["state"] == "uncertain":
            if record["response"]:
                return host._stored_response(record)
            raise BridgeError(
                "COMMAND_UNCERTAIN", "Command may have been delivered; do not resend."
            )
        return host._stored_response(record)
    host.command_context.active = True
    host.command_context.side_effect = False
    host.command_context.agent = None
    try:
        host._prepare_command(action, payload)
        result = host._dispatch(action, payload)
        response = {
            "protocol": PROTOCOL, "type": "response", "ok": True, "payload": result,
        }
        state = "succeeded"
    except Exception as error:
        if host.command_context.side_effect:
            state = "uncertain"
            response = host._command_error(
                "COMMAND_UNCERTAIN", "Command may have been delivered; do not resend."
            )
        else:
            state = "failed"
            response = host._command_error(
                error.code if isinstance(error, BridgeError) else "BRIDGE_ERROR",
                str(error) if isinstance(error, BridgeError) else "Command validation failed.",
            )
    finally:
        host.command_context.active = False
        host.command_context.agent = None
    try:
        ledger.finish(command_id, state, response)
    except Exception:
        # Even a successful Herdr reply is not an ACK until it has been committed.
        raise BridgeError(
            "COMMAND_UNCERTAIN", "Command result could not be persisted; do not resend."
        )
    return response


def prepare_command(host: Bridge, action: str, payload: dict[str, Any]) -> None:
    if "expectedProviderSessionId" in payload or "expectedPaneId" in payload:
        expected = {
            "providerSessionId": payload.get("expectedProviderSessionId"),
            "paneId": payload.get("expectedPaneId"),
        }
        if "expectedProvider" in payload:
            expected["provider"] = payload["expectedProvider"]
    else:
        expected = payload.get("precondition")
    fields = ("providerSessionId", "paneId")
    if not isinstance(expected, dict) or any(
        not isinstance(expected.get(field), str) or not expected[field] for field in fields
    ):
        raise BridgeError(
            "COMMAND_PRECONDITION_FAILED", "Provider session and pane identity are required."
        )
    host._refresh_runtime()
    agent = host._require_agent(payload)
    identity_error = host.sessions.identity_error(agent.get("paneId"))
    if identity_error:
        raise BridgeError("COMMAND_PRECONDITION_FAILED", identity_error)
    checked_fields = (*fields, "provider") if "provider" in expected else fields
    if any(expected[field] != agent.get(field) for field in checked_fields):
        raise BridgeError(
            "COMMAND_PRECONDITION_FAILED", "The target provider session or pane has changed."
        )
    host.command_context.agent = agent
    if action == "human_request.answer":
        conversation = host._load_conversation(agent)
        request = conversation.get("activeHumanRequest")
        if not isinstance(request, dict) or request.get("id") != payload.get("requestId"):
            raise BridgeError(
                "COMMAND_PRECONDITION_FAILED", "The question is no longer active."
            )
        host._remember_human_request(request, agent)


def herdr_mutation(host: Bridge, method: str, params: dict[str, Any]) -> dict[str, Any]:
    if getattr(host.command_context, "active", False):
        agent = host.command_context.agent
        if agent is None or params.get("target") != agent.get("paneId"):
            raise BridgeError("COMMAND_PRECONDITION_FAILED", "Command target is not bound.")
        host._require_agent({"agentId": agent["id"]})
        identity_error = host.sessions.identity_error(agent.get("paneId"))
        if identity_error:
            raise BridgeError("COMMAND_PRECONDITION_FAILED", identity_error)
        host.command_context.side_effect = True
    return host._herdr_request(method, params)
