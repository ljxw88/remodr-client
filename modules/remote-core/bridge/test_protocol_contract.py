"""Read-only golden contracts shared with src/domain/protocol-contract.test.ts."""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from herdr_mobile_bridge import Bridge


FIXTURES = Path(__file__).parent / "fixtures" / "protocol"
CONVERSATIONS = (
    "copilot-session-replacement.json",
    "claude-empty-session.json",
    "codex-empty-session.json",
    "cursor-null-session-fallback.json",
)


def fixture(name):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


class ProtocolContractTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.addCleanup(directory.cleanup)
        self.home = Path(directory.name)
        home = patch.object(Path, "home", return_value=self.home)
        home.start()
        self.addCleanup(home.stop)
        environment = patch.dict("os.environ", {
            "HOME": str(self.home),
            "CODEX_HOME": str(self.home / ".codex"),
            "HERDR_SOCKET": str(self.home / "herdr.sock"),
            "HERDR_SESSION": "contract-session",
            "REMOTE_WORKSPACE_DEVICE_ID": "contract-device",
        })
        environment.start()
        self.addCleanup(environment.stop)
        self.mutations = []
        self.fail_mutation = False
        self.bridge = self.make_bridge()

    def make_bridge(self):
        bridge = Bridge()
        bridge.agent_catalog = []
        bridge._ensure_pane_subscriptions = Mock()
        bridge.write_event = Mock()
        bridge.write = Mock()
        # Only the external Herdr boundary is faked; normalization, provider
        # readers, session reconciliation, dispatch and the ledger remain real.
        bridge._herdr_request = Mock(side_effect=self.herdr_request)
        return bridge

    def herdr_request(self, method, params):
        session = self.frame["session"]
        if method == "session.snapshot":
            return {"snapshot": {
                "workspaces": [{"workspace_id": "contract-workspace", "label": "Synthetic"}],
                "panes": [{"pane_id": session["paneId"]}],
                "agents": [{
                    "agent": session["provider"],
                    "pane_id": session["paneId"],
                    "workspace_id": "contract-workspace",
                    "agent_status": "idle",
                    "agent_session": {"value": session["providerSessionId"]},
                }],
            }}
        if method == "agent.read":
            return {"read": {"text": self.frame["terminalText"], "revision": 7}}
        if method == "pane.process_info":
            return {}
        if method == "agent.prompt":
            self.mutations.append(params)
            if self.fail_mutation:
                raise OSError("Synthetic lost acknowledgment after dispatch")
            return {}
        self.fail(f"Unexpected Herdr request: {method}")

    def install_frame(self, frame):
        self.frame = frame
        session = frame["session"]
        session_id = session["providerSessionId"]
        paths = {
            "copilot": self.home / ".copilot" / "session-state" / str(session_id) / "events.jsonl",
            "claude": self.home / ".claude" / "projects" / "synthetic" / f"{session_id}.jsonl",
            "codex": self.home / ".codex" / "sessions" / f"{session_id}.jsonl",
        }
        path = paths.get(session["provider"])
        if path:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(
                "".join(json.dumps(event) + "\n" for event in frame["events"]),
                encoding="utf-8",
            )

    def test_conversations_match_production_output_exactly(self):
        for name in CONVERSATIONS:
            self.bridge = self.make_bridge()
            for frame in fixture(name)["frames"]:
                with self.subTest(fixture=name, session=frame["session"]):
                    self.install_frame(frame)
                    actual = self.bridge._dispatch(
                        "agent.conversation", {"agentId": frame["conversation"]["agentId"]}
                    )
                    self.assertEqual(actual, frame["conversation"])
                    agent = self.bridge.runtime["agents"][0]
                    self.assertEqual(agent["capabilities"], frame["capabilities"])
                    self.assertEqual(
                        {key: agent[key] for key in frame["session"]}, frame["session"]
                    )
                    if actual["semantic"] and actual["provider"] != "codex":
                        self.assertFalse(any(
                            call.args[0] == "agent.read"
                            for call in self.bridge._herdr_request.call_args_list
                        ))
                    if not actual["activeHumanRequest"]:
                        self.assertEqual(self.bridge.sessions.question_ids(), frozenset())

    def test_durable_responses_and_restart_replay_match_production(self):
        self.install_frame(fixture("copilot-session-replacement.json")["frames"][0])
        for case in fixture("durable-command-responses.json")["cases"]:
            with self.subTest(case=case["name"]):
                self.bridge = self.make_bridge()
                self.fail_mutation = case["name"] == "uncertain"
                before = len(self.mutations)
                self.bridge._handle_request_line(json.dumps(case["request"]))
                self.assertEqual(self.bridge.write.call_args.args[0], case["response"])
                self.assertEqual(len(self.mutations), before + 1)

                restarted = self.make_bridge()
                status = restarted._dispatch(
                    "command.status", {"commandId": case["request"]["commandId"]}
                )
                stored = {key: value for key, value in case["response"].items() if key != "id"}
                self.assertEqual(status["state"], case["state"])
                self.assertEqual(status["response"], stored)
                retry = {**case["request"], "id": "contract-retry"}
                restarted._handle_request_line(json.dumps(retry))
                self.assertEqual(
                    restarted.write.call_args.args[0],
                    {**case["response"], "id": "contract-retry"},
                )
                restarted._herdr_request.assert_not_called()
                self.assertEqual(len(self.mutations), before + 1)


if __name__ == "__main__":
    unittest.main()
