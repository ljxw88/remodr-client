"""Private storage for managed OpenCode server credentials.

Nothing here talks to a server: these tests are about the store itself --
who can read it, what happens when it is damaged or contended, and the
guarantee that a record on disk is a claim rather than an entitlement.
"""
import os
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from herdr_mobile_bridge import Bridge, BridgeError
from remodr_bridge.providers.opencode.registry import (
    MAX_ENTRIES,
    ServerCredential,
    ServerRegistry,
    generate_credentials,
)
from remodr_bridge.storage import host_scope


WORKER = """
import sys
from pathlib import Path
sys.path.insert(0, {source!r})
from remodr_bridge.providers.opencode.registry import ServerCredential, ServerRegistry
Path.home = staticmethod(lambda: Path({home!r}))
registry = ServerRegistry("scope")
registry.record(ServerCredential(
    pane_id=sys.argv[1], cwd="/work", username="user-" + sys.argv[1],
    password="password-" + sys.argv[1], session_id="ses_" + sys.argv[1],
))
print(registry.load(sys.argv[1]).username)
"""


class OpenCodeServerRegistryTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.addCleanup(directory.cleanup)
        self.home = Path(directory.name)
        home = patch.object(Path, "home", return_value=self.home)
        home.start()
        self.addCleanup(home.stop)
        self.registry = ServerRegistry("scope-one")

    def age(self, panes, seconds=600):
        with sqlite3.connect(self.registry.path) as connection:
            connection.executemany(
                "UPDATE servers SET created = created - ? WHERE pane_id=?",
                [(seconds, pane) for pane in panes],
            )

    def credential(self, pane_id="p1", **changes):
        return ServerCredential(**{
            "pane_id": pane_id, "cwd": "/work/project", "username": "user",
            "password": "secret-password", "session_id": "ses_one", **changes,
        })

    def test_records_and_reads_back_one_pane(self):
        self.registry.record(self.credential())
        loaded = self.registry.load("p1")
        self.assertEqual(
            (loaded.pane_id, loaded.cwd, loaded.username, loaded.password, loaded.session_id),
            ("p1", "/work/project", "user", "secret-password", "ses_one"),
        )
        self.assertGreater(loaded.created, 0)

    def test_secrets_never_appear_in_a_rendered_record(self):
        credential = self.credential()
        for rendered in (repr(credential), str(credential), "{}".format(credential)):
            self.assertNotIn("secret-password", rendered)
            self.assertIn("p1", rendered)
        self.assertEqual(
            credential.authorization(), "Basic " + "dXNlcjpzZWNyZXQtcGFzc3dvcmQ=",
        )
        self.assertEqual(credential.environment(), {
            "OPENCODE_SERVER_USERNAME": "user",
            "OPENCODE_SERVER_PASSWORD": "secret-password",
        })

    def test_storage_is_private_and_separate_from_the_command_ledger(self):
        self.registry.record(self.credential())
        path = self.registry.path
        self.assertEqual(path.name, "opencode-servers.sqlite3")
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)
        for name in ("opencode-servers.initialized", "opencode-servers.lock"):
            self.assertEqual((path.parent / name).stat().st_mode & 0o777, 0o600)
        self.assertFalse((path.parent / "commands.sqlite3").exists())

    def test_command_history_and_schema_survive_alongside_the_new_store(self):
        bridge = Bridge()
        bridge.raw_agents = {}
        ledger = bridge._command_ledger()
        command_id = str(uuid.uuid4())
        ledger.reserve(command_id, "fingerprint")
        self.registry.record(self.credential())
        self.assertEqual(ledger.status(command_id)["fingerprint"], "fingerprint")
        with sqlite3.connect(ledger.path) as connection:
            self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], 1)
            self.assertEqual(
                {row[0] for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                )},
                {"commands"},
            )
        self.assertNotIn(b"secret-password", ledger.path.read_bytes())

    def test_reading_never_creates_or_reveals_storage(self):
        self.assertIsNone(self.registry.load("p1"))
        self.assertEqual(self.registry.panes(), frozenset())
        self.registry.forget("p1")
        self.assertFalse(self.registry.path.exists())
        self.assertFalse(self.registry.path.parent.exists())

    def test_scope_isolates_one_bridge_identity_from_another(self):
        self.registry.record(self.credential())
        self.assertIsNone(ServerRegistry("scope-two").load("p1"))
        self.assertEqual(ServerRegistry("scope-two").panes(), frozenset())
        self.assertEqual(self.registry.panes(), frozenset({"p1"}))

    def test_bridge_scope_follows_user_session_and_socket(self):
        bridge = Bridge()
        first = host_scope(bridge)
        bridge.session_name = "another-session"
        self.assertNotEqual(host_scope(bridge), first)
        bridge.session_name = Bridge().session_name
        bridge.herdr_socket = "/different/herdr.sock"
        self.assertNotEqual(host_scope(bridge), first)
        with patch("remodr_bridge.storage.os.getuid", return_value=os.getuid() + 1):
            self.assertNotEqual(host_scope(Bridge()), first)

    def test_forgetting_removes_only_that_pane(self):
        self.registry.record(self.credential("p1"))
        self.registry.record(self.credential("p2", username="second"))
        self.registry.forget("p1")
        self.assertIsNone(self.registry.load("p1"))
        self.assertEqual(self.registry.load("p2").username, "second")

    def test_relaunching_a_pane_replaces_rather_than_merges(self):
        self.registry.record(self.credential())
        self.registry.record(self.credential(username="rotated", password="rotated-password"))
        loaded = self.registry.load("p1")
        self.assertEqual((loaded.username, loaded.password), ("rotated", "rotated-password"))
        self.assertEqual(self.registry.panes(), frozenset({"p1"}))

    def test_stale_records_are_dropped_by_age_when_writing(self):
        self.registry.record(self.credential("old"))
        with sqlite3.connect(self.registry.path) as connection:
            connection.execute("UPDATE servers SET created = 0 WHERE pane_id='old'")
        self.registry.record(self.credential("new"))
        self.assertIsNone(self.registry.load("old"))
        self.assertEqual(self.registry.panes(), frozenset({"new"}))

    def test_a_record_from_the_future_is_not_trusted_either(self):
        self.registry.record(self.credential("skewed"))
        with sqlite3.connect(self.registry.path) as connection:
            connection.execute(
                "UPDATE servers SET created = ? WHERE pane_id='skewed'", (time.time() * 4,)
            )
        self.registry.record(self.credential("current"))
        self.assertIsNone(self.registry.load("skewed"))

    def test_damaged_rows_fail_closed_rather_than_returning_half_a_credential(self):
        self.registry.record(self.credential())
        with sqlite3.connect(self.registry.path) as connection:
            connection.execute("UPDATE servers SET password='' WHERE pane_id='p1'")
        self.assertIsNone(self.registry.load("p1"))

    def test_invalid_bindings_are_refused_before_they_are_written(self):
        for changes in ({"cwd": ""}, {"username": ""}, {"password": ""}, {"session_id": ""}):
            with self.subTest(changes=changes):
                with self.assertRaises(BridgeError) as caught:
                    self.registry.record(self.credential(**changes))
                self.assertEqual(caught.exception.code, "OPENCODE_SERVER_BINDING_INVALID")
        with self.assertRaises(BridgeError):
            self.registry.record(self.credential(pane_id=""))
        self.assertFalse(self.registry.path.exists())

    def test_capacity_refuses_new_panes_without_evicting_live_ones(self):
        self.registry.record(self.credential("p1"))
        with patch("remodr_bridge.providers.opencode.registry.MAX_ENTRIES", 1):
            with self.assertRaises(BridgeError) as caught:
                self.registry.record(self.credential("p2"))
            self.assertEqual(caught.exception.code, "OPENCODE_SERVER_STORE_FULL")
            # Replacing the pane already stored is not a new entry.
            self.registry.record(self.credential("p1", username="rotated"))
        self.assertEqual(self.registry.load("p1").username, "rotated")
        self.assertIsNone(self.registry.load("p2"))
        self.assertLessEqual(len(self.registry.panes()), MAX_ENTRIES)

    def test_only_this_scopes_records_count_towards_its_capacity(self):
        other = ServerRegistry("scope-two")
        with patch("remodr_bridge.providers.opencode.registry.MAX_ENTRIES", 2):
            for index in range(2):
                other.record(self.credential(f"other{index}"))
            # Another device filling its own scope cannot refuse this one.
            self.registry.record(self.credential("p1"))
            self.registry.record(self.credential("p2"))
            with self.assertRaises(BridgeError) as caught:
                self.registry.record(self.credential("p3"))
        self.assertEqual(caught.exception.code, "OPENCODE_SERVER_STORE_FULL")
        self.assertEqual(self.registry.panes(), frozenset({"p1", "p2"}))
        self.assertEqual(other.panes(), frozenset({"other0", "other1"}))

    def test_a_full_scope_still_rotates_a_pane_it_already_holds(self):
        with patch("remodr_bridge.providers.opencode.registry.MAX_ENTRIES", 1):
            self.registry.record(self.credential("p1"))
            self.registry.record(self.credential("p1", password="rotated-password"))
        self.assertEqual(self.registry.load("p1").password, "rotated-password")

    def test_panes_proven_absent_are_reclaimed_within_this_scope_only(self):
        other = ServerRegistry("scope-two")
        for pane in ("p1", "p2"):
            self.registry.record(self.credential(pane))
        other.record(self.credential("p1"))
        self.age(["p1", "p2"])
        self.assertEqual(self.registry.retain({"p2"}), 1)
        self.assertIsNone(self.registry.load("p1"))
        self.assertIsNotNone(self.registry.load("p2"))
        # Another device's panes are not this bridge's to judge.
        self.assertIsNotNone(other.load("p1"))

    def test_a_record_younger_than_the_grace_period_is_never_reclaimed(self):
        self.registry.record(self.credential("p1"))
        self.assertEqual(self.registry.retain(set()), 0)
        self.assertIsNotNone(self.registry.load("p1"))
        self.age(["p1"])
        self.assertEqual(self.registry.retain(set()), 1)
        self.assertIsNone(self.registry.load("p1"))

    def test_reclaiming_never_creates_the_store(self):
        self.assertEqual(self.registry.retain({"p1"}), 0)
        self.assertFalse(self.registry.path.exists())

    def test_transaction_contention_is_retried_rather_than_reported_as_damage(self):
        self.registry.record(self.credential("p1"))
        blocker = sqlite3.connect(self.registry.path, timeout=0)
        self.addCleanup(blocker.close)
        blocker.execute("BEGIN IMMEDIATE")
        with patch("remodr_bridge.providers.opencode.registry.BUSY_DELAY", 0):
            with self.assertRaises(BridgeError) as caught:
                self.registry.record(self.credential("p2"))
        self.assertEqual(caught.exception.code, "OPENCODE_SERVER_STORE_BUSY")
        blocker.execute("COMMIT")
        self.registry.record(self.credential("p2"))
        self.assertEqual(self.registry.panes(), frozenset({"p1", "p2"}))

    def test_a_contended_store_is_retried_before_it_is_refused(self):
        real = ServerRegistry._connect
        attempts = []

        def flaky(registry):
            attempts.append(1)
            if len(attempts) < 3:
                raise BridgeError("OPENCODE_SERVER_STORE_BUSY", "synthetic contention")
            return real(registry)

        with (
            patch.object(ServerRegistry, "_connect", flaky),
            patch("remodr_bridge.providers.opencode.registry.BUSY_DELAY", 0),
        ):
            self.registry.record(self.credential())
        self.assertEqual(len(attempts), 3)
        self.assertEqual(self.registry.load("p1").username, "user")

    def test_a_permanently_busy_store_is_a_typed_refusal(self):
        with (
            patch.object(
                ServerRegistry, "_connect",
                side_effect=BridgeError("OPENCODE_SERVER_STORE_BUSY", "synthetic contention"),
            ),
            patch("remodr_bridge.providers.opencode.registry.BUSY_DELAY", 0),
        ):
            with self.assertRaises(BridgeError) as caught:
                self.registry.record(self.credential())
        self.assertEqual(caught.exception.code, "OPENCODE_SERVER_STORE_BUSY")

    def test_concurrent_processes_each_store_their_own_pane(self):
        source = str(Path(__file__).parent)
        script = WORKER.format(source=source, home=str(self.home))
        processes = [
            subprocess.Popen(
                [sys.executable, "-c", script, f"pane{index}"],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            )
            for index in range(4)
        ]
        results = [process.communicate(timeout=30) for process in processes]
        for index, (out, err) in enumerate(results):
            self.assertEqual(processes[index].returncode, 0, err)
            self.assertEqual(out.strip(), f"user-pane{index}")
        self.assertEqual(
            ServerRegistry("scope").panes(), frozenset(f"pane{index}" for index in range(4))
        )

    def test_a_deleted_database_is_not_silently_recreated(self):
        self.registry.record(self.credential())
        self.registry.path.unlink()
        self.assertIsNone(self.registry.load("p1"))
        with self.assertRaises(BridgeError) as caught:
            self.registry.record(self.credential())
        self.assertEqual(caught.exception.code, "OPENCODE_SERVER_STORE_UNAVAILABLE")
        self.assertFalse(self.registry.path.exists())

    def test_a_foreign_schema_is_not_migrated_over(self):
        self.registry.record(self.credential())
        with sqlite3.connect(self.registry.path) as connection:
            connection.execute("PRAGMA user_version=7")
        with self.assertRaises(BridgeError) as caught:
            self.registry.record(self.credential())
        self.assertEqual(caught.exception.code, "OPENCODE_SERVER_STORE_UNAVAILABLE")
        self.assertIn("not initialized", str(caught.exception))

    def test_a_world_readable_store_is_refused_not_quietly_tightened(self):
        self.registry.record(self.credential())
        self.registry.path.chmod(0o644)
        with self.assertRaises(BridgeError) as caught:
            self.registry.record(self.credential())
        self.assertEqual(caught.exception.code, "OPENCODE_SERVER_STORE_UNAVAILABLE")
        self.assertIn("0644", str(caught.exception))
        self.assertEqual(self.registry.path.stat().st_mode & 0o777, 0o644)

    def test_a_symlinked_store_or_ancestor_is_refused(self):
        self.registry.record(self.credential())
        backup = self.registry.path.with_name("backup")
        self.registry.path.rename(backup)
        self.registry.path.symlink_to(backup)
        with self.assertRaises(BridgeError) as caught:
            self.registry.record(self.credential())
        self.assertEqual(caught.exception.code, "OPENCODE_SERVER_STORE_UNAVAILABLE")
        self.assertIn("symbolic link", str(caught.exception))

    def test_a_symlinked_ancestor_is_refused_before_anything_is_written(self):
        real = self.home / "elsewhere"
        real.mkdir()
        (self.home / ".local").symlink_to(real)
        with self.assertRaises(BridgeError) as caught:
            self.registry.record(self.credential())
        self.assertEqual(caught.exception.code, "OPENCODE_SERVER_STORE_UNAVAILABLE")
        self.assertFalse((real / "share").exists())

    def test_a_foreign_owned_directory_is_not_traversed_or_hardened(self):
        directory = self.home / ".local"
        directory.mkdir(mode=0o755)
        with patch("remodr_bridge.storage.os.getuid", return_value=directory.stat().st_uid + 1):
            with self.assertRaises(BridgeError) as caught:
                self.registry.record(self.credential())
        self.assertIn("owned by uid", str(caught.exception))
        self.assertEqual(directory.stat().st_mode & 0o777, 0o755)
        self.assertFalse((directory / "share").exists())

    def test_generated_credentials_are_random_and_absolute(self):
        first = generate_credentials("p1", "relative/../work", "ses_one")
        second = generate_credentials("p1", "/work", "ses_one")
        self.assertNotEqual(first.password, second.password)
        self.assertNotEqual(first.username, second.username)
        self.assertGreaterEqual(len(second.password), 32)
        self.assertTrue(Path(first.cwd).is_absolute())
        self.assertNotIn(":", second.username)

    def test_stored_secrets_are_never_world_readable_on_disk(self):
        self.registry.record(self.credential())
        mode = stat.S_IMODE(self.registry.path.lstat().st_mode)
        self.assertEqual(mode & 0o077, 0)


if __name__ == "__main__":
    unittest.main()
