#!/usr/bin/env python3
"""Validate the untrusted `pr-meta` artifact and confirm it against the GitHub API.

The unprivileged run writes pr.json = {"pr": N, "head_sha": ..., ...}. For fork PRs
`github.event.workflow_run.pull_requests` is empty, so the PR number has to come from the
artifact -- which the PR author controls. We therefore only accept it if the API says that
PR N in THIS repo is open and its head sha equals the workflow_run's head_sha (which GitHub
sets, not the PR).

Writes step outputs: skip=true|false, reason, pr, head_sha, base_sha, merge_base.

Usage: resolve_pr.py --meta pr.json --repo owner/repo --run-head-sha SHA [--allow-closed]
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import GitHub, check_repo, check_sha, load_json, log, parse_pr_number, write_outputs  # noqa: E402


def resolve(meta: dict, repo: str, run_head_sha: str, gh: GitHub, allow_closed: bool = False) -> dict:
    pr = parse_pr_number(meta.get("pr"))
    head = check_sha(meta.get("head_sha"))
    if head != run_head_sha:
        return {"skip": True, "reason": "pr-meta head_sha does not match workflow_run head_sha", "pr": pr}
    info = gh.get(f"/repos/{repo}/pulls/{pr}")
    if (info.get("base") or {}).get("repo", {}).get("full_name", "").lower() != repo.lower():
        return {"skip": True, "reason": "PR does not belong to this repository", "pr": pr}
    if info.get("head", {}).get("sha") != run_head_sha:
        return {"skip": True, "reason": "PR head moved on since this run (a newer run will publish)", "pr": pr}
    if info.get("state") != "open" and not allow_closed:
        return {"skip": True, "reason": f"PR is {info.get('state')}", "pr": pr}
    out = {"skip": False, "reason": "", "pr": pr, "head_sha": head,
           "base_sha": info.get("base", {}).get("sha", "")}
    mb = meta.get("merge_base")
    try:
        out["merge_base"] = check_sha(mb) if mb else ""
    except ValueError:
        out["merge_base"] = ""
    check_sha(out["base_sha"])
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--meta", required=True, type=Path)
    ap.add_argument("--repo", required=True)
    ap.add_argument("--run-head-sha", required=True)
    ap.add_argument("--allow-closed", action="store_true")
    a = ap.parse_args(argv)
    repo = check_repo(a.repo)
    run_head = check_sha(a.run_head_sha)
    meta = load_json(a.meta, max_bytes=10_000)
    if not isinstance(meta, dict):
        raise SystemExit("resolve_pr: pr-meta missing or not a JSON object")
    res = resolve(meta, repo, run_head, GitHub.from_env(read_only=True), a.allow_closed)
    if res["skip"]:
        log(f"resolve_pr: skipping publish: {res['reason']}")
    else:
        log(f"resolve_pr: PR #{res['pr']} head {res['head_sha']}")
    write_outputs(skip=str(res["skip"]).lower(), reason=res["reason"], pr=res.get("pr", ""),
                  head_sha=res.get("head_sha", ""), base_sha=res.get("base_sha", ""),
                  merge_base=res.get("merge_base", ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
