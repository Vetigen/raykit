"""Install the CLI and use the Rust SDK from an empty Cargo consumer."""

import argparse
from contextlib import contextmanager
import functools
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from threading import Thread

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from release import CRATES, REFERENCE, ROOT, check_versions, sha256
from release_registry import crate_publish_metadata, crates_index_path, get


@contextmanager
def local_registry(package_directory, version):
    index, packages = {}, {}
    for suffix in CRATES:
        name = f"raykit-{suffix}"
        filename = f"{name}-{version}.crate"
        path = package_directory / filename
        metadata = crate_publish_metadata(path, name, version)
        deps = []
        for dep in metadata["deps"]:
            original, alias = dep["name"], dep["explicit_name_in_toml"]
            deps.append({
                "name": alias or original, "package": original if alias else None,
                "req": dep["version_req"], "features": dep["features"], "optional": dep["optional"],
                "default_features": dep["default_features"], "target": dep["target"], "kind": dep["kind"],
                "registry": None,
            })
        index[crates_index_path(name)] = {
            "name": name, "vers": version, "deps": deps, "cksum": sha256(path),
            "features": {}, "features2": metadata["features"], "v": 2,
            "yanked": False, "links": metadata["links"], "rust_version": metadata["rust_version"],
        }
        packages[filename] = path

    @functools.cache
    def dependency(path):
        return get("https://index.crates.io/" + path, missing=True)

    class Registry(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            path = self.path.removeprefix("/")
            if path == "config.json":
                data = json.dumps({"dl": origin + "/crate/{crate}/{version}"}).encode()
            elif path in index:
                data = json.dumps(index[path]).encode() + b"\n"
            elif match := re.fullmatch(r"crate/([a-z0-9_-]+)/([0-9a-z.+-]+)", path):
                name, value = match.groups()
                filename = f"{name}-{value}.crate"
                if filename in packages:
                    data = packages[filename].read_bytes()
                else:
                    self.send_response(302)
                    self.send_header("Location", f"https://static.crates.io/crates/{name}/{filename}")
                    self.end_headers()
                    return
            elif re.fullmatch(r"(?:[a-z0-9_-]+/){1,2}[a-z0-9_-]+", path):
                data = dependency(path)
            else:
                data = None
            if data is None:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Registry)
    origin = f"http://127.0.0.1:{server.server_port}"
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield [
            "--config", 'source.crates-io.replace-with="raykit-rehearsal"',
            "--config", f'source.raykit-rehearsal.registry="sparse+{origin}/"',
        ]
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def verify_cli(work, version, rust, options):
    env = {**os.environ, "CARGO_HOME": str(work / "cargo-home")}
    subprocess.run(["cargo", f"+{rust}", "install", "raykit-cli", "--version", f"={version}", "--locked",
                    "--root", str(work / "installed"), *options], env=env, cwd=work, check=True)
    binary = work / "installed/bin" / ("raykit.exe" if os.name == "nt" else "raykit")
    fixture = ROOT / "fixtures/generated/comparison-ct.dcm"
    reference = REFERENCE
    record = json.loads((ROOT / "benchmarks/evidence/delivery-native.json").read_text())["record"]
    x, y = reference["pixel"]
    assert subprocess.check_output([binary, "--version"], cwd=work, text=True).strip() == f"raykit {version}"
    sample = json.loads(subprocess.check_output([
        binary, "sample", fixture, "--frame", str(reference["frame"]), "--sha256", reference["sha256"],
        "--x", str(x), "--y", str(y),
    ], cwd=work))
    assert sample["sample"]["stored"] == reference["stored"]
    assert sample["sample"]["modality"] == reference["modality"] and sample["modality_unit"] == reference["unit"]
    assert sample["patient"] == reference["patient"]
    measurement = work / "measurement.json"
    measurement.write_text(json.dumps(record))
    verified = json.loads(subprocess.check_output([binary, "measurements", "verify", fixture, measurement], cwd=work))
    assert verified == record and verified["values"] == [{"name": "length", "value": 7, "unit": "millimeter"}]
    record["values"][0]["value"] = 8
    measurement.write_text(json.dumps(record))
    result = subprocess.run([binary, "measurements", "verify", fixture, measurement], capture_output=True, cwd=work)
    assert result.returncode == 3 and json.loads(result.stderr)["code"] == "integrity"
    return {"sample": sample, "measurement": verified["values"], "tamper_rejected": True}


def verify_rust_sdk(work, version, rust, options):
    source = work / "src"
    source.mkdir()
    (work / "Cargo.toml").write_text(
        '[package]\nname = "raykit-consumer"\nversion = "0.0.0"\nedition = "2024"\n'
        f'[dependencies]\nraykit-core = "={version}"\n', encoding="utf-8",
    )
    (source / "main.rs").write_text("""use raykit_core::{Limits, Sample, Session};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let bytes = std::fs::read(args.next().unwrap())?;
    let sha = args.next().unwrap();
    let index = args.next().unwrap().parse()?;
    let x = args.next().unwrap().parse()?;
    let y = args.next().unwrap().parse()?;
    let mut source = Session::open_verified(bytes, Limits::default(), Some(&sha))?;
    let frame = source.read_frame(index)?;
    let Sample::Monochrome { stored, modality, padding: false } = frame.sample(x, y)? else {
        panic!("expected a monochrome sample");
    };
    println!("{stored} {modality}");
    Ok(())
}
""", encoding="utf-8")
    output = subprocess.check_output([
        "cargo", f"+{rust}", "run", "--quiet", "--release", *options, "--",
        ROOT / "fixtures/generated/comparison-ct.dcm", REFERENCE["sha256"], str(REFERENCE["frame"]),
        *map(str, REFERENCE["pixel"]),
    ], env={**os.environ, "CARGO_HOME": str(work / "cargo-home")}, cwd=work, text=True)
    stored, modality = output.split()
    assert int(stored) == REFERENCE["stored"] and float(modality) == REFERENCE["modality"]
    return {"stored": int(stored), "modality": float(modality), "frame": REFERENCE["frame"]}


def verify_consumers(work, version, rust, options):
    evidence = verify_cli(work, version, rust, options)
    evidence["rust_sdk"] = verify_rust_sdk(work, version, rust, options)
    return evidence


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--packages", type=Path)
    source.add_argument("--published", action="store_true")
    args = parser.parse_args()
    version, rust, _ = check_versions()
    with tempfile.TemporaryDirectory(prefix="raykit-cargo-consumer-") as directory:
        if args.published:
            evidence = verify_consumers(Path(directory), version, rust, [])
        else:
            with local_registry(args.packages, version) as options:
                evidence = verify_consumers(Path(directory), version, rust, options)
    print(json.dumps(evidence, indent=2))


if __name__ == "__main__":
    main()
