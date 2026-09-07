import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from remodr_bridge.activity import OutputActivity
from remodr_bridge.bridge import Bridge


class OutputActivityTest(unittest.TestCase):
    def setUp(self):
        self.host = Mock()
        self.host._herdr_request.return_value = {"read": {"text": "baseline"}}
        self.adapter = Mock()
        self.adapter.output_path.return_value = None
        self.activity = OutputActivity(self.host)
        self.agent = {"id": "a1", "paneId": "p1", "provider": "cursor", "providerSessionId": "s1"}

    def test_transcript_timestamp_is_not_replaced_by_poll_time(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "events.jsonl"
            path.write_text("output")
            os.utime(path, ns=(1000000000, 1000000000))
            self.adapter.output_path.return_value = path
            self.assertEqual(self.activity.observe(self.agent, "t1", self.adapter), 1000)
            self.assertEqual(self.activity.observe(self.agent, "t1", self.adapter), 1000)
            os.utime(path, ns=(2000000000, 2000000000))
            self.assertEqual(self.activity.observe(self.agent, "t1", self.adapter), 2000)
            self.host._herdr_request.assert_not_called()
            self.adapter.load_conversation.assert_not_called()

    def test_transcript_source_is_resolved_once_per_binding(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "events.jsonl"
            path.write_text("output")
            self.adapter.output_path.return_value = path

            self.activity.observe(self.agent, "t1", self.adapter)
            self.activity.observe(self.agent, "t1", self.adapter)

            self.adapter.output_path.assert_called_once_with(self.agent)

    def test_raw_output_uses_a_baseline_then_changes_not_status_or_title(self):
        self.assertIsNone(self.activity.observe(self.agent, "t1", self.adapter))
        changed_metadata = {**self.agent, "status": "done", "title": "Renamed"}
        self.assertIsNone(self.activity.observe(changed_metadata, "t1", self.adapter))
        self.host._herdr_request.return_value = {"read": {"text": "new output"}}
        with patch("remodr_bridge.activity.time.time_ns", return_value=3000000000):
            self.assertEqual(self.activity.observe(self.agent, "t1", self.adapter), 3000)
        with patch("remodr_bridge.activity.time.time_ns", return_value=9000000000):
            self.assertEqual(self.activity.observe(self.agent, "t1", self.adapter), 3000)

    def test_session_or_terminal_replacement_cannot_inherit_raw_activity(self):
        self.activity.observe(self.agent, "t1", self.adapter)
        self.host._herdr_request.return_value = {"read": {"text": "new"}}
        self.activity.observe(self.agent, "t1", self.adapter)
        replacement = {**self.agent, "providerSessionId": "s2"}
        self.assertIsNone(self.activity.cached(replacement, "t1"))
        self.assertIsNone(self.activity.observe(replacement, "t1", self.adapter))
        self.assertIsNone(self.activity.observe(replacement, "t2", self.adapter))

    def test_metadata_errors_are_diagnosed_without_losing_previous_activity(self):
        self.activity.observe(self.agent, "t1", self.adapter)
        self.host._herdr_request.return_value = {"read": {"text": "new"}}
        timestamp = self.activity.observe(self.agent, "t1", self.adapter)
        self.adapter.output_path.side_effect = OSError("temporarily unreadable")
        self.assertEqual(self.activity.observe(self.agent, "t1", self.adapter), timestamp)
        self.assertEqual(self.activity.observe(self.agent, "t1", self.adapter), timestamp)
        self.host._diagnostic.assert_called_once()
        self.activity.prune(set())
        self.assertIsNone(self.activity.cached(self.agent, "t1"))
        self.assertFalse(self.activity.errors)

    def test_regular_snapshots_and_event_hints_never_probe_output(self):
        bridge = Bridge()
        adapter = bridge.providers["copilot"]
        snapshot = {
            "panes": [{"pane_id": "p1"}],
            "agents": [{"pane_id": "p1", "agent": "copilot", "agent_session": {"value": "s1"}}],
        }
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(adapter, "resolve_session", return_value="s1"),
            patch.object(adapter, "session_tuning", return_value={}),
            patch.object(adapter, "output_path") as source,
        ):
            path = Path(directory) / "events.jsonl"
            path.write_text("output")
            source.return_value = path
            initial = bridge._normalize_snapshot(snapshot)
            self.assertNotIn("lastOutputAt", initial["agents"][0])
            source.assert_not_called()
            active = bridge._normalize_snapshot(snapshot, include_activity=True)
            timestamp = active["agents"][0]["lastOutputAt"]
            source.reset_mock()
            hints = bridge._normalize_snapshot(snapshot, inspect_copilot=False)
            self.assertEqual(hints["agents"][0]["lastOutputAt"], timestamp)
            source.assert_not_called()


if __name__ == "__main__":
    unittest.main()
