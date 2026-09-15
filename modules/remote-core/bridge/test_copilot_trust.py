import fcntl
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier
from unittest.mock import patch
from unittest.mock import Mock

from remodr_bridge.bridge import Bridge
from remodr_bridge.errors import BridgeError
from remodr_bridge.providers.copilot import trust


class CopilotTrustTest(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix=".copilot-trust-test-", dir=Path.cwd())
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name).resolve()
        self.home = self.root / "home"
        self.home.mkdir()
        self.project = self.root / "project"
        self.project.mkdir()
        self.config_home = self.home / ".copilot"
        self.config = self.config_home / "config.json"
        environment = patch.dict(os.environ, {"HOME": str(self.home), "COPILOT_HOME": ""})
        environment.start()
        self.addCleanup(environment.stop)

    def seed(self, config):
        self.config_home.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.config.write_text(json.dumps(config), encoding="utf-8")

    def read(self):
        return json.loads(self.config.read_text(encoding="utf-8"))

    def assert_rejected(self, cwd=None):
        with self.assertRaises(BridgeError) as raised:
            trust.trust_workspace(str(self.project) if cwd is None else cwd)
        self.assertEqual(raised.exception.code, "COPILOT_TRUST_UNAVAILABLE")
        self.assertIn("retry", str(raised.exception))
        return str(raised.exception)

    def test_missing_config_trusts_only_exact_canonical_workspace(self):
        nested = self.project / "nested"
        nested.mkdir()
        trust.trust_workspace(str(nested / ".."))
        self.assertEqual(self.read(), {"trustedFolders": [str(self.project)]})
        self.assertFalse((self.home / "config.json").exists())

    def test_idempotent_and_preserves_every_other_field(self):
        original = {
            "trustedFolders": ["/already/trusted", str(self.project), "/already/trusted"],
            "auth": {"secret": "never-print-this"},
            "tools": {"allow": ["existing"]},
            "boolean": True, "number": 23, "nested": [None, {"unicode": "日本語"}],
        }
        self.seed(original)
        trust.trust_workspace(str(self.project))
        expected = dict(original, trustedFolders=["/already/trusted", str(self.project)])
        self.assertEqual(self.read(), expected)
        before = self.config.stat()
        content = self.config.read_bytes()
        trust.trust_workspace(str(self.project))
        self.assertEqual(self.config.read_bytes(), content)
        self.assertEqual(self.config.stat().st_ino, before.st_ino)
        self.assertEqual(self.config.stat().st_mtime_ns, before.st_mtime_ns)

    def test_existing_trust_entries_are_not_normalized_or_broadened(self):
        self.seed({"trustedFolders": ["relative/path", "/another/../spelling"]})
        trust.trust_workspace(str(self.project))
        self.assertEqual(self.read()["trustedFolders"], [
            "relative/path", "/another/../spelling", str(self.project),
        ])

    def test_workspace_symlink_is_canonicalized(self):
        link = self.root / "project-link"
        link.symlink_to(self.project, target_is_directory=True)
        trust.trust_workspace(str(link))
        self.assertEqual(self.read()["trustedFolders"], [str(self.project)])

    def test_invalid_workspace_does_not_create_config_home(self):
        file = self.root / "file"
        file.touch()
        root_link = self.root / "root-link"
        root_link.symlink_to("/", target_is_directory=True)
        for cwd in ("", "relative", "/", str(root_link), str(file), str(self.root / "missing"), "/bad\0path"):
            with self.subTest(cwd=cwd):
                self.assert_rejected(cwd)
                self.assertFalse(self.config_home.exists())

    def test_malformed_config_is_unchanged_and_error_is_sanitized(self):
        self.config_home.mkdir()
        for content in (
            b"", b"\xffsecret", b'{"auth": "never-print-this",',
            b"[]", b"null", b'{"trustedFolders": null}', b'{"trustedFolders": {}}',
            b'{"trustedFolders": "never-print-this"}', b'{"trustedFolders": [42]}',
            b'{"trustedFolders": ["/ok", null]}', b'{"auth": NaN}',
            b'{"auth": 1, "auth": 2}',
        ):
            with self.subTest(content=content):
                self.config.write_bytes(content)
                message = self.assert_rejected()
                self.assertNotIn("never-print-this", message)
                self.assertNotIn("secret", message)
                self.assertEqual(self.config.read_bytes(), content)

    def test_jsonc_updates_only_existing_top_level_trust_array(self):
        prefix = (
            '// Copilot configuration\n{\n'
            '  "url": "https://example.test/a//b", /* keep URL */\n'
            '  "escaped": "a \\"quoted\\" value and \\\\ path",\n'
            '  "nested": {"trustedFolders": ["/not-top-level",],},\n'
            '  /* project choices */ "trustedFolders" /* key comment */: /* value comment */ '
        )
        suffix = ', // keep trailing comment\n  "auth": {"secret": "kept",},\n}\n// footer\n'
        self.config_home.mkdir()
        self.config.write_text(prefix + '["/existing", "/existing",]' + suffix)
        trust.trust_workspace(str(self.project))
        expected = prefix + json.dumps(["/existing", str(self.project)]) + suffix
        self.assertEqual(self.config.read_text(), expected)
        parsed = trust._parse(self.config.read_bytes())
        self.assertEqual(parsed["url"], "https://example.test/a//b")
        self.assertEqual(parsed["escaped"], 'a "quoted" value and \\ path')
        self.assertEqual(parsed["nested"], {"trustedFolders": ["/not-top-level"]})
        before = self.config.stat()
        trust.trust_workspace(str(self.project))
        self.assertEqual(self.config.read_text(), expected)
        self.assertEqual(self.config.stat().st_ino, before.st_ino)

    def test_jsonc_inserts_missing_trust_preserving_comments_and_original_values(self):
        self.config_home.mkdir()
        value = '  "auth": {"url": "https://example.test",}, "precise": 1.234567890123456789'
        for trailing in ("", ",", ", /* trailing comma */"):
            with self.subTest(trailing=trailing):
                original = "// header\n{\n" + value + trailing + "\n  // final note\n}\n/* footer */"
                self.config.write_text(original)
                trust.trust_workspace(str(self.project))
                expected = (
                    "// header\n{\n" + value + (trailing or ",") + "\n  // final note\n"
                    '\n  "trustedFolders": ' + json.dumps([str(self.project)])
                    + "\n}\n/* footer */"
                )
                self.assertEqual(self.config.read_text(), expected)
                self.assertEqual(trust._parse(self.config.read_bytes())["trustedFolders"], [str(self.project)])

    def test_jsonc_inserts_into_empty_commented_object(self):
        self.config_home.mkdir()
        for original in ("{}", "{ /* keep me */ }", "// header\n{\n// no settings\n}\n"):
            with self.subTest(original=original):
                self.config.write_text(original)
                trust.trust_workspace(str(self.project))
                output = self.config.read_text()
                insertion = '\n  "trustedFolders": ' + json.dumps([str(self.project)]) + "\n"
                self.assertEqual(output, original.replace("}", insertion + "}", 1))
                self.assertEqual(trust._parse(self.config.read_bytes()), {"trustedFolders": [str(self.project)]})

    def test_jsonc_preserves_comments_when_only_securing_permissions(self):
        text = (
            '// header\n{"trustedFolders": [/* already trusted */'
            + json.dumps(str(self.project)) + ',],}\n'
        )
        self.config_home.mkdir()
        self.config.write_text(text)
        self.config.chmod(0o644)
        trust.trust_workspace(str(self.project))
        self.assertEqual(self.config.read_text(), text)
        self.assertEqual(stat.S_IMODE(self.config.stat().st_mode), 0o600)

    def test_jsonc_quoted_comment_markers_and_escaped_key(self):
        self.config_home.mkdir()
        prefix = (
            '{"text": "/* not a comment */ // not a comment", '
            '"escaped": "\\\\\\\"// still a string", '
            '"trusted\\u0046olders": '
        )
        self.config.write_text(prefix + '["/existing", /* remove duplicate */ "/existing",],}')
        trust.trust_workspace(str(self.project))
        self.assertEqual(
            self.config.read_text(),
            prefix + json.dumps(["/existing", str(self.project)]) + ",}",
        )

    def test_malformed_jsonc_is_not_silently_repaired(self):
        self.config_home.mkdir()
        for text in (
            '/* unclosed secret', '{"auth": "secret"} /* unclosed',
            '{"auth": "unterminated // string}', '{"trustedFolders": [,]}',
            '{"trustedFolders": ["/ok",,]}', '{"trustedFolders": ["/ok", /* comment */,]}',
            '{"auth":,}', '{,}', '{"auth": true false,}',
            '{"trustedFolders": [], /* duplicate */ "trustedFolders": [],}',
            '{"auth": 1} // valid comment\n garbage',
            '{"auth": 1,} /* closed */ */',
            '{"auth": 1 /* missing comma */ "trustedFolders": []}',
            '{"auth": /* comment */ NaN,}', '{"auth": /* comment */ Infinity,}',
            '{"trustedFolders": [false,],}',
        ):
            with self.subTest(text=text):
                self.config.write_text(text)
                message = self.assert_rejected()
                self.assertNotIn("secret", message)
                self.assertEqual(self.config.read_text(), text)

    def test_custom_copilot_home(self):
        custom = self.root / "custom" / "copilot"
        with patch.dict(os.environ, {"COPILOT_HOME": str(custom)}):
            trust.trust_workspace(str(self.project))
        self.assertEqual(json.loads((custom / "config.json").read_text()), {
            "trustedFolders": [str(self.project)],
        })
        self.assertFalse(self.config_home.exists())

    def test_creation_prepares_workspace_trust_without_changing_tool_permissions(self):
        adapter = Bridge().providers["copilot"]
        args = ["--model", "gpt-5.4-mini"]
        launch = adapter.prepare_launch("First message", args, str(self.project))
        self.assertEqual(self.read()["trustedFolders"], [str(self.project)])
        self.assertEqual(
            args,
            ["--model", "gpt-5.4-mini", "--session-id", launch.session_id, "--name", "First message"],
        )
        # Copilot needs no managed server, so it contributes no environment.
        self.assertEqual(dict(launch.env), {})
        self.assertIsNone(launch.binding)
        self.assertNotIn("--allow-all-tools", args)
        self.assertNotIn("--allow-all-paths", args)

    def test_restart_trust_failure_leaves_existing_agent_running(self):
        bridge = Bridge()
        bridge._herdr_request = Mock()
        with patch.object(trust, "trust_workspace", side_effect=BridgeError("COPILOT_TRUST_UNAVAILABLE", "Unavailable")):
            with self.assertRaises(BridgeError):
                bridge.providers["copilot"].tuning.restart_agent(
                    {"provider": "copilot", "cwd": str(self.project)},
                    "p1", "session-a", {"model": "gpt-5.4-mini"},
                )
        bridge._herdr_request.assert_not_called()

    def test_restart_after_bridge_reconnect_does_not_enable_tool_bypass(self):
        bridge = Bridge()
        def request(method, params):
            if method == "agent.get":
                raise BridgeError("agent_not_found", "Exited")
            return {}
        bridge._herdr_request = Mock(side_effect=request)
        tuning = bridge.providers["copilot"].tuning
        with patch.object(tuning, "launch_tuned") as launch, patch("remodr_bridge.providers.copilot.tuning.time.sleep"):
            tuning.restart_agent({"provider": "copilot"}, "p1", "session-a", {"model": "gpt-5.4-mini"})
        self.assertFalse(launch.call_args.args[4])

    def test_created_files_are_private_even_with_permissive_umask(self):
        previous = os.umask(0)
        try:
            trust.trust_workspace(str(self.project))
        finally:
            os.umask(previous)
        self.assertEqual(stat.S_IMODE(self.config_home.stat().st_mode), 0o700)
        for path in (self.config, self.config_home / trust._LOCK):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_existing_public_config_becomes_private(self):
        self.seed({"trustedFolders": [str(self.project)], "auth": "kept"})
        self.config.chmod(0o644)
        trust.trust_workspace(str(self.project))
        self.assertEqual(stat.S_IMODE(self.config.stat().st_mode), 0o600)
        self.assertEqual(self.read()["auth"], "kept")

    def test_config_symlink_and_hardlink_are_rejected(self):
        self.config_home.mkdir()
        target = self.root / "sensitive"
        target.write_bytes(b'{"secret": "untouched"}')
        for create in (
            lambda: self.config.symlink_to(target),
            lambda: os.link(target, self.config),
        ):
            create()
            self.assert_rejected()
            self.assertEqual(target.read_bytes(), b'{"secret": "untouched"}')
            self.config.unlink()

    def test_non_regular_config_is_rejected_without_blocking(self):
        self.config_home.mkdir()
        os.mkfifo(self.config)
        self.assert_rejected()
        self.assertTrue(stat.S_ISFIFO(self.config.stat().st_mode))

    def test_symlink_home_and_intermediate_directory_are_rejected(self):
        target = self.root / "elsewhere"
        target.mkdir()
        self.config_home.symlink_to(target, target_is_directory=True)
        self.assert_rejected()
        self.assertEqual(list(target.iterdir()), [])
        with patch.dict(os.environ, {"COPILOT_HOME": str(self.config_home / "nested")}):
            self.assert_rejected()
        self.assertEqual(list(target.iterdir()), [])

    def test_symlink_lock_is_rejected(self):
        self.config_home.mkdir()
        target = self.root / "target"
        target.write_bytes(b"untouched")
        (self.config_home / trust._LOCK).symlink_to(target)
        self.assert_rejected()
        self.assertEqual(target.read_bytes(), b"untouched")
        self.assertFalse(self.config.exists())

    def test_unsafe_home_permissions_are_rejected(self):
        self.config_home.mkdir()
        self.config_home.chmod(0o777)
        self.assert_rejected()
        self.assertFalse(self.config.exists())

    def test_failed_replace_leaves_original_and_cleans_staging_file(self):
        self.seed({"auth": "never-print-this"})
        original = self.config.read_bytes()
        with patch.object(trust.os, "replace", side_effect=PermissionError("never-print-this")):
            self.assertNotIn("never-print-this", self.assert_rejected())
        self.assertEqual(self.config.read_bytes(), original)
        self.assertEqual({path.name for path in self.config_home.iterdir()}, {"config.json", trust._LOCK})

    def test_failed_staging_fsync_leaves_original(self):
        self.seed({"auth": "kept"})
        original = self.config.read_bytes()
        with patch.object(trust.os, "fsync", side_effect=OSError("disk full")):
            self.assert_rejected()
        self.assertEqual(self.config.read_bytes(), original)
        self.assertFalse(list(self.config_home.glob(".remodr-config-*")))

    def test_external_edits_before_replace_are_preserved(self):
        self.seed({"auth": "original"})
        real_read = trust._read_config
        calls = 0
        external = b'{"auth": "updated", "trustedFolders": ["/external"]}'

        def read(directory):
            nonlocal calls
            calls += 1
            if calls == 2:
                self.config.write_bytes(external)
            return real_read(directory)

        with patch.object(trust, "_read_config", side_effect=read):
            self.assertIn("changed", self.assert_rejected())
        self.assertEqual(self.config.read_bytes(), external)
        self.assertFalse(list(self.config_home.glob(".remodr-config-*")))

    def test_externally_created_config_is_not_overwritten(self):
        real_read = trust._read_config
        calls = 0
        external = b'{"auth": "new"}'

        def read(directory):
            nonlocal calls
            calls += 1
            if calls == 2:
                self.config.write_bytes(external)
            return real_read(directory)

        with patch.object(trust, "_read_config", side_effect=read):
            self.assertIn("changed", self.assert_rejected())
        self.assertEqual(self.config.read_bytes(), external)

    def test_config_creation_does_not_clobber_a_last_moment_external_write(self):
        real_link = trust.os.link
        external = b'{"auth": "new"}'

        def link(*args, **kwargs):
            self.config.write_bytes(external)
            return real_link(*args, **kwargs)

        with patch.object(trust.os, "link", side_effect=link):
            self.assert_rejected()
        self.assertEqual(self.config.read_bytes(), external)
        self.assertFalse(list(self.config_home.glob(".remodr-config-*")))

    def test_external_replacement_with_same_contents_is_detected(self):
        self.seed({"auth": "original"})
        original = self.config.read_bytes()
        real_read = trust._read_config
        calls = 0

        def read(directory):
            nonlocal calls
            calls += 1
            if calls == 2:
                replacement = self.config_home / "replacement"
                replacement.write_bytes(original)
                replacement.replace(self.config)
            return real_read(directory)

        with patch.object(trust, "_read_config", side_effect=read):
            self.assertIn("changed", self.assert_rejected())
        self.assertEqual(self.config.read_bytes(), original)

    def test_lock_timeout_is_bounded_and_does_not_change_config(self):
        self.seed({"auth": "kept"})
        original = self.config.read_bytes()
        lock = os.open(self.config_home / trust._LOCK, os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with patch.object(trust, "_LOCK_TIMEOUT", 0):
                self.assertIn("busy", self.assert_rejected())
        finally:
            os.close(lock)
        self.assertEqual(self.config.read_bytes(), original)

    def test_thread_lock_timeout_is_bounded_and_does_not_change_config(self):
        self.seed({"auth": "kept"})
        original = self.config.read_bytes()
        with trust._THREAD_LOCK:
            with patch.object(trust, "_LOCK_TIMEOUT", 0):
                self.assertIn("busy", self.assert_rejected())
        self.assertEqual(self.config.read_bytes(), original)

    def test_sidecar_creation_race_opens_the_winning_file_without_recreating_it(self):
        self.config_home.mkdir()
        real_open = trust.os.open
        flags_seen = []

        def open_file(path, flags, *args, **kwargs):
            if path == trust._LOCK:
                flags_seen.append(flags)
                if flags & os.O_EXCL:
                    fd = real_open(path, flags, *args, **kwargs)
                    os.close(fd)
                    raise FileExistsError("simulated competing process")
            return real_open(path, flags, *args, **kwargs)

        with patch.object(trust.os, "open", side_effect=open_file):
            trust.trust_workspace(str(self.project))
        self.assertEqual(len(flags_seen), 3)
        self.assertFalse(flags_seen[0] & os.O_CREAT)
        self.assertTrue(flags_seen[1] & os.O_EXCL)
        self.assertFalse(flags_seen[2] & os.O_CREAT)
        self.assertEqual(self.read()["trustedFolders"], [str(self.project)])

    def test_concurrent_launches_preserve_all_workspaces_and_other_keys(self):
        self.seed({"auth": {"secret": "kept"}, "trustedFolders": ["/existing"]})
        projects = [self.root / f"project-{index}" for index in range(8)]
        for project in projects:
            project.mkdir()
        barrier = Barrier(len(projects))

        def launch(project):
            barrier.wait()
            trust.trust_workspace(str(project))

        with ThreadPoolExecutor(max_workers=len(projects)) as pool:
            list(pool.map(launch, projects))
        config = self.read()
        self.assertEqual(config["auth"], {"secret": "kept"})
        self.assertEqual(set(config["trustedFolders"]), {"/existing", *map(str, projects)})
        self.assertEqual(len(config["trustedFolders"]), len(projects) + 1)

    def test_concurrent_processes_create_home_and_preserve_all_workspaces(self):
        projects = [self.root / f"process-project-{index}" for index in range(8)]
        for project in projects:
            project.mkdir()
        barrier = Barrier(len(projects))

        def launch(project):
            barrier.wait()
            result = subprocess.run(
                [
                    sys.executable, "-c",
                    "import sys; from remodr_bridge.providers.copilot.trust import trust_workspace; "
                    "trust_workspace(sys.argv[1])", str(project),
                ],
                cwd=Path(__file__).resolve().parent,
                capture_output=True, text=True, timeout=15,
            )
            self.assertEqual(result.returncode, 0, result.stderr)

        with ThreadPoolExecutor(max_workers=len(projects)) as pool:
            list(pool.map(launch, projects))
        self.assertEqual(set(self.read()["trustedFolders"]), set(map(str, projects)))
        self.assertEqual(len(self.read()["trustedFolders"]), len(projects))


if __name__ == "__main__":
    unittest.main()
