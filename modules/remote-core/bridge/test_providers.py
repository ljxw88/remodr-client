import json
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import Mock, patch

from remodr_bridge.bridge import Bridge
from remodr_bridge.errors import BridgeError
from remodr_bridge.providers import ADAPTER_TYPES
from remodr_bridge.providers.base import ProviderAdapter, ProviderSpec
from remodr_bridge.providers.claude import ClaudeAdapter
from remodr_bridge.providers.cursor import CursorAdapter


class ProbeAdapter(ProviderAdapter):
    """Replace a registered provider to verify every orchestration surface routes."""

    spec = replace(
        CursorAdapter.spec,
        bypass_arguments=("--probe-bypass",),
        tuning_flags={"model": "--probe-model"},
        retunable=True,
        structured_conversation=True,
    )

    @staticmethod
    def new_session_arguments(label, args):
        args.extend(["--probe-session", label])
        return "probe-launch"

    def resolve_session(self, raw, native_session_id, *, inspect):
        return "probe-session"

    def load_conversation(self, agent):
        return {"agentId": agent["id"], "providerSessionId": agent["providerSessionId"]}

    def session_tuning(self, session_id):
        return {"model": "probe-reported"}

    def retune(self, payload):
        return {"retunedBy": self.spec.name}

    def has_semantic_session(self, session_id):
        return session_id == "probe-session"


class ProviderRegistryTest(unittest.TestCase):
    def test_provider_spec_matches_its_own_id_without_redundant_aliases(self):
        spec = ProviderSpec("future", "Future", aliases=("alternate",))
        self.assertTrue(spec.matches("future"))
        self.assertTrue(spec.matches("alternate"))
        self.assertFalse(spec.matches("notfuture"))

    def test_tool_activity_is_independent_of_streaming_for_future_adapters(self):
        class ToolAdapter(ProbeAdapter):
            spec = replace(ProbeAdapter.spec, tool_activity=True, streaming=False)

        capabilities = ToolAdapter(Bridge()).agent_capabilities("probe-session")
        self.assertTrue(capabilities["toolActivity"])
        self.assertFalse(capabilities["streamingConversation"])

    def test_registry_drives_identity_conversations_tuning_and_capabilities(self):
        with patch.dict(ADAPTER_TYPES, {"cursor": ProbeAdapter}):
            bridge = Bridge()
            bridge.agent_catalog = [{"provider": "cursor", "available": True}]
            normalized = bridge._normalize_snapshot({
                "panes": [{"pane_id": "p1"}],
                "agents": [{
                    "pane_id": "p1", "agent": "cursor",
                    "agent_session": {"value": "native-session"},
                }],
            })
            agent = normalized["agents"][0]
            self.assertEqual(agent["providerSessionId"], "probe-session")
            self.assertEqual(agent["tuning"]["model"], "probe-reported")
            self.assertTrue(agent["capabilities"]["structuredConversation"])
            self.assertTrue(agent["capabilities"]["supportsRetuning"])
            self.assertEqual(bridge._load_conversation(agent), {
                "agentId": agent["id"], "providerSessionId": "probe-session",
            })
            self.assertEqual(
                bridge._retune_current_agent({"agentId": agent["id"]}),
                {"retunedBy": "cursor"},
            )
            capabilities = bridge._capabilities(check_store=False)["providerCapabilities"]["cursor"]
            self.assertTrue(capabilities["supportsRetuning"])
            self.assertTrue(capabilities["structuredConversation"])
            self.assertFalse(capabilities["streamingConversation"])

    def test_registry_drives_creation_settings_and_session_arguments(self):
        with patch.dict(ADAPTER_TYPES, {"cursor": ProbeAdapter}):
            bridge = Bridge()
            bridge.runtime["workspaces"] = [{"id": "w1"}]
            bridge.runtime["agents"] = [{"id": "a1", "paneId": "p1"}]
            bridge._refresh_runtime = Mock()
            bridge._agent_catalog_snapshot = Mock(
                return_value=[{"provider": "cursor", "available": True}]
            )
            bridge._herdr_request = Mock(return_value={"root_pane": {"pane_id": "p1"}})
            bridge._start_agent = Mock()
            bridge._create_agent({
                "provider": "cursor", "workspaceId": "w1", "name": "Probe",
                "model": "chosen", "bypassPermissions": True,
            })
            bridge._start_agent.assert_called_once_with(
                "cursor", "cursor", "p1",
                ["--probe-bypass", "--probe-model", "chosen", "--probe-session", "Probe"],
            )
            self.assertEqual(bridge.sessions.launched_session("p1"), "probe-launch")

    def test_each_bridge_owns_its_adapters_and_session_state(self):
        first, second = Bridge(), Bridge()
        self.assertEqual(set(first.providers), {*ADAPTER_TYPES, "unknown"})
        for provider in first.providers:
            self.assertIsNot(first.providers[provider], second.providers[provider])
            self.assertIs(first.providers[provider].host, first)
        self.assertIsNot(first.providers["copilot"].tuning, second.providers["copilot"].tuning)
        self.assertIsNot(first.sessions, second.sessions)
        first.sessions.cache_tuning("session", 1, {"model": "first"})
        self.assertIsNone(second.sessions.cached_tuning("session"))

    def test_claude_uses_native_identity_and_reads_only_its_transcript(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            home = Path(directory)
            project = home / ".claude" / "projects" / "workspace"
            project.mkdir(parents=True)
            (project / "claude-native.jsonl").write_text(
                json.dumps({"id": "user", "type": "user", "message": {
                    "role": "user", "content": [{"type": "text", "text": "native transcript"}],
                }}) + "\n"
            )
            with patch.object(Path, "home", return_value=home):
                bridge = Bridge()
                adapter = bridge.providers["claude"]
                self.assertIsInstance(adapter, ClaudeAdapter)
                bridge._herdr_request = Mock()
                bridge.sessions.record_identity(
                    "p1", error="old provider error", diagnostic="old diagnostic",
                    process_bound=True,
                )
                session = adapter.resolve_session(
                    {"pane_id": "p1"}, "claude-native", inspect=True,
                )
                self.assertEqual(session, "claude-native")
                self.assertFalse(bridge.sessions.is_process_bound("p1"))
                self.assertIsNone(bridge.sessions.identity_error("p1"))
                result = adapter.load_conversation({"id": "a1", "providerSessionId": session})
                self.assertEqual(result["items"][0]["text"], "native transcript")
                self.assertTrue(result["semantic"])
                self.assertEqual(adapter.session_tuning(session), {})
                bridge._herdr_request.assert_not_called()

    def test_cursor_and_unknown_do_not_claim_semantic_or_retuning_support(self):
        bridge = Bridge()
        for name in ("cursor", "unknown"):
            adapter = bridge.providers[name]
            self.assertIsNone(adapter.load_conversation({"id": "a1"}))
            self.assertFalse(adapter.agent_capabilities("s1")["structuredConversation"])
            with self.assertRaises(BridgeError) as error:
                adapter.retune({})
            self.assertEqual(error.exception.code, "PROVIDER_NOT_TUNABLE")


if __name__ == "__main__":
    unittest.main()
