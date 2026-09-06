"""Synchronous Herdr Unix-socket request/response transport."""
from __future__ import annotations

import json
import socket
import uuid
from typing import Any, TYPE_CHECKING
from .errors import BridgeError

if TYPE_CHECKING:
    from .bridge import Bridge

def herdr_request(host: Bridge, method: str, params: dict[str, Any]) -> dict[str, Any]:
    request_id = "mobile-" + uuid.uuid4().hex
    with socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(12)
        connection.connect(host.herdr_socket)
        connection.sendall(
            (
                json.dumps(
                    {"id": request_id, "method": method, "params": params},
                    separators=(",", ":"),
                )
                + "\n"
            ).encode()
        )
        stream = connection.makefile("r", encoding="utf-8")
        line = stream.readline()
    if not line:
        raise BridgeError("HERDR_DISCONNECTED", "Herdr closed the connection.")
    response = json.loads(line)
    if "error" in response:
        error = response["error"]
        raise BridgeError(
            str(error.get("code") or "HERDR_ERROR"),
            str(error.get("message") or "Herdr request failed."),
        )
    result = response.get("result")
    if not isinstance(result, dict):
        raise BridgeError("INVALID_HERDR_RESPONSE", "Herdr result is invalid.")
    return result
