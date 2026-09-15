"""Native variant discovery and delivery with synthetic provider metadata."""
import copy
import unittest
from unittest.mock import Mock, patch

from remodr_bridge.bridge import Bridge
from remodr_bridge.errors import BridgeError
from remodr_bridge.providers.opencode import native
from test_opencode_native import SESSION, binding


MODEL = "openai/custom/model"
PROVIDERS = {
    "all": [{
        "id": "openai", "key": "private-key", "options": {"apiKey": "secret"},
        "models": {"custom/model": {
            "id": "custom/model", "providerID": "openai", "name": "Custom model",
            "variants": {
                "low": {"reasoningEffort": "low"},
                "custom-deep": {"reasoningEffort": "high", "apiKey": "secret"},
                "hidden": {"disabled": True},
            },
        }},
    }],
    "connected": ["openai"], "default": {"openai": "custom/model"},
}


class OpenCodeApiVariantsTest(unittest.TestCase):
    def setUp(self):
        self.bridge = Bridge()
        self.agent = {"id": "a1", "provider": "opencode", "paneId": "p1", "providerSessionId": SESSION}
        self.bridge.raw_agents = {"a1": self.agent}
        self.bridge.runtime = {"agents": [], "workspaces": []}
        self.bridge._refresh_runtime = Mock()
        self.bridge._herdr_request = Mock()
        self.adapter = self.bridge.providers["opencode"]
        self.adapter.require_binding = Mock(return_value=binding())
        self.payload = {"agentId": "a1", "providerSessionId": SESSION, "model": MODEL}
        self.providers = copy.deepcopy(PROVIDERS)
        self.get = patch.object(native.api, "get", side_effect=lambda *a, **kw: (200, self.providers))
        self.request = self.get.start()
        self.addCleanup(self.get.stop)

    def test_discovery_projects_only_names_for_the_requested_model(self):
        self.assertEqual(self.adapter.variant_options(self.payload), {
            "modelLabel": "Custom model", "modelToken": MODEL,
            "currentVariant": None, "variants": ["low", "custom-deep"],
        })
        self.assertEqual(self.request.call_args.args[1], "/provider")
        self.bridge._herdr_request.assert_not_called()
        self.assertEqual(self.bridge.sessions.tuning("p1"), {})

    def test_variant_is_pinned_to_model_and_sent_on_future_prompts(self):
        self.adapter.retune({**self.payload, "variant": "custom-deep", "modelToken": MODEL})
        self.assertEqual(self.adapter.variant_options(self.payload)["currentVariant"], "custom-deep")
        with patch.object(native.api, "post", return_value=(204, None)) as post:
            self.adapter.send_message(self.agent, "Hello")
        self.assertEqual(post.call_args.args[2], {
            "parts": [{"type": "text", "text": "Hello"}],
            "model": {"providerID": "openai", "modelID": "custom/model"},
            "variant": "custom-deep",
        })
        self.bridge._herdr_request.assert_not_called()

    def test_default_and_model_changes_clear_the_override(self):
        for change in ({"variant": None}, {"model": "openai/another"}, {"model": None}):
            with self.subTest(change=change):
                self.adapter.retune({**self.payload, "variant": "low", "modelToken": MODEL})
                self.adapter.retune({**self.payload, **change})
                self.assertIsNone(self.bridge.sessions.tuning("p1")["variant"])
                with patch.object(native.api, "post", return_value=(204, None)) as post:
                    self.adapter.send_message(self.agent, "Hello")
                self.assertNotIn("variant", post.call_args.args[2])

    def test_rejects_stale_session_model_and_unavailable_variants_before_mutation(self):
        for change in (
            {"providerSessionId": "ses_other"}, {"modelToken": "openai/other"},
            {"variant": "hidden"}, {"variant": "removed"}, {"variant": "bad\nname"},
            {"model": None},
        ):
            with self.subTest(change=change), self.assertRaises(BridgeError):
                self.adapter.retune({**self.payload, "variant": "low", "modelToken": MODEL, **change})
            self.assertEqual(self.bridge.sessions.tuning("p1"), {})
        with self.assertRaises(BridgeError):
            self.adapter.variant_options({**self.payload, "providerSessionId": "ses_other"})
        self.bridge._herdr_request.assert_not_called()

    def test_revalidates_variants_on_apply(self):
        self.adapter.variant_options(self.payload)
        del self.providers["all"][0]["models"]["custom/model"]["variants"]["low"]
        with self.assertRaises(BridgeError):
            self.adapter.retune({**self.payload, "variant": "low", "modelToken": MODEL})
        self.assertEqual(self.bridge.sessions.tuning("p1"), {})

    def test_empty_variants_are_distinct_from_malformed_or_disconnected_models(self):
        model = self.providers["all"][0]["models"]["custom/model"]
        del model["variants"]
        self.assertEqual(self.adapter.variant_options(self.payload)["variants"], [])
        for variants in ([], {"bad\nname": {}}, {"low": "invalid"}, {str(i): {} for i in range(129)}):
            model["variants"] = variants
            with self.subTest(variants=variants), self.assertRaises(BridgeError):
                self.adapter.variant_options(self.payload)
        model["variants"] = {}
        self.providers["connected"] = []
        with self.assertRaises(BridgeError):
            self.adapter.variant_options(self.payload)

    def test_lost_native_binding_does_not_open_tui_picker(self):
        self.adapter.require_binding.side_effect = BridgeError("OPENCODE_API_UNAVAILABLE", "Reconnect")
        with self.assertRaises(BridgeError):
            self.adapter.variant_options(self.payload)
        self.adapter.require_binding.assert_called_once_with(self.agent, allow_compatibility=False)
        self.bridge._herdr_request.assert_not_called()


if __name__ == "__main__":
    unittest.main()
