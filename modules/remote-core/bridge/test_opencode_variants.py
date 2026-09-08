"""Synthetic native TUI only: no real OpenCode process, database, or inference."""
from copy import deepcopy
import re
import unicodedata
import unittest
from unittest.mock import Mock, patch

from remodr_bridge.bridge import Bridge
from remodr_bridge.errors import BridgeError
from remodr_bridge.providers.opencode.variants import VARIANT_COMMAND, _focused, _plain_view, parse_picker


TOKEN = "Build · Muse Spark 1.3 Free OpenCode Zen"
VARIANTS = ["minimal", "low", "medium", "high", "xhigh"]


def viewport(current="low", *, dialog=True, variants=None, draft="", token=TOKEN,
             palette=False, query="Search", focused=None, ansi=False):
    choices = [None, *(VARIANTS if variants is None else variants)]
    lines = [""] * 20 + ["  A prior conversation", "", ""]
    if palette:
        lines += ["         Commands                            esc", "", "         " + query, ""]
        lines += ["         Agent", "         " + VARIANT_COMMAND] if query != "Search" else [
            "         Suggested", "         Switch model", "", "         Agent", "         " + VARIANT_COMMAND,
        ]
    elif dialog:
        lines += ["         Select variant                      esc", "", "         Search", ""]
        lines += [
            "         " + ("● " if choice == current else "") + (choice or "Default")
            for choice in choices
        ]
    lines += ["", "", "", "  ┃", "  ┃ " + draft, "  ┃",
              "  ┃  " + token + (" · " + current if current else ""), "", "     tab agents"]
    if ansi and focused is not None:
        name = VARIANT_COMMAND if palette else ("Default", *(VARIANTS if variants is None else variants))[focused]
        for index, line in enumerate(lines):
            if line.strip().removeprefix("● ") == name and (not palette or index > 27):
                lines[index] = "\x1b[1;48;2;1;2;3m" + line + "\x1b[0m"
    return "\n".join(lines)


def session_background(text, *, wide=False):
    """Native 60-cell modal over transcript text on both sides and below."""
    raw = text.splitlines()
    plain = [re.sub(r"\x1b\[[0-9;]*m", "", line) for line in raw]
    footer = next(index for index, line in enumerate(plain) if line == "  ┃")
    headers = [index for index, line in enumerate(plain) if line.strip().endswith("esc")]
    top = headers[0] - 1 if headers else -1
    bottom = max(index for index in range(footer) if plain[index].strip()) + 2 if headers else -1
    background = "\x1b[0;48;2;10;10;10m"
    dialog = "\x1b[0;48;2;20;20;20m"
    result = []
    for index, line in enumerate(plain):
        if index >= footer:
            result.append(background + line + (" " * 35 + "~/Demo" if " · " in line else ""))
            continue
        prefix = "界" * 20 if wide else "Earlier conversation".ljust(40)
        suffix = " Conversation continues on the right"
        if not top <= index <= bottom:
            result.append(background + prefix + "Message behind the dialog".ljust(60) + suffix)
            continue
        content = line.strip()
        if index in headers:
            content = content.split("  ")[0].ljust(49) + "esc"
        width = sum(2 if unicodedata.east_asian_width(char) in ("W", "F") else 1 for char in content)
        content += " " * (52 - width)
        style = "\x1b[1m" if index in headers else "\x1b[1;48;2;200;200;200m" if "\x1b[1;48;" in raw[index] else ""
        result.append(background + prefix + dialog + " " * 4 + style + content + dialog + " " * 4 + background + suffix)
    return "\n".join(result)


class NativeTUI:
    def __init__(self):
        self.raw = {
            "pane_id": "p1", "terminal_id": "term1", "agent": "opencode",
            "agent_status": "idle", "agent_session": {"value": "ses_root"},
        }
        self.current = "low"
        self.dialog = False
        self.palette = False
        self.query = "Search"
        self.focus = 2
        self.variant_focus_available = True
        self.home_effective = True
        self.down_effective = True
        self.draft = ""
        self.token = TOKEN
        self.variants = list(VARIANTS)
        self.accept_selection = True
        self.transform = lambda text: text
        self.session_layout = False
        self.calls = []
        self.before = lambda method, params: None

    def request(self, method, params):
        self.calls.append((method, deepcopy(params)))
        self.before(method, params)
        if method == "agent.get":
            return {"agent": deepcopy(self.raw)}
        if method == "agent.read":
            ansi = params["format"] == "ansi"
            assert params == {"target": "p1", "source": "visible", "format": "ansi" if ansi else "text",
                              "strip_ansi": not ansi, "lines": 120}
            text = viewport(
                self.current, dialog=self.dialog, variants=self.variants,
                draft=self.draft, token=self.token, palette=self.palette, query=self.query,
                focused=0 if self.palette else self.focus if self.variant_focus_available else None, ansi=ansi,
            )
            if self.session_layout:
                text = session_background(text, wide=True)
            return {"read": {"text": self.transform(text)}}
        if method == "pane.send_text":
            if params == {"pane_id": "p1", "text": "\x1b[H"}:
                assert self.dialog and not self.palette
                if self.home_effective:
                    self.focus = 0
                return {}
            assert params == {"pane_id": "p1", "text": VARIANT_COMMAND}
            assert self.palette and self.query == "Search"
            self.query = VARIANT_COMMAND
            return {}
        if method == "agent.send_keys":
            keys = params["keys"]
            if keys == ["ctrl+p"]:
                assert not self.dialog and not self.palette and not self.draft
                self.palette = True
                self.query = "Search"
                return {}
            assert self.dialog or self.palette
            if keys == ["escape"]:
                self.dialog = self.palette = False
            elif self.palette:
                assert keys == ["enter"] and self.query == VARIANT_COMMAND
                self.palette = False
                self.dialog = True
                self.focus = [None, *self.variants].index(self.current)
            elif set(keys) in ({"down"}, {"up"}):
                if self.down_effective:
                    direction = 1 if keys[0] == "down" else -1
                    self.focus = (self.focus + direction * len(keys)) % (len(self.variants) + 1)
            else:
                assert keys == ["enter"]
                choices = [None, *self.variants]
                if self.accept_selection:
                    self.current = choices[self.focus]
                self.dialog = False
            return {}
        raise AssertionError(f"Unexpected native operation: {method}")

    def inputs(self):
        return [(method, params) for method, params in self.calls if method in ("pane.send_text", "agent.send_keys")]


class PickerParserTest(unittest.TestCase):
    def test_real_modal_is_separated_from_transcript_and_preserves_ansi_focus(self):
        for wide in (False, True):
            with self.subTest(wide=wide):
                raw = session_background(viewport(focused=3, ansi=True), wide=wide)
                result = parse_picker(_plain_view(raw))
                self.assertEqual(result.current, "low")
                self.assertEqual(result.variants, tuple(VARIANTS))
                self.assertEqual(result.footer.token, TOKEN)
                self.assertEqual(_focused(raw, ("Default", *VARIANTS)), 3)

    def test_unverifiable_dialog_background_does_not_hide_transcript(self):
        raw = session_background(viewport(ansi=True))
        raw = raw.replace("48;2;20;20;20", "48;2;10;10;10")
        with self.assertRaises(BridgeError):
            parse_picker(_plain_view(raw))

    def test_session_footer_directory_is_not_part_of_the_variant_or_model(self):
        for current in (None, "low", "high"):
            original = viewport(current)
            footer = "  ┃  " + TOKEN + (" · " + current if current else "")
            for directory in ("~", "~/Demo", "/home/demo/My Project", "C:\\Users\\demo\\Project"):
                with self.subTest(current=current, directory=directory):
                    text = original.replace(footer, footer + " " * 40 + directory)
                    self.assertEqual(parse_picker(text).result(), parse_picker(original).result())

    def test_current_and_default_and_custom_names(self):
        for current in (None, "low", "high"):
            parsed = parse_picker(viewport(current))
            self.assertEqual(parsed.result(), {
                "modelLabel": "Muse Spark 1.3 Free OpenCode Zen",
                "modelToken": TOKEN, "currentVariant": current, "variants": VARIANTS,
            })
        self.assertEqual(
            parse_picker(viewport("Custom / 深い", variants=["Custom / 深い"])).current,
            "Custom / 深い",
        )
        name = "x" * 128
        with self.assertRaises(BridgeError):
            parse_picker(viewport(name, variants=[name]))
        self.assertIsNone(parse_picker(viewport(None).replace("● Default", "Default")).current)
        self.assertIsNone(parse_picker(viewport(None).replace("         ● Default", "    ●    Default")).current)
        self.assertEqual(parse_picker(viewport().replace("         ● low", "    ●    low")).current, "low")

    def test_hidden_scrollbar_capacity_is_not_mistaken_for_complete_options(self):
        text = viewport()
        lines = text.splitlines()
        while len(lines) > 24:
            del lines[0]
        self.assertEqual(len(VARIANTS) + 1, len(lines) // 2 - 6)
        with self.assertRaises(BridgeError):
            parse_picker("\n".join(lines))
        self.assertEqual(parse_picker("\n\n" + "\n".join(lines)).variants, tuple(VARIANTS))

    def test_title_clipped_at_dialog_edge_without_ellipsis_is_not_authoritative(self):
        text = viewport(None, variants=["placeholder"])
        header = next(line for line in text.splitlines() if "Select variant" in line)
        title_width = len(header.rstrip()) - 9
        for name in ("x" * title_width, "界" * ((title_width + 1) // 2)):
            with self.subTest(name=name), self.assertRaises(BridgeError):
                parse_picker(text.replace("placeholder", name))

    def test_unsupported_and_incomplete_pickers_fail_closed(self):
        cases = [
            viewport().replace("Select variant", "Select model"),
            viewport().replace("Search", "Search high"),
            viewport().replace("Default", "Other"),
            viewport().replace("● low", "low"),
            viewport().replace("minimal", "● minimal"),
            viewport().replace("xhigh", "…"),
            viewport().replace("medium", "low"),
            viewport().replace("high", "x" * 129),
            viewport().replace("medium", "bad\x7fname"),
            viewport().replace("medium", "bad\u202ename"),
            viewport().replace(" · low", " · high"),
            viewport(variants=[f"variant-{index}" for index in range(25)], current="variant-0"),
            viewport().replace("\n\n\n\n  ┃", "\n  ┃"),
            viewport().replace("\n\n\n\n  ┃", "\n  6 more\n\n\n  ┃"),
        ]
        for text in cases:
            with self.subTest(text=text), self.assertRaises(BridgeError):
                parse_picker(text)


class OpenCodeVariantTest(unittest.TestCase):
    def setUp(self):
        self.bridge = Bridge()
        self.native = NativeTUI()
        self.bridge.raw_agents = {"a1": {
            **self.native.raw, "id": "a1", "paneId": "p1", "provider": "opencode",
            "providerSessionId": "ses_root", "status": "idle",
        }}
        self.bridge._herdr_request = Mock(side_effect=self.native.request)
        self.bridge._refresh_runtime_and_publish = Mock()
        self.bridge._refresh_runtime = Mock()
        self.bridge._reported_tuning = Mock(return_value={"model": "provider/old-model", "effort": None, "context": None})
        self.payload = {"agentId": "a1", "providerSessionId": "ses_root"}
        sleep = patch("remodr_bridge.providers.opencode.variants.time.sleep")
        sleep.start()
        self.addCleanup(sleep.stop)

    def options(self, **payload):
        return self.bridge._dispatch("agent.variant_options", {**self.payload, **payload})

    def retune(self, variant="high", **payload):
        return self.bridge._dispatch("agent.retune", {
            **self.payload, "variant": variant, "modelToken": TOKEN, **payload,
        })

    def test_options_only_open_and_close_verified_palette_command_without_prompt(self):
        self.assertEqual(self.options(), {
            "modelLabel": "Muse Spark 1.3 Free OpenCode Zen",
            "modelToken": TOKEN, "currentVariant": "low", "variants": VARIANTS,
        })
        self.assertEqual(self.native.inputs(), [
            ("agent.send_keys", {"target": "p1", "keys": ["ctrl+p"]}),
            ("pane.send_text", {"pane_id": "p1", "text": VARIANT_COMMAND}),
            ("agent.send_keys", {"target": "p1", "keys": ["enter"]}),
            ("agent.send_keys", {"target": "p1", "keys": ["escape"]}),
        ])
        self.assertFalse(self.native.dialog)
        self.bridge._refresh_runtime_and_publish.assert_called_once()
        self.bridge._reported_tuning.assert_not_called()

    def test_variant_round_trip_in_session_with_overlapping_wide_transcript(self):
        self.native.session_layout = True
        self.assertEqual(self.options()["currentVariant"], "low")
        for variant in ("medium", None, "high"):
            self.retune(variant)
            self.assertEqual(self.options()["currentVariant"], variant)
            self.assertFalse(self.native.dialog or self.native.palette)

    def test_recovers_only_matching_existing_variant_ui(self):
        for case in ("Search", VARIANT_COMMAND, "picker"):
            with self.subTest(case=case):
                self.setUp()
                self.native.session_layout = True
                self.native.dialog = case == "picker"
                self.native.palette = case != "picker"
                self.native.query = case
                self.assertEqual(self.options()["currentVariant"], "low")
                self.assertEqual(self.native.inputs()[0][1]["keys"], ["escape"])
                self.assertFalse(self.native.dialog or self.native.palette)

    def test_unrelated_palette_query_is_not_dismissed(self):
        self.native.session_layout = True
        self.native.palette = True
        self.native.query = "Other command"
        with self.assertRaises(BridgeError):
            self.options()
        self.assertEqual(self.native.inputs(), [])

    def test_existing_variant_ui_does_not_bypass_draft_or_model_guards(self):
        for dialog in (False, True):
            for guard in ("draft", "model"):
                with self.subTest(dialog=dialog, guard=guard):
                    self.setUp()
                    self.native.session_layout = True
                    self.native.dialog = dialog
                    self.native.palette = not dialog
                    if guard == "draft":
                        self.native.draft = "keep this draft"
                    else:
                        self.native.token = "Build · Another Model"
                    with self.assertRaises(BridgeError) as error:
                        self.retune()
                    self.assertEqual(
                        error.exception.code,
                        "VARIANT_DRAFT_PRESENT" if guard == "draft" else "VARIANT_MODEL_CHANGED",
                    )
                    self.assertEqual(self.native.inputs(), [])

    def test_unrelated_dialog_over_transcript_is_not_touched(self):
        self.native.session_layout = True
        self.native.dialog = True
        self.native.transform = lambda text: text.replace("Select variant", "Select model  ")
        with self.assertRaises(BridgeError):
            self.options()
        self.assertEqual(self.native.inputs(), [])

    def test_model_without_variant_command_has_actionable_error_and_closes_palette(self):
        self.native.current = None
        self.native.transform = lambda text: text.replace(
            "         Agent\n\x1b[1;48;2;1;2;3m         " + VARIANT_COMMAND + "\x1b[0m",
            "         No results found",
        )
        with self.assertRaises(BridgeError) as error:
            self.options()
        self.assertEqual(error.exception.code, "VARIANT_NOT_AVAILABLE")
        self.assertFalse(self.native.palette)
        self.assertFalse(any(params.get("keys") == ["enter"] for _, params in self.native.inputs()))

    def test_default_selection_waits_for_dialog_dismissal_to_finish(self):
        remaining = 2
        def transition(text):
            nonlocal remaining
            if self.native.current is None and not self.native.dialog and not self.native.palette and remaining:
                remaining -= 1
                return "             esc\n" + text
            return text
        self.native.transform = transition
        self.retune(None)
        self.assertIsNone(self.native.current)
        self.assertEqual(remaining, 0)
        self.assertFalse(self.native.dialog)

    def test_low_to_high_and_default_are_verified_in_reopened_picker(self):
        for desired in ("high", None):
            with self.subTest(desired=desired):
                self.setUp()
                before = self.bridge.sessions.tuning("p1")
                result = self.retune(desired)
                self.assertEqual(result, {"agentId": "a1", "runtime": self.bridge.runtime})
                self.assertEqual(self.native.current, desired)
                self.assertFalse(self.native.dialog)
                self.assertEqual(self.bridge.sessions.tuning("p1"), before)
                self.bridge._refresh_runtime.assert_called_once()
                inputs = self.native.inputs()
                selection = [("pane.send_text", {"pane_id": "p1", "text": "\x1b[H"})]
                if desired is not None:
                    selection += [("agent.send_keys", {"target": "p1", "keys": ["down"] * 4})]
                selection += [("agent.send_keys", {"target": "p1", "keys": ["enter"]})]
                self.assertEqual(inputs[3:3 + len(selection)], selection)
                self.assertEqual(inputs[-1][1]["keys"], ["escape"])
                for index, (method, params) in enumerate(self.native.calls):
                    if method in ("pane.send_text", "agent.send_keys"):
                        self.assertEqual(self.native.calls[index - 1][0], "agent.get")
                        self.assertEqual(self.native.calls[index + 1][0], "agent.get")

    def test_noop_is_still_reopened_and_verified(self):
        self.retune("low")
        self.assertEqual([params["keys"] for method, params in self.native.inputs()
                          if method == "agent.send_keys"],
                         [["ctrl+p"], ["enter"], ["escape"], ["ctrl+p"], ["enter"], ["escape"]])

    def test_unstored_default_is_explicitly_selected_and_then_confirmed(self):
        self.native.current = None
        selected = False
        def before(method, params):
            nonlocal selected
            if self.native.dialog and method == "agent.send_keys" and params["keys"] == ["enter"]:
                selected = True
        self.native.before = before
        self.native.transform = lambda text: text if selected else text.replace("● Default", "Default")
        self.retune(None)
        self.assertTrue(selected)
        self.assertIsNone(self.native.current)

    def test_visible_wrong_highlight_never_gets_selection_enter(self):
        self.native.down_effective = False
        with self.assertRaises(BridgeError) as error:
            self.retune()
        self.assertEqual(error.exception.code, "VARIANT_FOCUS_UNVERIFIED")
        self.assertEqual(self.native.current, "low")
        keys = [params["keys"] for method, params in self.native.inputs() if method == "agent.send_keys"]
        self.assertEqual(keys.count(["enter"]), 1)  # Palette command only.
        self.assertEqual(keys[-1], ["escape"])

    def test_missing_option_sgr_does_not_guess_focus_from_current_marker(self):
        self.native.variant_focus_available = False
        with self.assertRaises(BridgeError) as error:
            self.retune()
        self.assertEqual(error.exception.code, "VARIANT_FOCUS_UNVERIFIED")
        self.assertEqual(self.native.current, "low")
        self.assertFalse(self.native.dialog)
        keys = [params["keys"] for method, params in self.native.inputs() if method == "agent.send_keys"]
        self.assertEqual(keys.count(["enter"]), 1)
        self.assertFalse(any("home" in batch for batch in keys))

    def test_raw_home_must_visibly_focus_default_before_down_or_enter(self):
        self.native.home_effective = False
        with self.assertRaises(BridgeError) as error:
            self.retune()
        self.assertEqual(error.exception.code, "VARIANT_FOCUS_UNVERIFIED")
        self.assertEqual(self.native.current, "low")
        self.assertFalse(any("down" in params.get("keys", []) for _, params in self.native.inputs()))
        self.bridge._refresh_runtime.assert_not_called()

    def test_unverified_palette_never_gets_literal_text(self):
        self.native.transform = lambda text: text.replace("Commands", "Other dialog")
        with self.assertRaises(BridgeError):
            self.options()
        self.assertEqual(self.native.inputs(), [
            ("agent.send_keys", {"target": "p1", "keys": ["ctrl+p"]}),
        ])

    def test_filtered_command_must_be_unique_before_enter(self):
        self.native.transform = lambda text: text.replace("         Agent\n", "         Agent\n         Other command\n")
        with self.assertRaises(BridgeError):
            self.options()
        self.assertFalse(any(params.get("keys") == ["enter"] for _, params in self.native.inputs()))
        self.assertFalse(any(method == "agent.prompt" for method, _ in self.native.calls))

    def test_default_without_post_selection_marker_is_not_confirmed(self):
        self.native.transform = lambda text: text.replace("● Default", "Default")
        with self.assertRaises(BridgeError) as error:
            self.retune(None)
        self.assertEqual(error.exception.code, "VARIANT_VERIFICATION_FAILED")
        self.bridge._refresh_runtime.assert_not_called()

    def test_no_input_on_wrong_requested_session_busy_native_draft_or_existing_dialog(self):
        for case in ("request", "session", "terminal", "provider", "working", "blocked", "unknown", "draft", "attachment", "dialog"):
            with self.subTest(case=case):
                self.setUp()
                payload = {}
                if case == "request":
                    payload["providerSessionId"] = "ses_other"
                elif case == "session":
                    self.native.raw["agent_session"]["value"] = "ses_other"
                elif case == "terminal":
                    self.native.raw["terminal_id"] = "term2"
                elif case == "provider":
                    self.native.raw["agent"] = "copilot"
                elif case in ("working", "blocked", "unknown"):
                    self.native.raw["agent_status"] = case
                elif case in ("draft", "attachment"):
                    self.native.draft = "unfinished" if case == "draft" else "[image.png]"
                else:
                    self.native.dialog = True
                    self.native.transform = lambda text: text.replace("Select variant", "Select model")
                with self.assertRaises(BridgeError):
                    self.options(**payload)
                self.assertEqual(self.native.inputs(), [])

    def test_changed_model_token_prevents_opening(self):
        with self.assertRaises(BridgeError) as error:
            self.retune(modelToken="Build · Previous Model")
        self.assertEqual(error.exception.code, "VARIANT_MODEL_CHANGED")
        self.assertEqual(self.native.inputs(), [])

    def test_invalid_payloads_and_other_tuning_changes_do_not_touch_terminal(self):
        for extra in ({"variant": ""}, {"variant": "x" * 129}, {"variant": "bad\nname"},
                      {"variant": 3}, {"variant": "Default"}, {"modelToken": ""},
                      {"model": "different/model"}, {"model": None},
                      {"effort": "high"}, {"context": "long_context"}):
            with self.subTest(extra=extra), self.assertRaises(BridgeError):
                self.retune(**extra)
        with self.assertRaises(BridgeError):
            self.bridge._dispatch("agent.retune", self.payload)
        self.assertEqual(self.native.inputs(), [])

    def test_unchanged_other_tuning_fields_are_accepted(self):
        self.retune(model="provider/old-model", effort=None, context=None)
        self.assertEqual(self.native.current, "high")

    def test_unknown_choice_closes_owned_picker_without_enter(self):
        with self.assertRaises(BridgeError) as error:
            self.retune("not available")
        self.assertEqual(error.exception.code, "INVALID_VARIANT")
        self.assertFalse(self.native.dialog)
        self.assertEqual(self.native.inputs()[-1][1]["keys"], ["escape"])

    def test_wrong_dialog_never_gets_enter_or_escape(self):
        self.native.transform = lambda text: text.replace("Select variant", "Select model")
        with self.assertRaises(BridgeError):
            self.retune()
        self.assertEqual([params["keys"] for method, params in self.native.inputs() if method == "agent.send_keys"],
                         [["ctrl+p"], ["enter"]])

    def test_changed_identity_before_selection_does_not_send_any_keys(self):
        def before(method, params):
            if self.native.dialog and method == "agent.get":
                self.native.raw["agent_session"]["value"] = "ses_changed"
        self.native.before = before
        with self.assertRaises(BridgeError) as error:
            self.retune()
        self.assertEqual(error.exception.code, "VARIANT_SESSION_CHANGED")
        self.assertEqual([params["keys"] for method, params in self.native.inputs() if method == "agent.send_keys"],
                         [["ctrl+p"], ["enter"]])

    def test_changed_model_in_owned_dialog_is_not_escaped(self):
        reads = 0
        def before(method, params):
            nonlocal reads
            if self.native.dialog and method == "agent.read":
                reads += 1
                if reads > 1:
                    self.native.token = "Build · Changed Model"
        self.native.before = before
        with self.assertRaises(BridgeError) as error:
            self.retune()
        self.assertEqual(error.exception.code, "VARIANT_MODEL_CHANGED")
        self.assertEqual([params["keys"] for method, params in self.native.inputs() if method == "agent.send_keys"],
                         [["ctrl+p"], ["enter"]])

    def test_busy_or_replaced_owned_dialog_is_never_escaped(self):
        for change in ("working", "dialog", "terminal"):
            with self.subTest(change=change):
                self.setUp()
                reads = 0
                def before(method, params):
                    nonlocal reads
                    if self.native.dialog and method == "agent.read":
                        reads += 1
                        if reads > 1:
                            if change == "working":
                                self.native.raw["agent_status"] = "working"
                            elif change == "terminal":
                                self.native.raw["terminal_id"] = "replacement"
                            else:
                                self.native.transform = lambda text: text.replace("Select variant", "Permissions")
                self.native.before = before
                with self.assertRaises(BridgeError):
                    self.retune()
                self.assertEqual([params["keys"] for method, params in self.native.inputs()
                                  if method == "agent.send_keys"], [["ctrl+p"], ["enter"]])

    def test_session_change_after_selection_is_not_success_or_further_input(self):
        selected = False
        def before(method, params):
            nonlocal selected
            if self.native.dialog and method == "agent.send_keys" and "enter" in params["keys"]:
                selected = True
            elif selected and method == "agent.get":
                self.native.raw["agent_session"]["value"] = "ses_replacement"
        self.native.before = before
        with self.assertRaises(BridgeError) as error:
            self.retune()
        self.assertEqual(error.exception.code, "VARIANT_SESSION_CHANGED")
        self.assertEqual([params["keys"] for method, params in self.native.inputs() if method == "agent.send_keys"],
                         [["ctrl+p"], ["enter"], ["down"] * 4, ["enter"]])
        self.bridge._refresh_runtime.assert_not_called()

    def test_native_errors_are_sanitized(self):
        self.bridge._herdr_request.side_effect = BridgeError("RAW_FAILURE", "private terminal text")
        with self.assertRaises(BridgeError) as error:
            self.options()
        self.assertEqual(error.exception.code, "VARIANT_UNAVAILABLE")
        self.assertNotIn("private", str(error.exception))
        self.assertEqual(self.native.inputs(), [])

    def test_publication_without_native_change_is_not_success(self):
        self.native.accept_selection = False
        with self.assertRaises(BridgeError) as error:
            self.retune()
        self.assertEqual(error.exception.code, "VARIANT_VERIFICATION_FAILED")
        self.bridge._refresh_runtime.assert_not_called()
        self.assertFalse(self.native.dialog)

    def test_options_refuse_other_providers(self):
        self.bridge.raw_agents["a1"]["provider"] = "copilot"
        with self.assertRaises(BridgeError) as error:
            self.options()
        self.assertEqual(error.exception.code, "UNSUPPORTED_TUNING")
        self.assertEqual(self.native.inputs(), [])

    def test_dispatch_holds_refresh_lock_for_variant_queries(self):
        with patch.object(self.bridge.providers["opencode"], "variant_options") as options:
            options.side_effect = lambda payload: self.assertTrue(self.bridge.refresh_lock._is_owned()) or {}
            self.options()
        self.bridge._refresh_runtime_and_publish.assert_called_once()


if __name__ == "__main__":
    unittest.main()
