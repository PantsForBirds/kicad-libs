"""Tests for make_report.py: python3 -m unittest discover -s tools/component-review/report/tests"""
import json
import sys
import tempfile
import unittest
from html.parser import HTMLParser
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE.parent.parent / "ci" / "tests"))

import make_mock  # noqa: E402
import make_report  # noqa: E402

XSS = '<script>alert(1)</script><img src=x onerror=alert(2)>"\'><svg onload=alert(3)>javascript:alert(4)'
ALLOWED_TAGS = {"html", "head", "meta", "title", "style", "body", "main", "header", "h1", "h2", "h3", "h4", "p",
                "a", "code", "span", "div", "table", "thead", "tbody", "tr", "th", "td", "ul", "li", "b", "strong",
                "small", "wbr", "br", "figure", "figcaption", "img", "details", "summary", "input", "label", "pre",
                "del", "ins", "i", "section", "footer"}


class Audit(HTMLParser):
    """Collects every tag/attribute so the tests can assert nothing active got through."""

    def __init__(self):
        super().__init__()
        self.tags, self.problems = set(), []

    def handle_starttag(self, tag, attrs):
        self.tags.add(tag)
        if tag not in ALLOWED_TAGS:
            self.problems.append(f"tag <{tag}>")
        for k, v in attrs:
            v = v or ""
            if k.startswith("on"):
                self.problems.append(f"handler {k} on <{tag}>")
            if k == "href" and not (v.startswith(("https://", "http://", "#"))):
                self.problems.append(f"href {v[:60]!r}")
            if k == "src" and not v.startswith("data:image/png;base64,"):
                self.problems.append(f"src {v[:60]!r}")
            if k == "style":
                self.problems.append("inline style attribute")


def audit(page: str) -> Audit:
    a = Audit()
    a.feed(page)
    return a


class Base(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.tmp = Path(self._td.name)
        make_mock.main(self.tmp / "mock")
        self.site = self.tmp / "mock" / "site"
        self.m = json.loads((self.site / "manifest.json").read_text())
        self.r = json.loads((self.site / "review.json").read_text())

    def tearDown(self):
        self._td.cleanup()

    def save(self):
        (self.site / "manifest.json").write_text(json.dumps(self.m))
        (self.site / "review.json").write_text(json.dumps(self.r))

    def page(self, level=0):
        return make_report.build(self.site, level, now="test")


class TestContent(Base):
    def test_mock_report(self):
        page = self.page()
        a = audit(page)
        self.assertEqual(a.problems, [])
        self.assertIn("Content-Security-Policy", page)
        self.assertNotIn("<script", page.lower())
        self.assertIn("PR #8", page)
        self.assertIn("1627ad2136", page)
        for it in self.m["items"]:
            self.assertIn(f'id="{make_report.slug_id(it["slug"])}"', page)
            self.assertIn(f'href="#{make_report.slug_id(it["slug"])}"', page)
        # finding links point at the head sha
        self.assertIn("https://github.com/PantsForBirds/kicad-libs/blob/1627ad2136c15edddf09c6034d03ee3de04acf9b/"
                      "lib_fp/Custom_Connector_Card.pretty/microSD_SHOU-HAN_TF-PUSH.kicad_mod#L120", page)
        self.assertIn("PR-level findings", page)
        self.assertIn("Diff over before", page)       # modified item has the overlay
        self.assertIn("data:image/png;base64,", page)

    def test_unlocated_findings_link_item_start(self):
        rid = "symbol:Custom_Audio:NS4168"             # line_range head [5, 180]
        self.r["items"][rid]["findings"] = [
            {"severity": "warning", "category": "klc", "message": "no line", "path": "lib_sch/Custom_Audio.kicad_sym"},
            {"severity": "warning", "category": "klc", "message": "line 0", "line": 0, "path": "lib_sch/Custom_Audio.kicad_sym"}]
        self.save()
        page = self.page()
        self.assertNotIn("#L0", page)
        self.assertNotIn(".kicad_sym:0", page)
        self.assertEqual(page.count("lib_sch/Custom_Audio.kicad_sym#L5\">lib_sch/Custom_Audio.kicad_sym</a>"), 2)

    def test_statuses(self):
        # make the modified item's twin deleted, with a text diff
        it = dict(self.m["items"][0])
        it.update(id="footprint:Gone:Old", slug="footprint__Gone__Old", library="Gone", name="Old",
                  status="deleted", path="lib_fp/Gone.pretty/Old.kicad_mod",
                  line_range={"head": None, "base": [1, 9]},
                  renders={"head": None, "base": self.m["items"][0]["renders"]["head"]}, diff_png=None,
                  text_diff="items/footprint__Gone__Old/diff.patch")
        d = self.site / "items" / "footprint__Gone__Old"
        d.mkdir()
        (d / "diff.patch").write_text("--- a/x\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-(footprint Old\n-)\n")
        (d / "head.png").write_bytes((self.site / self.m["items"][0]["renders"]["head"]["png"]).read_bytes())
        it["renders"]["base"] = {"png": "items/footprint__Gone__Old/head.png", "svg": None, "layers": {}}
        self.m["items"].append(it)
        self.save()
        page = self.page()
        self.assertEqual(audit(page).problems, [])
        sec = page[page.index('id="c-footprint__Gone__Old"'):]
        sec = sec[: sec.index("</section>")]
        self.assertIn("Before (base)", sec)
        self.assertNotIn("After (head)", sec)
        self.assertIn('<span class="del">-(footprint Old</span>', sec)
        added = page[page.index('id="c-footprint__Custom_Buzzer_Beeper'):]
        added = added[: added.index("</section>")]
        self.assertIn("After (head)", added)
        self.assertNotIn("Before (base)", added)

    def test_pad_and_pin_diff(self):
        it = self.m["items"][5]   # modified SH1421
        pad = {"number": "1", "type": "smd", "shape": "rect", "at": [0, 0, 0], "size": [1, 1], "layers": ["F.Cu"]}
        it["stats"] = {"base": {"pad_count": 2, "pads": [pad, dict(pad, number="2")]},
                       "head": {"pad_count": 2, "pads": [dict(pad, size=[1.2, 1]), dict(pad, number="3")]}}
        self.save()
        page = self.page()
        self.assertIn("<del>(1, 1)</del> → <ins>(1.2, 1)</ins>", page)
        self.assertIn(">removed<", page)
        self.assertIn(">added<", page)

    def test_missing_fields_and_junk(self):
        self.m["items"] = [{"id": "footprint:A:B"}, {"slug": "../../etc"}, "junk", None,
                           {"id": 5, "slug": 7, "renders": "x", "stats": [], "properties": 3, "model3d": "y",
                            "line_range": "z", "datasheet": [], "warnings": "w", "preview_3d": 1}]
        self.m["repo"] = "not a repo"
        self.m["head_sha"] = "nope"
        self.r["items"] = {"footprint:A:B": {"findings": "x", "checks": None, "verdict": "maybe"}}
        self.r["pr_findings"] = "nope"
        self.save()
        page = self.page()
        self.assertEqual(audit(page).problems, [])
        (self.site / "review.json").unlink()
        page = self.page()
        self.assertIn("No review.json", page)
        (self.site / "manifest.json").write_text("{broken")
        self.assertIn("No footprints or symbols changed", self.page())


class TestEscaping(Base):
    def test_xss_everywhere(self):
        it = self.m["items"][0]
        for k in ("library", "name", "status", "kind"):
            it[k] = XSS
        it["path"] = "lib_fp/" + XSS
        it["properties"] = {"base": {XSS: XSS}, "head": {XSS: XSS + "2", "Value": XSS}}
        it["stats"] = {"base": {XSS: XSS, "pads": [{"number": XSS, "type": XSS}]},
                       "head": {XSS: 1, "pads": [{"number": XSS, "type": XSS + "x"}]}}
        it["kind"] = "footprint"
        it["status"] = "modified"
        it["model3d_by_side"] = {"base": [], "head": [{"path_raw": XSS, "resolved": XSS, "exists": False,
                                                       "offset": [XSS], "stock": {"tag": XSS}}]}
        it["warnings"] = [XSS]
        it["change_reasons"] = [XSS]
        it["datasheet"] = {"url": "javascript:alert(1)", "local": XSS}
        it["text_diff"] = f"items/{it['slug']}/diff.patch"
        (self.site / it["text_diff"]).write_text(f"--- a\n+++ b\n@@ -1 +1 @@\n-{XSS}\n+{XSS}\n")
        rid = self.m["items"][1]["id"]
        self.r["generator"] = XSS
        self.r["summary_markdown"] = XSS + " **bold** `code`"
        self.r["items"][rid] = {"verdict": XSS, "summary": XSS, "findings": [
            {"severity": XSS, "category": XSS, "message": XSS, "suggestion": XSS, "path": XSS, "line": XSS},
            {"severity": "error", "category": "klc", "message": "**" + XSS + "**", "path": "lib_fp/a b.kicad_mod", "line": 3}],
            "checks": [{"name": XSS, "result": XSS, "detail": XSS}]}
        self.r["pr_findings"] = [{"severity": "warning", "category": XSS, "message": XSS, "path": XSS}]
        self.m["generated_at"] = XSS
        self.m["kicad_version"] = XSS
        self.save()
        for level in (0, 3):
            page = self.page(level)
            a = audit(page)
            self.assertEqual(a.problems, [], a.problems)
            low = page.lower()
            self.assertNotIn("<script>alert", low)
            self.assertNotIn("<svg onload", low)
            self.assertNotIn("<img src=x", low)
            self.assertNotIn('href="javascript', low)                  # shown as text only
            self.assertIn("datasheet: <code>javascript:alert(1)</code>", page)
            self.assertIn("&lt;script&gt;alert(1)&lt;/script&gt;", page)
        self.assertIn("lib_fp/a%20b.kicad_mod#L3", page)

    def test_unsafe_svg_and_fake_png(self):
        it = self.m["items"][5]
        d = self.site / "items" / it["slug"]
        (d / "head_F.Cu.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">'
                                          '<rect width="5" height="5" fill="#c83434"/></svg>')
        (d / "head_F.SilkS.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
        (d / "head_B.Cu.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example/x.png"/></svg>')
        it["renders"]["head"]["layers"] = {"F.Cu": f"items/{it['slug']}/head_F.Cu.svg",
                                           "F.SilkS": f"items/{it['slug']}/head_F.SilkS.svg",
                                           "B.Cu": f"items/{it['slug']}/head_B.Cu.svg",
                                           "Evil": "../../../../etc/passwd"}
        (d / "diff.png").write_text("<html>not a png</html>")
        self.save()
        page = self.page()
        self.assertEqual(audit(page).problems, [])
        self.assertFalse(any(x in page for x in ('href="https://evil', 'src="https://evil', "<svg")))
        if make_report.cairosvg is not None:
            sec = page[page.index(f'id="{make_report.slug_id(it["slug"])}"'):]
            self.assertIn(">F.Cu</label>", sec)
            self.assertNotIn(">F.SilkS</label>", sec)
            self.assertNotIn(">B.Cu</label>", sec)
        self.assertNotIn("Diff over before", page[page.index(f'id="{make_report.slug_id(it["slug"])}"'):])


class TestSize(Base):
    def test_levels_and_cap(self):
        full, level = make_report.make_report(self.site, 20 * make_report.MB)
        self.assertEqual(level, 0)
        self.assertNotIn("To stay under the size limit", full)
        small, level = make_report.make_report(self.site, len(full.encode()) - 1)
        self.assertGreater(level, 0)
        self.assertIn("To stay under the size limit", small)
        tiny, level = make_report.make_report(self.site, 1000)
        self.assertEqual(level, len(make_report.LEVELS) - 1)
        self.assertIn("all images left out", tiny)
        self.assertNotIn("data:image", tiny)

    def test_downscale(self):
        if make_report.Image is None:
            self.skipTest("Pillow not installed")
        from PIL import Image
        it = self.m["items"][0]
        p = self.site / it["renders"]["head"]["png"]
        Image.new("RGB", (3000, 1000), (40, 160, 60)).save(p)
        imgs = make_report.Images(self.site)
        import base64
        import io
        uri = imgs.png(it["renders"]["head"]["png"], it["slug"], 500)
        im = Image.open(io.BytesIO(base64.b64decode(uri.split(",", 1)[1])))
        self.assertEqual(im.size, (500, 167))

    def test_cli(self):
        out = self.tmp / "r.html"
        self.assertEqual(make_report.main(["--out", str(self.site), "--output", str(out)]), 0)
        self.assertTrue(out.read_text().startswith("<!DOCTYPE html>"))
        self.assertEqual(make_report.main(["--out", str(self.tmp / "nope")]), 2)


if __name__ == "__main__":
    unittest.main()
