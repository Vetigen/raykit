"""Publish or verify the exact release candidate with registry-specific checks."""

import argparse
import base64
from dataclasses import dataclass
import hashlib
from io import BytesIO
import json
import os
from pathlib import Path, PurePosixPath
import struct
import subprocess
import tarfile
import tempfile
import time
import tomllib
from urllib.error import HTTPError
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen

from release import CRATES, github_outputs, inventory, require, verify_bundle

REGISTRIES = ("crates", "npm", "pypi", "pub")
USER_AGENT = "RayKit release (https://github.com/Vetigen/raykit)"


@dataclass(frozen=True)
class Package:
    path: Path
    name: str
    checksum: str
    version: str


def packages_for(directory, report, channel):
    # inventory() orders Cargo dependencies, then npm addons before the loader and SDK before the component.
    return [
        Package(directory / "files" / name, meta["package"], report["files"][name]["sha256"], report["version"])
        for name, meta in inventory(report["version"]).items() if meta["channel"] == channel
    ]


def get(url, missing=False):
    request = Request(url, headers={"User-Agent": USER_AGENT, "Cache-Control": "no-cache"})
    try:
        with urlopen(request, timeout=45) as response:
            return response.read()
    except HTTPError as error:
        if missing and error.code == 404:
            return None
        raise


def get_json(url, missing=False):
    data = get(url, missing=missing)
    return json.loads(data) if data is not None else None


def archive_contents(data, prefix=""):
    files = {}
    with tarfile.open(fileobj=BytesIO(data), mode="r:gz") as archive:
        for member in archive:
            if member.isdir():
                continue
            name = member.name.removeprefix("./")
            require(member.isfile() and name.startswith(prefix), f"Unexpected pub archive member {name}")
            name = name.removeprefix(prefix)
            path = PurePosixPath(name)
            require(name not in files and not path.is_absolute() and ".." not in path.parts, f"Invalid pub archive path {name}")
            with archive.extractfile(member) as stream:
                files[name] = hashlib.file_digest(stream, "sha256").hexdigest()
    return files


def crates_index_path(name):
    return f"{name[:2]}/{name[2:4]}/{name}"


def crate_index(package):
    data = get(f"https://index.crates.io/{crates_index_path(package.name)}", missing=True)
    if data is not None:
        return next((row for row in map(json.loads, data.splitlines()) if row["vers"] == package.version), None)
    return None


def registry_file(channel, package, expected):
    """Return verified registry bytes, or None only when this exact file is absent."""
    name, version = package.name, package.version
    integrity = None
    if channel == "crates":
        index = crate_index(package)
        if index is None:
            return None
        require(not index["yanked"], f"{name} {version} has been yanked")
        checksum = index["cksum"]
        url = f"https://static.crates.io/crates/{name}/{package.path.name}"
        hosts = {"static.crates.io"}
    elif channel == "npm":
        meta = get_json(f"https://registry.npmjs.org/{quote(name, safe='@')}/{version}", missing=True)
        if meta is None:
            return None
        require(meta["name"] == name and meta["version"] == version, f"Unexpected npm metadata for {name}")
        url = meta["dist"]["tarball"]
        integrity = meta["dist"]["integrity"]
        checksum = package.checksum
        hosts = {"registry.npmjs.org"}
    elif channel == "pypi":
        meta = get_json(f"https://pypi.org/pypi/{name}/{version}/json", missing=True)
        if meta is None:
            return None
        require(meta["info"]["name"] == name and meta["info"]["version"] == version, f"Unexpected PyPI metadata for {name}")
        require({file["filename"] for file in meta["urls"]}.issubset(expected), f"Unexpected files in {name} {version} on PyPI")
        file = next((f for f in meta["urls"] if f["filename"] == package.path.name), None)
        if file is None:
            return None
        require(not file["yanked"], f"{file['filename']} has been yanked")
        url, checksum = file["url"], file["digests"]["sha256"]
        hosts = {"files.pythonhosted.org"}
    else:
        meta = get_json(f"https://pub.dev/api/packages/{name}/versions/{version}", missing=True)
        if meta is None:
            return None
        require(meta["version"] == version and meta["pubspec"]["name"] == name
                and meta["pubspec"]["version"] == version and not meta.get("retracted"), "Unexpected pub.dev version metadata")
        url, checksum = meta["archive_url"], meta["archive_sha256"]
        hosts = {"pub.dev", "storage.googleapis.com"}

    location = urlparse(url)
    require(location.scheme == "https" and location.hostname in hosts, f"Unexpected download URL for {name}")
    if channel != "pub":
        require(checksum == package.checksum, f"{package.path.name}: registry digest differs from candidate")
    data = get(url)
    require(hashlib.sha256(data).hexdigest() == checksum, f"{package.path.name}: downloaded bytes differ from registry digest")
    if integrity:
        sha512 = "sha512-" + base64.b64encode(hashlib.sha512(data).digest()).decode()
        require(integrity == sha512, f"{package.path.name}: npm integrity differs")
    if channel == "pub":
        wanted = archive_contents(package.path.read_bytes(), prefix="raykit/")
        require(archive_contents(data) == wanted, f"{name} {version}: pub.dev archive contents differ from candidate")
    return data


def crate_publish_metadata(path, name, version):
    with tarfile.open(path, "r:gz") as archive:
        base = f"{name}-{version}/"
        manifest = tomllib.loads(archive.extractfile(base + "Cargo.toml").read().decode())
        package = manifest["package"]
        metadata = {field.replace("-", "_"): package.get(field) for field in (
            "description", "documentation", "homepage", "repository", "license", "license-file", "links", "rust-version",
        )}
        metadata.update(name=name, vers=version, features=manifest.get("features", {}),
                        authors=package.get("authors", []), keywords=package.get("keywords", []),
                        categories=package.get("categories", []), badges=manifest.get("badges", {}),
                        readme_file=package["readme"], readme=archive.extractfile(base + package["readme"]).read().decode())
        dependencies = []
        for target, tables in [(None, manifest), *manifest.get("target", {}).items()]:
            for kind, table in (("normal", "dependencies"), ("dev", "dev-dependencies"), ("build", "build-dependencies")):
                for alias, dependency in tables.get(table, {}).items():
                    if isinstance(dependency, str):
                        dependency = {"version": dependency}
                    require(not {"path", "git", "registry", "registry-index"}.intersection(dependency),
                            f"{alias}: packaged manifest must use crates.io dependencies")
                    dependencies.append({
                        "name": dependency.get("package", alias), "version_req": dependency["version"],
                        "features": dependency.get("features", []), "optional": dependency.get("optional", False),
                        "default_features": dependency.get("default-features", True), "target": target, "kind": kind,
                        "registry": None, "explicit_name_in_toml": alias if "package" in dependency else None,
                    })
        metadata["deps"] = dependencies
        return metadata


def upload_crate(package):
    metadata = json.dumps(crate_publish_metadata(package.path, package.name, package.version)).encode()
    crate = package.path.read_bytes()
    body = struct.pack("<I", len(metadata)) + metadata + struct.pack("<I", len(crate)) + crate
    request = Request("https://crates.io/api/v1/crates/new", data=body, method="PUT",
                      headers={"Authorization": os.environ["CARGO_REGISTRY_TOKEN"], "User-Agent": USER_AGENT,
                               "Content-Type": "application/octet-stream", "Accept": "application/json"})
    try:
        with urlopen(request, timeout=90) as response:
            result = json.load(response)
    except HTTPError as error:
        # The response is public API diagnostic text. Never print the request or its headers.
        raise ValueError(f"{package.name}: crates.io returned {error.code}: {error.read(2048).decode(errors='replace')}") from None
    require(not result.get("errors"), f"{package.name}: crates.io rejected the package: {result.get('errors')}")
    print(result.get("warnings", {}))


def upload_pub(package):
    with tempfile.TemporaryDirectory(prefix="raykit-pub-") as directory:
        with tarfile.open(package.path, "r:gz") as archive:
            archive.extractall(directory, filter="data")
        subprocess.run(["flutter", "pub", "publish", "--force"], cwd=Path(directory) / "raykit", check=True)


def upload_npm(package):
    subprocess.run(["npm", "publish", str(package.path.resolve()), "--access", "public", "--ignore-scripts",
                    "--registry", "https://registry.npmjs.org"], check=True)


def wait_for_file(package, lookup, attempts=36, delay=5):
    for attempt in range(attempts):
        try:
            data = lookup(package)
        except HTTPError as error:
            if error.code not in (404, 429, 500, 502, 503, 504) or attempt + 1 == attempts:
                raise
            data = None
        if data is not None:
            return data
        if attempt + 1 < attempts:
            time.sleep(delay)
    raise ValueError(f"{package.path.name}: registry has not indexed the uploaded file")


def publish(packages, lookup, upload, wait=wait_for_file):
    # Scan existing contents first, then re-check each version at its point in dependency order.
    for package in packages:
        lookup(package)
    for package in packages:
        if lookup(package) is not None:
            print(f"Verified existing {package.path.name}")
            continue
        upload(package)
        wait(package, lookup)
        print(f"Verified uploaded {package.path.name}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("plan", "publish", "verify"))
    parser.add_argument("channel", choices=(*REGISTRIES, "all"))
    parser.add_argument("bundle", type=Path)
    parser.add_argument("commit")
    parser.add_argument("digest")
    parser.add_argument("--stage", type=Path)
    args = parser.parse_args()
    report = verify_bundle(args.bundle, args.commit, args.digest)
    channels = REGISTRIES if args.channel == "all" else (args.channel,)
    uploaders = {"crates": upload_crate, "npm": upload_npm, "pub": upload_pub}
    pending = []
    for channel in channels:
        packages = packages_for(args.bundle, report, channel)
        names = {p.path.name for p in packages}

        def lookup(package):
            return registry_file(channel, package, names)

        if args.mode == "publish":
            require(args.channel in uploaders, "Select one registry. PyPI uploads use the PyPI trusted publishing action.")
            publish(packages, lookup, uploaders[channel])
            continue
        for package in packages:
            data = wait_for_file(package, lookup) if args.mode == "verify" else lookup(package)
            if data is None:
                pending.append(package.path.name)
                if args.stage:
                    args.stage.mkdir(parents=True, exist_ok=True)
                    with (args.stage / package.path.name).open("xb") as stream:
                        stream.write(package.path.read_bytes())
            else:
                print(f"Verified {channel} {package.path.name}")
    if args.mode == "plan":
        print(json.dumps({"pending": pending}, indent=2))
        github_outputs({"pending": str(bool(pending)).lower()})


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError) as exc:
        raise SystemExit(str(exc)) from exc
