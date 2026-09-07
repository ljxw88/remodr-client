import unittest
from unittest.mock import Mock, patch

from remodr_bridge.bridge import Bridge
from remodr_bridge.providers import SUPPORTED_PROVIDERS


class CompletionRevisionTest(unittest.TestCase):
    def test_runtime_revision_orders_snapshots_without_redundant_events_or_wall_clock_dependence(self):
        bridge = Bridge()
        bridge.agent_catalog = []
        bridge._herdr_request = Mock(return_value={"snapshot": {"agents": [], "panes": [], "workspaces": []}})
        bridge._ensure_pane_subscriptions = Mock()
        bridge.write_event = Mock()
        with patch("remodr_bridge.runtime.time.time", side_effect=[200, 100]):
            bridge._refresh_runtime()
            self.assertEqual(bridge.runtime["runtimeRevision"], 1)
            bridge._refresh_runtime_and_publish()
        self.assertEqual(bridge.runtime["runtimeRevision"], 2)
        bridge.write_event.assert_not_called()

    def test_native_status_revision_is_forwarded_for_every_provider(self):
        for provider in SUPPORTED_PROVIDERS:
            with self.subTest(provider=provider):
                bridge = Bridge()
                adapter = bridge.provider_adapter(provider)
                with (
                    patch.object(adapter, "resolve_session", return_value=None),
                    patch.object(adapter, "session_tuning", return_value={}),
                ):
                    runtime = bridge._normalize_snapshot({
                        "panes": [{"pane_id": "p1"}],
                        "agents": [{
                            "pane_id": "p1", "agent": provider,
                            "agent_status": "done", "state_change_seq": 42,
                        }],
                    })
                self.assertEqual(runtime["agents"][0]["status"], "done")
                self.assertEqual(runtime["agents"][0]["statusRevision"], 42)

    def test_invalid_or_missing_status_revisions_do_not_break_snapshots(self):
        bridge = Bridge()
        for revision in (None, True, -1, "42", 10 ** 30):
            with self.subTest(revision=revision):
                runtime = bridge._normalize_snapshot({
                    "panes": [{"pane_id": "p1"}],
                    "agents": [{"pane_id": "p1", "agent": "opencode", "state_change_seq": revision}],
                })
                self.assertNotIn("statusRevision", runtime["agents"][0])


if __name__ == "__main__":
    unittest.main()
