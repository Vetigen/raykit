"""Check release versions and assemble the tested package set."""

import argparse
from email.parser import BytesParser
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tarfile
import tomllib
import zipfile

ROOT = Path(__file__).resolve().parents[1]
CONFIG = json.loads((ROOT / "scripts/release-targets.json").read_text())
CRATES = ("core", "vet", "protocol", "ffi", "wasm", "cli", "node")
BROWSERS = ("chromium", "firefox", "webkit")
REFERENCE = json.loads((ROOT / "benchmarks/evidence/comparison-reference.json").read_text())


def require(condition, message):
    if not condition:
        raise ValueError(message)


def toml(path):
    return tomllib.loads(path.read_text(encoding="utf-8"))


def json_file(path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def github_outputs(values):
    if file := os.getenv("GITHUB_OUTPUT"):
        with open(file, "a", encoding="utf-8") as stream:
            for key, value in values.items():
                print(f"{key}={value}", file=stream)


def pubspec_value(text, name):
    match = re.search(rf"^{re.escape(name)}: ([^\n]+)$", text, re.MULTILINE)
    return match[1].strip("'\"") if match else None


def check_versions(root=ROOT, tag=None):
    workspace = toml(root / "Cargo.toml")["workspace"]
    version = workspace["package"]["version"]
    require(re.fullmatch(r"(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*)){2}", version), "Expected a stable workspace version")
    if tag:
        require(tag == f"v{version}", f"Tag {tag} does not match workspace version {version}")
    require(workspace["package"].get("publish") is not False, "Workspace cannot be published")
    for dependency in ("raykit-core", "raykit-vet", "raykit-protocol"):
        require(workspace["dependencies"][dependency]["version"] == f"={version}", f"{dependency}: workspace dependency version differs")
    require(set(workspace["members"]) == {f"crates/raykit-{name}" for name in CRATES}, "Crate inventory differs")
    for name in CRATES:
        package = toml(root / f"crates/raykit-{name}/Cargo.toml")["package"]
        require(package["version"] == {"workspace": True} and package.get("publish") is not False,
                f"raykit-{name}: expected a publishable workspace crate")
    rust = toml(root / "rust-toolchain.toml")["toolchain"]["channel"]
    ffi = toml(root / "crates/raykit-ffi/rust-toolchain.toml")["toolchain"]
    require(rust == workspace["package"]["rust-version"] == ffi["channel"], "Rust toolchains and MSRV differ")
    require({target["rust"] for target in CONFIG["targets"]}.issubset(ffi["targets"]), "Dart hook is missing a Rust release target")
    lock = toml(root / "Cargo.lock")
    versions = {item["name"]: item["version"] for item in lock["package"] if "source" not in item}
    require(versions == {f"raykit-{name}": version for name in CRATES}, "Cargo.lock has inconsistent workspace versions")
    binding = toml(root / "crates/raykit-wasm/Cargo.toml")["dependencies"]["wasm-bindgen"].removeprefix("=")
    require([p["version"] for p in lock["package"] if p["name"] == "wasm-bindgen"] == [binding], "wasm-bindgen is not pinned to Cargo.lock")

    npm_lock = json_file(root / "package-lock.json")
    npm_root = json_file(root / "package.json")
    require(npm_root["private"] and npm_root["version"] == npm_lock["version"] == npm_lock["packages"][""]["version"] == version,
            "Root npm workspace and lockfile must use the workspace version and be private")
    require(npm_root["engines"] == npm_lock["packages"][""]["engines"]
            == {"node": ">=" + CONFIG["nodeBuild"].split(".")[0]}, "Build Node version and workspace engines differ")
    example = json_file(root / "examples/web/package.json")
    require(example["private"], "Web example must be private")
    for name in ("web", "web-component", "node"):
        manifest = json_file(root / f"packages/{name}/package.json")
        require(manifest["name"] == f"@raykit/{name}" and manifest["version"] == version and not manifest.get("private")
                and manifest["publishConfig"]["access"] == "public", f"npm release metadata differs for {name}")
        if name != "node":
            require(npm_lock["packages"][f"packages/{name}"]["version"] == example["dependencies"][f"@raykit/{name}"] == version,
                    f"{name}: npm lockfile or example version differs")
        else:
            require(manifest["optionalDependencies"] == {f"@raykit/{t['nodePackage']}": version for t in CONFIG["targets"]},
                    "Node optional addon inventory or versions differ")
            require(manifest["engines"]["node"] == f">={CONFIG['node']}", "Node consumer runtime and engines differ")
        if name == "web-component":
            require(manifest["dependencies"]["@raykit/web"] == version, "Web component requires a different SDK version")

    python = toml(root / "packages/python/pyproject.toml")["project"]
    require(python["name"] == "raykit-dicom" and python["version"] == version, "Python release metadata differs")
    require(python["requires-python"] == ">=" + CONFIG["python"].rsplit(".", 1)[0], "Python consumer runtime and requires-python differ")
    flutter = (root / "packages/flutter/pubspec.yaml").read_text(encoding="utf-8")
    require(pubspec_value(flutter, "name") == "raykit" and pubspec_value(flutter, "version") == version
            and pubspec_value(flutter, "publish_to") is None, "Flutter SDK release metadata differs")
    require(f"flutter: '>={CONFIG['flutterMinimum']}'" in flutter, "Flutter SDK minimum and test runtime differ")
    flutter_example = (root / "examples/flutter/pubspec.yaml").read_text(encoding="utf-8")
    require(pubspec_value(flutter_example, "publish_to") == "none"
            and pubspec_value(flutter_example, "version").split("+")[0] == version, "Flutter example release metadata differs")
    locked_example = (root / "examples/flutter/pubspec.lock").read_text()
    require(re.search(rf'^  raykit:\n(?:    .*\n)*?    version: "{re.escape(version)}"$', locked_example, re.MULTILINE),
            "Flutter example lockfile needs the new package version")
    require(f"# {version}\n" in (root / "packages/flutter/CHANGELOG.md").read_text(), "Flutter change log has no release entry")
    return version, rust, binding


def inventory(version):
    files = {}

    def add(lane, channel, filename, package, target="source"):
        files[filename] = {"lane": lane, "channel": channel, "package": package, "target": target}

    for name in CRATES:
        add("cargo", "crates", f"raykit-{name}-{version}.crate", f"raykit-{name}")
    for target in CONFIG["targets"]:
        triple = target["rust"]
        lane = f"native-{triple}"
        add(lane, "github", f"raykit-{version}-{triple}.tar.gz", "raykit", triple)
        add(lane, "github", f"raykit-c-sdk-{version}-{triple}.tar.gz", "raykit-c-sdk", triple)
        name = target["nodePackage"]
        add(lane, "npm", f"raykit-{name}-{version}.tgz", f"@raykit/{name}", triple)
        add(lane, "pypi", f"raykit_dicom-{version}-py3-none-{target['wheel']}.whl", "raykit-dicom", triple)
        if desktop := target.get("desktop"):
            add(f"desktop-{desktop}", "github", f"raykit-desktop-{version}-{desktop}.tar.gz", "raykit-desktop", desktop)
    for name in ("node", "web", "web-component"):
        add("portable", "npm", f"raykit-{name}-{version}.tgz", f"@raykit/{name}")
    add("portable", "pypi", f"raykit_dicom-{version}.tar.gz", "raykit-dicom")
    add("portable", "pub", f"raykit-flutter-{version}.tar.gz", "raykit")
    return files


def required_lanes(version):
    return {meta["lane"] for meta in inventory(version).values()} | {
        "python-source", "flutter", "android", "ios", *(f"web-{browser}" for browser in BROWSERS),
    }


def validate_archive(path, meta, version, commit):
    channel, name = meta["channel"], meta["package"]
    if path.suffix == ".whl":
        with zipfile.ZipFile(path) as archive:
            wheel = archive.namelist()
            project = BytesParser().parsebytes(archive.read(next(p for p in wheel if p.endswith(".dist-info/METADATA"))))
            require(project["Name"] == name and project["Version"] == version, f"Unexpected wheel metadata in {path.name}")
            require(any(p.startswith("raykit_dicom/native/") for p in wheel), f"Missing wheel library in {path.name}")
            require(not any(p.startswith(("raykit/", "native/")) for p in wheel), "Wheel contains unexpected source or import path")
        return
    with tarfile.open(path, "r:gz") as archive:
        members = {member.name.removeprefix("./"): member for member in archive.getmembers()}
        require(len(members) == len(archive.getmembers()), f"Duplicate archive paths in {path.name}")

        def read(member):
            with archive.extractfile(members[member]) as stream:
                return stream.read()

        if channel == "npm":
            package = json.loads(read("package/package.json"))
            require(package["version"] == version and package["name"] == name, f"Unexpected package.json in {path.name}")
            if name == "@raykit/web":
                for file in ("index.d.ts", "worker.js", "worker.d.ts", "generated/raykit_wasm_bg.wasm",
                             "generated/advanced/raykit_wasm_bg.wasm", "notices/inventory.json", "LICENSE"):
                    require(f"package/dist/{file}" in members, f"Missing {file} in {path.name}")
            elif name == "@raykit/node":
                require("package/LICENSE" in members and not any(p.endswith(".node") for p in members), "Invalid portable Node package")
            elif name.startswith("@raykit/node-"):
                target = next(t for t in CONFIG["targets"] if t["rust"] == meta["target"])
                require(package["os"] == [target["os"]] and package["cpu"] == [target["arch"]]
                        and package.get("libc") == (["glibc"] if target.get("manylinux") else None)
                        and "package/raykit.node" in members and "package/LICENSE" in members, f"Invalid native Node package {path.name}")
        elif channel == "crates":
            base = f"{name}-{version}/"
            package = tomllib.loads(read(base + "Cargo.toml").decode())["package"]
            vcs = json.loads(read(base + ".cargo_vcs_info.json"))["git"]
            require(package["name"] == name and package["version"] == version and vcs["sha1"] == commit and not vcs.get("dirty"),
                    f"Unexpected crate identity in {path.name}")
            require(base + "LICENSE" in members, f"Missing crate license in {path.name}")
        elif channel == "pub":
            pubspec = read("raykit/pubspec.yaml").decode()
            require(pubspec_value(pubspec, "name") == name and pubspec_value(pubspec, "version") == version, "Invalid pub package version")
            for file in ("hook/build.dart", "shaders/monochrome.frag", "lib/raykit.dart", "native/Cargo.lock",
                         "native/crates/raykit-ffi/src/lib.rs", "notices/inventory.json", "LICENSE", "CHANGELOG.md"):
                require(f"raykit/{file}" in members, f"Missing {file} in Flutter archive")
        elif channel == "pypi":
            base = f"raykit_dicom-{version}/"
            project = BytesParser().parsebytes(read(base + "PKG-INFO"))
            require(project["Name"] == name and project["Version"] == version, "Invalid Python source distribution metadata")
            for file in ("native/Cargo.lock", "raykit_dicom/__init__.py", "LICENSE"):
                require(base + file in members, f"Missing {file} in Python source distribution")
            require(not any(p.startswith(base + "raykit_dicom/native/") for p in members), "Source distribution contains a prebuilt library")
        elif channel == "github":
            base = path.name.removesuffix(".tar.gz")
            for file in ("LICENSE", "notices/inventory.json"):
                require(f"{base}/{file}" in members, f"Missing {file} in {path.name}")


def record_shard(directory, lane, commit, evidence):
    version, _, _ = check_versions()
    files = inventory(version)
    require(lane in required_lanes(version), f"Unknown package lane {lane}")
    directory.mkdir(parents=True, exist_ok=True)
    payload = directory / "files"
    payload.mkdir(exist_ok=True)
    wanted = {name for name, meta in files.items() if meta["lane"] == lane}
    require({item.name for item in payload.iterdir()} == wanted, f"{lane}: expected files {sorted(wanted)}")
    for name in wanted:
        validate_archive(payload / name, files[name], version, commit)
    write_json(directory / "check.json", {
        "lane": lane, "commit": commit, "version": version, "run": os.getenv("GITHUB_RUN_ID"),
        "attempt": os.getenv("GITHUB_RUN_ATTEMPT"), "runner": os.getenv("RUNNER_OS"),
        "arch": os.getenv("RUNNER_ARCH"), "image": os.getenv("ImageVersion"),
        "result": "success", "evidence": evidence,
        "files": {name: sha256(payload / name) for name in sorted(wanted)},
    })


def assemble(shards, output, commit, results):
    version, rust, binding = check_versions()
    expected = inventory(version)
    output.mkdir(parents=True, exist_ok=False)
    (output / "files").mkdir()
    checks, files, errors = {}, {}, []
    for lane in sorted(required_lanes(version)):
        shard = shards / f"raykit-shard-{lane}"
        try:
            check = json_file(shard / "check.json")
            require(check["lane"] == lane and check["commit"] == commit and check["version"] == version
                    and check["run"] == os.getenv("GITHUB_RUN_ID") and check["result"] == "success",
                    f"{lane}: invalid test record")
            assigned = {name for name, meta in expected.items() if meta["lane"] == lane}
            require(set(check["files"]) == assigned, f"{lane}: unexpected artifact inventory")
            for name in sorted(assigned):
                source = shard / "files" / name
                require(sha256(source) == check["files"][name], f"{name}: changed since consumer check")
                shutil.copyfile(source, output / "files" / name)
                files[name] = {**expected[name], "bytes": source.stat().st_size, "sha256": check["files"][name]}
            checks[lane] = check
        except (OSError, ValueError, KeyError) as error:
            errors.append(f"{lane}: {error}")
    for job, value in results.items():
        if value["result"] != "success":
            errors.append(f"{job}: {value['result']}")
    notes = (ROOT / "docs/release-notes.md").read_text(encoding="utf-8")
    require(notes.startswith(f"# RayKit {version}\n"), "Release notes do not match the workspace version")
    (output / "RELEASE-NOTES.md").write_text(notes, encoding="utf-8")
    sums = "".join(f"{meta['sha256']}  {name}\n" for name, meta in sorted(files.items()))
    (output / "SHA256SUMS").write_text(sums, encoding="utf-8")
    write_json(output / "provenance.json", {
        "repository": os.getenv("GITHUB_REPOSITORY"), "commit": commit, "version": version,
        "workflow": os.getenv("GITHUB_WORKFLOW_REF"), "run": os.getenv("GITHUB_RUN_ID"),
        "toolchains": {"rust": rust, "wasm_bindgen": binding, **{k: v for k, v in CONFIG.items() if k != "targets"}},
        "targets": CONFIG["targets"], "checks": checks,
    })
    report = {
        "version": version, "commit": commit, "complete": not errors and set(files) == set(expected),
        "reference": {**REFERENCE, "length_mm": 7},
        "files": files, "checks": checks, "errors": errors,
        "support": {name: sha256(output / name) for name in ("RELEASE-NOTES.md", "provenance.json", "SHA256SUMS")},
    }
    write_json(output / "release-report.json", report)
    digest = sha256(output / "release-report.json")
    lines = [f"## RayKit {version} ({commit})", "", f"Report SHA256 {digest}", "",
             "| Target or gate | Result |", "| --- | --- |"]
    lines += [f"| {lane} | {'passed' if lane in checks else 'missing or failed'} |" for lane in sorted(required_lanes(version))]
    lines += ["", "| File | Target | Bytes | SHA256 |", "| --- | --- | ---: | --- |"]
    lines += [f"| {name} | {meta['target']} | {meta['bytes']} | {meta['sha256']} |" for name, meta in sorted(files.items())]
    if errors:
        lines += ["", "Errors", *[f"- {error}" for error in errors]]
    if summary := os.getenv("GITHUB_STEP_SUMMARY"):
        with open(summary, "a", encoding="utf-8") as stream:
            stream.write("\n".join(lines) + "\n")
    print(f"Release report SHA256 {digest}")
    require(report["complete"], "Package matrix is incomplete. See release-report.json.")
    github_outputs({"digest": digest})


def verify_bundle(directory, commit, digest, tag=None):
    version, _, _ = check_versions(tag=tag)
    require(re.fullmatch(r"[a-f0-9]{40}", commit), "Invalid package commit")
    require(re.fullmatch(r"[a-f0-9]{64}", digest) and sha256(directory / "release-report.json") == digest,
            "Release report digest differs from the approved candidate")
    report = json_file(directory / "release-report.json")
    require(report["complete"] is True and not report["errors"] and report["commit"] == commit and report["version"] == version,
            "Release report does not describe a complete matrix for this commit and version")
    require(report["reference"] == {**REFERENCE, "length_mm": 7}, "Release references differ")
    expected = inventory(version)
    require(set(report["files"]) == set(expected) == {p.name for p in (directory / "files").iterdir()},
            "Release inventory is missing expected files or contains extra files")
    require(set(report["checks"]) == required_lanes(version), "Release report does not cover all required tests")
    for lane, check in report["checks"].items():
        require(check["lane"] == lane and check["commit"] == commit and check["version"] == version
                and check["result"] == "success", f"{lane}: missing successful acceptance")
        require(check["files"] == {name: report["files"][name]["sha256"] for name, meta in expected.items() if meta["lane"] == lane},
                f"{lane}: package digest differs from consumer check")
    for name, meta in expected.items():
        actual = report["files"][name]
        path = directory / "files" / name
        require({key: actual[key] for key in meta} == meta and path.is_file() and path.stat().st_size == actual["bytes"]
                and sha256(path) == actual["sha256"], f"{name}: incorrect target, size or digest")
    require(set(report["support"]) == {"RELEASE-NOTES.md", "provenance.json", "SHA256SUMS"}, "Missing release metadata")
    for name, checksum in report["support"].items():
        require(sha256(directory / name) == checksum, f"{name}: incorrect digest")
    sums = "".join(f"{meta['sha256']}  {name}\n" for name, meta in sorted(report["files"].items()))
    require((directory / "SHA256SUMS").read_text() == sums, "Checksum list differs from the approved files")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    check = commands.add_parser("check")
    check.add_argument("--tag")
    shard = commands.add_parser("shard")
    shard.add_argument("directory", type=Path)
    shard.add_argument("lane")
    shard.add_argument("commit")
    shard.add_argument("--evidence", type=Path)
    report = commands.add_parser("report")
    report.add_argument("shards", type=Path)
    report.add_argument("output", type=Path)
    report.add_argument("commit")
    verify = commands.add_parser("verify")
    verify.add_argument("directory", type=Path)
    verify.add_argument("commit")
    verify.add_argument("digest")
    verify.add_argument("--tag")
    args = parser.parse_args()
    if args.command == "check":
        version, rust, binding = check_versions(tag=args.tag)
        github_outputs({
            "version": version, "rust": rust, "bindgen": binding,
            **{key: value for key, value in CONFIG.items() if key != "targets"},
            "native": json.dumps(CONFIG["targets"]),
            "desktop": json.dumps([t for t in CONFIG["targets"] if "desktop" in t]),
        })
        print(f"RayKit {version}, Rust {rust}, wasm-bindgen {binding}")
    elif args.command == "shard":
        record_shard(args.directory, args.lane, args.commit, json_file(args.evidence) if args.evidence else None)
    elif args.command == "report":
        assemble(args.shards, args.output, args.commit, json.loads(os.getenv("RAYKIT_JOB_RESULTS", "{}")))
    else:
        verify_bundle(args.directory, args.commit, args.digest, args.tag)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError) as exc:
        raise SystemExit(str(exc)) from exc
