"""Synthetic-only tests for the pinned OpenCode SQLite reader and native identity."""
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import Mock, patch

from remodr_bridge.bridge import Bridge
from remodr_bridge.errors import BridgeError
from remodr_bridge.providers.opencode import OpenCodeAdapter
from remodr_bridge.providers.opencode import questions, transcript


SCHEMA = """
CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, revert TEXT, model TEXT);
CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, data TEXT);
CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, data TEXT);
"""
TODO_SCHEMA = """
CREATE TABLE todo (
    session_id TEXT NOT NULL,
    content TEXT NOT NULL,
    status TEXT NOT NULL,
    priority TEXT NOT NULL,
    position INTEGER NOT NULL,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL,
    PRIMARY KEY (session_id, position)
);
"""


class OpenCodeTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.addCleanup(directory.cleanup)
        self.home = Path(directory.name)
        self.path = self.home / "opencode.db"
        environment = patch.dict(os.environ, {"REMODR_OPENCODE_DB": str(self.path)})
        environment.start()
        self.addCleanup(environment.stop)
        self.connection = sqlite3.connect(self.path)
        self.connection.executescript(SCHEMA)
        self.connection.executemany(
            "INSERT INTO session (id, parent_id) VALUES (?, ?)",
            [("ses_root", None), ("ses_other", None), ("ses_child", "ses_root")],
        )
        self.connection.commit()
        self.addCleanup(self.connection.close)
        self.bridge = Bridge()
        self.bridge._herdr_request = Mock()
        self.adapter = self.bridge.providers["opencode"]
        self.agent = {"id": "a1", "paneId": "p1", "provider": "opencode", "providerSessionId": "ses_root"}

    def v1(self, identifier, role, parts, session="ses_root", created=1):
        self.connection.execute(
            "INSERT INTO message VALUES (?, ?, ?, ?)",
            (identifier, session, created, json.dumps({"role": role})),
        )
        for index, part in enumerate(parts):
            self.connection.execute(
                "INSERT INTO part VALUES (?, ?, ?, ?)",
                (f"{identifier}part{index}", session, identifier, json.dumps(part)),
            )
        self.connection.commit()

    def v2(self, identifier, role, data, session="ses_root", seq=1):
        self.connection.execute(
            "INSERT INTO session_message VALUES (?, ?, ?, ?, ?)",
            (identifier, session, role, seq, json.dumps(data)),
        )
        self.connection.commit()

    def load(self):
        return self.adapter.load_conversation(self.agent)

    def enable_todos(self):
        self.connection.executescript(TODO_SCHEMA)
        self.connection.commit()

    def test_v1_filters_private_parts_and_cross_session_joins(self):
        self.v1("msg_user", "user", [
            {"type": "text", "text": "Hello"},
            {"type": "text", "text": "hidden synthetic", "synthetic": True},
            {"type": "text", "text": "hidden ignored", "ignored": True},
            {"type": "reasoning", "text": "hidden reasoning"},
        ])
        self.v1("msg_assistant", "assistant", [
            {"type": "text", "text": "Answer"},
            {"type": "tool", "tool": "read", "state": {"status": "completed", "input": {"path": "src/main.py"}}},
        ], created=2)
        self.v1("msg_other", "user", [{"type": "text", "text": "other session"}], session="ses_other")
        self.v1("msg_child", "user", [{"type": "text", "text": "child session"}], session="ses_child")
        self.connection.execute("INSERT INTO part VALUES (?, ?, ?, ?)", (
            "badjoin", "ses_other", "msg_user", json.dumps({"type": "text", "text": "bad join"}),
        ))
        self.connection.commit()
        items = self.load()["items"]
        self.assertEqual([item["kind"] for item in items], ["user_message", "assistant_message", "tool_activity"])
        self.assertEqual(items[0]["text"], "Hello")
        self.assertEqual(items[1]["markdown"], "Answer")
        self.assertEqual(items[2]["state"], "completed")
        self.assertEqual(items[2]["detail"], "src/main.py")
        self.assertEqual(items, self.load()["items"])
        self.bridge._herdr_request.assert_not_called()

    def test_v2_prioritized_and_tools_do_not_create_interactive_questions(self):
        self.v1("legacy", "user", [{"type": "text", "text": "legacy duplicate"}])
        for seq, role in enumerate(("synthetic", "system", "compaction"), 1):
            self.v2(role, role, {"text": "hidden", "summary": "hidden"}, seq=seq)
        self.v2("user", "user", {"text": "Please inspect.", "files": [], "agents": []}, seq=4)
        content = [{"type": "text", "id": "text1", "text": "Inspecting."},
                   {"type": "reasoning", "id": "reason1", "text": "private"}]
        for status in ("pending", "running", "completed", "error"):
            content.append({"type": "tool", "id": status, "name": "question",
                            "state": {"status": status, "input": "partial" if status == "pending" else {}}})
        self.v2("assistant", "assistant", {"content": content}, seq=5)
        self.v2("child", "user", {"text": "child session"}, session="ses_child")
        self.v2("other", "user", {"text": "other session"}, session="ses_other")
        conversation = self.load()
        self.assertEqual(len(conversation["items"]), 6)
        self.assertEqual([item["state"] for item in conversation["items"][2:]],
                         ["running", "running", "completed", "failed"])
        self.assertIsNone(conversation["activeHumanRequest"])
        self.assertEqual(conversation, self.load())
        self.assertNotIn("private", json.dumps(conversation))
        self.assertNotIn("legacy duplicate", json.dumps(conversation))
        self.assertEqual(self.bridge.sessions.question_ids(), frozenset())

    def test_running_question_tools_become_copilot_style_needs_input(self):
        self.v2("user", "user", {"text": "Choose a path.", "files": [], "agents": []})
        self.v2("assistant", "assistant", {"content": [
            {"type": "text", "id": "text1", "text": "I need a choice."},
            {"type": "tool", "id": "ask1", "name": "question", "state": {
                "status": "running",
                "input": {"questions": [{
                    "question": "Which path should I use?",
                    "header": "Path",
                    "multiple": False,
                    "options": [
                        {"label": "Keep current", "description": "Leave the workspace as-is"},
                        {"label": "Create folder", "description": "Make a new directory"},
                    ],
                }]},
            }},
        ]}, seq=2)
        conversation = self.load()
        request = {
            "id": "opencode:ses_root:assistant:ask1",
            "kind": "choice",
            "question": "Which path should I use?",
            "options": [
                {"id": "Keep current", "label": "Keep current", "description": "Leave the workspace as-is"},
                {"id": "Create folder", "label": "Create folder", "description": "Make a new directory"},
            ],
            "allowCustomAnswer": True,
            "multiSelect": False,
        }
        self.assertEqual(conversation["items"][-1], {
            "id": request["id"], "kind": "human_request", "request": request,
        })
        self.assertEqual(conversation["activeHumanRequest"], request)
        self.assertEqual(self.bridge.sessions.question_ids(), frozenset({request["id"]}))
        self.connection.execute(
            "UPDATE session_message SET data = ? WHERE id = 'assistant'",
            (json.dumps({"content": [
                {"type": "text", "id": "text1", "text": "I need a choice."},
                {"type": "tool", "id": "ask1", "name": "question", "state": {
                    "status": "completed",
                    "input": {"questions": [{"question": "Which path should I use?", "options": [{"label": "Keep current"}]}]},
                }},
            ]}),),
        )
        self.connection.commit()
        resolved = self.load()
        self.assertIsNone(resolved["activeHumanRequest"])
        self.assertTrue(resolved["items"][-1]["resolved"])
        self.assertEqual(self.bridge.sessions.question_ids(), frozenset())

    def test_pending_json_string_input_still_creates_needs_input(self):
        self.v2("assistant", "assistant", {"content": [
            {"type": "tool", "id": "ask2", "name": "question", "state": {
                "status": "pending",
                "input": json.dumps({"questions": [{
                    "question": "Which host?",
                    "options": [{"label": "Alpha"}, {"label": "Beta"}],
                }]}),
            }},
        ]})
        conversation = self.load()
        self.assertEqual(conversation["activeHumanRequest"]["question"], "Which host?")
        self.assertEqual(
            [option["label"] for option in conversation["activeHumanRequest"]["options"]],
            ["Alpha", "Beta"],
        )
        self.assertEqual(conversation["items"][-1]["kind"], "human_request")

    def test_blocked_tui_dialog_becomes_needs_input_when_sqlite_has_no_question(self):
        self.agent["status"] = "blocked"
        self.bridge._herdr_request.return_value = {"read": {"text": "\n".join([
            "  Which product?                                      esc",
            "",
            "  Which one should I research?",
            "",
            "  Remodlr.ai",
            "  construction Scope Ledger",
            "  Remodel AI",
            "  home design",
            "  Type your own answer",
            "  ┃",
        ])}}
        conversation = self.load()
        request = conversation["activeHumanRequest"]
        self.assertEqual(request["question"], "Which one should I research?")
        self.assertEqual([option["label"] for option in request["options"]], ["Remodlr.ai", "Remodel AI"])
        self.assertTrue(request["id"].startswith("opencode:tui:"))
        self.assertEqual(conversation["items"][-1]["kind"], "human_request")
        self.assertEqual(self.bridge.sessions.question_ids(), frozenset({request["id"]}))

    def test_blocked_status_still_surfaces_needs_input_when_the_dialog_cannot_be_read(self):
        self.agent["status"] = "blocked"
        self.bridge._herdr_request.side_effect = BridgeError("INVALID_HERDR_RESPONSE", "unavailable")
        conversation = self.load()
        request = conversation["activeHumanRequest"]
        self.assertEqual(request["kind"], "text")
        self.assertEqual(request["question"], "OpenCode is waiting for input.")
        self.assertEqual(conversation["items"][-1]["kind"], "human_request")

    def test_focused_choice_reads_reverse_video_and_ignores_descriptions(self):
        names = ("Alpha", "Beta", "Gamma")
        screen = "\n".join([
            "  Which host?                                      esc",
            "",
            "  Alpha",
            "  first host",
            "\x1b[7m  Beta\x1b[0m",
            "  second host",
            "  Gamma",
        ])
        self.assertEqual(questions.focused_choice(screen, names), 1)
        self.assertEqual(
            questions.focused_choice("\n".join(["  Alpha", "\x1b[1;48;5;12m  Beta\x1b[0m", "  Gamma"]), names),
            1,
        )
        self.assertIsNone(questions.focused_choice("  Alpha\n  Beta\n", names))

    def _drive_dialog(self, names, focus=0):
        sent = []
        state = {"focus": focus}

        def screen():
            rows = ["  Which?                                      esc", ""]
            for index, name in enumerate(names):
                row = f"  {name}"
                rows.append(f"\x1b[7m{row}\x1b[0m" if index == state["focus"] else row)
            return "\n".join(rows)

        def request(method, params):
            sent.append((method, params))
            if method == "agent.read":
                return {"read": {"text": screen()}}
            if method == "agent.send_keys":
                keys = params["keys"]
                if keys == ["down"]:
                    state["focus"] += 1
                elif keys == ["up"]:
                    state["focus"] -= 1
            return {}

        self.bridge.dialog_settle_seconds = 0
        self.bridge._herdr_request = request
        return sent, state

    def test_answering_a_later_choice_steps_from_verified_focus(self):
        # Batched downs wrap on OpenCode. One verified step at a time does not.
        sent, state = self._drive_dialog(("Remodlr.ai", "Remodel AI", "home design"))
        request = {
            "options": [
                {"id": "Remodlr.ai", "label": "Remodlr.ai"},
                {"id": "Remodel AI", "label": "Remodel AI"},
                {"id": "home design", "label": "home design"},
            ]
        }
        self.bridge._answer_blocked_dialog(
            {**self.agent, "provider": "opencode"}, request, ["home design"], "home design",
        )
        self.assertEqual(
            [params["keys"] for method, params in sent if method == "agent.send_keys"],
            [["down"], ["down"], ["enter"]],
        )
        self.assertEqual(state["focus"], 2)

    def test_the_first_opencode_choice_is_enter_without_movement(self):
        sent, _ = self._drive_dialog(("A", "B"))
        request = {"options": [{"id": "a", "label": "A"}, {"id": "b", "label": "B"}]}
        self.bridge._answer_blocked_dialog(
            {**self.agent, "provider": "opencode"}, request, ["a"], "A",
        )
        self.assertEqual(
            [params["keys"] for method, params in sent if method == "agent.send_keys"],
            [["enter"]],
        )

    def test_a_typed_opencode_answer_reaches_the_freeform_row(self):
        sent, state = self._drive_dialog(("A", "B", "Type your own answer"))
        request = {"options": [{"id": "a", "label": "A"}, {"id": "b", "label": "B"}]}
        self.bridge._answer_blocked_dialog(
            {**self.agent, "provider": "opencode"}, request, [], "custom host",
        )
        self.assertEqual(
            [params["keys"] for method, params in sent if method == "agent.send_keys"],
            [
                ["down"],
                ["down"],
                ["enter"],
                ["c", "u", "s", "t", "o", "m", "space", "h", "o", "s", "t"],
                ["enter"],
            ],
        )
        self.assertEqual(state["focus"], 2)

    def test_unhighlighted_dialog_still_steps_from_the_first_row(self):
        # OpenCode often styles focus with color, not reverse video. If no row
        # is uniquely marked, assume the first choice and step from there.
        sent = []
        self.bridge.dialog_settle_seconds = 0

        def request(method, params):
            sent.append((method, params))
            if method == "agent.read":
                return {"read": {"text": "  Which?  esc\n  A\n  B\n"}}
            return {}

        self.bridge._herdr_request = request
        self.bridge._answer_blocked_dialog(
            {**self.agent, "provider": "opencode"},
            {"options": [{"id": "a", "label": "A"}, {"id": "b", "label": "B"}]},
            ["b"],
            "B",
        )
        self.assertEqual(
            [params["keys"] for method, params in sent if method == "agent.send_keys"],
            [["down"], ["enter"]],
        )

    def test_opencode_answers_drive_the_dialog_even_when_not_blocked(self):
        # SQLite can expose the question while Herdr still reports working.
        # Prompting then types into the focused first row and Enter submits it.
        sent, _ = self._drive_dialog(("Keep current", "Create folder"))
        agent = {**self.agent, "agent_status": "working"}
        self.bridge.raw_agents = {"a1": agent}
        self.bridge._remember_human_request(
            {
                "id": "req-1",
                "options": [
                    {"id": "Keep current", "label": "Keep current"},
                    {"id": "Create folder", "label": "Create folder"},
                ],
            },
            agent,
        )
        self.bridge._answer_human_request(
            {"agentId": "a1", "requestId": "req-1", "answer": {"selectedOptionIds": ["Create folder"]}}
        )
        self.assertEqual(
            [params["keys"] for method, params in sent if method == "agent.send_keys"],
            [["down"], ["enter"]],
        )

    def test_a_text_only_opencode_question_types_then_enters(self):
        sent, _ = self._drive_dialog(())
        self.bridge._answer_blocked_dialog(
            {**self.agent, "provider": "opencode"}, {"options": []}, [], "Yes",
        )
        self.assertEqual(
            [params["keys"] for method, params in sent if method == "agent.send_keys"],
            [["Y", "e", "s"], ["enter"]],
        )

    def test_variant_and_idle_screens_are_not_treated_as_questions(self):
        self.assertIsNone(questions.parse_dialog("ses_root", "         Select variant                      esc\n         Search\n         Default\n"))
        self.agent["status"] = "idle"
        self.bridge._herdr_request.return_value = {"read": {"text": "  Which product?  esc\n  Remodlr.ai\n"}}
        self.assertIsNone(self.load()["activeHumanRequest"])
        self.bridge._herdr_request.assert_not_called()

    def test_empty_v1_and_v2_sessions_remain_semantic(self):
        self.assertEqual(self.load()["items"], [])
        self.assertTrue(self.load()["semantic"])
        self.connection.execute("DROP TABLE session_message")
        self.assertEqual(self.load()["items"], [])
        self.assertTrue(self.adapter.has_semantic_session("ses_root"))

    def test_todos_are_exact_session_ordered_snapshots_with_native_states(self):
        self.enable_todos()
        self.connection.executemany(
            "INSERT INTO todo VALUES (?, ?, ?, ?, ?, ?, ?)",
            [
                ("ses_root", "Inspect", "completed", "high", 0, 10, 20),
                ("ses_root", "Implement", "in_progress", "medium", 1, 11, 21),
                ("ses_root", "Verify", "pending", "low", 2, 12, 22),
                ("ses_root", "Superseded", "cancelled", "low", 3, 13, 23),
                ("ses_other", "Other session", "pending", "high", 0, 14, 24),
            ],
        )
        self.connection.commit()
        conversation = self.load()
        self.assertEqual(conversation["items"], [{
            "id": "opencode:ses_root:todos",
            "kind": "todo_update",
            "timestamp": 23,
            "todos": [
                {"id": "opencode:ses_root:todo:0", "text": "Inspect", "state": "done"},
                {"id": "opencode:ses_root:todo:1", "text": "Implement", "state": "in_progress"},
                {"id": "opencode:ses_root:todo:2", "text": "Verify", "state": "pending"},
                {"id": "opencode:ses_root:todo:3", "text": "Superseded", "state": "cancelled"},
            ],
        }])
        self.assertTrue(self.adapter.agent_capabilities("ses_root")["todos"])
        self.assertTrue(self.adapter.provider_capabilities(True)["todos"])
        self.connection.execute("DELETE FROM todo WHERE session_id = 'ses_root'")
        self.connection.commit()
        self.assertEqual(self.load()["items"], [])

    def test_invalid_todo_rows_fail_instead_of_publishing_a_partial_plan(self):
        self.enable_todos()
        invalid = [
            ("x" * (transcript.MAX_TODO_CONTENT + 1), "pending", "high", 0, 1),
            ("Task", "bad\nstatus", "high", 0, 1),
            ("Task", "pending", "bad\npriority", 0, 1),
            ("Task", "pending", "high", 1, 1),
            ("Task", "pending", "high", 0, -1),
        ]
        for content, status, priority, position, updated in invalid:
            self.connection.execute("DELETE FROM todo")
            self.connection.execute(
                "INSERT INTO todo VALUES (?, ?, ?, ?, ?, ?, ?)",
                ("ses_root", content, status, priority, position, 1, updated),
            )
            self.connection.commit()
            with self.subTest(row=(content, status, priority, position, updated)):
                with self.assertRaises(transcript.TranscriptError):
                    self.load()
        self.connection.execute("DELETE FROM todo")
        self.connection.executemany(
            "INSERT INTO todo VALUES (?, ?, 'pending', 'high', ?, 1, 1)",
            [("ses_root", "One", 0), ("ses_root", "Two", 1)],
        )
        self.connection.commit()
        with patch.object(transcript, "MAX_TODOS", 1), self.assertRaises(transcript.TranscriptError):
            self.load()

    def test_future_todo_status_and_priority_use_safe_fallbacks(self):
        self.enable_todos()
        self.connection.execute(
            "INSERT INTO todo VALUES (?, ?, ?, ?, ?, ?, ?)",
            ("ses_root", "Future state", "paused", "critical", 0, 1, 2),
        )
        self.connection.commit()
        self.assertEqual(self.load()["items"][0]["todos"], [{
            "id": "opencode:ses_root:todo:0",
            "text": "Future state",
            "state": "unknown",
        }])

    def test_v2_only_database_is_supported(self):
        self.connection.execute("DROP TABLE part")
        self.connection.execute("DROP TABLE message")
        self.connection.commit()
        self.assertEqual(self.load()["items"], [])
        self.v2("user", "user", {"text": "V2 only"})
        self.assertEqual(self.load()["items"][0]["text"], "V2 only")

    def test_missing_identity_never_bootstraps_from_db_or_launch_hint(self):
        self.v2("user", "user", {"text": "must not guess"})
        self.bridge.sessions.remember_launch_session("p1", "ses_root")
        self.assertIsNone(self.adapter.resolve_session({"pane_id": "p1", "cwd": "/work"}, None, inspect=True))
        self.assertIsNone(self.bridge.sessions.launched_session("p1"))
        self.assertIsNone(self.adapter.load_conversation({**self.agent, "providerSessionId": None}))
        self.assertFalse(self.adapter.agent_capabilities(None)["structuredConversation"])
        with self.assertRaisesRegex(BridgeError, "identity"):
            self.bridge._prepare_command("agent.send", {
                "agentId": "a1", "expectedPaneId": "p1", "expectedProviderSessionId": None,
            })
        self.bridge._herdr_request.assert_not_called()

    def test_identity_validation_and_exact_lookup_fail_closed(self):
        for identifier in ("ses_../root", "ses_a-b", "root", "", "ses_", 4):
            with self.subTest(identifier=identifier):
                self.assertIsNone(self.adapter.resolve_session({"pane_id": "p1"}, identifier, inspect=False))
                self.assertIsNotNone(self.bridge.sessions.identity_error("p1"))
                with self.assertRaises(transcript.TranscriptError):
                    transcript.read_session(identifier)
        self.assertEqual(self.adapter.resolve_session({"pane_id": "p1"}, "ses_root", inspect=False), "ses_root")
        self.assertIsNone(self.bridge.sessions.identity_error("p1"))
        with self.assertRaisesRegex(transcript.TranscriptError, "exact"):
            transcript.read_session("ses_missing")
        self.assertFalse(self.adapter.has_semantic_session("ses_missing"))

    def test_rotation_reads_only_new_exact_session_and_clears_stale_agent(self):
        self.v2("first", "user", {"text": "first"})
        self.v2("second", "user", {"text": "second"}, session="ses_other")
        self.bridge.agent_catalog = []
        def snapshot(identifier):
            return self.bridge._normalize_snapshot({
                "panes": [{"pane_id": "p1"}],
                "agents": [{"pane_id": "p1", "agent": "opencode", "agent_session": {"value": identifier}}],
            })["agents"][0]
        first = snapshot("ses_root")
        second = snapshot("ses_other")
        self.assertEqual(first["id"], second["id"])
        self.assertEqual(self.bridge._load_conversation(second)["items"][0]["text"], "second")
        with self.assertRaises(BridgeError):
            self.bridge._load_conversation(first)
        missing = snapshot(None)
        self.assertIsNone(missing["providerSessionId"])
        self.assertFalse(missing["capabilities"]["structuredConversation"])

    def test_wal_updates_are_read_without_main_file_mtime_change(self):
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.execute("PRAGMA wal_autocheckpoint=0")
        self.connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        self.assertEqual(self.load()["items"], [])
        modified = self.path.stat().st_mtime_ns
        self.v2("user", "user", {"text": "fresh WAL"})
        self.assertEqual(self.path.stat().st_mtime_ns, modified)
        self.assertEqual(self.load()["items"][0]["text"], "fresh WAL")
        self.connection.execute("UPDATE session_message SET data = ? WHERE id = 'user'",
                                (json.dumps({"text": "newer WAL"}),))
        self.connection.commit()
        self.assertEqual(self.load()["items"][0]["text"], "newer WAL")

    def test_capabilities_are_honest_and_no_global_output_recency(self):
        capabilities = self.adapter.agent_capabilities("ses_root")
        self.assertTrue(capabilities["structuredConversation"])
        self.assertTrue(capabilities["toolActivity"])
        self.assertTrue(capabilities["supportsRetuning"])
        self.assertTrue(capabilities["structuredQuestions"])
        for key in ("streamingConversation", "todos"):
            self.assertFalse(capabilities[key])
        self.assertIsNone(self.adapter.output_path(self.agent))
        self.assertTrue(self.adapter.provider_capabilities(True)["structuredConversation"])
        self.connection.execute("DROP TABLE session")
        self.connection.commit()
        self.assertFalse(self.adapter.provider_capabilities(True)["structuredConversation"])

    def test_model_reporting_is_exact_without_effort_or_context_inference(self):
        self.connection.execute("UPDATE session SET model = ? WHERE id = 'ses_root'",
                                (json.dumps({"providerID": "anthropic", "id": "claude-sonnet-4-6", "variant": "high"}),))
        self.connection.commit()
        self.assertEqual(self.adapter.session_tuning("ses_root"),
                         {"model": "anthropic/claude-sonnet-4-6", "effort": None, "context": None})
        self.assertEqual(self.adapter.session_tuning("ses_other"), {})
        self.assertEqual(self.adapter.session_tuning("invalid"), {})

    def test_launch_flags_use_auto_and_never_mint_a_session(self):
        self.assertEqual(OpenCodeAdapter.spec.bypass_arguments, ("--auto",))
        args = OpenCodeAdapter.tuning_arguments({"model": "anthropic/claude-sonnet-4-6"})
        self.assertIsNone(OpenCodeAdapter.new_session_arguments("Test", args))
        self.assertEqual(args, ["--model", "anthropic/claude-sonnet-4-6"])
        for payload in ({"model": "auto"}, {"model": "provider/"}, {"model": "/model"},
                        {"model": "provider/model\nflag"}, {"effort": "high"}, {"context": "default"}):
            with self.subTest(payload=payload), self.assertRaises(BridgeError):
                OpenCodeAdapter.tuning_arguments(payload)
        with self.assertRaises(BridgeError):
            self.adapter.retune({})

    def test_interrupt_uses_escape_without_exiting_opencode(self):
        self.bridge.raw_agents = {"a1": self.agent}
        self.assertEqual(self.bridge._dispatch("agent.interrupt", {"agentId": "a1"}), {"accepted": True})
        self.bridge._herdr_request.assert_called_once_with(
            "agent.send_keys", {"target": "p1", "keys": ["escape"]},
        )
        for provider in ("copilot", "unknown"):
            self.assertEqual(self.bridge.providers[provider].spec.interrupt_keys, ("ctrl-c",))

    def test_malformed_json_and_schema_are_not_empty_transcripts(self):
        self.connection.execute("INSERT INTO session_message VALUES ('bad', 'ses_root', 'user', 1, '{')")
        self.connection.commit()
        with self.assertRaises(transcript.TranscriptError):
            self.load()
        self.assertFalse(self.adapter.has_semantic_session("ses_root"))
        self.connection.execute("DELETE FROM session_message")
        self.connection.execute("DROP TABLE part")
        self.connection.execute("DROP TABLE session_message")
        self.connection.commit()
        with self.assertRaises(transcript.TranscriptError):
            self.load()

    def test_malformed_content_and_tool_states_fail_explicitly(self):
        for data in ({"content": "bad"}, {"content": [None]},
                     {"content": [{"id": "tool", "type": "tool", "name": "read", "state": {"status": "future"}}]}):
            self.connection.execute("DELETE FROM session_message")
            self.v2("bad", "assistant", data)
            with self.subTest(data=data), self.assertRaises(transcript.TranscriptError):
                self.load()

    def test_revert_boundaries_are_explicitly_unsupported(self):
        self.v2("user", "user", {"text": "must not show reverted"})
        for revert in ({"messageID": "user"}, {"messageID": "user", "partID": "part"}, "invalid"):
            self.connection.execute("UPDATE session SET revert = ? WHERE id = 'ses_root'", (json.dumps(revert),))
            self.connection.commit()
            with self.subTest(revert=revert), self.assertRaises(transcript.TranscriptError):
                self.load()
            self.assertFalse(self.adapter.has_semantic_session("ses_root"))

    def test_recent_message_limit_preserves_tool_activity(self):
        for index in range(205):
            self.v2(f"msg{index}", "user", {"text": str(index)}, seq=index)
        self.v2("latest", "assistant", {"content": [{
            "id": "tool", "type": "tool", "name": "read", "state": {"status": "running", "input": {}},
        }]}, seq=205)
        items = self.load()["items"]
        self.assertEqual(len(items), 200)
        self.assertEqual(items[0]["text"], "6")
        self.assertEqual(items[-1]["kind"], "tool_activity")

    def test_read_only_connection_rejects_writes(self):
        with transcript.database() as connection:
            with self.assertRaises(sqlite3.OperationalError):
                connection.execute("DELETE FROM session")
        self.assertEqual(self.connection.execute("SELECT COUNT(*) FROM session").fetchone()[0], 3)

    def test_single_read_transaction_has_consistent_snapshot(self):
        self.connection.execute("PRAGMA journal_mode=WAL").fetchone()
        self.connection.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
        with transcript.database() as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM session_message").fetchone()[0], 0)
            self.v2("user", "user", {"text": "committed during read"})
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM session_message").fetchone()[0], 0)
        self.assertEqual(self.load()["items"][0]["text"], "committed during read")

    def test_database_paths_follow_xdg_and_explicit_overrides(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(Path, "home", return_value=self.home):
            self.assertEqual(transcript.database_path(), self.home / ".local/share/opencode/opencode.db")
            with patch.dict(os.environ, {"XDG_DATA_HOME": str(self.home / "data"), "OPENCODE_DB": "channel.db"}):
                self.assertEqual(transcript.database_path(), self.home / "data/opencode/channel.db")
                with patch.dict(os.environ, {"REMODR_OPENCODE_DB": str(self.path)}):
                    self.assertEqual(transcript.database_path(), self.path)
            with patch.dict(os.environ, {"OPENCODE_DB": str(self.path)}):
                self.assertEqual(transcript.database_path(), self.path)
            with patch.dict(os.environ, {"OPENCODE_DB": ":memory:"}):
                with self.assertRaises(transcript.TranscriptError):
                    transcript.database_path()
                self.assertFalse(transcript.database_supported())

    def test_missing_database_does_not_create_files_or_claim_semantics(self):
        missing = self.home / "missing.db"
        with patch.dict(os.environ, {"REMODR_OPENCODE_DB": str(missing)}):
            self.assertIsNone(self.load())
            self.assertFalse(self.adapter.has_semantic_session("ses_root"))
            self.assertFalse(missing.exists())


if __name__ == "__main__":
    unittest.main()
