"""Tests for build_site.py's file:// support.   python3 -m unittest tools/component-review/viewer/testdata/build_site_test.py"""
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

VIEWER = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(VIEWER))
import build_site  # noqa: E402


class BundleTests(unittest.TestCase):
    def test_transform(self):
        src = ("import {\n  a, b as c,\n} from './x.js';\n"
               "export const K = 1;\nexport async function f() { return import('./y.js'); }\n"
               "export class D {}\nconst u = import.meta.url;\n")
        out = build_site.transform_module("m.js", src)
        self.assertIn('const { a, b: c } = __require("./x.js");', out)
        self.assertIn("const K = 1;", out)
        self.assertIn('Promise.resolve().then(() => __require("./y.js"))', out)
        self.assertIn('new URL("js/m.js", document.baseURI).href', out)
        self.assertIn("Object.assign(__exports, { K, f, D });", out)
        self.assertNotRegex(out, r"(?m)^\s*(import|export)\s")

    def test_rejects_unsupported(self):
        for src in ("import x from './x.js';\n", "export default 1;\n", "export { a };\n", "import * as n from './x.js';\n"):
            with self.assertRaises(ValueError, msg=src):
                build_site.transform_module("m.js", src)

    def test_real_bundle_parses(self):
        bundle = build_site.make_bundle(VIEWER / "js")
        self.assertIn("window.CR_STEP_WORKER_SRC", bundle)
        if shutil.which("node"):
            with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as f:
                f.write(bundle)
            subprocess.run(["node", "--check", f.name], check=True)

    def test_js_literal(self):
        s = build_site.js_literal({"x": "</script><!-- &   "})
        for bad in ("<", ">", "&", " ", " "):
            self.assertNotIn(bad, s)
        self.assertEqual(json.loads(s), {"x": "</script><!-- &   "})

    def test_asset_url_matches_js(self):
        self.assertEqual(build_site.asset_url("items/a b/c#d.svg"), "items/a%20b/c%23d.svg")
        self.assertEqual(build_site.asset_url("items/x_(1)!~*'.svg"), "items/x_(1)!~*'.svg")


class OfflineDataTests(unittest.TestCase):
    def setUp(self):
        self.out = Path(tempfile.mkdtemp())
        (self.out / "secret.txt").write_text("SECRET")
        d = self.out / "items" / "fp"
        d.mkdir(parents=True)
        (d / "diff.patch").write_text("+</script>\n")
        (d / "head_geom.json").write_text('{"pads": []}')
        (d / "head_F.Cu.svg").write_text("<svg/>")
        (d / "model_1.step").write_bytes(b"ISO-10303-21;")
        items = [{"slug": "fp", "kind": "footprint", "text_diff": "items/fp/diff.patch",
                  "geom": {"head": "items/fp/head_geom.json", "base": "items/fp/../../secret.txt"},
                  "renders": {"head": {"layers": {"F.Cu": "items/fp/head_F.Cu.svg", "B.Cu": "/etc/passwd"}}},
                  "model3d_by_side": {"head": [{"file": "items/fp/model_1.step"}], "base": [{"file": "secret.txt"}]}},
                 {"slug": "../evil", "kind": "footprint", "text_diff": "../secret.txt", "geom": {"head": "secret.txt"}}]
        (self.out / "manifest.json").write_text(json.dumps({"items": items}))

    def test_build_offline(self):
        stats = build_site.build_offline(self.out)
        self.assertEqual(stats["packs"], 1)
        data = (self.out / "data.js").read_text()
        self.assertNotIn("SECRET", data)
        self.assertNotIn("</script>", data)
        blob = json.loads(data.split("window.CR_DATA = ", 1)[1].rstrip().rstrip(";"))
        self.assertEqual(blob["texts"], {"items/fp/diff.patch": "+</script>\n"})
        self.assertIsNone(blob["review"])
        pack = (self.out / "offline" / "fp.js").read_text()
        files = json.loads(pack.split("] = ", 1)[1].rstrip().rstrip(";"))["files"]
        self.assertEqual(sorted(files), ["items/fp/head_F.Cu.svg", "items/fp/head_geom.json", "items/fp/model_1.step"])
        self.assertEqual(files["items/fp/model_1.step"], {"b64": "SVNPLTEwMzAzLTIxOw=="})
        self.assertEqual(sorted(p.name for p in (self.out / "offline").iterdir()), ["fp.js"])


if __name__ == "__main__":
    unittest.main()
