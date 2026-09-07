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
from remodr_bridge.providers.opencode import transcript


SCHEMA = """
CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, revert TEXT, model TEXT);
CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, data TEXT);
CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, data TEXT);
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

    def test_empty_v1_and_v2_sessions_remain_semantic(self):
        self.assertEqual(self.load()["items"], [])
        self.assertTrue(self.load()["semantic"])
        self.connection.execute("DROP TABLE session_message")
        self.assertEqual(self.load()["items"], [])
        self.assertTrue(self.adapter.has_semantic_session("ses_root"))

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
        for key in ("supportsRetuning", "streamingConversation", "structuredQuestions", "todos"):
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
        for provider in ("copilot", "claude", "codex", "unknown"):
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
