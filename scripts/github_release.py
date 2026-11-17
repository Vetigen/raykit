"""Attach immutable assets to a draft and expose it after all checks."""

import argparse
import json
import os
from pathlib import Path
import subprocess

from release import require, sha256, verify_bundle


def gh(*args):
    return subprocess.check_output(["gh", *args])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path)
    parser.add_argument("commit")
    parser.add_argument("digest")
    parser.add_argument("tag")
    args = parser.parse_args()
    report = verify_bundle(args.bundle, args.commit, args.digest, args.tag)
    repository = os.environ["GITHUB_REPOSITORY"]
    files = {args.bundle / "files" / name: meta["sha256"]
             for name, meta in report["files"].items() if meta["channel"] == "github"}
    files.update({args.bundle / name: checksum for name, checksum in report["support"].items()})
    files[args.bundle / "release-report.json"] = args.digest

    def find_release():
        pages = json.loads(gh("api", "--paginate", "--slurp", f"repos/{repository}/releases?per_page=100"))
        matches = [release for page in pages for release in page if release["tag_name"] == args.tag]
        require(len(matches) <= 1, f"Multiple releases for {args.tag}")
        return matches[0] if matches else None

    release = find_release()
    if release is None:
        print(gh("release", "create", args.tag, "--repo", repository, "--verify-tag", "--draft",
                 "--title", f"RayKit {report['version']}", "--notes-file", str(args.bundle / "RELEASE-NOTES.md")).decode())
        release = find_release()
        require(release is not None and release["draft"], "Could not locate the created draft")
    assets = {asset["name"]: asset for asset in release["assets"]}
    require(set(assets).issubset({path.name for path in files}), f"{args.tag}: unexpected GitHub Release assets")
    for path, checksum in files.items():
        if asset := assets.get(path.name):
            require(asset["state"] == "uploaded" and asset["size"] == path.stat().st_size
                    and asset.get("digest") == f"sha256:{checksum}", f"{path.name}: existing release asset differs")
        else:
            require(release["draft"], f"{path.name}: already visible release is incomplete")
    if release["draft"]:
        for path in files:
            if path.name not in assets:
                gh("release", "upload", args.tag, str(path), "--repo", repository)
        confirmed = find_release()
        require(confirmed is not None and confirmed["id"] == release["id"] and confirmed["draft"],
                "Draft release changed during asset upload")
        require({asset["name"]: asset.get("digest") for asset in confirmed["assets"] if asset["state"] == "uploaded"}
                == {path.name: f"sha256:{checksum}" for path, checksum in files.items()}, "GitHub did not confirm all asset digests")
        gh("release", "edit", args.tag, "--draft=false", "--repo", repository)
        release = find_release()
    require(release is not None and not release["draft"], "GitHub Release is not visible")
    print(release["html_url"])


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, subprocess.CalledProcessError) as exc:
        raise SystemExit(str(exc)) from exc
