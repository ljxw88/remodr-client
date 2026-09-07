import ast
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

from build_bundle import build_bundle


class BundleBuilderTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.source = self.root / "source"
        package = self.source / "remodr_bridge"
        package.mkdir(parents=True)
        (self.source / "archive_main.py").write_text(
            "from remodr_bridge.__main__ import main\nmain()\n"
        )
        (package / "__init__.py").write_text("")
        (package / "__main__.py").write_text(
            'def main():\n    print("bundled runtime")\n'
        )

    def test_build_is_deterministic_and_ignores_source_timestamps(self):
        first = build_bundle(self.root / "first.pyz", self.source)
        for path in self.source.rglob("*.py"):
            os.utime(path, (1700000000, 1700000000))
        second = build_bundle(self.root / "second.pyz", self.source)
        self.assertEqual(first.read_bytes(), second.read_bytes())
        previous_time = first.stat().st_mtime_ns
        build_bundle(first, self.source)
        self.assertEqual(first.stat().st_mtime_ns, previous_time)

    def test_only_runtime_modules_are_packaged(self):
        package = self.source / "remodr_bridge"
        (package / "providers" / "example").mkdir(parents=True)
        (package / "providers" / "example" / "settings.py").write_text('MODEL = "example"\n')
        (package / "tests").mkdir()
        (package / "tests" / "fixture.py").write_text("not runtime\n")
        (package / "__pycache__").mkdir()
        (package / "__pycache__" / "cached.py").write_text("not runtime\n")
        (package / "test_runtime.py").write_text("not runtime\n")
        (package / "private.json").write_text('{"not": "runtime"}')
        (self.source / "test_bridge.py").write_text("not runtime\n")
        output = build_bundle(self.root / "app.pyz", self.source)
        with zipfile.ZipFile(output) as archive:
            self.assertEqual(archive.namelist(), [
                "__main__.py",
                "remodr_bridge/__init__.py",
                "remodr_bridge/__main__.py",
                "remodr_bridge/providers/example/settings.py",
            ])

    def test_provider_edits_change_the_whole_bundle_fingerprint(self):
        path = self.source / "remodr_bridge" / "provider.py"
        path.write_text('MODEL = "first"\n')
        output = build_bundle(self.root / "app.pyz", self.source)
        first = hashlib.sha256(output.read_bytes()).hexdigest()
        path.write_text('MODEL = "second"\n')
        build_bundle(output, self.source)
        self.assertNotEqual(hashlib.sha256(output.read_bytes()).hexdigest(), first)

    def test_archive_runs_without_the_source_tree_or_pythonpath(self):
        output = build_bundle(self.root / "app.pyz", self.source)
        self.source.rename(self.root / "source-not-on-path")
        result = subprocess.run(
            [sys.executable, "-I", str(output)],
            cwd=self.root, capture_output=True, text=True, check=True, timeout=10,
        )
        self.assertEqual(result.stdout.strip(), "bundled runtime")

    def test_rejects_symlinked_runtime_files_without_replacing_existing_output(self):
        output = build_bundle(self.root / "app.pyz", self.source)
        original = output.read_bytes()
        outside = self.root / "outside.py"
        outside.write_text("not runtime\n")
        (self.source / "remodr_bridge" / "linked.py").symlink_to(outside)
        with self.assertRaisesRegex(ValueError, "Unsafe bridge module"):
            build_bundle(output, self.source)
        self.assertEqual(output.read_bytes(), original)

    def test_rejects_symlinked_module_directories(self):
        outside = self.root / "external-package"
        outside.mkdir()
        (outside / "module.py").write_text("not runtime\n")
        (self.source / "remodr_bridge" / "linked").symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "Unsafe bridge module"):
            build_bundle(self.root / "app.pyz", self.source)


class PackagedRuntimeTest(unittest.TestCase):
    def test_union_annotations_remain_compatible_with_python_39_hosts(self):
        package = Path(__file__).parent / "remodr_bridge"
        for path in package.rglob("*.py"):
            with self.subTest(module=path.relative_to(package)):
                tree = ast.parse(path.read_text())
                postponed = any(
                    isinstance(node, ast.ImportFrom) and node.module == "__future__"
                    and any(alias.name == "annotations" for alias in node.names)
                    for node in tree.body
                )
                annotations = []
                for node in ast.walk(tree):
                    if isinstance(node, (ast.AnnAssign, ast.arg)) and node.annotation:
                        annotations.append(node.annotation)
                    elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.returns:
                        annotations.append(node.returns)
                has_union = any(
                    isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr)
                    for annotation in annotations for node in ast.walk(annotation)
                )
                self.assertTrue(postponed or not has_union, "Union annotations must be postponed on Python 3.9")

    def test_archive_preserves_ndjson_protocol_without_a_local_source_tree(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            home = root / "home"
            home.mkdir()
            output = build_bundle(root / "herdr_mobile_bridge.pyz")
            request = {
                "protocol": 1, "type": "request", "id": "packaged-ping",
                "action": "bridge.ping", "payload": {},
            }
            result = subprocess.run(
                [sys.executable, "-I", str(output)],
                input=json.dumps(request) + "\n",
                env={
                    **os.environ, "HOME": str(home),
                    "HERDR_SOCKET": str(root / "not-running.sock"),
                    "HERDR_SESSION": "bundle-test",
                    "REMOTE_WORKSPACE_DEVICE_ID": "bundle-device",
                },
                cwd=root, capture_output=True, text=True, check=True, timeout=20,
            )
            messages = [json.loads(line) for line in result.stdout.splitlines()]
            hello = next(message for message in messages if message["type"] == "hello")
            self.assertEqual(hello["protocol"], 1)
            response = next(message for message in messages if message.get("id") == "packaged-ping")
            self.assertTrue(response["ok"])
            self.assertEqual(response["payload"], {"alive": True})

    def test_real_package_imports_all_providers_in_isolation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            home = root / "home"
            home.mkdir()
            output = build_bundle(root / "herdr_mobile_bridge.pyz")
            result = subprocess.run(
                [sys.executable, "-I", str(output), "--version"],
                env={**os.environ, "HOME": str(home)},
                cwd=root, capture_output=True, text=True, check=True, timeout=10,
            )
            version = json.loads(result.stdout)
            self.assertEqual(version["protocol"], 1)
            self.assertEqual(version["providers"], ["opencode", "copilot", "claude", "codex"])
            self.assertTrue(version["bridgeVersion"])
            self.assertEqual(result.stderr, "")
            self.assertEqual(set(root.iterdir()), {output, home})
            self.assertEqual(list(home.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
