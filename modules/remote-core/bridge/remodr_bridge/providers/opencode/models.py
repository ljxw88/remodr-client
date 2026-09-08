"""Workspace-scoped selectors from OpenCode's non-verbose native models command."""
from __future__ import annotations

import os
from pathlib import Path
import re
import select
import signal
import subprocess
import time
import unicodedata
from typing import Any

from ...errors import BridgeError
from ..base import ProviderHost
from . import bootstrap
from .transcript import database_path

DISCOVERY_TIMEOUT = 32
# transport.herdr_request has a 12-second socket timeout. Reserve its final
# scope check inside the native bridge's 35-second request budget.
SCOPE_TIMEOUT = 12
CLEANUP_TIMEOUT = 1
MAX_MODELS = 10_000
MAX_SELECTOR = 512
MAX_OUTPUT = 2 * 1024 * 1024
FAILURE = (
    "Could not list OpenCode models. Check the remote OpenCode installation "
    "(or OPENCODE_BIN), workspace configuration, and provider authentication, then retry."
)


def _invalid_output() -> BridgeError:
    return BridgeError(
        "INVALID_OPENCODE_MODELS",
        "OpenCode returned an invalid or oversized model list. Check the remote "
        "OpenCode installation and plugin configuration, then retry.",
    )


def parse_models(output: bytes) -> list[str]:
    if len(output) > MAX_OUTPUT:
        raise _invalid_output()
    if not output:
        return []
    # The native CLI prints complete lines. An unterminated last line may be
    # truncated output; do not silently advertise a partial catalogue.
    if not output.endswith(b"\n"):
        raise _invalid_output()
    try:
        lines = output.decode("utf-8").split("\n")[:-1]
    except UnicodeError:
        raise _invalid_output() from None
    if len(lines) > MAX_MODELS:
        raise _invalid_output()
    models = []
    seen = set()
    for line in lines:
        selector = line[:-1] if line.endswith("\r") else line
        if (
            not 0 < len(selector) <= MAX_SELECTOR
            or re.fullmatch(r"[A-Za-z0-9._-]+/[^\s\x00-\x1f\x7f]+", selector) is None
            or any(unicodedata.category(char).startswith("C") for char in selector)
            or selector in seen
        ):
            raise _invalid_output()
        seen.add(selector)
        models.append(selector)
    return models


def _workspace(host: ProviderHost, workspace_id: str) -> tuple[str, Path, int, int]:
    # Reading a snapshot has no pane inputs, provider inspection, subscriptions,
    # or session creation. In particular, never fall back to the focused pane.
    try:
        result = host._herdr_request("session.snapshot", {})
        if not isinstance(result, dict):
            raise ValueError()
        snapshot = result.get("snapshot")
        if not isinstance(snapshot, dict):
            raise ValueError()
        workspaces = snapshot.get("workspaces")
        panes = snapshot.get("panes", [])
        agents = snapshot.get("agents", [])
        if not all(isinstance(items, list) for items in (workspaces, panes, agents)):
            raise ValueError()
        matches = [
            item for item in workspaces
            if isinstance(item, dict) and str(item.get("workspace_id") or "") == workspace_id
        ]
        if len(matches) != 1:
            raise BridgeError("WORKSPACE_NOT_FOUND", "The selected space no longer exists.")
        # Match runtime.normalize_snapshot's workspace-cwd selection.
        cwd = next((
            item.get("foreground_cwd") or item.get("cwd")
            for item in [*panes, *agents]
            if isinstance(item, dict)
            and str(item.get("workspace_id") or "") == workspace_id
            and isinstance(item.get("foreground_cwd") or item.get("cwd"), str)
            and (item.get("foreground_cwd") or item.get("cwd"))
        ), None)
        if not isinstance(cwd, str) or not cwd:
            raise BridgeError("INVALID_WORKSPACE", "The selected space has no known directory.")
        directory = Path(cwd).expanduser()
        if not directory.is_absolute() or not directory.is_dir():
            raise BridgeError("INVALID_WORKSPACE", "The selected space needs an existing absolute directory.")
        directory = directory.resolve()
        stat = directory.stat()
        return cwd, directory, stat.st_dev, stat.st_ino
    except BridgeError as error:
        # Herdr errors can contain arbitrary remote data. Only our own fixed
        # scope messages are allowed across this endpoint.
        if error.code in ("WORKSPACE_NOT_FOUND", "INVALID_WORKSPACE") and str(error) in (
            "The selected space no longer exists.",
            "The selected space has no known directory.",
            "The selected space needs an existing absolute directory.",
        ):
            raise
        raise BridgeError("OPENCODE_MODELS_FAILED", FAILURE) from None
    except (OSError, ValueError, RuntimeError):
        raise BridgeError("OPENCODE_MODELS_FAILED", FAILURE) from None


def _timeout() -> BridgeError:
    return BridgeError(
        "OPENCODE_MODELS_TIMEOUT",
        "OpenCode model discovery timed out. Check remote connectivity, workspace "
        "configuration, and provider authentication, then retry.",
    )


def _read_models(process: subprocess.Popen, deadline: float) -> list[str]:
    output = bytearray()
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise _timeout()
        ready, _, _ = select.select([process.stdout], [], [], remaining)
        if not ready:
            raise _timeout()
        chunk = os.read(process.stdout.fileno(), 64 * 1024)
        if not chunk:
            break
        if len(output) + len(chunk) > MAX_OUTPUT:
            raise _invalid_output()
        output.extend(chunk)
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise _timeout()
    try:
        status = process.wait(timeout=remaining)
    except subprocess.TimeoutExpired:
        raise _timeout() from None
    if status != 0:
        raise BridgeError("OPENCODE_MODELS_FAILED", FAILURE)
    return parse_models(bytes(output))


def _discover(cwd: Path, refresh: bool, deadline: float) -> list[str]:
    process = None
    try:
        environment = {**os.environ, "OPENCODE_DB": str(database_path()), "NO_COLOR": "1"}
        for name in ("HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH"):
            environment.pop(name, None)
        arguments = [bootstrap.executable(), "models"]
        if refresh:
            arguments.append("--refresh")
        if time.monotonic() >= deadline:
            raise _timeout()
        process = subprocess.Popen(
            arguments, cwd=cwd, env=environment, stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True,
        )
        return _read_models(process, deadline)
    except BridgeError:
        raise
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
        raise BridgeError("OPENCODE_MODELS_FAILED", FAILURE) from None
    finally:
        if process is not None:
            try:
                # This group belongs exclusively to this discovery process.
                # Clean plugin descendants even if the CLI has already exited.
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait(timeout=CLEANUP_TIMEOUT)
            except (OSError, subprocess.SubprocessError):
                raise BridgeError("OPENCODE_MODELS_FAILED", FAILURE) from None
            finally:
                if process.stdout is not None:
                    process.stdout.close()


def list_models(host: ProviderHost, payload: dict[str, Any]) -> dict[str, Any]:
    workspace_id = payload.get("workspaceId")
    refresh = payload.get("refresh", False)
    if not isinstance(workspace_id, str) or not workspace_id:
        raise BridgeError("INVALID_WORKSPACE", "A space is required.")
    if not isinstance(refresh, bool) or set(payload) - {"workspaceId", "refresh"}:
        raise BridgeError("INVALID_REQUEST", "Only workspaceId and a boolean refresh are accepted.")
    try:
        deadline = time.monotonic() + DISCOVERY_TIMEOUT
        scope = _workspace(host, workspace_id)
        models = _discover(scope[1], refresh, deadline - SCOPE_TIMEOUT)
        if _workspace(host, workspace_id) != scope:
            raise BridgeError("WORKSPACE_CHANGED", "The selected space changed. Reopen Models and retry.")
        if time.monotonic() > deadline + CLEANUP_TIMEOUT:
            raise _timeout()
        return {"workspaceId": workspace_id, "cwd": str(scope[1]), "models": models}
    except BridgeError:
        raise
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
        raise BridgeError("OPENCODE_MODELS_FAILED", FAILURE) from None
