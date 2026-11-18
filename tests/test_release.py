"""Offline tests for the gates that protect publication and retries."""

import hashlib
from io import BytesIO
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from release import (
    REFERENCE, check_versions, inventory, required_lanes, sha256, verify_bundle, write_json,
)
from release_registry import Package, publish, registry_file, upload_npm


class CandidateTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.bundle = Path(self.directory.name)
        self.version = check_versions()[0]
        self.commit = "a" * 40
        (self.bundle / "files").mkdir()
        files = inventory(self.version)
        for name, meta in files.items():
            path = self.bundle / "files" / name
            path.write_bytes(name.encode())
            meta.update(bytes=path.stat().st_size, sha256=sha256(path))
        support = {}
        for name in ("RELEASE-NOTES.md", "provenance.json", "SHA256SUMS"):
            path = self.bundle / name
            path.write_text("".join(f"{meta['sha256']}  {artifact}\n" for artifact, meta in sorted(files.items()))
                            if name == "SHA256SUMS" else name)
            support[name] = sha256(path)
        report = self.bundle / "release-report.json"
        write_json(report, {
            "version": self.version, "commit": self.commit, "complete": True, "errors": [],
            "reference": {**REFERENCE, "length_mm": 7}, "files": files, "support": support,
            "checks": {lane: {"lane": lane, "commit": self.commit, "version": self.version, "result": "success",
                              "files": {name: meta["sha256"] for name, meta in files.items() if meta["lane"] == lane}}
                       for lane in required_lanes(self.version)},
        })
        self.digest = sha256(report)

    def test_tag_mismatch(self):
        with self.assertRaisesRegex(ValueError, "does not match workspace version"):
            check_versions(tag="v999.999.999")

    def test_missing_target_rejected(self):
        verify_bundle(self.bundle, self.commit, self.digest)
        next((self.bundle / "files").glob("*windows-msvc.tar.gz")).unlink()
        with self.assertRaisesRegex(ValueError, "missing expected files"):
            verify_bundle(self.bundle, self.commit, self.digest)

    def test_payload_digest_mismatch(self):
        file = next((self.bundle / "files").iterdir())
        file.write_bytes(b"!" * file.stat().st_size)
        with self.assertRaisesRegex(ValueError, "size or digest"):
            verify_bundle(self.bundle, self.commit, self.digest)

    def test_extra_file_rejected(self):
        (self.bundle / "files" / "stale.tar.gz").touch()
        with self.assertRaisesRegex(ValueError, "extra files"):
            verify_bundle(self.bundle, self.commit, self.digest)


class RegistryTests(unittest.TestCase):
    def test_npm_upload_pins_scope_to_public_registry(self):
        path = Path("vetigen-raykit-node-1.0.0.tgz")
        package = Package(path, "@vetigen/raykit-node", "", "1.0.0")
        with patch("release_registry.subprocess.run") as run:
            upload_npm(package)
        args = run.call_args.args[0]
        self.assertEqual(args[:3], ["npm", "publish", str(path.resolve())])
        self.assertIn("--@vetigen:registry=https://registry.npmjs.org", args)
        self.assertTrue(run.call_args.kwargs["check"])

    def test_resume_only_missing_versions_and_wait_in_order(self):
        packages = [Package(Path(name + ".crate"), name, name, "1.0.0") for name in ("core", "vet", "protocol")]
        remote = {"core": "core"}
        uploads = []
        checks = []

        def lookup(package):
            if package.name not in remote:
                return None
            if remote[package.name] != package.checksum:
                raise ValueError("different digest")
            return remote[package.name]

        def upload(package):
            uploads.append(package.name)
            remote[package.name] = package.checksum

        def wait(package, read):
            self.assertEqual(read(package), package.checksum)
            checks.append(package.name)

        publish(packages, lookup, upload, wait)
        self.assertEqual(uploads, ["vet", "protocol"])
        self.assertEqual(checks, uploads)
        publish(packages, lookup, upload, wait)
        self.assertEqual(uploads, ["vet", "protocol"])
        del remote["core"]
        remote["protocol"] = "other"
        with self.assertRaisesRegex(ValueError, "different digest"):
            publish(packages, lookup, upload, wait)
        self.assertEqual(uploads, ["vet", "protocol"])

    def test_pypi_partial_release_stages_only_missing_file(self):
        data = b"approved wheel"
        checksum = hashlib.sha256(data).hexdigest()
        uploaded = Package(Path("first.whl"), "raykit-dicom", checksum, "1.0.0")
        missing = Package(Path("second.whl"), "raykit-dicom", checksum, "1.0.0")
        meta = {"info": {"name": "raykit-dicom", "version": "1.0.0"}, "urls": [{
            "filename": uploaded.path.name, "digests": {"sha256": checksum}, "yanked": False,
            "url": "https://files.pythonhosted.org/first.whl",
        }]}
        with patch("release_registry.get_json", return_value=meta), patch("release_registry.get", return_value=data):
            self.assertEqual(registry_file("pypi", uploaded, {"first.whl", "second.whl"}), data)
            self.assertIsNone(registry_file("pypi", missing, {"first.whl", "second.whl"}))
            meta["urls"][0]["digests"]["sha256"] = "0" * 64
            with self.assertRaisesRegex(ValueError, "registry digest differs"):
                registry_file("pypi", uploaded, {"first.whl", "second.whl"})

    def test_pub_checks_archive_checksum_and_repacked_contents(self):
        def archive(path, content):
            data = BytesIO()
            with tarfile.open(fileobj=data, mode="w:gz") as stream:
                member = tarfile.TarInfo(path)
                member.size = len(content)
                stream.addfile(member, BytesIO(content))
            return data.getvalue()

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "raykit.tar.gz"
            path.write_bytes(archive("raykit/pubspec.yaml", b"name: raykit"))
            package = Package(path, "raykit", sha256(path), "1.0.0")
            published = archive("pubspec.yaml", b"name: raykit")
            meta = {"version": "1.0.0", "pubspec": {"name": "raykit", "version": "1.0.0"},
                    "archive_sha256": hashlib.sha256(published).hexdigest(),
                    "archive_url": "https://pub.dev/api/archives/raykit-1.0.0.tar.gz"}
            with patch("release_registry.get_json", return_value=meta), patch("release_registry.get", return_value=published):
                self.assertEqual(registry_file("pub", package, {path.name}), published)
                meta["archive_sha256"] = "0" * 64
                with self.assertRaisesRegex(ValueError, "downloaded bytes differ"):
                    registry_file("pub", package, {path.name})
            different = archive("pubspec.yaml", b"name: other")
            meta["archive_sha256"] = hashlib.sha256(different).hexdigest()
            with patch("release_registry.get_json", return_value=meta), patch("release_registry.get", return_value=different):
                with self.assertRaisesRegex(ValueError, "contents differ"):
                    registry_file("pub", package, {path.name})


if __name__ == "__main__":
    unittest.main()
