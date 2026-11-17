"""Resolve the main commit and verify release authorization evidence."""

import argparse
from fnmatch import fnmatchcase
import json
import os
from pathlib import Path
import re
import subprocess

from release import check_versions, github_outputs, require


def git(*args):
    return subprocess.check_output(["git", *args], text=True).strip()


def github(path):
    return json.loads(subprocess.check_output(["gh", "api", f"repos/{os.environ['GITHUB_REPOSITORY']}/{path}"]))


def main_commit(commit):
    require(re.fullmatch(r"[a-f0-9]{40}", commit), "Select the full 40-character main commit SHA")
    require(git("rev-parse", f"{commit}^{{commit}}") == commit, "Expected a Git commit")
    result = subprocess.run(["git", "merge-base", "--is-ancestor", commit, "refs/remotes/origin/main"])
    require(result.returncode == 0, "Selected commit is not in origin/main history")


def approved_tag(commit):
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    ref = os.environ["GITHUB_REF"]
    tag = ref.removeprefix("refs/tags/")
    check_versions(tag=tag)
    require(os.environ["GITHUB_EVENT_NAME"] == "push" and ref.startswith("refs/tags/")
            and event.get("created") and not event.get("deleted") and not event.get("forced"),
            "Release requires a new tag pushed to GitHub")
    require(os.environ.get("GITHUB_REF_PROTECTED") == "true", "A tag protection rule must cover this release tag")
    require(git("cat-file", "-t", ref) == "tag" and git("rev-parse", f"{ref}^{{commit}}") == commit,
            "Release requires an annotated tag pointing to the checked out commit")
    annotation = git("for-each-ref", "--format=%(contents:body)", ref)
    entries = re.findall(r"^RayKit-Candidate: ([1-9][0-9]*) ([0-9a-f]{64})$", annotation, re.MULTILINE)
    require(len(entries) == 1, "Tag must pin one rehearsal run ID and its report SHA256")
    run_id, digest = entries[0]
    ci = github(f"actions/workflows/ci.yml/runs?branch=main&event=push&head_sha={commit}&per_page=10")["workflow_runs"]
    require(ci and ci[0]["head_sha"] == commit and ci[0]["conclusion"] == "success",
            f"Push CI for main commit {commit} has no current successful run")
    jobs = github(f"actions/runs/{ci[0]['id']}/jobs?per_page=100")["jobs"]
    required = [job for job in jobs if job["name"] == "ci-required" and job["head_sha"] == commit]
    require(len(required) == 1 and required[0]["conclusion"] == "success", f"ci-required did not pass for {commit}")
    environment = github("environments/release")
    require(environment.get("can_admins_bypass") is False,
            "Disable administrator bypass on the release environment")
    require(any(rule["type"] == "required_reviewers" and rule.get("reviewers")
                and rule.get("prevent_self_review") is True
                for rule in environment["protection_rules"]), "Configure required reviewers on the release environment")
    require((environment.get("deployment_branch_policy") or {}).get("custom_branch_policies"),
            "Restrict the release environment to release tags")
    policies = github("environments/release/deployment-branch-policies?per_page=100")["branch_policies"]
    require(policies and all(policy["type"] == "tag" for policy in policies)
            and any(fnmatchcase(tag, policy["name"]) for policy in policies), f"Environment policy does not admit release tag {tag}")
    github_outputs({"commit": commit, "run": run_id, "digest": digest})


def rehearsal(run_id, digest):
    require(re.fullmatch(r"[1-9][0-9]*", run_id) and re.fullmatch(r"[0-9a-f]{64}", digest), "Invalid rehearsal pin")
    run = github(f"actions/runs/{run_id}")
    require(run["path"].split("@")[0] == ".github/workflows/release-dry-run.yml"
            and run["head_branch"] == "main" and run["event"] == "workflow_dispatch"
            and run["head_repository"]["full_name"].lower() == os.environ["GITHUB_REPOSITORY"].lower()
            and run["conclusion"] == "success", "Expected a successful main-branch release rehearsal from this repository")
    name = f"raykit-candidate-{digest}"
    artifacts = github(f"actions/runs/{run_id}/artifacts?name={name}")["artifacts"]
    require(len(artifacts) == 1 and not artifacts[0]["expired"], "Approved rehearsal artifact is missing or expired")
    github_outputs({"artifact": name, "artifact_id": artifacts[0]["id"]})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("tag")
    dry = commands.add_parser("dry-run")
    dry.add_argument("commit")
    prior = commands.add_parser("rehearsal")
    prior.add_argument("run")
    prior.add_argument("digest")
    args = parser.parse_args()
    if args.command == "dry-run":
        require(os.environ["GITHUB_REF"] == "refs/heads/main", "Dispatch the dry run from the main branch")
        main_commit(args.commit)
        github_outputs({"commit": args.commit})
    elif args.command == "tag":
        commit = git("rev-parse", "HEAD")
        main_commit(commit)
        approved_tag(commit)
    else:
        rehearsal(args.run, args.digest)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, subprocess.CalledProcessError) as exc:
        raise SystemExit(str(exc)) from exc
