"""Verified, session-bound navigation of OpenCode's native variant picker."""
from __future__ import annotations

from dataclasses import dataclass
import re
import time
import unicodedata
from typing import Any

from ...errors import BridgeError
from ..base import ProviderHost
from .transcript import session_id


POLL_ATTEMPTS = 12
POLL_INTERVAL = 0.1
MAX_CHOICES = 20
HEADER = re.compile(r"^\s*Select variant\s+esc\s*$")
PALETTE_HEADER = re.compile(r"^\s*Commands\s+esc\s*$")
VARIANT_COMMAND = "Switch model variant"
SGR = re.compile(r"\x1b\[([0-9;]*)m")


def _unsupported() -> BridgeError:
    return BridgeError(
        "VARIANT_PICKER_UNSUPPORTED",
        "OpenCode's complete variant picker could not be verified. Close any native "
        "dialog, enlarge the terminal, and reopen settings.",
    )


def _name(value: Any) -> bool:
    return (
        isinstance(value, str) and 0 < len(value) <= 128
        and value == value.strip()
        and not any(unicodedata.category(char).startswith("C") for char in value)
    )


@dataclass(frozen=True)
class Footer:
    token: str
    label: str
    variant: str | None
    prompt_start: int


@dataclass(frozen=True)
class Picker:
    footer: Footer
    variants: tuple[str, ...]
    current: str | None
    confirmed: bool

    def result(self) -> dict[str, Any]:
        return {
            "modelLabel": self.footer.label,
            "modelToken": self.footer.token,
            "currentVariant": self.current,
            "variants": list(self.variants),
        }


@dataclass(frozen=True)
class Palette:
    footer: Footer
    query: str
    body: tuple[str, ...]


def _styled_lines(text: str) -> tuple[list[str], list[list[bool]]]:
    lines: list[str] = []
    styles: list[list[bool]] = []
    backgrounds: list[list[tuple[int, ...] | None]] = []
    bold = False
    background: tuple[int, ...] | None = None
    for raw in text.splitlines():
        plain = ""
        flags: list[bool] = []
        colors: list[tuple[int, ...] | None] = []
        offset = 0
        for match in SGR.finditer(raw):
            chunk = raw[offset:match.start()]
            plain += chunk
            flags.extend([bold and background is not None] * len(chunk))
            colors.extend([background] * len(chunk))
            codes = [int(value) if value else 0 for value in match[1].split(";")]
            index = 0
            while index < len(codes):
                code = codes[index]
                if code == 0:
                    bold = False
                    background = None
                elif code == 1:
                    bold = True
                elif code == 22:
                    bold = False
                elif code == 49:
                    background = None
                elif code in (38, 48, 58):
                    if index + 1 >= len(codes) or codes[index + 1] not in (2, 5):
                        raise _unsupported()
                    if code == 48:
                        count = 4 if codes[index + 1] == 2 else 2
                        background = tuple(codes[index + 1:index + count + 1])
                    index += 4 if codes[index + 1] == 2 else 2
                elif 40 <= code <= 47 or 100 <= code <= 107:
                    background = (code,)
                index += 1
            offset = match.end()
        chunk = raw[offset:]
        plain += chunk
        flags.extend([bold and background is not None] * len(chunk))
        colors.extend([background] * len(chunk))
        lines.append(plain)
        styles.append(flags)
        backgrounds.append(colors)
    return _dialog_view(lines, styles, backgrounds)


def _cell_width(char: str) -> int:
    if unicodedata.combining(char):
        return 0
    return 2 if unicodedata.east_asian_width(char) in ("W", "F") else 1


def _dialog_view(
    lines: list[str], styles: list[list[bool]], backgrounds: list[list[tuple[int, ...] | None]],
) -> tuple[list[str], list[list[bool]]]:
    """Read the native modal rectangle, not the dimmed transcript behind it."""
    cells = [
        [color for char, color in zip(line, colors) for _ in range(_cell_width(char))]
        for line, colors in zip(lines, backgrounds)
    ]
    candidates = []
    for row, line in enumerate(lines):
        for match in re.finditer(r"\besc\b", line):
            color = backgrounds[row][match.start()]
            if color is None:
                continue
            left_index, right_index = match.start(), match.end()
            while left_index > 0 and backgrounds[row][left_index - 1] == color:
                left_index -= 1
            while right_index < len(line) and backgrounds[row][right_index] == color:
                right_index += 1
            if left_index == 0 or right_index == len(line):
                continue
            start = left_index + 4
            title = line[start:match.start()].rstrip()
            if not _name(title) or not all(styles[row][start:start + len(title)]):
                continue
            left = sum(_cell_width(char) for char in line[:left_index])
            right = left + sum(_cell_width(char) for char in line[left_index:right_index])
            if right_index - match.end() != 4:
                continue
            candidates.append((row, left, right, color))
    if not candidates:
        return lines, styles
    if len(candidates) != 1:
        raise _unsupported()
    row, left, right, color = candidates[0]
    footer = _footer(lines)

    def inside(index: int) -> bool:
        return len(cells[index]) >= right and cells[index][left] == color and cells[index][right - 1] == color

    top = bottom = row
    while top > 0 and inside(top - 1):
        top -= 1
    while bottom + 1 < footer.prompt_start and inside(bottom + 1):
        bottom += 1
    if bottom >= footer.prompt_start or bottom <= row:
        raise _unsupported()
    rendered, flags = [], []
    for index, line in enumerate(lines):
        if index >= footer.prompt_start:
            rendered.append(line)
            flags.append(styles[index])
            continue
        if not top <= index <= bottom:
            rendered.append("")
            flags.append([])
            continue
        column = 0
        visible, active = [], []
        for char, focused in zip(line, styles[index]):
            width = _cell_width(char)
            keep = left <= column and column + width <= right
            visible.append(char if keep else " " * width)
            active.extend([focused] if keep else [False] * width)
            column += width
        rendered.append("".join(visible))
        flags.append(active)
    return rendered, flags


def _plain_view(text: str) -> str:
    return "\n".join(_styled_lines(text)[0])


def _dialog_body(lines: list[str], footer: Footer, header: re.Pattern[str], query: str) -> tuple[int, int]:
    headers = [index for index, line in enumerate(lines) if header.fullmatch(line)]
    if len(headers) != 1 or headers[0] >= footer.prompt_start:
        raise _unsupported()
    index = headers[0] + 1
    if index >= footer.prompt_start or lines[index].strip():
        raise _unsupported()
    while index < footer.prompt_start and not lines[index].strip():
        index += 1
    if index >= footer.prompt_start or lines[index].strip() != query:
        raise _unsupported()
    index += 1
    if index >= footer.prompt_start or lines[index].strip():
        raise _unsupported()
    while index < footer.prompt_start and not lines[index].strip():
        index += 1
    end = footer.prompt_start
    while end > index and not lines[end - 1].strip():
        end -= 1
    if footer.prompt_start - end < 2:
        raise _unsupported()
    return index, end


def _palette(text: str, query: str) -> Palette:
    lines = text.splitlines()
    footer = _footer(lines)
    start, end = _dialog_body(lines, footer, PALETTE_HEADER, query)
    body = tuple(line.strip() for line in lines[start:end])
    if not body or (query != "Search" and body not in (("Agent", VARIANT_COMMAND), ("No results found",))):
        raise _unsupported()
    return Palette(footer, query, body)


def _focused(text: str, names: tuple[str, ...], *, palette: bool = False) -> int | None:
    lines, styles = _styled_lines(text)
    footer = _footer(lines)
    start, end = _dialog_body(
        lines, footer, PALETTE_HEADER if palette else HEADER,
        VARIANT_COMMAND if palette else "Search",
    )
    focused: list[int] = []
    for row in range(start, end):
        label = lines[row].strip()
        if label.startswith("● "):
            label = label[1:].lstrip()
        if label not in names:
            continue
        column = lines[row].rfind(label)
        if all(styles[row][column:column + len(label)]):
            focused.append(names.index(label))
    if len(focused) > 1:
        raise _unsupported()
    return focused[0] if focused else None


def _footer(lines: list[str]) -> Footer:
    candidates = [index for index, line in enumerate(lines) if re.match(r"^\s*┃\s+\S.* · ", line)]
    if not candidates:
        raise _unsupported()
    index = candidates[-1]
    content = lines[index].strip().removeprefix("┃").strip()
    # Session screens put a right-aligned cwd beside the model/variant;
    # empty sessions omit it. It is chrome, not part of either identifier.
    content = re.split(r"\s{2,}(?=~(?:/|$)|/|[A-Za-z]:[\\/])", content, maxsplit=1)[0].rstrip()
    parts = content.split(" · ")
    if len(parts) not in (2, 3) or not all(_name(part) for part in parts):
        raise _unsupported()
    start = index
    while start > 0 and lines[start - 1].lstrip().startswith("┃"):
        start -= 1
    if index - start < 3:
        raise _unsupported()
    if any(line.strip() != "┃" for line in lines[start:index]):
        raise BridgeError(
            "VARIANT_DRAFT_PRESENT",
            "OpenCode has a native draft or attachment. Send or remove it in the terminal "
            "before changing variants; your app draft has not been changed.",
        )
    return Footer(" · ".join(parts[:2]), parts[1], parts[2] if len(parts) == 3 else None, start)


def parse_picker(text: str) -> Picker:
    lines = text.splitlines()
    if "\t" in text:
        raise _unsupported()
    footer = _footer(lines)
    headers = [index for index, line in enumerate(lines) if HEADER.fullmatch(line)]
    if len(headers) != 1 or headers[0] >= footer.prompt_start:
        raise _unsupported()
    title_right = len(lines[headers[0]].rstrip())
    index = headers[0] + 1
    if index >= len(lines) or lines[index].strip():
        raise _unsupported()
    while index < footer.prompt_start and not lines[index].strip():
        index += 1
    if index >= footer.prompt_start or lines[index].strip() != "Search":
        raise _unsupported()
    index += 1
    if index >= footer.prompt_start or lines[index].strip():
        raise _unsupported()
    while index < footer.prompt_start and not lines[index].strip():
        index += 1
    choices: list[str] = []
    selected: list[str] = []
    column: int | None = None
    marker_columns: list[tuple[int, int]] = []
    while index < footer.prompt_start and lines[index].strip():
        value = lines[index].strip()
        marked = value.startswith("● ")
        indent = len(lines[index]) - len(lines[index].lstrip())
        title_column = indent
        if marked:
            label = value[1:].lstrip()
            # The current marker occupies the native gutter, not the title column.
            marker_columns.append((indent, indent + len(value) - len(label)))
            title_column += len(value) - len(label)
            value = label
        else:
            if column is not None and indent != column:
                raise _unsupported()
            column = indent
        if not _name(value) or any(char in value for char in ("●", "…", "┃", "│", "↑", "↓")):
            raise _unsupported()
        width = sum(
            0 if unicodedata.combining(char) else
            2 if unicodedata.east_asian_width(char) in ("W", "F", "A") else 1
            for char in value
        )
        # The title's right edge shares the header's four-cell right inset.
        # Native overflow can clip without an ellipsis, so a full-width title
        # (or the source's 61-character truncation limit) is not authoritative.
        if title_column + width >= title_right or len(value) >= 61:
            raise _unsupported()
        choices.append(value)
        if marked:
            selected.append(value)
        index += 1
    if (
        not choices or choices[0] != "Default" or len(choices) > MAX_CHOICES
        or len(set(choices)) != len(choices) or "default" in choices[1:] or len(selected) > 1
        or (column is not None and any(column not in positions for positions in marker_columns))
        # 1.18.29 caps DialogSelect at floor(terminal height / 2) - 6 and
        # hides its scrollbar. A full-height list cannot prove its last item.
        or len(choices) >= len(lines) // 2 - 6
        or footer.prompt_start - index < 2
        or any(line.strip() for line in lines[index:footer.prompt_start])
    ):
        raise _unsupported()
    current = None if not selected or selected[0] == "Default" else selected[0]
    if footer.variant != current:
        raise _unsupported()
    return Picker(footer, tuple(choices[1:]), current, bool(selected))


class OpenCodeVariants:
    def __init__(self, host: ProviderHost, payload: dict[str, Any]) -> None:
        self.host = host
        self.agent = dict(host._require_agent(payload))
        requested = payload.get("providerSessionId")
        if (
            self.agent.get("provider") != "opencode" or not session_id(requested)
            or requested != self.agent.get("providerSessionId")
            or not isinstance(self.agent.get("paneId"), str) or not self.agent["paneId"]
            or not isinstance(self.agent.get("terminal_id"), str) or not self.agent["terminal_id"]
            or host.sessions.identity_error(self.agent["paneId"]) is not None
        ):
            raise BridgeError(
                "VARIANT_SESSION_CHANGED", "The OpenCode session cannot be verified. Refresh and reopen settings.",
            )
        self.owned: Picker | None = None
        self.owned_palette: Palette | None = None

    def _request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        try:
            result = self.host._herdr_request(method, params)
        except BridgeError as error:
            raise BridgeError(
                "VARIANT_UNAVAILABLE",
                "OpenCode's terminal could not be verified. Check the terminal and reopen settings.",
            ) from error
        if not isinstance(result, dict):
            raise _unsupported()
        return result

    def _live(self) -> None:
        result = self._request("agent.get", {"target": self.agent["paneId"]})
        live = result.get("agent")
        native = live.get("agent_session") if isinstance(live, dict) else None
        if (
            not isinstance(live, dict) or not isinstance(native, dict)
            or native.get("value") != self.agent["providerSessionId"]
            or live.get("pane_id") != self.agent["paneId"]
            or live.get("terminal_id") != self.agent["terminal_id"]
            or live.get("agent") not in ("opencode", "herdr:opencode")
        ):
            raise BridgeError(
                "VARIANT_SESSION_CHANGED", "The OpenCode session or terminal changed. Refresh and reopen settings.",
            )
        if live.get("agent_status") not in ("idle", "done"):
            raise BridgeError(
                "VARIANT_BUSY", "Wait until OpenCode is idle and has no pending question before changing variants.",
            )

    def _read(self, *, ansi: bool = False) -> str:
        self._live()
        result = self._request("agent.read", {
            "target": self.agent["paneId"], "source": "visible",
            "format": "ansi", "strip_ansi": False, "lines": 120,
        })
        read = result.get("read")
        text = read.get("text") if isinstance(read, dict) else None
        if (
            not isinstance(text, str) or len(text) > 100_000 or len(text.splitlines()) >= 120
            or any(ord(char) < 32 and char not in "\n\r\t" for char in SGR.sub("", text))
            or read.get("truncated") is True
        ):
            raise _unsupported()
        self._live()
        return text if ansi else _plain_view(text)

    @staticmethod
    def _model(footer: Footer, token: str | None) -> None:
        if token is not None and footer.token != token:
            raise BridgeError(
                "VARIANT_MODEL_CHANGED", "OpenCode's model changed. Reopen settings to load its current variants.",
            )

    def _empty_prompt(self, text: str, token: str | None) -> Footer:
        lines = text.splitlines()
        footer = _footer(lines)
        self._model(footer, token)
        if any(re.search(r"\besc\s*$", line, re.IGNORECASE) or line.strip() == "Search" for line in lines):
            raise _unsupported()
        return footer

    def _keys(self, keys: list[str]) -> None:
        self._live()
        self._request("agent.send_keys", {"target": self.agent["paneId"], "keys": keys})
        self._live()

    def _open(self, token: str | None) -> Picker:
        text = self._read()
        # A prior interrupted settings read may have left this verified
        # palette open. Recover it without entering text into another dialog.
        if any(PALETTE_HEADER.fullmatch(line) for line in text.splitlines()):
            for query in ("Search", VARIANT_COMMAND):
                try:
                    palette = _palette(text, query)
                except BridgeError as error:
                    if error.code != "VARIANT_PICKER_UNSUPPORTED":
                        raise
                    continue
                self._model(palette.footer, token)
                self.owned_palette = palette
                self._close()
                text = self._read()
                break
        if any(HEADER.fullmatch(line) for line in text.splitlines()):
            picker = parse_picker(text)
            self._model(picker.footer, token)
            self.owned = picker
            return picker
        footer = self._empty_prompt(text, token)
        self._keys(["ctrl+p"])
        palette = self._wait_palette(footer.token, "Search")
        self.owned_palette = palette
        self._same_palette(palette)
        self._live()
        self._request("pane.send_text", {"pane_id": self.agent["paneId"], "text": VARIANT_COMMAND})
        self._live()
        palette = self._wait_palette(footer.token, VARIANT_COMMAND)
        self.owned_palette = palette
        if palette.body == ("No results found",):
            raise BridgeError(
                "VARIANT_NOT_AVAILABLE",
                "OpenCode does not offer reasoning variants for its current model. Choose a model with variants in OpenCode.",
            )
        self._verify_focus(palette, 0)
        self._keys(["enter"])
        self.owned_palette = None
        for attempt in range(POLL_ATTEMPTS):
            if attempt:
                time.sleep(POLL_INTERVAL)
            text = self._read()
            try:
                self._model(_footer(text.splitlines()), footer.token)
                if any(HEADER.fullmatch(line) for line in text.splitlines()):
                    picker = parse_picker(text)
                    self.owned = picker
                    return picker
            except BridgeError as error:
                if error.code != "VARIANT_PICKER_UNSUPPORTED":
                    raise
        raise _unsupported()

    def _wait_palette(self, token: str, query: str) -> Palette:
        for attempt in range(POLL_ATTEMPTS):
            if attempt:
                time.sleep(POLL_INTERVAL)
            text = self._read()
            try:
                self._model(_footer(text.splitlines()), token)
                lines = text.splitlines()
                if any(PALETTE_HEADER.fullmatch(line) for line in lines):
                    if any(line.strip() == query for line in lines):
                        return _palette(text, query)
            except BridgeError as error:
                if error.code != "VARIANT_PICKER_UNSUPPORTED":
                    raise
        raise _unsupported()

    def _same_palette(self, expected: Palette) -> None:
        current = _palette(self._read(), expected.query)
        self._model(current.footer, expected.footer.token)
        if current != expected:
            raise _unsupported()

    def _verify_focus(self, expected: Picker | Palette, index: int) -> None:
        for attempt in range(POLL_ATTEMPTS):
            if attempt:
                time.sleep(POLL_INTERVAL)
            text = self._read(ansi=True)
            plain = _plain_view(text)
            palette = isinstance(expected, Palette)
            current = _palette(plain, expected.query) if palette else parse_picker(plain)
            self._model(current.footer, expected.footer.token)
            if current != expected:
                raise _unsupported()
            names = (VARIANT_COMMAND,) if palette else ("Default", *expected.variants)
            focused = _focused(text, names, palette=palette)
            if focused == index:
                return
        raise BridgeError(
            "VARIANT_FOCUS_UNVERIFIED",
            "OpenCode's highlighted choice could not be verified. Restore the default "
            "terminal key bindings and reopen settings.",
        )

    def _same_picker(self, expected: Picker) -> Picker:
        picker = parse_picker(self._read())
        self._model(picker.footer, expected.footer.token)
        if picker != expected:
            raise BridgeError(
                "VARIANT_VERIFICATION_FAILED", "OpenCode's variant picker changed. Reopen settings and try again.",
            )
        return picker

    def _close(self) -> None:
        if self.owned_palette is not None:
            palette = self.owned_palette
            self._same_palette(palette)
            self._keys(["escape"])
            self.owned_palette = None
            self._wait_closed(palette.footer.token)
            return
        if self.owned is None:
            return
        picker = self._same_picker(self.owned)
        self._keys(["escape"])
        self.owned = None
        self._wait_closed(picker.footer.token)

    def _wait_closed(self, token: str) -> None:
        for attempt in range(POLL_ATTEMPTS):
            if attempt:
                time.sleep(POLL_INTERVAL)
            text = self._read()
            try:
                self._model(_footer(text.splitlines()), token)
                if not any(HEADER.fullmatch(line) or PALETTE_HEADER.fullmatch(line) for line in text.splitlines()):
                    self._empty_prompt(text, token)
                    return
            except BridgeError as error:
                # Native dialog removal can briefly leave its Search/esc line
                # after the title disappears. Wait without sending more input.
                if error.code != "VARIANT_PICKER_UNSUPPORTED":
                    raise
        raise BridgeError(
            "VARIANT_VERIFICATION_FAILED", "OpenCode did not close its variant picker. Check the terminal and retry.",
        )

    def options(self) -> dict[str, Any]:
        try:
            picker = self._open(None)
            self._close()
            return picker.result()
        except BridgeError:
            self._cleanup()
            raise

    def _cleanup(self) -> None:
        if self.owned is not None or self.owned_palette is not None:
            try:
                self._close()
            except BridgeError:
                # Never dismiss a dialog whose target, model or contents changed.
                pass

    def retune(self, variant: str | None, token: str) -> dict[str, Any]:
        try:
            picker = self._open(token)
            if variant is not None and variant not in picker.variants:
                raise BridgeError(
                    "INVALID_VARIANT", "This variant is not available for OpenCode's current model. Reopen settings.",
                )
            self._same_picker(picker)
            if picker.current != variant or not picker.confirmed:
                choices = (None, *picker.variants)
                # Herdr 0.9 rejects the named Home key, but forwards its
                # native escape sequence through pane.send_text.
                self._live()
                self._request("pane.send_text", {"pane_id": self.agent["paneId"], "text": "\x1b[H"})
                self._live()
                self._verify_focus(picker, 0)
                if choices.index(variant):
                    self._keys(["down"] * choices.index(variant))
                self._verify_focus(picker, choices.index(variant))
                self._keys(["enter"])
                self.owned = None
                self._wait_closed(token)
            else:
                self._close()
            verified = self._open(token)
            if not verified.confirmed or verified.current != variant or verified.variants != picker.variants:
                raise BridgeError(
                    "VARIANT_VERIFICATION_FAILED",
                    "OpenCode did not confirm the requested variant. Reopen settings to check the current choice.",
                )
            self._close()
            self._live()
            self.host._refresh_runtime()
            return {"agentId": self.agent["id"], "runtime": self.host.runtime}
        except BridgeError:
            self._cleanup()
            raise


def retune(host: ProviderHost, payload: dict[str, Any]) -> dict[str, Any]:
    variant = payload.get("variant")
    token = payload.get("modelToken")
    if "variant" not in payload or (variant is not None and (not _name(variant) or variant == "Default")):
        raise BridgeError("INVALID_VARIANT", "Choose an OpenCode variant, or Default to clear it.")
    if not isinstance(token, str) or not token or len(token) > 260 or any(
        unicodedata.category(char).startswith("C") for char in token
    ):
        raise BridgeError("INVALID_MODEL_TOKEN", "Reopen settings to load OpenCode's current model.")
    operation = OpenCodeVariants(host, payload)
    current = host._reported_tuning(
        operation.agent["paneId"], operation.agent["providerSessionId"], "opencode",
    )
    if any(key in payload and payload[key] != current.get(key) for key in ("model", "effort", "context")):
        raise BridgeError(
            "UNSUPPORTED_TUNING", "Only the current OpenCode model's variant can be changed here.",
        )
    return operation.retune(variant, token)
