import unittest
from concurrent.futures import ThreadPoolExecutor
from dataclasses import FrozenInstanceError
from threading import Barrier

from remodr_bridge.session_registry import SessionBinding, SessionKey, SessionRegistry


VERSION = (1, 2, 3, 4)


class SessionRegistryTest(unittest.TestCase):
    def setUp(self):
        self.sessions = SessionRegistry()
        self.key = SessionKey("a1", "copilot", "s1")
        self.binding = SessionBinding(self.key, "p1")
        self.other = SessionKey("a2", "claude", "s2")

    def seed(self, key, pane):
        self.sessions.record_launch(pane, key.session_id, {"model": key.session_id}, False)
        self.sessions.bind(SessionBinding(key, pane), reported=True)
        self.sessions.cache_tuning(key.session_id, 10, {"model": key.session_id})
        self.sessions.cache_conversation(key, VERSION, {"items": [{"text": key.session_id}]})
        self.sessions.remember_question(key, {"id": key.agent_id, "options": [{"id": "yes"}]})

    def assert_other_untouched(self):
        self.assertEqual(self.sessions.binding("a2"), SessionBinding(self.other, "p2"))
        self.assertEqual(self.sessions.tuning("p2"), {"model": "s2"})
        self.assertEqual(self.sessions.cached_tuning("s2"), (10, {"model": "s2"}))
        self.assertEqual(
            self.sessions.conversation(self.other, VERSION), {"items": [{"text": "s2"}]},
        )
        self.assertEqual(self.sessions.question("a2").key, self.other)
        self.assertFalse(self.sessions.bypass("p2"))

    def test_identity_value_objects_are_immutable_and_include_provider_and_agent(self):
        raw = {"id": "a1", "provider": "copilot", "providerSessionId": "s1", "paneId": "p1"}
        self.assertEqual(SessionKey.from_agent(raw), self.key)
        self.assertEqual(SessionBinding.from_agent(raw), self.binding)
        self.assertEqual(SessionBinding.from_agent({"id": "shell"}), SessionBinding(
            SessionKey("shell", None, None), "",
        ))
        self.assertEqual(SessionBinding.from_agent({"id": "a1", "paneId": 7}).pane_id, "7")
        raw["providerSessionId"] = "changed"
        self.assertEqual(self.key.session_id, "s1")
        with self.assertRaises(FrozenInstanceError):
            self.key.session_id = "changed"
        self.assertEqual(len({
            self.key, SessionKey("a2", "copilot", "s1"), SessionKey("a1", "claude", "s1"),
        }), 3)

    def test_first_identity_retains_launch_tuning_with_or_without_a_launch_id(self):
        for launch_id in (None, "s1"):
            with self.subTest(launch_id=launch_id):
                sessions = SessionRegistry()
                tuning = {"model": "chosen", "effort": "high"}
                sessions.record_launch("p1", launch_id, tuning, False)
                self.assertFalse(sessions.bind(self.binding, reported=True))
                self.assertEqual(sessions.binding("a1"), self.binding)
                self.assertEqual(sessions.tuning("p1"), tuning)
                self.assertTrue(sessions.was_observed("p1"))
                self.assertFalse(sessions.bypass("p1"))

    def test_first_native_identity_after_unreported_placeholder_retains_tuning(self):
        self.sessions.bind(SessionBinding(SessionKey("a1", "claude", None), "p1"), reported=False)
        self.sessions.set_tuning("p1", {"model": "sonnet"})
        self.assertFalse(self.sessions.bind(
            SessionBinding(SessionKey("a1", "claude", "native"), "p1"), reported=True,
        ))
        self.assertEqual(self.sessions.tuning("p1"), {"model": "sonnet"})

    def test_launch_id_mismatch_invalidates_only_the_replaced_agents_state(self):
        self.seed(self.other, "p2")
        self.sessions.record_launch("p1", "launch-id", {"model": "old"}, False)
        launched = SessionKey("a1", "copilot", "launch-id")
        self.sessions.cache_tuning("launch-id", 20, {"model": "old"})
        self.sessions.cache_conversation(launched, VERSION, {"items": []})
        self.sessions.remember_question(launched, {"id": "old"})
        self.assertTrue(self.sessions.bind(self.binding, reported=True))
        self.assertEqual(self.sessions.tuning("p1"), {})
        self.assertIsNone(self.sessions.cached_tuning("launch-id"))
        self.assertIsNone(self.sessions.conversation(launched, VERSION))
        self.assertIsNone(self.sessions.question("old"))
        self.assertFalse(self.sessions.bypass("p1"))
        self.assert_other_untouched()

    def test_rotation_clears_related_caches_and_questions_but_preserves_permissions(self):
        for bypass in (False, True):
            with self.subTest(bypass=bypass):
                self.seed(self.key, "p1")
                self.seed(self.other, "p2")
                self.sessions.record_launch("p1", "s1", {"model": "s1"}, bypass)
                replacement = SessionBinding(SessionKey("a1", "copilot", "new"), "p1")
                self.assertTrue(self.sessions.bind(replacement, reported=True))
                self.assertEqual(self.sessions.binding("a1"), replacement)
                self.assertEqual(self.sessions.tuning("p1"), {})
                self.assertIsNone(self.sessions.cached_tuning("s1"))
                self.assertEqual(self.sessions.conversation_keys(), frozenset({self.other}))
                self.assertEqual(self.sessions.question_ids(), frozenset({"a2"}))
                self.assertEqual(self.sessions.bypass("p1"), bypass)
                self.assertFalse(self.sessions.bind(replacement, reported=True))
                self.assert_other_untouched()

    def test_observed_null_identity_never_revives_a_remembered_launch_hint(self):
        self.seed(self.key, "p1")
        missing = SessionBinding(SessionKey("a1", "copilot", None), "p1")
        self.assertTrue(self.sessions.bind(missing, reported=False))
        self.assertTrue(self.sessions.was_observed("p1"))
        self.assertEqual(self.sessions.launched_session("p1"), "s1")
        self.sessions.set_tuning("p1", {"model": "after-clear"})
        self.assertFalse(self.sessions.bind(missing, reported=False))
        self.assertEqual(self.sessions.binding("a1"), missing)
        self.assertEqual(self.sessions.tuning("p1"), {"model": "after-clear"})
        self.assertTrue(self.sessions.bind(self.binding, reported=True))
        self.assertEqual(self.sessions.tuning("p1"), {})

    def test_provider_switch_invalidates_even_when_session_id_is_unchanged(self):
        self.seed(self.key, "p1")
        self.seed(self.other, "p2")
        replacement = SessionBinding(SessionKey("a1", "claude", "s1"), "p1")
        self.assertTrue(self.sessions.bind(replacement, reported=True))
        self.assertEqual(self.sessions.binding("a1"), replacement)
        self.assertEqual(self.sessions.tuning("p1"), {})
        self.assertIsNone(self.sessions.cached_tuning("s1"))
        self.assertIsNone(self.sessions.conversation(self.key, VERSION))
        self.assertIsNone(self.sessions.question("a1"))
        self.assert_other_untouched()

    def test_shared_session_conversations_remain_scoped_to_the_agent_and_provider(self):
        keys = (self.key, SessionKey("a2", "copilot", "s1"), SessionKey("a1", "claude", "s1"))
        for key in keys:
            self.sessions.cache_conversation(key, VERSION, {"agent": key.agent_id, "provider": key.provider})
        for key in keys:
            self.assertEqual(self.sessions.conversation(key, VERSION), {
                "agent": key.agent_id, "provider": key.provider,
            })
            self.assertIsNone(self.sessions.conversation(key, (1, 2, 3, 5)))
        self.assertEqual(self.sessions.conversation_keys(), frozenset(keys))

    def test_pruning_dead_agents_keeps_live_shell_pane_launch_and_permission_state(self):
        self.seed(self.key, "p1")
        self.seed(self.other, "p2")
        self.sessions.record_launch("shell", "pending", {"model": "pending"}, False)
        self.sessions.record_identity(
            "shell", error="pending identity", diagnostic="waiting", process_bound=True,
        )
        self.sessions.prune({"p1", "p2", "shell"}, {"s2"}, {"a2"})
        self.assertIsNone(self.sessions.binding("a1"))
        self.assertEqual(self.sessions.tuning("p1"), {})
        self.assertIsNone(self.sessions.cached_tuning("s1"))
        self.assertEqual(self.sessions.conversation_keys(), frozenset({self.other}))
        self.assertEqual(self.sessions.question_ids(), frozenset({"a2"}))
        self.assertEqual(self.sessions.launched_session("p1"), "s1")
        self.assertFalse(self.sessions.bypass("p1"))
        self.assertEqual(self.sessions.launched_session("shell"), "pending")
        self.assertEqual(self.sessions.tuning("shell"), {"model": "pending"})
        self.assertFalse(self.sessions.bypass("shell"))
        self.assertEqual(self.sessions.identity_error("shell"), "pending identity")
        self.assertTrue(self.sessions.is_process_bound("shell"))
        self.assert_other_untouched()
        self.sessions.prune({"p2"}, {"s2"}, {"a2"})
        for pane in ("p1", "shell"):
            self.assertIsNone(self.sessions.launched_session(pane))
            self.assertEqual(self.sessions.tuning(pane), {})
            self.assertTrue(self.sessions.bypass(pane))
            self.assertIsNone(self.sessions.identity_error(pane))
            self.assertFalse(self.sessions.is_process_bound(pane))
            self.assertFalse(self.sessions.was_observed(pane))
        self.assert_other_untouched()

    def test_forgetting_a_pane_removes_every_binding_and_is_idempotent(self):
        self.seed(self.key, "p1")
        same_pane = SessionKey("a3", "opencode", "ses_registry")
        self.seed(same_pane, "p1")
        self.seed(self.other, "p2")
        self.sessions.forget_pane("p1")
        self.sessions.forget_pane("p1")
        for key in (self.key, same_pane):
            self.assertIsNone(self.sessions.binding(key.agent_id))
            self.assertIsNone(self.sessions.cached_tuning(key.session_id))
            self.assertIsNone(self.sessions.question(key.agent_id))
        self.assertIsNone(self.sessions.launched_session("p1"))
        self.assertFalse(self.sessions.was_observed("p1"))
        self.assertTrue(self.sessions.bypass("p1"))
        self.assertEqual(self.sessions.conversation_keys(), frozenset({self.other}))
        self.assert_other_untouched()

    def test_removing_an_unbound_agent_still_clears_its_questions_and_conversations(self):
        self.sessions.cache_conversation(self.key, VERSION, {"items": []})
        self.sessions.remember_question(self.key, {"id": "unbound"})
        self.sessions.remove_agent("a1")
        self.sessions.remove_agent("a1")
        self.assertEqual(self.sessions.conversation_keys(), frozenset())
        self.assertEqual(self.sessions.question_ids(), frozenset())

    def test_json_inputs_and_outputs_are_owned_copies(self):
        tuning = {"model": "chosen", "nested": {"values": ["original"]}}
        self.sessions.record_launch("p1", "s1", tuning, False)
        self.sessions.set_tuning("p2", tuning)
        self.sessions.cache_tuning("s1", 10, tuning)
        conversation = {"items": [{"text": "original"}]}
        question = {"id": "q1", "options": [{"label": "original"}]}
        self.sessions.cache_conversation(self.key, VERSION, conversation)
        self.sessions.remember_question(self.key, question)
        tuning["nested"]["values"].append("input mutation")
        conversation["items"][0]["text"] = "input mutation"
        question["options"][0]["label"] = "input mutation"
        for pane in ("p1", "p2"):
            output = self.sessions.tuning(pane)
            self.assertEqual(output["nested"]["values"], ["original"])
            output["nested"]["values"].append("output mutation")
            self.assertEqual(self.sessions.tuning(pane)["nested"]["values"], ["original"])
        cached = self.sessions.cached_tuning("s1")
        self.assertEqual(cached[1]["nested"]["values"], ["original"])
        cached[1]["nested"]["values"].append("output mutation")
        self.assertEqual(self.sessions.cached_tuning("s1")[1]["nested"]["values"], ["original"])
        result = self.sessions.conversation(self.key, VERSION)
        self.assertEqual(result["items"][0]["text"], "original")
        result["items"][0]["text"] = "output mutation"
        self.assertEqual(self.sessions.conversation(self.key, VERSION)["items"][0]["text"], "original")
        pending = self.sessions.question("q1")
        self.assertEqual(pending.key, self.key)
        self.assertEqual(pending.request["options"][0]["label"], "original")
        pending.request["options"][0]["label"] = "output mutation"
        self.assertEqual(self.sessions.question("q1").request["options"][0]["label"], "original")
        keys, ids = self.sessions.conversation_keys(), self.sessions.question_ids()
        self.sessions.remember_question(self.other, {"id": "q2"})
        self.sessions.cache_conversation(self.other, VERSION, {})
        self.assertEqual(keys, frozenset({self.key}))
        self.assertEqual(ids, frozenset({"q1"}))

    def test_registry_instances_do_not_share_any_state(self):
        self.seed(self.key, "p1")
        self.sessions.record_identity(
            "p1", error="error", diagnostic="diagnostic", process_bound=True, observed=True,
        )
        other = SessionRegistry()
        self.assertIsNone(other.binding("a1"))
        self.assertIsNone(other.launched_session("p1"))
        self.assertEqual(other.tuning("p1"), {})
        self.assertTrue(other.bypass("p1"))
        self.assertIsNone(other.cached_tuning("s1"))
        self.assertIsNone(other.identity_error("p1"))
        self.assertFalse(other.was_observed("p1"))
        self.assertFalse(other.is_process_bound("p1"))
        self.assertEqual(other.conversation_keys(), frozenset())
        self.assertEqual(other.question_ids(), frozenset())

    def test_identity_updates_replace_inspection_state_and_preserve_observation(self):
        self.assertIsNone(self.sessions.identity_error(None))
        self.assertTrue(self.sessions.record_identity(
            "p1", error="unresolved", diagnostic="first", process_bound=True, observed=True,
        ))
        self.assertEqual(self.sessions.identity_error("p1"), "unresolved")
        self.assertTrue(self.sessions.is_process_bound("p1"))
        self.assertTrue(self.sessions.was_observed("p1"))
        self.assertFalse(self.sessions.record_identity(
            "p1", error=None, diagnostic="first", process_bound=False,
        ))
        self.assertIsNone(self.sessions.identity_error("p1"))
        self.assertFalse(self.sessions.is_process_bound("p1"))
        self.assertTrue(self.sessions.was_observed("p1"))
        self.assertTrue(self.sessions.record_identity(
            "p1", error="retry", diagnostic="second", process_bound=True,
        ))
        self.sessions.forget_process_binding("p1")
        self.assertFalse(self.sessions.is_process_bound("p1"))
        self.assertEqual(self.sessions.identity_error("p1"), "retry")
        self.sessions.clear_identity("p1")
        self.assertIsNone(self.sessions.identity_error("p1"))
        self.assertFalse(self.sessions.is_process_bound("p1"))
        self.assertTrue(self.sessions.was_observed("p1"))
        self.assertFalse(self.sessions.record_identity(
            "p1", error=None, diagnostic=None, process_bound=False,
        ))

    def test_forgetting_launch_and_question_does_not_clear_unrelated_state(self):
        self.seed(self.key, "p1")
        self.sessions.forget_launch_session("p1")
        self.sessions.forget_launch_session("missing")
        self.sessions.forget_question("a1")
        self.sessions.forget_question("missing")
        self.assertIsNone(self.sessions.launched_session("p1"))
        self.assertIsNone(self.sessions.question("a1"))
        self.assertEqual(self.sessions.binding("a1"), self.binding)
        self.assertEqual(self.sessions.tuning("p1"), {"model": "s1"})
        self.assertFalse(self.sessions.bypass("p1"))
        self.assertIsNotNone(self.sessions.conversation(self.key, VERSION))
        self.sessions.remember_launch_session("p1", "replacement")
        self.assertEqual(self.sessions.launched_session("p1"), "replacement")

    def test_concurrent_identical_identity_updates_report_one_diagnostic_change(self):
        workers = 8
        ready = Barrier(workers)

        def record(_):
            ready.wait(timeout=5)
            return self.sessions.record_identity(
                "p1", error="unresolved", diagnostic="same diagnostic",
                process_bound=True, observed=True,
            )

        with ThreadPoolExecutor(max_workers=workers) as executor:
            changes = list(executor.map(record, range(workers)))
        self.assertEqual(changes.count(True), 1)
        self.assertEqual(self.sessions.identity_error("p1"), "unresolved")
        self.assertTrue(self.sessions.is_process_bound("p1"))
        self.assertTrue(self.sessions.was_observed("p1"))

    def test_concurrent_rotations_keep_every_new_binding_and_question(self):
        workers = 8
        ready = Barrier(workers)

        def rotate(index):
            key = SessionKey(f"agent-{index}", "copilot", f"old-{index}")
            pane = f"pane-{index}"
            self.seed(key, pane)
            ready.wait(timeout=5)
            replacement = SessionKey(key.agent_id, key.provider, f"new-{index}")
            changed = self.sessions.bind(SessionBinding(replacement, pane), reported=True)
            self.sessions.remember_question(replacement, {"id": key.agent_id})
            self.sessions.cache_conversation(replacement, VERSION, {"items": []})
            return replacement, changed

        with ThreadPoolExecutor(max_workers=workers) as executor:
            results = list(executor.map(rotate, range(workers)))
        self.assertTrue(all(changed for _, changed in results))
        self.assertEqual(self.sessions.conversation_keys(), frozenset(key for key, _ in results))
        self.assertEqual(self.sessions.question_ids(), frozenset(key.agent_id for key, _ in results))
        for index, (key, _) in enumerate(results):
            self.assertEqual(self.sessions.binding(key.agent_id), SessionBinding(key, f"pane-{index}"))
            self.assertEqual(self.sessions.question(key.agent_id).key, key)
            self.assertIsNone(self.sessions.cached_tuning(f"old-{index}"))
            self.assertFalse(self.sessions.bypass(f"pane-{index}"))


if __name__ == "__main__":
    unittest.main()
