import unittest
from dataclasses import replace
from unittest.mock import Mock, patch

from remodr_bridge.bridge import Bridge
from remodr_bridge.errors import BridgeError
from remodr_bridge.providers import ADAPTER_TYPES
from remodr_bridge.providers.base import ProviderAdapter, ProviderSpec


class ProbeAdapter(ProviderAdapter):
    """Replace a registered provider to verify every orchestration surface routes."""

    spec = replace(
        ProviderSpec("opencode", "Probe"),
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
        with patch.dict(ADAPTER_TYPES, {"opencode": ProbeAdapter}):
            bridge = Bridge()
            bridge.agent_catalog = [{"provider": "opencode", "available": True}]
            normalized = bridge._normalize_snapshot({
                "panes": [{"pane_id": "p1"}],
                "agents": [{
                    "pane_id": "p1", "agent": "opencode",
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
                {"retunedBy": "opencode"},
            )
            capabilities = bridge._capabilities(check_store=False)["providerCapabilities"]["opencode"]
            self.assertTrue(capabilities["supportsRetuning"])
            self.assertTrue(capabilities["structuredConversation"])
            self.assertFalse(capabilities["streamingConversation"])

    def test_registry_drives_creation_settings_and_session_arguments(self):
        with patch.dict(ADAPTER_TYPES, {"opencode": ProbeAdapter}):
            bridge = Bridge()
            bridge.runtime["workspaces"] = [{"id": "w1"}]
            bridge.runtime["agents"] = [{"id": "a1", "paneId": "p1"}]
            bridge._refresh_runtime = Mock()
            bridge._agent_catalog_snapshot = Mock(
                return_value=[{"provider": "opencode", "available": True}]
            )
            bridge._herdr_request = Mock(return_value={"root_pane": {"pane_id": "p1"}})
            bridge._start_agent = Mock()
            bridge._create_agent({
                "provider": "opencode", "workspaceId": "w1", "name": "Probe",
                "model": "chosen", "bypassPermissions": True,
            })
            bridge._start_agent.assert_called_once_with(
                "opencode", "opencode", "p1",
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

    def test_opencode_without_identity_and_unknown_refuse_retuning(self):
        bridge = Bridge()
        for name in ("opencode", "unknown"):
            adapter = bridge.providers[name]
            self.assertIsNone(adapter.load_conversation({"id": "a1"}))
            self.assertFalse(adapter.agent_capabilities("s1")["structuredConversation"])
            with self.assertRaises(BridgeError) as error:
                adapter.retune({})
            self.assertEqual(error.exception.code, "INVALID_VARIANT" if name == "opencode" else "PROVIDER_NOT_TUNABLE")


if __name__ == "__main__":
    unittest.main()
