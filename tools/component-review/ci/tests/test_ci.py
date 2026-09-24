"""Tests for the component-review CI scripts: python3 -m unittest discover -s tools/component-review/ci/tests"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import common  # noqa: E402
import deploy_pages  # noqa: E402
import make_mock  # noqa: E402
import post_review  # noqa: E402
import resolve_pr  # noqa: E402
import sanitize_site  # noqa: E402
from make_comment import Ctx, build_comment, finding_key  # noqa: E402

HEAD = "1627ad2136c15edddf09c6034d03ee3de04acf9b"
PAGES = "0123456789abcdef0123456789abcdef01234567"
REPO = "PantsForBirds/kicad-libs"


class Tmp(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.tmp = Path(self._td.name)
        make_mock.main(self.tmp / "mock")
        self.site = self.tmp / "mock" / "site"
        self.files = json.loads((self.tmp / "mock" / "pr_files.json").read_text())

    def tearDown(self):
        self._td.cleanup()


class TestValidation(unittest.TestCase):
    def test_pr_number(self):
        self.assertEqual(common.parse_pr_number(8), 8)
        self.assertEqual(common.parse_pr_number("12"), 12)
        for bad in ("12; rm -rf /", "-1", 0, True, "1e3", None, 1.5, "../1"):
            with self.assertRaises(ValueError, msg=bad):
                common.parse_pr_number(bad)

    def test_sha_repo(self):
        common.check_sha(HEAD)
        common.check_repo(REPO)
        for bad in ("abc", HEAD.upper(), HEAD + "\n"):
            with self.assertRaises(ValueError):
                common.check_sha(bad)
        with self.assertRaises(ValueError):
            common.check_repo("a/../b")

    def test_markdown_escaping(self):
        s = common.md_inline("<img src=x onerror=alert(1)> @team | ![p](http://e/x.png)\n<!-- component-review -->")
        self.assertNotIn("<", s)
        self.assertNotIn("@team", s)
        self.assertNotIn("![", s)
        self.assertNotIn("\n", s)
        self.assertIn("\\|", s)
        self.assertNotIn(common.MARKER, common.md_block(common.MARKER))

    def test_urls(self):
        self.assertIsNone(common.safe_http_url("javascript:alert(1)"))
        self.assertNotIn(")", common.safe_http_url("https://x.com/a)b"))

    def test_repo_path(self):
        self.assertTrue(common.safe_repo_path("lib_fp/A.pretty/B (1).kicad_mod"))
        for bad in ("../x", "/etc/passwd", "a/../../b", "a\nb"):
            self.assertIsNone(common.safe_repo_path(bad), bad)


class TestSanitize(Tmp):
    def test_drops_active_content(self):
        src = self.site
        slug_dir = next((src / "items").iterdir())
        (src / "index.html").write_text("<script>evil()</script>")
        (slug_dir / "x.js").write_text("evil()")
        (slug_dir / "evil.svg").write_text('<svg><script>alert(1)</script></svg>')
        (slug_dir / "evil2.svg").write_text('<svg><image href="https://evil/x"/></svg>')
        (slug_dir / "evil3.svg").write_text('<svg onload="x()"/>')
        (slug_dir / "link.png").symlink_to("/etc/passwd")
        (src / "other").mkdir()
        (src / "other" / "a.png").write_bytes(b"x")
        dst = self.tmp / "clean"
        stats = sanitize_site.sanitize(src, dst)
        kept = {str(p.relative_to(dst)) for p in dst.rglob("*") if p.is_file()}
        self.assertIn("manifest.json", kept)
        self.assertNotIn("review.json", kept)
        self.assertNotIn("index.html", kept)
        for name in ("x.js", "evil.svg", "evil2.svg", "evil3.svg", "link.png"):
            self.assertFalse((dst / slug_dir.relative_to(src) / name).exists(), name)
        self.assertFalse((dst / "other").exists())
        self.assertTrue(any(k.endswith("head.svg") for k in kept))
        self.assertTrue(stats["dropped"])

    def test_requires_manifest(self):
        (self.site / "manifest.json").unlink()
        with self.assertRaises(SystemExit):
            sanitize_site.sanitize(self.site, self.tmp / "clean")


class TestReview(Tmp):
    def load(self):
        return common.load_site(self.site)

    def test_right_lines(self):
        self.assertEqual(post_review.right_lines("@@ -10,4 +10,5 @@\n x\n-y\n+z\n+w\n x\n x\n"), {10, 11, 12, 13, 14})
        self.assertEqual(post_review.right_lines("@@ -0,0 +1,2 @@\n+a\n+b\n\\ No newline at end of file"), {1, 2})

    def test_inline_only_in_diff(self):
        manifest, review = self.load()
        allowed = post_review.commentable(self.files)
        inline, rest = post_review.inline_candidates(manifest, review, allowed)
        got = {(p, f["line"]) for _i, f, p in inline}
        self.assertIn(("lib_sch/Custom_Audio.kicad_sym", 130), got)
        # patch omitted by GitHub for an added file -> bounded by its additions
        self.assertIn(("lib_fp/Custom_Connector_Card.pretty/microSD_SHOU-HAN_TF-PUSH.kicad_mod", 120), got)
        self.assertNotIn(9999, {line for _p, line in got})
        # modified file, line 3 outside the hunk; info findings never inline
        self.assertFalse(any(p.endswith("SH1421.kicad_mod") for p, _l in got))
        self.assertFalse(any(f["severity"] == "info" for _i, f, _p in inline))

    def test_dedupe(self):
        manifest, review = self.load()
        inline, _ = post_review.inline_candidates(manifest, review, post_review.commentable(self.files))
        first = post_review.build_review_payload(HEAD, inline, set())
        self.assertEqual(len(first["comments"]), len(inline))
        keys = set()
        for c in first["comments"]:
            keys.update(common.FINDING_MARKER_RE.findall(c["body"]))
        self.assertIsNone(post_review.build_review_payload(HEAD, inline, keys))

    def test_comment(self):
        manifest, review = self.load()
        ctx = Ctx(self.site, REPO, 8, HEAD, "https://pantsforbirds.github.io/kicad-libs/", PAGES)
        body = build_comment(ctx, manifest, review, artifact_url="https://github.com/x/y/actions/runs/1/artifacts/2")
        self.assertTrue(body.startswith(common.MARKER))
        self.assertEqual(body.count(common.MARKER), 1)
        self.assertIn(f"https://raw.githubusercontent.com/{REPO}/{PAGES}/pr/8/items/", body)
        self.assertIn("https://pantsforbirds.github.io/kicad-libs/pr/8/#symbol__Custom_Audio__NS4168", body)
        self.assertIn("diff.png", body)
        self.assertIn("/artifacts/2", body)
        self.assertNotIn("<script", body)
        self.assertNotIn("@someone", body)
        self.assertEqual(body.count("<details>"), body.count("</details>"))

    def test_comment_without_review_and_missing_images(self):
        (self.site / "review.json").unlink()
        for p in self.site.rglob("*.png"):
            p.unlink()
        manifest, review = self.load()
        self.assertIsNone(review)
        ctx = Ctx(self.site, REPO, 8, HEAD, "https://pantsforbirds.github.io/kicad-libs/", None)
        body = build_comment(ctx, manifest, review)
        self.assertIn("not reviewed", body)
        self.assertNotIn("<img", body)

    def test_image_paths_must_stay_in_item_dir(self):
        m = json.loads((self.site / "manifest.json").read_text())
        m["items"][0]["renders"]["head"]["png"] = "../../../etc/passwd"
        m["items"][1]["renders"]["head"]["png"] = "items/" + m["items"][2]["slug"] + "/head.png"
        m["items"][2]["slug"] = "bad slug/.."
        (self.site / "manifest.json").write_text(json.dumps(m))
        manifest, review = self.load()
        ctx = Ctx(self.site, REPO, 8, HEAD, "https://o.github.io/r/", PAGES)
        body = build_comment(ctx, manifest, review)
        self.assertNotIn("passwd", body)
        self.assertNotIn("bad slug", body)
        self.assertEqual(body.count("<img"), 5)   # 8 in the mock, minus 3 rejected

    def test_size_limit(self):
        m = json.loads((self.site / "manifest.json").read_text())
        base = m["items"][0]
        m["items"] = [dict(base, id=f"footprint:L:n{i}", name=f"n{i}", slug=base["slug"]) for i in range(400)]
        (self.site / "manifest.json").write_text(json.dumps(m))
        manifest, review = self.load()
        ctx = Ctx(self.site, REPO, 8, HEAD, "https://o.github.io/r/", PAGES)
        body = build_comment(ctx, manifest, review)
        self.assertLess(len(body), 65536)
        self.assertIn("omitted", body)

    def test_check_conclusion(self):
        manifest, review = self.load()
        self.assertEqual(post_review.check_payload(HEAD, manifest, review, "u", "neutral")["conclusion"], "neutral")
        self.assertEqual(post_review.check_payload(HEAD, manifest, review, "u", "failure")["conclusion"], "failure")
        self.assertEqual(post_review.check_payload(HEAD, manifest, None, "u", "failure")["conclusion"], "neutral")

    def test_cli_dry_run(self):
        out = subprocess.run([sys.executable, str(HERE.parent / "post_review.py"), "--site", str(self.site),
                              "--repo", REPO, "--pr", "8", "--head-sha", HEAD, "--pages-sha", PAGES,
                              "--files-json", str(self.tmp / "mock" / "pr_files.json"), "--dry-run"],
                             capture_output=True, text=True, env={**os.environ, "GITHUB_TOKEN": ""})
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn("review payload", out.stdout)


class FakeGH:
    def __init__(self, pr):
        self.pr = pr

    def get(self, path):
        return self.pr


class TestResolve(unittest.TestCase):
    def pr(self, **kw):
        d = {"state": "open", "head": {"sha": HEAD}, "base": {"sha": PAGES, "repo": {"full_name": REPO}}}
        d.update(kw)
        return d

    def test_ok(self):
        r = resolve_pr.resolve({"pr": 8, "head_sha": HEAD}, REPO, HEAD, FakeGH(self.pr()))
        self.assertFalse(r["skip"])
        self.assertEqual(r["pr"], 8)

    def test_spoofed_pr_number(self):
        other = self.pr(head={"sha": "f" * 40})
        self.assertTrue(resolve_pr.resolve({"pr": 3, "head_sha": HEAD}, REPO, HEAD, FakeGH(other))["skip"])
        self.assertTrue(resolve_pr.resolve({"pr": 8, "head_sha": "e" * 40}, REPO, HEAD, FakeGH(self.pr()))["skip"])
        self.assertTrue(resolve_pr.resolve({"pr": 8, "head_sha": HEAD}, REPO, HEAD, FakeGH(self.pr(state="closed")))["skip"])
        with self.assertRaises(ValueError):
            resolve_pr.resolve({"pr": "8 && x", "head_sha": HEAD}, REPO, HEAD, FakeGH(self.pr()))


class TestDeploy(Tmp):
    def test_deploy_and_delete(self):
        remote = self.tmp / "remote.git"
        subprocess.run(["git", "init", "-q", "--bare", str(remote)], check=True)
        env_backup = os.environ.pop("GITHUB_TOKEN", None)
        try:
            kw = dict(remote=str(remote), branch="gh-pages", push=True)
            deploy_pages.deploy(REPO, 8, self.site, workdir=self.tmp / "w1", **kw)
            sha = deploy_pages.deploy(REPO, 9, self.site, workdir=self.tmp / "w2", **kw)
            ls = subprocess.run(["git", "--git-dir", str(remote), "ls-tree", "-r", "--name-only", sha],
                                capture_output=True, text=True, check=True).stdout.split()
            self.assertIn("pr/8/manifest.json", ls)
            self.assertIn("pr/9/manifest.json", ls)
            self.assertIn(".nojekyll", ls)
            # a stale clone (w1 is behind) must still land its change: simulates a push race
            sha = deploy_pages.deploy(REPO, 8, None, workdir=self.tmp / "w1", **kw)
            ls = subprocess.run(["git", "--git-dir", str(remote), "ls-tree", "-r", "--name-only", sha],
                                capture_output=True, text=True, check=True).stdout.split()
            self.assertFalse(any(p.startswith("pr/8/") for p in ls))
            self.assertIn("pr/9/manifest.json", ls)
            # deleting when there is no gh-pages branch at all is a no-op
            empty = self.tmp / "empty.git"
            subprocess.run(["git", "init", "-q", "--bare", str(empty)], check=True)
            self.assertIsNone(deploy_pages.deploy(REPO, 8, None, workdir=self.tmp / "w3",
                                                  remote=str(empty), branch="gh-pages", push=True))
        finally:
            if env_backup is not None:
                os.environ["GITHUB_TOKEN"] = env_backup


if __name__ == "__main__":
    unittest.main()
