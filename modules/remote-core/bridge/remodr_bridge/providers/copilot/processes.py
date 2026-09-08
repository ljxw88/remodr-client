"""Bounded foreground-process and descriptor verification on Linux and macOS."""
from __future__ import annotations

import os
import re
import select
import shutil
import stat
import subprocess
import sys
import time
from pathlib import Path
from typing import Any
from ..base import ProviderHost

PROCESS_INSPECTION_TIMEOUT = 2.0
PROCESS_INSPECTION_MAX_BYTES = 512 * 1024
PROCESS_INSPECTION_MAX_FDS = 4096
SESSION_ID_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}")

class CopilotProcesses:
    def __init__(self, host: ProviderHost) -> None:
        self.host = host

    def foreground_process(self, pane_id: str) -> tuple[int, int]:
        result = self.host._herdr_request("pane.process_info", {"pane_id": pane_id})
        info = result.get("process_info")
        if not isinstance(info, dict) or info.get("pane_id") != pane_id:
            raise OSError("pane process metadata is unavailable or mismatched")
        group = info.get("foreground_process_group_id")
        shell_pid = info.get("shell_pid")
        processes = info.get("foreground_processes")
        if (
            type(group) is not int or group <= 0
            or type(shell_pid) is not int or shell_pid <= 0
            or not isinstance(processes, list)
        ):
            raise OSError("pane process metadata is incomplete")
        roots = [
            item for item in processes
            if isinstance(item, dict) and type(item.get("pid")) is int
            and item["pid"] == group
        ]
        if len(roots) != 1 or group == shell_pid:
            raise ValueError("no unique foreground Copilot group leader")
        root = roots[0]
        if not sys.platform.startswith("linux"):
            if not all(
                isinstance(root.get(key), str) and Path(root[key]).name == "copilot"
                for key in ("name", "argv0")
            ):
                raise ValueError("foreground group leader is not the Copilot executable")
            return group, shell_pid

        # Linux may omit argv0 and launch through VS Code's shell/Node shims.
        # Follow only the verified foreground launch chain, not arbitrary children.
        if len(processes) > 256:
            raise OSError("foreground process list exceeds the inspection limit")
        leader = self.linux_process_metadata(group)
        if leader["group"] != group:
            raise ValueError("foreground process group changed")
        ancestor = leader["parent"]
        visited = {group}
        for _ in range(32):
            if ancestor == shell_pid:
                break
            if ancestor <= 1 or ancestor in visited:
                raise ValueError("foreground process no longer belongs to the pane shell")
            visited.add(ancestor)
            ancestor = self.linux_process_metadata(ancestor)["parent"]
        else:
            raise ValueError("foreground process ancestry could not be verified")
        # Package updates can unlink a still-running executable on Linux.
        executable = self.linux_executable_name(leader["executable"])
        if executable == "copilot":
            return group, shell_pid
        argv = leader["argv"]
        script = argv[1] if len(argv) > 1 else ""
        if (
            executable not in ("sh", "dash", "bash", "zsh", "node", "bun")
            or Path(script).name not in ("copilot", "copilotCLIShim.js")
        ):
            raise ValueError("foreground group leader is not a verified Copilot launcher")
        metadata = {group: leader}
        for process in processes:
            pid = process.get("pid") if isinstance(process, dict) else None
            if type(pid) is not int or pid <= 0 or pid == group:
                continue
            try:
                item = self.linux_process_metadata(pid)
            except FileNotFoundError:
                continue
            if item["group"] == group:
                metadata[pid] = item
        candidates = {
            pid for pid, item in metadata.items()
            if self.linux_executable_name(item["executable"]) == "copilot"
        }
        primary = []
        for pid in candidates:
            parent = metadata[pid]["parent"]
            visited = {pid}
            while parent in metadata and parent not in visited and parent not in candidates:
                if parent == group:
                    primary.append(pid)
                    break
                visited.add(parent)
                parent = metadata[parent]["parent"]
        if len(primary) != 1:
            raise ValueError("Copilot launcher has no unique foreground runtime")
        return primary[0], shell_pid

    @staticmethod
    def linux_executable_name(executable: str) -> str:
        suffix = " (deleted)"
        return Path(executable[:-len(suffix)] if executable.endswith(suffix) else executable).name

    @staticmethod
    def linux_process_metadata(pid: int) -> dict[str, Any]:
        directory = Path("/proc") / str(pid)
        if directory.stat().st_uid != os.getuid():
            raise OSError("foreground process belongs to another user")
        fields = (directory / "stat").read_text().rsplit(")", 1)[1].split()
        executable = os.readlink(directory / "exe")
        with (directory / "cmdline").open("rb") as command:
            argv = command.read(65537)
        if len(argv) > 65536:
            raise OSError("foreground command metadata exceeds the inspection limit")
        return {
            "parent": int(fields[1]),
            "group": int(fields[2]),
            "executable": executable,
            "argv": [os.fsdecode(part) for part in argv.split(b"\0") if part],
        }

    @staticmethod
    def bounded_process_output(arguments: list[str]) -> bytes:
        deadline = time.monotonic() + PROCESS_INSPECTION_TIMEOUT
        with subprocess.Popen(
            arguments, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        ) as process:
            try:
                output = bytearray()
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise OSError("process descriptor inspection timed out")
                    readable, _, _ = select.select([process.stdout], [], [], remaining)
                    if not readable:
                        raise OSError("process descriptor inspection timed out")
                    chunk = os.read(process.stdout.fileno(), 16384)
                    if not chunk:
                        break
                    output.extend(chunk)
                    if len(output) > PROCESS_INSPECTION_MAX_BYTES:
                        raise OSError("process descriptor output exceeds the size limit")
                code = process.wait(timeout=max(0.001, deadline - time.monotonic()))
                if code != 0:
                    raise OSError("process descriptor inspection was refused")
                return bytes(output)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()

    @staticmethod
    def lsof_paths(output: bytes, pid: int) -> list[str]:
        paths = []
        current_pid = None
        owner = None
        for field in output.split(b"\0"):
            field = field.lstrip(b"\n")
            if not field:
                continue
            if field[:1] == b"p":
                current_pid = int(field[1:])
                if current_pid != pid:
                    raise OSError("descriptor output belongs to another process")
            elif field[:1] == b"u":
                owner = int(field[1:])
                if owner != os.getuid():
                    raise OSError("descriptor output belongs to another user")
            elif field[:1] == b"n":
                if current_pid != pid or owner != os.getuid():
                    raise OSError("descriptor output has no verified process owner")
                paths.append(os.fsdecode(field[1:]))
        if current_pid != pid or owner != os.getuid():
            raise OSError("descriptor output has no verified process owner")
        return paths

    @staticmethod
    def linux_process_paths(pid: int) -> list[str]:
        process_dir = Path("/proc") / str(pid)
        if process_dir.stat().st_uid != os.getuid():
            raise OSError("foreground process belongs to another user")
        deadline = time.monotonic() + PROCESS_INSPECTION_TIMEOUT
        paths = []
        size = 0
        with os.scandir(process_dir / "fd") as entries:
            for index, entry in enumerate(entries):
                if index >= PROCESS_INSPECTION_MAX_FDS or time.monotonic() >= deadline:
                    raise OSError("process descriptor inspection exceeds its limit")
                if not entry.name.isdigit():
                    continue
                try:
                    path = os.readlink(entry.path)
                except FileNotFoundError:
                    continue
                size += len(os.fsencode(path))
                if size > PROCESS_INSPECTION_MAX_BYTES:
                    raise OSError("process descriptor output exceeds the size limit")
                paths.append(path)
        return paths

    def open_session_ids(self, pid: int) -> set[str]:
        if sys.platform.startswith("linux"):
            paths = self.linux_process_paths(pid)
        elif sys.platform == "darwin":
            lsof = "/usr/sbin/lsof"
            if not Path(lsof).is_file():
                lsof = shutil.which("lsof")
            if not lsof:
                raise OSError("lsof is unavailable")
            paths = self.lsof_paths(
                self.bounded_process_output([lsof, "-nP", "-a", "-p", str(pid), "-F0pun"]),
                pid,
            )
        else:
            raise OSError("process descriptor inspection is unsupported on this platform")
        root = (Path.home() / ".copilot" / "session-state").resolve()
        sessions = set()
        for value in paths:
            path = Path(value)
            if (
                path.is_absolute() and path.name == "session.db"
                and path.parent.parent == root
                and SESSION_ID_PATTERN.fullmatch(path.parent.name)
            ):
                sessions.add(path.parent.name)
        return sessions

    def process_start_time(self, pid: int) -> float:
        if sys.platform.startswith("linux"):
            fields = (Path("/proc") / str(pid) / "stat").read_text().rsplit(")", 1)[1].split()
            with Path("/proc/stat").open() as system:
                boot = next((line.split()[1] for line in system if line.startswith("btime ")), None)
            if boot is None:
                raise OSError("process boot time is unavailable")
            return int(boot) + int(fields[19]) / os.sysconf("SC_CLK_TCK")
        if sys.platform == "darwin":
            output = self.bounded_process_output([
                "/usr/bin/env", "LC_ALL=C", "/bin/ps", "-p", str(pid), "-o", "lstart=",
            ]).decode("ascii").strip()
            return time.mktime(time.strptime(output, "%a %b %d %H:%M:%S %Y"))
        raise OSError("process start time is unsupported on this platform")

    def locked_session_ids(self, pid: int) -> set[str]:
        """Copilot creates a PID-scoped marker before it writes the first turn.

        Inspect only markers for the verified foreground runtime. Old markers
        from a reused PID cannot bind a new process to a previous conversation.
        """
        started = self.process_start_time(pid)
        root = (Path.home() / ".copilot" / "session-state").resolve()
        if not root.is_dir():
            return set()
        deadline = time.monotonic() + PROCESS_INSPECTION_TIMEOUT
        sessions = set()
        with os.scandir(root) as entries:
            for index, entry in enumerate(entries):
                if index >= PROCESS_INSPECTION_MAX_FDS or time.monotonic() >= deadline:
                    raise OSError("session marker inspection exceeds its limit")
                if not SESSION_ID_PATTERN.fullmatch(entry.name) or not entry.is_dir(follow_symlinks=False):
                    continue
                marker = Path(entry.path) / f"inuse.{pid}.lock"
                try:
                    fd = os.open(marker, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                except FileNotFoundError:
                    continue
                with os.fdopen(fd, "rb") as handle:
                    info = os.fstat(handle.fileno())
                    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
                        continue
                    if info.st_mtime < started or info.st_size > 32:
                        continue
                    if handle.read(33).strip() == str(pid).encode("ascii"):
                        sessions.add(entry.name)
        return sessions
