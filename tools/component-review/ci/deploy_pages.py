#!/usr/bin/env python3
"""Publish (or remove) one PR's preview under pr/<N>/ on the gh-pages branch.

Other PRs' directories are left alone. Pushes are retried: on a rejected push (another PR's
publish won the race) we re-fetch gh-pages, re-apply our pr/<N>/ change and push again, so
parallel publishes for different PRs never clobber each other.

The token (GITHUB_TOKEN) is passed to git through GIT_CONFIG_* environment variables, so it
is never written to disk or to a remote URL.

Usage:
  deploy_pages.py --repo owner/repo --pr N --site DIR [--push] [--remote URL] [--branch gh-pages]
  deploy_pages.py --repo owner/repo --pr N --delete [--push] ...
Without --push the commit is made in a temp clone and the resulting tree is summarized.
Writes step output `sha` (the gh-pages commit that contains the preview).
"""
from __future__ import annotations

import argparse
import base64
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import check_repo, log, parse_pr_number, write_outputs  # noqa: E402

ROOT_INDEX = """<!doctype html>
<meta charset="utf-8">
<title>Component review previews</title>
<style>body{font:16px system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem}</style>
<h1>Component review previews</h1>
<p>Each open pull request that changes footprints or symbols gets a preview at
<code>pr/&lt;number&gt;/</code>. Open it from the link in the PR's component-review comment.</p>
"""


def git_env() -> dict:
    env = dict(os.environ)
    env.update({"GIT_TERMINAL_PROMPT": "0", "GIT_AUTHOR_NAME": "github-actions[bot]",
                "GIT_AUTHOR_EMAIL": "41898282+github-actions[bot]@users.noreply.github.com"})
    env["GIT_COMMITTER_NAME"], env["GIT_COMMITTER_EMAIL"] = env["GIT_AUTHOR_NAME"], env["GIT_AUTHOR_EMAIL"]
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        server = os.environ.get("GITHUB_SERVER_URL", "https://github.com").rstrip("/")
        basic = base64.b64encode(f"x-access-token:{token}".encode()).decode()
        n = int(env.get("GIT_CONFIG_COUNT", "0") or 0)
        env[f"GIT_CONFIG_KEY_{n}"] = f"http.{server}/.extraheader"
        env[f"GIT_CONFIG_VALUE_{n}"] = f"AUTHORIZATION: basic {basic}"
        env["GIT_CONFIG_COUNT"] = str(n + 1)
    return env


def git(cwd: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    r = subprocess.run(["git", *args], cwd=cwd, env=git_env(), capture_output=True, text=True)
    if check and r.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {r.stderr.strip()[:1000]}")
    return r


def checkout_branch(work: Path, remote: str, branch: str) -> bool:
    """Fresh checkout of the remote branch tip in `work`. Returns False if it doesn't exist yet."""
    if (work / ".git").exists():
        shutil.rmtree(work)
    work.mkdir(parents=True, exist_ok=True)
    git(work, "init", "-q")
    git(work, "remote", "add", "origin", remote)
    r = git(work, "fetch", "-q", "--depth", "1", "origin", f"+refs/heads/{branch}:refs/remotes/origin/{branch}",
            check=False)
    if r.returncode == 0:
        git(work, "checkout", "-q", "-B", branch, f"origin/{branch}")
        return True
    if "couldn't find remote ref" not in r.stderr and "not found" not in r.stderr.lower():
        raise RuntimeError(f"git fetch failed: {r.stderr.strip()[:1000]}")
    git(work, "checkout", "-q", "--orphan", branch)
    return False


def apply_change(work: Path, pr: int, site: Path | None) -> None:
    (work / ".nojekyll").touch()
    if not (work / "index.html").exists():
        (work / "index.html").write_text(ROOT_INDEX, encoding="utf-8")
    target = work / "pr" / str(pr)
    if target.exists():
        shutil.rmtree(target)
    if site is not None:
        shutil.copytree(site, target, symlinks=False)
    git(work, "add", "-A", ".")


def deploy(repo: str, pr: int, site: Path | None, *, remote: str, branch: str, push: bool,
           workdir: Path, attempts: int = 6) -> str | None:
    action = f"component-review: {'update' if site else 'remove'} preview for PR #{pr}"
    for attempt in range(1, attempts + 1):
        exists = checkout_branch(workdir, remote, branch)
        if not exists and site is None:
            log(f"deploy: no {branch} branch, nothing to remove")
            return None
        apply_change(workdir, pr, site)
        if git(workdir, "status", "--porcelain").stdout.strip() == "" and \
                git(workdir, "rev-parse", "--verify", "-q", "HEAD", check=False).returncode == 0:
            log("deploy: nothing changed")
            return git(workdir, "rev-parse", "HEAD").stdout.strip()
        git(workdir, "commit", "-q", "-m", action)
        sha = git(workdir, "rev-parse", "HEAD").stdout.strip()
        if not push:
            files = git(workdir, "ls-files", f"pr/{pr}").stdout.split()
            log(f"deploy (no --push): commit {sha} has {len(files)} file(s) under pr/{pr}/")
            return sha
        r = git(workdir, "push", "-q", "origin", f"HEAD:refs/heads/{branch}", check=False)
        if r.returncode == 0:
            log(f"deploy: pushed {sha} to {branch}")
            return sha
        log(f"deploy: push attempt {attempt} rejected ({r.stderr.strip()[:300]}); retrying")
        time.sleep(min(2 ** attempt, 30))
    raise RuntimeError("deploy: could not push to gh-pages")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo", required=True)
    ap.add_argument("--pr", required=True)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--site", type=Path)
    g.add_argument("--delete", action="store_true")
    ap.add_argument("--branch", default="gh-pages")
    ap.add_argument("--remote", help="git remote URL (default: $GITHUB_SERVER_URL/<repo>.git)")
    ap.add_argument("--push", action="store_true")
    ap.add_argument("--workdir", type=Path)
    a = ap.parse_args(argv)
    repo = check_repo(a.repo)
    pr = parse_pr_number(a.pr)
    remote = a.remote or f"{os.environ.get('GITHUB_SERVER_URL', 'https://github.com').rstrip('/')}/{repo}.git"
    if a.site and not (a.site / "manifest.json").is_file():
        raise SystemExit(f"deploy: {a.site} has no manifest.json")
    workdir = a.workdir or Path(tempfile.mkdtemp(prefix="cr-pages-"))
    sha = deploy(repo, pr, None if a.delete else a.site, remote=remote, branch=a.branch,
                 push=a.push, workdir=workdir)
    write_outputs(sha=sha or "")
    return 0


if __name__ == "__main__":
    sys.exit(main())
