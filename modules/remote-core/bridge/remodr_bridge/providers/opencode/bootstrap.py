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


def create_session(cwd: str, title: str) -> str:
    directory = Path(cwd).expanduser()
    if not directory.is_absolute() or not directory.is_dir():
        raise BridgeError("INVALID_WORKSPACE", "OpenCode needs an existing absolute workspace directory.")
    directory = directory.resolve()
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
        url = ready_url(process)
        request = Request(
            url + "/session",
            data=json.dumps({"title": title or "Remodr"}).encode(),
            headers={
                "Content-Type": "application/json",
                "Authorization": "Basic " + base64.b64encode(f"opencode:{password}".encode()).decode(),
                "x-opencode-directory": str(directory),
            },
            method="POST",
        )
        # No proxy settings or redirects may carry the generated credential off-host.
        with build_opener(ProxyHandler({}), NoRedirect()).open(request, timeout=REQUEST_TIMEOUT) as response:
            raw = response.read(MAX_RESPONSE + 1)
        if len(raw) > MAX_RESPONSE:
            raise BridgeError("INVALID_OPENCODE_RESPONSE", "OpenCode returned an oversized session response.")
        data = json.loads(raw)
        if not isinstance(data, dict) or not session_id(data.get("id")):
            raise BridgeError("INVALID_OPENCODE_RESPONSE", "OpenCode did not return a valid session identity.")
        returned_directory = data.get("directory")
        if not isinstance(returned_directory, str) or Path(returned_directory).resolve() != directory:
            raise BridgeError("INVALID_OPENCODE_RESPONSE", "OpenCode created a session in a different directory.")
        return data["id"]
    except FileNotFoundError as error:
        raise BridgeError(
            "OPENCODE_START_FAILED",
            "OpenCode was not found in the SSH environment. Install it or set OPENCODE_BIN to its absolute path.",
        ) from error
    except (OSError, URLError, HTTPError, ValueError) as error:
        raise BridgeError(
            "OPENCODE_START_FAILED",
            "Could not create the OpenCode session. Check OpenCode installation and workspace configuration.",
        ) from error
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
