"""Read and answer OpenCode's live question dialog from the blocked TUI.

Pending questions live in the TUI process, not SQLite. Copilot's clamped-list
keystrokes wrap here and always submit the first row, so answering is native.
This TUI path is temporary until OpenCode's session-bound HTTP/SSE reply API
is owned by Remodr.
"""
from __future__ import annotations

import hashlib
import re
import time
from typing import Any, TYPE_CHECKING

from ...errors import BridgeError
from ..base import ProviderHost

if TYPE_CHECKING:
    from ...bridge import Bridge

QUESTION_HEADER = re.compile(r"^\s*(.+?)\s+esc\s*$")
SKIP = re.compile(r"^(search|type your own answer|other)$", re.IGNORECASE)
CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
SGR = re.compile(r"\x1b\[([0-9;]*)m")
FREEFORM = "Type your own answer"
POLL_ATTEMPTS = 12
BULLET = re.compile(r"^[●○•]\s*")


def _unverified() -> BridgeError:
    return BridgeError(
        "QUESTION_DIALOG_UNVERIFIED",
        "OpenCode's highlighted answer could not be verified. Check the terminal and retry.",
    )


def _option_labels(request: dict[str, Any] | None) -> tuple[str, ...]:
    if request is None:
        return ()
    labels: list[str] = []
    for option in request.get("options", []):
        if isinstance(option, dict) and isinstance(option.get("label"), str) and option["label"]:
            labels.append(option["label"])
    return tuple(labels)


def _option_index(request: dict[str, Any] | None, selected_ids: list[Any]) -> int | None:
    if request is None or len(selected_ids) != 1:
        return None
    return next(
        (
            position
            for position, option in enumerate(request.get("options", []))
            if isinstance(option, dict) and option.get("id") == selected_ids[0]
        ),
        None,
    )


def _sgr_skip(kind: int) -> int:
    return 4 if kind == 2 else 2


def _line_style(raw: str) -> tuple[str, tuple[object, ...]]:
    plain = ""
    bold = reverse = underline = False
    background: tuple[int, ...] | None = None
    foreground: tuple[int, ...] | None = None
    offset = 0
    marked: set[tuple[object, ...]] = set()

    def mark(chunk: str) -> None:
        if chunk.strip():
            marked.add((bold, reverse, underline, background, foreground))

    for match in SGR.finditer(raw):
        chunk = raw[offset:match.start()]
        plain += chunk
        mark(chunk)
        codes = [int(value) if value else 0 for value in match[1].split(";")]
        index = 0
        while index < len(codes):
            code = codes[index]
            if code == 0:
                bold = reverse = underline = False
                background = foreground = None
            elif code == 1:
                bold = True
            elif code == 4:
                underline = True
            elif code == 7:
                reverse = True
            elif code == 22:
                bold = False
            elif code == 24:
                underline = False
            elif code == 27:
                reverse = False
            elif code == 39:
                foreground = None
            elif code == 49:
                background = None
            elif code in (38, 48, 58):
                if index + 1 >= len(codes) or codes[index + 1] not in (2, 5):
                    index += 1
                    continue
                count = _sgr_skip(codes[index + 1])
                value = tuple(codes[index + 1:index + count + 1])
                if code == 48:
                    background = value
                elif code == 38:
                    foreground = value
                index += count
            elif 40 <= code <= 47 or 100 <= code <= 107:
                background = (code,)
            elif 30 <= code <= 37 or 90 <= code <= 97:
                foreground = (code,)
            index += 1
        offset = match.end()
    chunk = raw[offset:]
    plain += chunk
    mark(chunk)
    style = next(iter(marked), (False, False, False, None, None))
    return plain, style


def _is_highlight(style: tuple[object, ...]) -> bool:
    bold, reverse, underline, background, _foreground = style
    return bool(reverse or background or underline or bold)


def focused_choice(text: str, names: tuple[str, ...]) -> int | None:
    rows: list[tuple[int, tuple[object, ...], bool]] = []
    last: int | None = None
    for raw in text.splitlines():
        plain, style = _line_style(raw)
        value = BULLET.sub("", plain.strip())
        if not value or value.startswith("┃"):
            continue
        if value in names:
            last = names.index(value)
            rows.append((last, style, bool(BULLET.match(plain.strip()))))
            continue
        if last is not None and not SKIP.fullmatch(value) and _is_highlight(style):
            rows.append((last, style, False))
    highlighted = [index for index, style, bullet in rows if bullet or _is_highlight(style)]
    unique = list(dict.fromkeys(highlighted))
    if len(unique) == 1:
        return unique[0]
    styles = {index: style for index, style, _bullet in rows}
    if len(styles) < 2:
        return None
    counts: dict[tuple[object, ...], int] = {}
    for style in styles.values():
        counts[style] = counts.get(style, 0) + 1
    rares = [index for index, style in styles.items() if counts[style] == 1]
    return rares[0] if len(rares) == 1 else None


def _read_dialog(host: Bridge, agent: dict[str, Any]) -> str:
    result = host._herdr_request("agent.read", {
        "target": agent["paneId"],
        "source": "visible",
        "format": "ansi",
        "strip_ansi": False,
        "lines": 80,
    })
    read = result.get("read") if isinstance(result, dict) else None
    text = read.get("text") if isinstance(read, dict) else None
    if not isinstance(text, str) or len(text) > 100_000:
        raise _unverified()
    return text


def _wait_focus(host: Bridge, agent: dict[str, Any], names: tuple[str, ...]) -> int | None:
    readable = False
    for attempt in range(POLL_ATTEMPTS):
        if attempt:
            time.sleep(host.dialog_settle_seconds)
        try:
            focused = focused_choice(_read_dialog(host, agent), names)
            readable = True
        except BridgeError as error:
            if error.code != "QUESTION_DIALOG_UNVERIFIED":
                raise
            focused = None
        if focused is not None:
            return focused
        if readable and attempt >= 1:
            return None
    return None


def _move_to(host: Bridge, agent: dict[str, Any], names: tuple[str, ...], target: int) -> None:
    current = _wait_focus(host, agent, names)
    if current is None:
        current = 0
    steps = 0
    while current != target:
        if steps > len(names):
            raise _unverified()
        key = "down" if target > current else "up"
        host._send_keys(agent, [key])
        nxt = _wait_focus(host, agent, names)
        if nxt is None:
            remaining = abs(target - current) - 1
            if remaining > 0:
                for _ in range(remaining):
                    host._send_keys(agent, [key])
                    time.sleep(host.dialog_settle_seconds)
            return
        if nxt != current + (1 if key == "down" else -1):
            raise _unverified()
        current = nxt
        steps += 1


def answer_dialog(
    host: Bridge,
    agent: dict[str, Any],
    request: dict[str, Any] | None,
    selected_ids: list[Any],
    text: str,
) -> None:
    """Temporary: drive OpenCode's question list from verified TUI focus."""
    labels = _option_labels(request)
    index = _option_index(request, selected_ids)
    if index is not None:
        if labels:
            _move_to(host, agent, labels, index)
        host._send_keys(agent, ["enter"])
        return
    if labels:
        names = (*labels, FREEFORM)
        _move_to(host, agent, names, len(labels))
        host._send_keys(agent, ["enter"])
        time.sleep(host.dialog_settle_seconds)
    host._send_keys(agent, host._text_keys(text))
    time.sleep(host.dialog_settle_seconds)
    host._send_keys(agent, ["enter"])


def live_question(host: ProviderHost, agent: dict[str, Any]) -> dict[str, Any] | None:
    if str(agent.get("status") or agent.get("agent_status") or "").lower() != "blocked":
        return None
    try:
        result = host._herdr_request("agent.read", {
            "target": agent["paneId"],
            "source": "visible",
            "format": "text",
            "strip_ansi": True,
            "lines": 80,
        })
    except BridgeError:
        return _blocked_fallback(agent)
    read = result.get("read") if isinstance(result, dict) else None
    text = read.get("text") if isinstance(read, dict) else None
    if not isinstance(text, str) or CONTROL.search(text):
        return _blocked_fallback(agent)
    parsed = parse_dialog(str(agent.get("providerSessionId") or agent["id"]), text)
    return parsed or _blocked_fallback(agent, text)


def _blocked_fallback(agent: dict[str, Any], text: str = "") -> dict[str, Any] | None:
    for line in text.splitlines():
        match = QUESTION_HEADER.fullmatch(line.strip())
        if match and match.group(1).strip().lower() in ("select variant", "commands", "permissions"):
            return None
    session_id = str(agent.get("providerSessionId") or agent["id"])
    return {
        "id": f"opencode:tui:{session_id}:blocked",
        "kind": "text",
        "question": "OpenCode is waiting for input.",
        "options": [],
        "allowCustomAnswer": True,
        "multiSelect": False,
    }


def parse_dialog(session_id: str, text: str) -> dict[str, Any] | None:
    lines = [line.rstrip() for line in text.splitlines()]
    headers = [index for index, line in enumerate(lines) if QUESTION_HEADER.fullmatch(line.strip())]
    if len(headers) != 1:
        return None
    title = QUESTION_HEADER.fullmatch(lines[headers[0]].strip())
    if title is None:
        return None
    header = title.group(1).strip()
    if header.lower() in ("select variant", "commands", "permissions"):
        return None
    blocks: list[list[str]] = []
    current: list[str] = []
    for line in lines[headers[0] + 1:]:
        value = line.strip()
        if value.startswith("┃"):
            break
        if not value:
            if current:
                blocks.append(current)
                current = []
            continue
        if SKIP.fullmatch(value):
            break
        current.append(value)
    if current:
        blocks.append(current)
    if not blocks:
        question, option_lines = header, []
    elif len(blocks) == 1 and (len(blocks[0]) != 1 or not blocks[0][0].endswith("?")):
        question, option_lines = header, blocks[0]
    else:
        question, option_lines = " ".join(blocks[0]), [item for block in blocks[1:] for item in block]
    if not question or question.lower() in ("search",):
        return None
    options: list[dict[str, str]] = []
    index = 0
    while index < len(option_lines):
        label = option_lines[index]
        option = {"id": label, "label": label}
        nxt = option_lines[index + 1] if index + 1 < len(option_lines) else ""
        if nxt and (len(nxt) > len(label) or (nxt[:1].islower() and label[:1].isupper())):
            option["description"] = nxt
            index += 2
        else:
            index += 1
        options.append(option)
    digest = hashlib.sha1(f"{session_id}:{question}:{','.join(item['label'] for item in options)}".encode()).hexdigest()[:16]
    return {
        "id": f"opencode:tui:{digest}",
        "kind": "choice" if options else "text",
        "question": question,
        "options": options,
        "allowCustomAnswer": True,
        "multiSelect": False,
    }


def _option(line: str) -> dict[str, str] | None:
    value = re.sub(r"^[●○•]\s*", "", line.strip())
    if not value or SKIP.fullmatch(value) or value.startswith("┃") or len(value) > 80:
        return None
    if value.endswith("esc") or " · " in value:
        return None
    return {"id": value, "label": value}
