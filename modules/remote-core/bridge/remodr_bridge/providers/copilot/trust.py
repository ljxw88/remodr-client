"""Persist Copilot's supported, workspace-scoped trustedFolders setting."""
from __future__ import annotations

import fcntl
import json
import os
import stat
import threading
import time
import uuid
from pathlib import Path

from ...errors import BridgeError


_CONFIG = "config.json"
_LOCK = ".remodr-workspace-trust.lock"
_LOCK_TIMEOUT = 2.0
_THREAD_LOCK = threading.Lock()


def _error(detail: str) -> BridgeError:
    return BridgeError(
        "COPILOT_TRUST_UNAVAILABLE",
        f"Cannot persist Copilot workspace trust: {detail} "
        "Check the workspace and ${COPILOT_HOME:-~/.copilot}/config.json, "
        "preserve existing configuration, and retry.",
    )


def _workspace(cwd: str) -> str:
    if not isinstance(cwd, str) or not os.path.isabs(cwd):
        raise _error("an existing absolute project directory is required.")
    try:
        path = Path(cwd).resolve(strict=True)
        if not path.is_dir() or path == Path(path.anchor):
            raise _error("the project must be a directory other than the filesystem root.")
        return str(path)
    except (OSError, ValueError, RuntimeError):
        raise _error("the project directory cannot be resolved; check that it exists.") from None


def _open_home() -> int:
    home = Path(os.path.abspath(os.path.expanduser(
        os.environ.get("COPILOT_HOME") or str(Path.home() / ".copilot")
    )))
    fd = os.open(home.anchor, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        # Walk with directory descriptors so even intermediate symlinks cannot
        # redirect configuration writes to an unintended location.
        for part in home.parts[1:]:
            try:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            except FileNotFoundError:
                try:
                    os.mkdir(part, 0o700, dir_fd=fd)
                except FileExistsError:
                    pass
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        info = os.fstat(fd)
        if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o022:
            raise _error("the Copilot home must be user-owned and not writable by other users.")
        return fd
    except BaseException:
        os.close(fd)
        raise


def _regular(info: os.stat_result) -> None:
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
        raise _error("configuration and lock files must be user-owned, single-link regular files.")


def _version(info: os.stat_result) -> tuple:
    return (
        info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns,
        info.st_ctime_ns, info.st_mode, info.st_uid, info.st_nlink,
    )


def _read_config(directory: int) -> tuple[bytes | None, tuple | None]:
    try:
        fd = os.open(_CONFIG, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    except FileNotFoundError:
        return None, None
    with os.fdopen(fd, "rb") as stream:
        before = os.fstat(stream.fileno())
        _regular(before)
        data = stream.read()
        after = os.fstat(stream.fileno())
        current = os.stat(_CONFIG, dir_fd=directory, follow_symlinks=False)
        if _version(before) != _version(after) or _version(current) != _version(after):
            raise _error("configuration changed while being read; close other configuration writers.")
        return data, _version(after)


def _object(pairs: list) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _invalid_constant(value: str) -> None:
    raise ValueError("non-JSON constant")


def _without_comments(text: str) -> str:
    characters = list(text)
    index = 0
    while index < len(text):
        if text[index] == '"':
            index += 1
            while index < len(text):
                if text[index] == "\\":
                    index += 2
                elif text[index] == '"':
                    index += 1
                    break
                else:
                    index += 1
        elif text.startswith("//", index) or text.startswith("/*", index):
            start = index
            if text.startswith("//", index):
                while index < len(text) and text[index] not in "\r\n":
                    index += 1
            else:
                end = text.find("*/", index + 2)
                if end == -1:
                    raise ValueError("unterminated JSONC comment")
                index = end + 2
            for position in range(start, index):
                if text[position] not in "\r\n":
                    characters[position] = " "
        else:
            index += 1
    return "".join(characters)


def _without_trailing_commas(text: str) -> str:
    characters = list(text)
    index = 0
    previous = ""
    while index < len(text):
        character = text[index]
        if character == '"':
            index += 1
            while index < len(text):
                if text[index] == "\\":
                    index += 2
                elif text[index] == '"':
                    index += 1
                    break
                else:
                    index += 1
            previous = '"'
            continue
        if character == ",":
            following = index + 1
            while following < len(text) and text[following] in " \t\r\n":
                following += 1
            if (
                following < len(text) and text[following] in "]}"
                and previous and previous not in "[{,:"
            ):
                characters[index] = " "
        if character not in " \t\r\n":
            previous = character
        index += 1
    return "".join(characters)


def _parse(data: bytes | None) -> dict:
    if data is None:
        return {}
    try:
        config = json.loads(
            _without_trailing_commas(_without_comments(data.decode("utf-8"))),
            object_pairs_hook=_object, parse_constant=_invalid_constant,
        )
    except (ValueError, UnicodeError, RecursionError):
        raise _error("configuration is not valid UTF-8 JSONC; repair it without discarding its contents.") from None
    if not isinstance(config, dict):
        raise _error("configuration must contain a JSON object.")
    folders = config.get("trustedFolders", [])
    if not isinstance(folders, list) or any(not isinstance(folder, str) for folder in folders):
        raise _error("trustedFolders must be a JSON list of directory strings.")
    return config


def _updated_text(data: bytes | None, folders: list[str]) -> str:
    replacement = json.dumps(folders, ensure_ascii=True)
    if data is None:
        return '{\n  "trustedFolders": ' + replacement + "\n}\n"
    text = data.decode("utf-8")
    uncommented = _without_comments(text)
    sanitized = _without_trailing_commas(uncommented)
    decoder = json.JSONDecoder()

    def skip_space(index: int) -> int:
        while index < len(sanitized) and sanitized[index] in " \t\r\n":
            index += 1
        return index

    # Validation has already established an object with unique keys. Sanitizing
    # replaces characters with spaces, so decoder offsets address the original.
    index = skip_space(skip_space(0) + 1)
    last_value_end = None
    while sanitized[index] != "}":
        key, end = decoder.raw_decode(sanitized, index)
        start = skip_space(skip_space(end) + 1)
        _, end = decoder.raw_decode(sanitized, start)
        if key == "trustedFolders":
            return text[:start] + replacement + text[end:]
        last_value_end = end
        index = skip_space(end)
        if sanitized[index] == ",":
            index = skip_space(index + 1)
    prefix = text[:index]
    if last_value_end is not None and "," not in uncommented[last_value_end:index]:
        prefix = text[:last_value_end] + "," + text[last_value_end:index]
    return prefix + '\n  "trustedFolders": ' + replacement + "\n" + text[index:]


def _acquire_lock(directory: int) -> int:
    flags = os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK
    try:
        fd = os.open(_LOCK, flags, dir_fd=directory)
    except FileNotFoundError:
        try:
            fd = os.open(_LOCK, flags | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=directory)
        except FileExistsError:
            fd = os.open(_LOCK, flags, dir_fd=directory)
    try:
        info = os.fstat(fd)
        _regular(info)
        if stat.S_IMODE(info.st_mode) != 0o600:
            raise _error("the workspace trust lock must have private (0600) permissions.")
        deadline = time.monotonic() + _LOCK_TIMEOUT
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise _error("configuration is busy; wait for the other workspace launch to finish.")
                time.sleep(0.025)
        current = os.stat(_LOCK, dir_fd=directory, follow_symlinks=False)
        if _version(current) != _version(info):
            raise _error("the workspace trust lock changed; close other configuration writers.")
        return fd
    except BaseException:
        os.close(fd)
        raise


def _write_config(directory: int, text: str, original: tuple) -> None:
    name = f".remodr-config-{uuid.uuid4().hex}"
    fd = os.open(
        name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory,
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        # The sidecar serializes bridge writers. Copilot itself need not honor
        # it: this check detects earlier edits, but cannot eliminate an external
        # writer's race between the final check and replacement of an old file.
        if _read_config(directory) != original:
            raise _error("configuration changed before saving; close other configuration writers.")
        if original[0] is None:
            # Creating a new config can additionally use an atomic no-clobber
            # operation, including against writers that ignore our lock.
            os.link(name, _CONFIG, src_dir_fd=directory, dst_dir_fd=directory, follow_symlinks=False)
            os.unlink(name, dir_fd=directory)
        else:
            os.replace(name, _CONFIG, src_dir_fd=directory, dst_dir_fd=directory)
        os.fsync(directory)
    finally:
        try:
            os.unlink(name, dir_fd=directory)
        except FileNotFoundError:
            pass


def _persist_workspace(workspace: str) -> None:
    directory = lock = None
    try:
        directory = _open_home()
        lock = _acquire_lock(directory)
        original = _read_config(directory)
        config = _parse(original[0])
        folders = list(dict.fromkeys([*config.get("trustedFolders", []), workspace]))
        if folders == config.get("trustedFolders") and original[1] is not None:
            if stat.S_IMODE(original[1][5]) == 0o600:
                return
        text = (
            original[0].decode("utf-8")
            if folders == config.get("trustedFolders") and original[0] is not None
            else _updated_text(original[0], folders)
        )
        _write_config(directory, text, original)
    except (OSError, ValueError, RuntimeError, RecursionError):
        # Never include exception text: configuration and paths can contain
        # credentials or other sensitive user-controlled data.
        raise _error("safe configuration access failed; check ownership, permissions, and free space.") from None
    finally:
        if lock is not None:
            os.close(lock)
        if directory is not None:
            os.close(directory)


def trust_workspace(cwd: str) -> None:
    """Trust only an existing canonical project directory, or raise BridgeError.

    This updates trustedFolders, not tool/path allowances. Existing malformed or
    unsafe configuration is never replaced with an empty configuration.
    """
    workspace = _workspace(cwd)
    # Serialize home/sidecar creation as well as updates within this process;
    # flock only starts protecting the operation after opening the sidecar.
    if not _THREAD_LOCK.acquire(timeout=_LOCK_TIMEOUT):
        raise _error("configuration is busy; wait for the other workspace launch to finish.")
    try:
        _persist_workspace(workspace)
    finally:
        _THREAD_LOCK.release()
