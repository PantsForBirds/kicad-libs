"""Tests for the component-review CI scripts: python3 -m unittest discover -s tools/component-review/ci/tests"""
import json
import re
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
import job_summary  # noqa: E402
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


class TestSanitizeLimits(Tmp):
    def item_dir(self, idx=0):
        m = json.loads((self.site / "manifest.json").read_text())
        return m, m["items"][idx]["slug"]

    def add_step(self, name, size, magic=True):
        m, slug = self.item_dir()
        p = self.site / "items" / slug / name
        with open(p, "wb") as f:
            f.write(b"ISO-10303-21;\nHEADER;\n" if magic else b"not a step file")
            f.truncate(size)
        m["items"][0]["model3d"] = [{"path_raw": "x", "file": f"items/{slug}/{name}"}]
        m["items"][0]["geom"] = {"head": f"items/{slug}/head_geom.json", "base": None}
        (self.site / "items" / slug / "head_geom.json").write_text('{"bbox": [0, 0, 1, 1], "pads": []}')
        (self.site / "manifest.json").write_text(json.dumps(m))
        return slug

    def test_geom_and_step_kept(self):
        slug = self.add_step("model_1.step", 1000)
        sanitize_site.sanitize(self.site, self.tmp / "clean")
        clean = self.tmp / "clean" / "items" / slug
        self.assertTrue((clean / "model_1.step").is_file())
        self.assertTrue((clean / "head_geom.json").is_file())
        m = json.loads((self.tmp / "clean" / "manifest.json").read_text())
        self.assertEqual(m["items"][0]["model3d"][0]["file"], f"items/{slug}/model_1.step")

    def test_step_cap_nulls_manifest(self):
        slug = self.add_step("model_1.step", 26 * 1024 * 1024)
        stats = sanitize_site.sanitize(self.site, self.tmp / "clean")
        self.assertFalse((self.tmp / "clean" / "items" / slug / "model_1.step").exists())
        m = json.loads((self.tmp / "clean" / "manifest.json").read_text())
        self.assertIsNone(m["items"][0]["model3d"][0]["file"])
        self.assertTrue(any("model_1.step not published" in w for w in m["items"][0]["warnings"]))
        self.assertEqual(stats["manifest_refs_nulled"], 1)

    def test_fake_step_dropped(self):
        slug = self.add_step("model_1.step", 1000, magic=False)
        sanitize_site.sanitize(self.site, self.tmp / "clean")
        self.assertFalse((self.tmp / "clean" / "items" / slug / "model_1.step").exists())

    def test_site_budget_drops_bulky_first(self):
        slug = self.add_step("model_1.step", 3 * 1024 * 1024)
        sanitize_site.sanitize(self.site, self.tmp / "clean", max_total=2 * 1024 * 1024)
        clean = self.tmp / "clean" / "items" / slug
        self.assertFalse((clean / "model_1.step").exists())
        self.assertTrue((clean / "head.png").exists())
        self.assertTrue((clean / "head_geom.json").exists())


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
        body = build_comment(ctx, manifest, review, artifact_url="https://github.com/x/y/actions/runs/1/artifacts/2",
                             report_url="https://github.com/x/y/actions/runs/1/artifacts/3")
        self.assertTrue(body.startswith(common.MARKER))
        self.assertEqual(body.count(common.MARKER), 1)
        self.assertIn(f"https://raw.githubusercontent.com/{REPO}/{PAGES}/pr/8/items/", body)
        self.assertIn("https://pantsforbirds.github.io/kicad-libs/pr/8/#symbol__Custom_Audio__NS4168", body)
        self.assertIn("diff.png", body)
        self.assertIn("[⬇️ offline viewer (zip)](https://github.com/x/y/actions/runs/1/artifacts/2)", body)
        self.assertIn("[📄 HTML report (single file, no JS)](https://github.com/x/y/actions/runs/1/artifacts/3)", body)
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

    def test_pr_findings_and_generator(self):
        r = json.loads((self.site / "review.json").read_text())
        r["generator"] = "deterministic checks + KLC"
        r["pr_findings"] = [
            {"severity": "warning", "category": "3d-model", "path": "lib_3d/Custom_Module/SH1421-C.step",
             "line": None, "message": "3D model file is unreferenced <b>@x</b>", "suggestion": "Drop it."},
            "junk", {"severity": "bogus", "message": None}]
        (self.site / "review.json").write_text(json.dumps(r))
        manifest, review = self.load()
        ctx = Ctx(self.site, REPO, 8, HEAD, "https://o.github.io/r/", PAGES)
        body = build_comment(ctx, manifest, review)
        self.assertIn("### PR-level findings", body)
        self.assertIn("`lib_3d/Custom_Module/SH1421-C.step`", body)
        self.assertIn("unreferenced &lt;b&gt;&#64;x&lt;/b&gt;", body)
        self.assertNotIn("<b>@x", body)
        self.assertNotIn("**info** ·  — ", body)      # message-less finding skipped
        self.assertIn("(deterministic checks + KLC)", body)
        self.assertLess(body.index("PR-level"), body.index("### Details"))
        check = post_review.check_payload(HEAD, manifest, review, "u", "neutral")
        self.assertIn("5 warning(s)", check["output"]["title"])   # 4 item warnings + 1 PR-level

    def test_old_model_field_is_fallback(self):
        r = json.loads((self.site / "review.json").read_text())
        del r["generator"]
        r["model"] = "deterministic checks only"
        (self.site / "review.json").write_text(json.dumps(r))
        manifest, review = self.load()
        body = build_comment(Ctx(self.site, REPO, 8, HEAD, "https://o.github.io/r/", PAGES), manifest, review)
        self.assertIn("(deterministic checks only)", body)

    def test_odd_generator_types(self):
        r = json.loads((self.site / "review.json").read_text())
        r.update(generator={"x": 1}, model=None, pr_findings="nope")
        (self.site / "review.json").write_text(json.dumps(r))
        manifest, review = self.load()
        body = build_comment(Ctx(self.site, REPO, 8, HEAD, "https://o.github.io/r/", PAGES), manifest, review)
        self.assertNotIn("PR-level", body)
        self.assertIn("Generated by the component-review workflow. ", body)

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


class TestJobSummary(Tmp):
    def test_annotations(self):
        review = json.loads((self.site / "review.json").read_text())
        rid = "footprint:Custom_Connector_Card:microSD_SHOU-HAN_TF-PUSH"
        review["items"][rid]["findings"].append({"severity": "error", "category": "a,b:c", "line": 5,
                                                 "path": "lib_fp/x.kicad_mod", "message": "50% bad\n::error::x"})
        (self.site / "review.json").write_text(json.dumps(review))
        manifest, review = common.load_site(self.site)
        lines = job_summary.annotations(manifest, review)
        self.assertTrue(lines[0].startswith("::error "))           # most severe first
        self.assertTrue(all(len(l.splitlines()) == 1 for l in lines))
        inj = next(l for l in lines if "50%25 bad" in l)
        self.assertIn("file=lib_fp/x.kicad_mod,line=5,title=a%2Cb%3Ac%3A Custom_Connector_Card%3AmicroSD_SHOU-HAN_TF-PUSH::", inj)
        self.assertTrue(inj.endswith("::50%25 bad ::error::x"))   # one line; the message part is inert
        self.assertFalse(any(l.startswith("::info") or l.startswith("::notice") for l in lines))
        self.assertTrue(any("file=lib_3d/Custom_Module/SH1421-C.step" in l for l in lines))  # PR-level

    def test_no_line_zero(self):
        """KLC-checker findings have no line: annotate/link the item's first line, never 0."""
        review = json.loads((self.site / "review.json").read_text())
        rid = "symbol:Custom_Audio:NS4168"             # line_range head [5, 180]
        review["items"][rid]["findings"] += [
            {"severity": "warning", "category": "klc", "message": "KLC S3.1 no line", "path": "lib_sch/Custom_Audio.kicad_sym"},
            {"severity": "warning", "category": "klc", "message": "KLC S3.2 line 0", "line": 0,
             "path": "lib_sch/Custom_Audio.kicad_sym"}]
        (self.site / "review.json").write_text(json.dumps(review))
        manifest, review = common.load_site(self.site)
        lines = job_summary.annotations(manifest, review)
        self.assertTrue(all(re.search(r"(^|,)line=[1-9][0-9]*(,|::)", l) for l in lines), lines)
        for msg in ("KLC S3.1 no line", "KLC S3.2 line 0"):
            self.assertIn("file=lib_sch/Custom_Audio.kicad_sym,line=5,", next(l for l in lines if msg in l))
        self.assertIn("line=1,", next(l for l in lines if "SH1421-C.step" in l))   # PR-level: line 1
        ctx = Ctx(self.site, REPO, 8, HEAD, "https://pantsforbirds.github.io/kicad-libs/", PAGES)
        body = build_comment(ctx, manifest, review)
        self.assertNotIn("#L0", body)
        self.assertNotIn("[L0]", body)
        self.assertIn("Custom_Audio.kicad_sym#L5)", body)
        self.assertEqual(common.finding_line_no({"line": True}, None), (1, False))
        self.assertEqual(common.finding_line_no({"line": 7}, None), (7, True))

    def test_summary(self):
        (self.site / "review.md").write_text("## Component review\n\n| a | b |\n")
        out = self.tmp / "summary.md"
        job_summary.main(["--out", str(self.site), "--summary", str(out),
                          "--link", "component-review.html (report)=https://github.com/o/r/actions/runs/1/artifacts/9",
                          "--link", "empty=", "--link", "bad=javascript:alert(1)"])
        text = out.read_text()
        self.assertIn("[component-review.html (report)](https://github.com/o/r/actions/runs/1/artifacts/9)", text)
        self.assertNotIn("javascript", text)
        self.assertNotIn("empty", text)
        self.assertIn("### Findings", text)
        self.assertIn("6** changed component(s)", text)


if __name__ == "__main__":
    unittest.main()
