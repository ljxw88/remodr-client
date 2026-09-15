"""Strict loopback client for a managed OpenCode TUI's own HTTP server.

Herdr starts the TUI; this module only ever talks to the server that TUI is
already running. Nothing here searches for a server. A binding exists only when
all of the following hold, in this order:

1. A private registry record claims this pane was launched with credentials.
2. Herdr reports the pane's foreground process, and its argv is an OpenCode
   invocation carrying the managed ``--hostname 127.0.0.1`` and ``--port``.
3. That exact PID owns exactly one TCP listener, on 127.0.0.1, discovered
   from the kernel's view of *that PID's* descriptors -- never by scanning
   ports and never by trusting a port number on its own.
4. Only then is the credential sent, so a collided listener belonging to some
   other program can never be handed this agent's password.
5. The server answers ``/global/health`` with ``healthy`` and a supported
   version, and returns the exact session Herdr reports for the pane, in the
   directory the record was created for.

Any failure means "no binding", which means no API capability. It never means
"try another port". Proxies, redirects, non-loopback hosts, credentials in URLs
and unbounded responses are all refused.
"""
from __future__ import annotations

import contextlib
from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
import select
import shutil
import socket
import struct
import subprocess
import sys
import time
from typing import Any, Iterable
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from ...errors import BridgeError
from .registry import ServerCredential
from .transcript import session_id as valid_session_id

REQUEST_TIMEOUT = 5.0
MAX_RESPONSE = 256 * 1024
PROCESS_TIMEOUT = 2.0
MAX_PROCESS_OUTPUT = 512 * 1024
MAX_DESCRIPTORS = 4096
MAX_FOREGROUND_PROCESSES = 256
MAX_ARGUMENTS = 512
MINIMUM_VERSION = (1, 18, 30)
LOOPBACK = "127.0.0.1"
PROC = Path("/proc")
VERSION_PATTERN = re.compile(r"(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.\-+]+)?")
LISTEN_ADDRESS = re.compile(r"^(?:\[)?(?P<host>[0-9a-fA-F.:]+)(?:\])?:(?P<port>\d{1,5})$")


class OwnershipError(ValueError):
    """The pane does not demonstrably own a managed OpenCode server."""


@dataclass(frozen=True)
class ServerBinding:
    """A verified pane -> OpenCode server binding for this snapshot only."""

    pane_id: str
    pid: int
    port: int
    cwd: str
    session_id: str
    version: str
    credential: ServerCredential

    def __repr__(self) -> str:
        return (
            f"ServerBinding(pane_id={self.pane_id!r}, pid={self.pid}, "
            f"port={self.port}, session_id={self.session_id!r})"
        )

    __str__ = __repr__

    @property
    def base_url(self) -> str:
        return f"http://{LOOPBACK}:{self.port}"


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def supported_version(value: Any) -> bool:
    if not isinstance(value, str) or not value or len(value) > 64:
        return False
    match = VERSION_PATTERN.fullmatch(value.strip())
    return match is not None and tuple(int(part) for part in match.groups()) >= MINIMUM_VERSION


def managed_arguments(argv: Iterable[Any]) -> bool:
    """Whether argv is a TUI this bridge launched with a managed local server."""
    arguments = list(argv)
    if not arguments or len(arguments) > MAX_ARGUMENTS:
        return False
    if not all(isinstance(argument, str) for argument in arguments):
        return False
    return managed_port(arguments) is not None


def managed_port(arguments: list[str]) -> int | None:
    """The port the TUI was told to use, or None when the launch is not managed.

    ``--port 0`` means "any free port", which is what the managed launch uses,
    so zero is a valid answer and is not a missing value.
    """
    hostname: str | None = None
    port: str | None = None
    for index, argument in enumerate(arguments):
        following = arguments[index + 1] if index + 1 < len(arguments) else None
        if argument == "--hostname":
            hostname = following
        elif argument.startswith("--hostname="):
            hostname = argument.split("=", 1)[1]
        elif argument == "--port":
            port = following
        elif argument.startswith("--port="):
            port = argument.split("=", 1)[1]
    if hostname != LOOPBACK or port is None or not port.isdigit():
        return None
    value = int(port)
    return value if 0 <= value < 65536 else None


def foreground_process(host: Any, pane_id: str) -> tuple[int, int]:
    """The pane's foreground OpenCode process and the port it was launched with."""
    result = host._herdr_request("pane.process_info", {"pane_id": pane_id})
    info = result.get("process_info") if isinstance(result, dict) else None
    if not isinstance(info, dict) or info.get("pane_id") != pane_id:
        raise OwnershipError("pane process metadata is unavailable or mismatched")
    group = info.get("foreground_process_group_id")
    shell_pid = info.get("shell_pid")
    processes = info.get("foreground_processes")
    if (
        type(group) is not int or group <= 0
        or type(shell_pid) is not int or shell_pid <= 0
        or not isinstance(processes, list)
    ):
        raise OwnershipError("pane process metadata is incomplete")
    if len(processes) > MAX_FOREGROUND_PROCESSES:
        raise OwnershipError("foreground process list exceeds the inspection limit")
    roots = [
        item for item in processes
        if isinstance(item, dict) and type(item.get("pid")) is int and item["pid"] == group
    ]
    if len(roots) != 1 or group == shell_pid:
        raise OwnershipError("no unique foreground OpenCode group leader")
    root = roots[0]
    argv = root.get("argv")
    if not isinstance(argv, list) or not managed_arguments(argv):
        raise OwnershipError("the pane's foreground process is not a managed OpenCode server")
    names = {
        Path(value).name
        for value in (root.get("name"), root.get("argv0"), argv[0])
        if isinstance(value, str) and value
    }
    if "opencode" not in names:
        raise OwnershipError("the pane's foreground process is not the OpenCode executable")
    return group, managed_port(list(argv))


def bounded_output(arguments: list[str]) -> bytes:
    deadline = time.monotonic() + PROCESS_TIMEOUT
    with subprocess.Popen(
        arguments, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    ) as process:
        try:
            output = bytearray()
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise OwnershipError("listener inspection timed out")
                readable, _, _ = select.select([process.stdout], [], [], remaining)
                if not readable:
                    raise OwnershipError("listener inspection timed out")
                chunk = os.read(process.stdout.fileno(), 16384)
                if not chunk:
                    break
                output.extend(chunk)
                if len(output) > MAX_PROCESS_OUTPUT:
                    raise OwnershipError("listener output exceeds the size limit")
            if process.wait(timeout=max(0.001, deadline - time.monotonic())) != 0:
                raise OwnershipError("listener inspection was refused")
            return bytes(output)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()


def loopback_ipv4(encoded: str) -> bool:
    if len(encoded) != 8:
        return False
    packed = struct.pack("<L", int(encoded, 16))
    return socket.inet_ntoa(packed) == LOOPBACK


def loopback_ipv6(encoded: str) -> bool:
    """Only an IPv4-mapped 127.0.0.1 counts; ``::1`` is a different address."""
    if len(encoded) != 32:
        return False
    packed = b"".join(
        struct.pack("<L", int(encoded[index:index + 8], 16)) for index in range(0, 32, 8)
    )
    return packed[:12] == b"\x00" * 10 + b"\xff\xff" and packed[12:] == b"\x7f\x00\x00\x01"


def linux_socket_inodes(pid: int) -> set[int]:
    directory = PROC / str(pid)
    if directory.stat().st_uid != os.getuid():
        raise OwnershipError("the foreground process belongs to another user")
    deadline = time.monotonic() + PROCESS_TIMEOUT
    inodes: set[int] = set()
    with os.scandir(directory / "fd") as entries:
        for index, entry in enumerate(entries):
            if index >= MAX_DESCRIPTORS or time.monotonic() >= deadline:
                raise OwnershipError("descriptor inspection exceeds its limit")
            if not entry.name.isdigit():
                continue
            try:
                target = os.readlink(entry.path)
            except (FileNotFoundError, PermissionError):
                continue
            match = re.fullmatch(r"socket:\[(\d+)\]", target)
            if match:
                inodes.add(int(match[1]))
    return inodes


def linux_listening_ports(pid: int) -> set[int]:
    inodes = linux_socket_inodes(pid)
    if not inodes:
        return set()
    ports: set[int] = set()
    for name, loopback in (("tcp", loopback_ipv4), ("tcp6", loopback_ipv6)):
        path = PROC / "net" / name
        if not path.is_file():
            continue
        with path.open("r") as handle:
            for index, line in enumerate(handle):
                if index == 0:
                    continue
                if index > 200_000:
                    raise OwnershipError("listener table exceeds the inspection limit")
                fields = line.split()
                if len(fields) < 10 or fields[3] != "0A":
                    continue
                try:
                    inode = int(fields[9])
                    owner = int(fields[7])
                except ValueError:
                    continue
                if inode not in inodes:
                    continue
                if owner != os.getuid():
                    raise OwnershipError("the listener belongs to another user")
                address, _, port = fields[1].rpartition(":")
                if not loopback(address):
                    # A managed server binds loopback only; anything else is
                    # some other socket this process happens to hold.
                    continue
                ports.add(int(port, 16))
    return ports


def lsof_listening_ports(pid: int) -> set[int]:
    lsof = "/usr/sbin/lsof" if Path("/usr/sbin/lsof").is_file() else shutil.which("lsof")
    if not lsof:
        raise OwnershipError("lsof is unavailable")
    output = bounded_output([
        lsof, "-nP", "-a", "-p", str(pid), "-iTCP", "-sTCP:LISTEN", "-F0pun",
    ])
    ports: set[int] = set()
    current_pid = None
    owner = None
    for field in output.split(b"\0"):
        field = field.lstrip(b"\n")
        if not field:
            continue
        marker, value = field[:1], field[1:]
        if marker == b"p":
            current_pid = int(value)
            if current_pid != pid:
                raise OwnershipError("listener output belongs to another process")
        elif marker == b"u":
            owner = int(value)
            if owner != os.getuid():
                raise OwnershipError("listener output belongs to another user")
        elif marker == b"n":
            if current_pid != pid or owner != os.getuid():
                raise OwnershipError("listener output has no verified process owner")
            match = LISTEN_ADDRESS.fullmatch(os.fsdecode(value))
            if match and match["host"] == LOOPBACK:
                ports.add(int(match["port"]))
    if current_pid != pid or owner != os.getuid():
        raise OwnershipError("listener output has no verified process owner")
    return ports


def listening_ports(pid: int) -> set[int]:
    if sys.platform.startswith("linux"):
        return linux_listening_ports(pid)
    if sys.platform == "darwin":
        return lsof_listening_ports(pid)
    raise OwnershipError("listener inspection is unsupported on this platform")


def owned_listener(host: Any, pane_id: str) -> tuple[int, int]:
    """(pid, port) for the single loopback listener this pane's TUI owns."""
    pid, requested = foreground_process(host, pane_id)
    try:
        ports = listening_ports(pid)
    except (OwnershipError, OSError, ValueError) as error:
        raise OwnershipError(f"the pane's OpenCode listener could not be verified: {error}")
    if requested:
        # An explicit non-zero port must be the one the process actually holds.
        ports = {port for port in ports if port == requested}
    if len(ports) != 1:
        raise OwnershipError("the pane's OpenCode process has no single loopback listener")
    return pid, next(iter(ports))


def request_json(
    port: int,
    path: str,
    credential: ServerCredential | None,
    directory: str,
    *,
    method: str,
    payload: dict[str, Any] | None = None,
    parse: bool = True,
    max_response: int = MAX_RESPONSE,
) -> tuple[int, Any]:
    """Loopback request with no proxy, no redirects and a bounded body.

    ``credential`` is optional so the unauthenticated probe below can use the
    same restrictions. A refusal's body is never read, parsed or reported.
    """
    if (
        not path.startswith("/")
        or any(character in path for character in " \r\n")
        or type(max_response) is not int
        or not 0 < max_response <= 16 * 1024 * 1024
        or method not in ("GET", "POST")
        or (method == "GET" and payload is not None)
    ):
        raise BridgeError("OPENCODE_API_UNAVAILABLE", "Invalid OpenCode API path.")
    headers = {"Accept": "application/json", "x-opencode-directory": directory}
    if credential is not None:
        headers["Authorization"] = credential.authorization()
    data = None
    if payload is not None:
        try:
            data = json.dumps(
                payload, ensure_ascii=True, allow_nan=False,
                separators=(",", ":"),
            ).encode()
        except (TypeError, ValueError) as error:
            raise BridgeError(
                "INVALID_OPENCODE_REQUEST", "OpenCode request data is invalid."
            ) from error
        headers["Content-Type"] = "application/json"
    request = Request(
        f"http://{LOOPBACK}:{port}{path}", data=data, headers=headers, method=method,
    )
    opener = build_opener(ProxyHandler({}), NoRedirect())
    try:
        with opener.open(request, timeout=REQUEST_TIMEOUT) as response:
            raw = response.read(max_response + 1)
            status = response.status
    except HTTPError as error:
        # The body of a refusal is never read, parsed or reported.
        with contextlib.suppress(Exception):
            error.close()
        return error.code, None
    except (OSError, URLError, ValueError) as error:
        raise BridgeError(
            "OPENCODE_API_UNAVAILABLE",
            "The OpenCode server for this agent could not be reached.",
        ) from error
    if len(raw) > max_response:
        raise BridgeError(
            "OPENCODE_API_UNAVAILABLE", "The OpenCode server returned an oversized response."
        )
    if not parse:
        return status, None
    if not raw:
        return status, None
    try:
        return status, json.loads(raw)
    except ValueError as error:
        raise BridgeError(
            "OPENCODE_API_UNAVAILABLE", "The OpenCode server returned an unreadable response."
        ) from error


def get(
    port: int,
    path: str,
    credential: ServerCredential | None,
    directory: str,
    *,
    parse: bool = True,
    max_response: int = MAX_RESPONSE,
) -> tuple[int, Any]:
    return request_json(
        port, path, credential, directory, method="GET",
        parse=parse, max_response=max_response,
    )


def post(
    binding: ServerBinding,
    path: str,
    payload: dict[str, Any] | None = None,
    *,
    parse: bool = True,
    max_response: int = MAX_RESPONSE,
) -> tuple[int, Any]:
    return request_json(
        binding.port, path, binding.credential, binding.cwd,
        method="POST", payload=payload, parse=parse, max_response=max_response,
    )


def demands_credential(port: int, directory: str) -> bool:
    """Whether this listener refuses a request that carries no credential.

    A managed server is started with a username and password, so the only
    correct answer to an unauthenticated request is 401. A 200, a redirect, a
    404 or anything else means whatever is listening is not provably the
    password-protected server this bridge started, and it must never be
    offered the agent's credential -- a port can be inherited, reused, or
    simply collided with by another program owned by the same user.
    """
    try:
        # No Authorization header, and the body is neither parsed nor reported.
        status, _ = get(port, "/global/health", None, directory, parse=False)
    except BridgeError:
        return False
    return status == 401


def verify(
    port: int, credential: ServerCredential, session_id: str
) -> tuple[str, str] | None:
    """(version, directory) when the server is the one this record describes."""
    directory = credential.cwd
    if not demands_credential(port, directory):
        return None
    status, health = get(port, "/global/health", credential, directory)
    if status != 200 or not isinstance(health, dict):
        return None
    if health.get("healthy") is not True or not supported_version(health.get("version")):
        return None
    status, session = get(port, "/session/" + session_id, credential, directory)
    if status != 200 or not isinstance(session, dict):
        return None
    if session.get("id") != session_id:
        return None
    reported = session.get("directory")
    if not isinstance(reported, str) or not reported:
        return None
    try:
        if Path(reported).resolve() != Path(directory).resolve():
            return None
    except OSError:
        return None
    return str(health["version"]), reported


def resolve(
    host: Any, pane_id: str, session_id: Any, credential: ServerCredential | None
) -> ServerBinding | None:
    """Verify a stored claim end to end, or report no binding at all.

    A stale record, a replaced process, a collided listener, a refused
    credential or an unknown session all produce ``None``: the caller must not
    advertise or use an API for this snapshot. None of these on their own mean
    the record is wrong, so none of them delete it.
    """
    if credential is None or not isinstance(pane_id, str) or not pane_id:
        return None
    if not valid_session_id(session_id) or credential.pane_id != pane_id:
        return None
    try:
        pid, port = owned_listener(host, pane_id)
    except (OwnershipError, BridgeError, OSError, ValueError):
        return None
    try:
        verified = verify(port, credential, session_id)
    except BridgeError:
        return None
    if verified is None:
        return None
    version, directory = verified
    return ServerBinding(
        pane_id=pane_id, pid=pid, port=port, cwd=directory,
        session_id=session_id, version=version, credential=credential,
    )
