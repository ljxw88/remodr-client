"""Create an empty native session before starting the Herdr-managed TUI.

The temporary server is owned by this call, password protected and loopback only.
It sends no inference prompt and is never reused as a TUI/server discovery guess.
OpenCode 1.18.29: cli/cmd/serve.ts readiness and POST /session API.
"""
from __future__ import annotations

import base64
import json
import os
from pathlib import Path
import re
import secrets
import select
import shutil
import subprocess
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from ...errors import BridgeError
from .transcript import database_path, session_id

START_TIMEOUT = 30
REQUEST_TIMEOUT = 10
MAX_RESPONSE = 256 * 1024


def executable() -> str:
    configured = os.environ.get("OPENCODE_BIN")
    if configured:
        return os.path.expanduser(configured)
    discovered = shutil.which("opencode")
    if discovered:
        return discovered
    # SSH exec shells need not load the installer-added interactive PATH entry.
    installed = Path.home() / ".opencode" / "bin" / "opencode"
    if installed.is_file() and os.access(installed, os.X_OK):
        return str(installed)
    return "opencode"


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def ready_url(process: subprocess.Popen) -> str:
    deadline = time.monotonic() + START_TIMEOUT
    pending = b""
    received = 0
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise BridgeError("OPENCODE_START_FAILED", "OpenCode server exited before session creation.")
        ready, _, _ = select.select([process.stdout], [], [], max(0, deadline - time.monotonic()))
        if not ready:
            break
        chunk = os.read(process.stdout.fileno(), 4096)
        if not chunk:
            raise BridgeError("OPENCODE_START_FAILED", "OpenCode server closed its startup output.")
        received += len(chunk)
        if received > 64 * 1024:
            raise BridgeError("OPENCODE_START_FAILED", "OpenCode did not report a valid local server endpoint.")
        pending += chunk
        while b"\n" in pending:
            line, pending = pending.split(b"\n", 1)
            match = re.fullmatch(
                rb"opencode server listening on http://127\.0\.0\.1:([0-9]+)", line.strip(),
            )
            if match and 0 < int(match[1]) < 65536:
                return f"http://127.0.0.1:{int(match[1])}"
    raise BridgeError("OPENCODE_START_FAILED", "OpenCode timed out while creating the initial session.")


def workspace_directory(cwd: str) -> Path:
    directory = Path(cwd).expanduser()
    if not directory.is_absolute() or not directory.is_dir():
        raise BridgeError("INVALID_WORKSPACE", "OpenCode needs an existing absolute workspace directory.")
    return directory.resolve()


def with_owned_server(directory: Path, action: Any, failure: str) -> Any:
    """Run one action against a private, password-protected, loopback server.

    The server is started by this call, used once and stopped. It is never
    reused, never advertised and never treated as a discovery result: the only
    thing it is trusted for is the exact request ``action`` makes.
    """
    password = secrets.token_urlsafe(32)
    environment = {
        **os.environ,
        "OPENCODE_SERVER_USERNAME": "opencode",
        "OPENCODE_SERVER_PASSWORD": password,
        "OPENCODE_DB": str(database_path()),
        "NO_COLOR": "1",
    }
    # This is not a pane process. Never let its plugin report another pane's identity.
    for name in ("HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH"):
        environment.pop(name, None)
    process = None
    try:
        process = subprocess.Popen(
            [executable(), "serve",
             "--hostname", "127.0.0.1", "--port", "0", "--mdns=false"],
            cwd=directory, env=environment, stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        )
        return action(ready_url(process), password)
    except FileNotFoundError as error:
        raise BridgeError(
            "OPENCODE_START_FAILED",
            "OpenCode was not found in the SSH environment. Install it or set OPENCODE_BIN to its absolute path.",
        ) from error
    except (OSError, URLError, HTTPError, ValueError) as error:
        raise BridgeError("OPENCODE_START_FAILED", failure) from error
    finally:
        if process is not None:
            try:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=5)
            finally:
                if process.stdout is not None:
                    process.stdout.close()


def request_json(
    url: str, password: str, path: str, directory: Path, method: str, payload: Any = None,
) -> Any:
    headers = {
        "Authorization": "Basic " + base64.b64encode(f"opencode:{password}".encode()).decode(),
        "x-opencode-directory": str(directory),
    }
    data = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(payload).encode()
    request = Request(url + path, data=data, headers=headers, method=method)
    # No proxy settings or redirects may carry the generated credential off-host.
    with build_opener(ProxyHandler({}), NoRedirect()).open(request, timeout=REQUEST_TIMEOUT) as response:
        raw = response.read(MAX_RESPONSE + 1)
    if len(raw) > MAX_RESPONSE:
        raise BridgeError("INVALID_OPENCODE_RESPONSE", "OpenCode returned an oversized session response.")
    return json.loads(raw) if raw else None


def create_session(cwd: str, title: str) -> str:
    directory = workspace_directory(cwd)

    def action(url: str, password: str) -> str:
        data = request_json(
            url, password, "/session", directory, "POST", {"title": title or "Remodr"},
        )
        if not isinstance(data, dict) or not session_id(data.get("id")):
            raise BridgeError("INVALID_OPENCODE_RESPONSE", "OpenCode did not return a valid session identity.")
        returned_directory = data.get("directory")
        if not isinstance(returned_directory, str) or Path(returned_directory).resolve() != directory:
            raise BridgeError("INVALID_OPENCODE_RESPONSE", "OpenCode created a session in a different directory.")
        return data["id"]

    return with_owned_server(
        directory, action,
        "Could not create the OpenCode session. Check OpenCode installation and workspace configuration.",
    )


def delete_session(cwd: str, identifier: str) -> None:
    """Delete exactly one session this bridge created and nothing else.

    Used only to clean up a session that was made for an agent which then
    never started, so nothing has ever written to it. The identifier is
    checked against the session-id grammar before it is put in a path, the
    request is scoped to the same directory the session was created in, and a
    failure is reported rather than retried against anything else.
    """
    if not session_id(identifier):
        raise BridgeError("INVALID_OPENCODE_SESSION", "Refusing to delete an invalid session identifier.")
    directory = workspace_directory(cwd)

    def action(url: str, password: str) -> None:
        request_json(url, password, "/session/" + identifier, directory, "DELETE")

    with_owned_server(
        directory, action, "Could not delete the unused OpenCode session.",
    )
