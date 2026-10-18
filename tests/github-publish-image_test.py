"""Run with Python's standard library; no Docker, credentials or network needed."""
import contextlib
import hashlib
import importlib.util
import io
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "publisher", Path(__file__).parent / "../publish-image/publish.py")
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)

IMAGE = "registry.example.com/project/app"
RUNTIME_DIGEST = "sha256:" + "a" * 64
PUBLISHED_DIGEST = "sha256:" + "b" * 64
SHA = "c" * 40


class PublisherTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name) / "source"
        self.root.mkdir()
        (self.root / "Dockerfile").write_text("FROM base AS runtime\n")
        (self.root / "requirements.txt").write_text("dependency==1\n")
        for name in ("gunicorn.conf.py", "release.json"):
            (self.root / name).write_text("file")
        for name in ("app", "web", "migrations"):
            (self.root / name).mkdir()
            (self.root / name / "content.txt").write_text("hello")
        self.files = ["gunicorn.conf.py", "release.json", "app", "web", "migrations"]
        self.runtime_files = ["Dockerfile", "requirements.txt"]
        self.layer = Path(self.directory.name) / "layer.tar"
        self.calls = []

    def command(self, args, **kwargs):
        self.calls.append(list(args))
        stdout = ""
        if args[:2] == ("crane", "mutate") or args[:2] == ["crane", "mutate"]:
            stdout = IMAGE + "@" + PUBLISHED_DIGEST + "\n"
        elif args[:2] == ("crane", "digest") or args[:2] == ["crane", "digest"]:
            stdout = RUNTIME_DIGEST + "\n"
        return subprocess.CompletedProcess(args, 0, stdout, "")

    def publish(self, **kwargs):
        values = dict(source=self.root, image=IMAGE, sha=SHA, repository="Example/app",
                      files=self.files, runtime_files=self.runtime_files,
                      environment=["DEMO_COMMIT=" + SHA, "DEMO_BRANCH=ui/blue-accent"])
        values.update(kwargs)
        with contextlib.redirect_stdout(io.StringIO()):
            return publisher.publish(**values)

    def test_layer_is_deterministic_and_preserves_the_original_file_contract(self):
        (self.root / ".env").write_text("not selected")
        (self.root / "app/__pycache__").mkdir()
        (self.root / "app/__pycache__/module.pyc").write_bytes(b"ignored")
        publisher.pack(self.root, self.layer, self.files)
        first = self.layer.read_bytes()
        os.utime(self.root / "app/content.txt", (1, 1))
        publisher.pack(self.root, self.layer, self.files + ["app/content.txt"])
        self.assertEqual(first, self.layer.read_bytes())
        with tarfile.open(self.layer) as archive:
            self.assertEqual(archive.getnames(), [
                "app/app/content.txt", "app/gunicorn.conf.py", "app/migrations/content.txt",
                "app/release.json", "app/web/content.txt"])
            self.assertTrue(all(m.uid == m.gid == 10001 and m.mode == 0o644 and m.mtime == 0
                                for m in archive.getmembers()))

    def test_symlink_files_directories_and_parent_components_are_rejected(self):
        for target in (self.root / "release.json", self.root / "app"):
            link = self.root / "web/link"
            link.symlink_to(target)
            with self.assertRaises(ValueError):
                publisher.pack(self.root, self.layer, self.files)
            with self.assertRaises(ValueError):
                publisher.pack(self.root, self.layer, ["web/link/content.txt"])
            link.unlink()

    def test_invalid_selections_fail_before_publication(self):
        for name in ("../outside", "/etc/passwd", "app/../release.json", "app/*", ".env", ".git/config"):
            with self.subTest(name=name), patch.object(publisher.subprocess, "run") as command:
                with self.assertRaises((ValueError, FileNotFoundError)):
                    self.publish(files=[name])
                command.assert_not_called()
        (self.root / "app/.env.local").write_text("secret")
        with self.assertRaises(ValueError):
            publisher.pack(self.root, self.layer, ["app"])

    def test_destination_and_ownership_are_validated(self):
        for destination in ("app", "/../etc", "/app/../etc", "/"):
            with self.assertRaises(ValueError):
                publisher.pack(self.root, self.layer, self.files, destination)
        with self.assertRaises(ValueError):
            publisher.pack(self.root, self.layer, self.files, uid=-1)
        publisher.pack(self.root, self.layer, ["app"], "/srv/site", 42, 43)
        with tarfile.open(self.layer) as archive:
            entry = archive.getmembers()[0]
            self.assertEqual((entry.name, entry.uid, entry.gid), ("srv/site/app/content.txt", 42, 43))

    def test_runtime_key_is_compatible_and_ignores_application_changes(self):
        expected = hashlib.sha256(
            b"Dockerfile\0FROM base AS runtime\n\0requirements.txt\0dependency==1\n\0").hexdigest()
        original = publisher.runtime_key(self.root, self.runtime_files)
        self.assertEqual(original, expected)
        (self.root / "release.json").write_text("next version")
        self.assertEqual(original, publisher.runtime_key(self.root, self.runtime_files))
        (self.root / "requirements.txt").write_text("dependency==2\n")
        self.assertNotEqual(original, publisher.runtime_key(self.root, self.runtime_files))
        with self.assertRaises(ValueError):
            publisher.runtime_key(self.root, ["requirements.txt"])

    def test_cache_hit_uses_runtime_digest_and_never_builds(self):
        with patch.object(publisher.subprocess, "run", side_effect=self.command):
            result = self.publish()
        self.assertFalse(result["runtimeCacheMiss"])
        self.assertEqual(result["image"], IMAGE + "@" + PUBLISHED_DIGEST)
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(self.calls[1][:3], ["crane", "mutate", IMAGE + "@" + RUNTIME_DIGEST])
        self.assertIn("org.opencontainers.image.source=https://github.com/Example/app", self.calls[1])
        self.assertIn("DEMO_BRANCH=ui/blue-accent", self.calls[1])

    def test_only_missing_manifest_builds_and_pushes_a_runtime(self):
        def missing(args, **kwargs):
            if not self.calls:
                self.calls.append(list(args))
                return subprocess.CompletedProcess(args, 1, "", "MANIFEST_UNKNOWN")
            return self.command(args, **kwargs)
        with patch.object(publisher.subprocess, "run", side_effect=missing):
            result = self.publish()
        self.assertTrue(result["runtimeCacheMiss"])
        self.assertEqual([call[:2] for call in self.calls], [
            ["crane", "digest"], ["docker", "build"], ["docker", "push"],
            ["crane", "digest"], ["crane", "mutate"]])
        self.assertEqual(self.calls[1][2:6], ["--platform", "linux/amd64", "--target", "runtime"])

    def test_registry_failures_do_not_trigger_a_rebuild(self):
        for error in ("UNAUTHORIZED", "DENIED", "connection timed out"):
            with self.subTest(error=error), patch.object(publisher.subprocess, "run") as command:
                command.return_value = subprocess.CompletedProcess([], 1, "", error)
                with self.assertRaisesRegex(RuntimeError, "registry access"):
                    self.publish()
                self.assertEqual(command.call_count, 1)

    def test_invalid_digests_are_rejected(self):
        with patch.object(publisher.subprocess, "run") as command:
            command.return_value = subprocess.CompletedProcess([], 0, "latest\n", "")
            with self.assertRaisesRegex(RuntimeError, "runtime digest"):
                self.publish()
            self.assertEqual(command.call_count, 1)
        for stdout in ("", IMAGE + ":latest", "another.example/app@" + PUBLISHED_DIGEST):
            with patch.object(publisher.subprocess, "run", side_effect=[
                subprocess.CompletedProcess([], 0, RUNTIME_DIGEST, ""),
                subprocess.CompletedProcess([], 0, stdout, ""),
            ]):
                with self.assertRaisesRegex(RuntimeError, "immutable digest"):
                    self.publish()

    def test_bad_identity_or_environment_fails_before_registry_access(self):
        for values in (dict(sha="main"), dict(image=IMAGE + ":tag"),
                       dict(repository="bad\nrepository"), dict(environment=["A=x\nB=y"])):
            with patch.object(publisher.subprocess, "run") as command:
                with self.assertRaises(ValueError):
                    self.publish(**values)
                command.assert_not_called()

    def test_action_entrypoint_writes_outputs_and_rejects_context_escape(self):
        output = Path(self.directory.name) / "outputs"
        environment = {
            "GITHUB_WORKSPACE": str(self.root), "GITHUB_SHA": SHA, "GITHUB_REPOSITORY": "Example/app",
            "GITHUB_OUTPUT": str(output), "PUBLISH_CONTEXT": ".", "PUBLISH_IMAGE": IMAGE,
            "PUBLISH_FILES": "\n".join(self.files), "PUBLISH_RUNTIME_KEY_FILES": "\n".join(self.runtime_files),
            "PUBLISH_DESTINATION": "/app", "PUBLISH_UID": "10001", "PUBLISH_GID": "10001",
        }
        with patch.dict(os.environ, environment), patch.object(publisher.subprocess, "run", side_effect=self.command):
            with contextlib.redirect_stdout(io.StringIO()):
                publisher.main()
            self.assertIn("image=" + IMAGE + "@" + PUBLISHED_DIGEST, output.read_text())
            self.assertIn("runtime-cache-miss=false\n", output.read_text())
            with patch.dict(os.environ, {"PUBLISH_CONTEXT": ".."}):
                with self.assertRaises(ValueError):
                    publisher.main()


if __name__ == "__main__":
    unittest.main()
