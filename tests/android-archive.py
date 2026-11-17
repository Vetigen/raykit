"""Inspect the release-mode ARM64 APK built from the packaged Flutter SDK."""

import hashlib
import json
from pathlib import Path
import sys
import zipfile

apk = Path(sys.argv[1])
root = Path(__file__).resolve().parents[1]
ref = json.loads((root / "benchmarks/evidence/comparison-reference.json").read_text())
with zipfile.ZipFile(apk) as archive:
    library = archive.read("lib/arm64-v8a/libraykit_ffi.so")
    assert library[:6] == b"\x7fELF\x02\x01" and int.from_bytes(library[18:20], "little") == 183
    for entry in (b"raykit_v1_abi_version", b"raykit_v1_open_descriptor", b"raykit_v1_request"):
        assert entry + b"\0" in library
    source = archive.read("assets/flutter_assets/assets/raykit/comparison-ct.dcm")
    assert hashlib.sha256(source).hexdigest() == ref["sha256"]
    assert archive.getinfo("assets/flutter_assets/packages/raykit/shaders/monochrome.frag").file_size > 0
with apk.open("rb") as stream:
    print(json.dumps({"build": "passed", "runtime": "not run", "physical_device": "not run",
                      "target": "android-arm64", "sha256": hashlib.file_digest(stream, "sha256").hexdigest(),
                      "bytes": apk.stat().st_size, "fixture": ref["sha256"]}))
