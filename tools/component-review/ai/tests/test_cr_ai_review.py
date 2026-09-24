"""Unit tests for the component-review AI step. Stdlib unittest; also runs under pytest.

  python3 -m unittest discover -s tools/component-review/ai/tests -v
"""

from __future__ import annotations

import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
AI_DIR = os.path.dirname(HERE)
REPO = os.path.abspath(os.path.join(AI_DIR, "..", "..", ".."))
sys.path.insert(0, AI_DIR)
sys.path.insert(0, HERE)

import cr_ai_review as cr  # noqa: E402
import datasheet as ds_mod  # noqa: E402
import kicad_checks as kc  # noqa: E402
import make_mock_out  # noqa: E402
import prompts  # noqa: E402
import sexpr  # noqa: E402

FP_OK = """(footprint "R_0603_1608Metric"
	(version 20260206)
	(generator "pcbnew")
	(layer "F.Cu")
	(descr "Resistor 0603, https://example.com/r0603.pdf")
	(tags "resistor")
	(property "Reference" "REF**"
		(at 0 -1.43 0)
		(layer "F.SilkS")
	)
	(property "Value" "R_0603"
		(at 0 1.43 0)
		(layer "F.Fab")
	)
	(fp_line (start -0.8 -0.4) (end 0.8 -0.4) (stroke (width 0.1) (type solid)) (layer "F.Fab"))
	(fp_line (start -0.8 0.4) (end 0.8 0.4) (stroke (width 0.1) (type solid)) (layer "F.Fab"))
	(fp_rect (start -1.48 -0.73) (end 1.48 0.73) (stroke (width 0.05) (type solid)) (layer "F.CrtYd"))
	(fp_line (start -0.24 -0.51) (end 0.24 -0.51) (stroke (width 0.12) (type solid)) (layer "F.SilkS"))
	(fp_text user "${REFERENCE}" (at 0 0 0) (layer "F.Fab"))
	(pad "1" smd roundrect (at -0.79 0) (size 0.88 0.95) (layers "F.Cu" "F.Mask" "F.Paste"))
	(pad "2" smd roundrect (at 0.79 0) (size 0.88 0.95) (layers "F.Cu" "F.Mask" "F.Paste"))
	(model "${KICAD_LIBS_DIR}/lib_3d/Custom_Resistor/R_0603.step"
		(offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0))
	)
)
"""

FP_BAD = """(footprint "Bad"
	(version 20260206)
	(layer "F.Cu")
	(property "Reference" "REF**" (at 0 -2 0) (layer "F.SilkS"))
	(property "Value" "Bad" (at 0 2 0) (layer "F.Fab"))
	(fp_line (start -2 0) (end 2 0) (stroke (width 0.12) (type solid)) (layer "F.SilkS"))
	(pad "1" smd rect (at -1 0) (size 1 1) (layers "F.Cu" "F.Mask" "F.Paste"))
	(pad "2" smd rect (at 1 0) (size 1 1) (layers "F.Cu" "F.Mask"))
	(pad "2" smd rect (at 1 1.5) (size 1 1) (layers "F.Cu" "F.Mask"))
	(model "${KICAD9_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603.step"
		(offset (xyz 0 0 0)) (scale (xyz 2 1 1)) (rotate (xyz 0 0 45))
	)
)
"""

SYM = """(kicad_symbol_lib
	(version 20251024)
	(generator "kicad_symbol_editor")
	(symbol "AMP1"
		(property "Reference" "U" (at 0 0 0))
		(property "Value" "AMP1" (at 0 0 0))
		(property "Footprint" "Custom_Test:R_0603_1608Metric" (at 0 0 0))
		(property "Datasheet" "" (at 0 0 0))
		(property "Description" "" (at 0 0 0))
		(symbol "AMP1_1_1"
			(pin input line (at -5.08 0 0) (length 2.54) (name "IN" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
			(pin power_in line (at 0 5.08 270) (length 2.54) (hide yes) (name "VDD") (number "3"))
			(pin output line (at 5.1 1.27 180) (length 2.54) (name "OUT") (number "2"))
			(pin passive line (at 5.08 -1.27 180) (length 2.54) (name "X") (number "2"))
		)
	)
)
"""


def _msgs(findings):
    return [f["message"] for f in findings]


class SexprTests(unittest.TestCase):
    def test_parse_lines_and_atoms(self):
        root = sexpr.parse(FP_OK)
        self.assertEqual(root.name, "footprint")
        self.assertEqual(root.atom(), "R_0603_1608Metric")
        pads = root.children("pad")
        self.assertEqual([p.atom() for p in pads], ["1", "2"])
        self.assertEqual(pads[0].line, FP_OK.splitlines().index(next(l for l in FP_OK.splitlines() if '(pad "1"' in l)) + 1)

    def test_escapes_and_flags(self):
        n = sexpr.parse('(a "x \\"y\\"" (hide yes) bare)')
        self.assertEqual(n.atom(0), 'x "y"')
        self.assertTrue(n.has_flag("hide"))
        self.assertTrue(sexpr.parse("(p hide)").has_flag("hide"))

    def test_unbalanced(self):
        with self.assertRaises(sexpr.ParseError):
            sexpr.parse("(a (b)")


class FootprintCheckTests(unittest.TestCase):
    def run_fp(self, text, model3d=None, start=10):
        fp = sexpr.parse(text)
        return kc.check_footprint(fp, kc.LineMap(fp.line, start), model3d)

    def test_clean_footprint(self):
        f, c = self.run_fp(FP_OK, [{"path_raw": "${KICAD_LIBS_DIR}/lib_3d/Custom_Resistor/R_0603.step", "exists": True}])
        self.assertEqual([x for x in f if x["severity"] != "info"], [], _msgs(f))
        self.assertTrue(all(x["result"] == "pass" for x in c), c)

    def test_bad_footprint(self):
        f, _ = self.run_fp(FP_BAD)
        msgs = " | ".join(_msgs(f))
        self.assertIn("no courtyard", msgs)
        self.assertIn("No fabrication-layer outline", msgs)
        self.assertIn("${REFERENCE}", msgs)
        self.assertIn("overlaps copper pad(s) 1, 2", msgs)
        self.assertIn("does not use `${KICAD_LIBS_DIR}", msgs)
        self.assertIn("scale", msgs)
        self.assertIn("not a multiple of 90", msgs)
        self.assertIn("Pad numbers used more than once: 2×2", msgs)
        self.assertIn("SMD pad 2 has no paste", msgs)
        self.assertIn("No datasheet URL", msgs)
        self.assertTrue(all(x["category"] == "klc" for x in f))
        # stock-library model paths cannot be verified -> no "does not exist" error
        self.assertNotIn("does not exist", msgs)

    def test_model_missing_in_repo(self):
        f, _ = self.run_fp(FP_OK, [{"path_raw": "${KICAD_LIBS_DIR}/lib_3d/Custom_Resistor/R_0603.step", "exists": False}])
        self.assertTrue(any(x["severity"] == "error" and "does not exist" in x["message"] for x in f))

    def test_line_mapping(self):
        f, _ = self.run_fp(FP_BAD, start=100)
        silk = next(x for x in f if "overlaps" in x["message"])
        self.assertEqual(silk["line"], 100 + 6 - 1)  # fp_line is on line 6 of the source

    def test_courtyard_too_small(self):
        text = FP_OK.replace("(start -1.48 -0.73) (end 1.48 0.73)", "(start -1.0 -0.5) (end 1.0 0.5)")
        f, _ = self.run_fp(text)
        self.assertTrue(any(x["severity"] == "error" and "outside the courtyard" in x["message"] for x in f), _msgs(f))

    def test_rotated_pad_silk(self):
        pad = {"number": "1", "shape": "rect", "x": 0, "y": 0, "w": 2, "h": 0.4, "rot": 90}
        self.assertTrue(kc._seg_hits_pad((-0.1, -0.9), (0.1, -0.9), 0.06, pad))  # inside once rotated
        self.assertFalse(kc._seg_hits_pad((-0.9, -0.1), (-0.9, 0.1), 0.06, pad))


class ModelNameTests(unittest.TestCase):
    def test_package_dimension_mismatch(self):
        msg = kc.model_name_mismatch("SOIC-8-1EP_3.9x4.9mm_P1.27mm_EP2.41x3.3mm",
                                     "${KICAD10_3DMODEL_DIR}/Package_SO.3dshapes/SOIC-8-1EP_3.9x4.9mm_P1.27mm_EP2.29x3mm.step")
        self.assertIn("EP2.41x3.3mm", msg)
        self.assertIn("EP2.29x3mm", msg)

    def test_no_false_positives(self):
        self.assertIsNone(kc.model_name_mismatch("R_0603_1608Metric", "x/R_0603_1608Metric.step"))
        self.assertIsNone(kc.model_name_mismatch("SW_SPST_Same-Sky_TS32_with-boss", "x/TS32-7-35-BK-B-260-RA-SMT-TR.STEP"))
        self.assertIsNone(kc.model_name_mismatch("QFN-16-1EP_3x3mm_P0.5mm_EP1.7x1.7mm_ThermalVias",
                                                 "x/QFN-16-1EP_3x3mm_P0.5mm_EP1.7x1.7mm.step"))
        self.assertIsNotNone(kc.model_name_mismatch("R_0603_1608Metric", "x/R_0805_2012Metric.wrl"))

    def test_in_footprint_check(self):
        text = FP_OK.replace("R_0603.step", "R_0603_1608Metric_EP1x1mm.step")
        fp = sexpr.parse(text)
        f, _ = kc.check_footprint(fp, kc.LineMap(1, 1), None)
        hit = [x for x in f if x["category"] == "3d-model"]
        self.assertEqual(len(hit), 1, _msgs(f))
        self.assertEqual(hit[0]["severity"], "warning")


class KlcUtilsTests(unittest.TestCase):
    JUNIT = """<testsuites><testsuite name="Footprint KLC Checks">
<testcase name="X - Warnings"><failure message="F6.3" type="WARNING">F6.3: Pad requirements for SMD footprints
    https://klc.kicad.org/footprint/f6/f6.3/
    Pad(s) potentially missing layers
       - Pad '9' missing layer 'Paste'</failure></testcase>
<testcase name="X - Errors"><failure message="F9.3" type="FAILURE">F9.3: Footprint 3D model requirements
    https://klc.kicad.org/footprint/f9/f9.3/
    3D model directory is different from footprint directory (found 'a.3dshapes', should be 'b.3dshapes')</failure>
<failure message="F5.3" type="FAILURE">F5.3: Courtyard layer requirements
    https://klc.kicad.org/footprint/f5/f5.3/
    Missing courtyard</failure></testcase>
</testsuite></testsuites>"""

    def test_parse_junit_filters_repo_conventions(self):
        import xml.etree.ElementTree as ET
        import klc_utils
        f = klc_utils.parse_junit(ET.fromstring(self.JUNIT))
        self.assertEqual([x["severity"] for x in f], ["info", "warning"])
        self.assertIn("Pad '9' missing layer 'Paste'", f[0]["message"])
        self.assertIn("Missing courtyard", f[1]["message"])
        self.assertTrue(all("3dshapes" not in x["message"] for x in f))

    @unittest.skipUnless(os.environ.get("CR_KLC_UTILS"), "set CR_KLC_UTILS to a kicad-library-utils checkout")
    def test_real_checker(self):
        import klc_utils
        path = os.path.join(REPO, "lib_fp/Custom_Package_SO.pretty/SOIC-8-1EP_3.9x4.9mm_P1.27mm_EP2.41x3.3mm.kicad_mod")
        if not os.path.isfile(path):
            self.skipTest("demo footprint not in this checkout")
        with open(path) as fh:
            text = fh.read()
        f, err = klc_utils.run(os.environ["CR_KLC_UTILS"], "footprint", "Custom_Package_SO",
                               "SOIC-8-1EP_3.9x4.9mm_P1.27mm_EP2.41x3.3mm", text)
        self.assertIsNone(err)
        self.assertTrue(any("F6.3" in x["message"] for x in f), f)
        # unparseable input is reported as an error, not as a clean pass
        f, err = klc_utils.run(os.environ["CR_KLC_UTILS"], "footprint", "Custom_Test", "Bad", FP_BAD)
        self.assertEqual(f, [])
        self.assertIn("could not parse", err)


class SymbolCheckTests(unittest.TestCase):
    def test_symbol(self):
        root = sexpr.parse(SYM)
        sym = kc.find_item_node(root, "symbol", "AMP1")
        f, c = kc.check_symbol(sym, kc.LineMap(sym.line, 50))
        msgs = " | ".join(_msgs(f))
        self.assertIn("Datasheet` property is empty", msgs)
        self.assertIn("Description` property is empty", msgs)
        self.assertIn("Pin 2 (OUT) at (5.1, 1.27) is off the 50 mil grid", msgs)
        self.assertIn("Pin 2 (X) at (5.08, -1.27) is on 50 mil but not 100 mil grid", msgs)
        self.assertIn("Pin number 2 is used by 2 pins", msgs)
        self.assertIn("Power pin 3 (VDD) is hidden", msgs)
        # line mapping: symbol opens at source line 4 -> file line 50
        hidden = next(x for x in f if "hidden" in x["message"])
        self.assertEqual(hidden["line"], 50 + (SYM.splitlines().index(next(l for l in SYM.splitlines() if '"VDD"' in l)) + 1) - 4)

    def test_pairing(self):
        sym = kc.find_item_node(sexpr.parse(SYM), "symbol", "AMP1")
        pins = kc.parse_pins(sym)
        pads = kc.parse_pads(sexpr.parse(FP_OK))
        f, c = kc.check_pairing(pins, pads, "symbol:X:AMP1", "footprint:Y:R", None)
        self.assertIn("Symbol pins 3 have no matching pad", " ".join(_msgs(f)))
        self.assertEqual(c[0]["result"], "fail")


class PathSafetyTests(unittest.TestCase):
    def test_safe_join(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(cr.safe_join(d, "../etc/passwd"))
            self.assertIsNone(cr.safe_join(d, "/etc/passwd"))
            self.assertIsNone(cr.safe_join(d, "items/../../x"))
            self.assertEqual(cr.safe_join(d, "items/a.png"), os.path.join(os.path.realpath(d), "items", "a.png"))

    def test_symlink_escape(self):
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as other:
            os.symlink(other, os.path.join(d, "link"))
            self.assertIsNone(cr.safe_join(d, "link/file"))

    def test_download_blocks_private_hosts(self):
        data, note = ds_mod.download("http://127.0.0.1/x.pdf")
        self.assertIsNone(data)
        self.assertIn("non-public", note)
        data, note = ds_mod.download("file:///etc/passwd")
        self.assertIsNone(data)


class _FakeResp:
    def __init__(self, body: bytes, ctype="application/pdf", url="https://ds.example.com/x.pdf", delay=0.0, length=True):
        self._chunks = [body[i:i + 1000] for i in range(0, len(body), 1000)]
        self.headers = {"Content-Type": ctype}
        if length:
            self.headers["Content-Length"] = str(len(body))
        self._url, self._delay = url, delay

    def geturl(self):
        return self._url

    def read(self, n=-1):
        import time
        time.sleep(self._delay)
        return self._chunks.pop(0) if self._chunks else b""

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class _FakeOpener:
    def __init__(self, *resps):
        self.resps = list(resps)
        self.urls = []

    def open(self, req, timeout=None):
        self.urls.append(req.full_url)
        return self.resps.pop(0)


PUBLIC_DNS = mock.patch("socket.getaddrinfo", return_value=[(2, 1, 6, "", ("93.184.216.34", 443))])


class DownloadGuardTests(unittest.TestCase):
    def setUp(self):
        ds_mod.reset()

    def test_ok_pdf(self):
        with PUBLIC_DNS:
            data, note = ds_mod.download("https://ds.example.com/a.pdf", opener=_FakeOpener(_FakeResp(b"%PDF-1.4 hello")))
        self.assertEqual(data, b"%PDF-1.4 hello")

    def test_https_only(self):
        with PUBLIC_DNS, mock.patch.dict(os.environ, {"CR_DS_HTTPS_ONLY": "1"}):
            data, note = ds_mod.download("http://ds.example.com/a.pdf", opener=_FakeOpener(_FakeResp(b"%PDF")))
            self.assertIsNone(data)
            self.assertIn("CR_DS_HTTPS_ONLY", note)
            # a redirect to http is refused by the redirect handler's check too
            with self.assertRaises(ds_mod._Blocked):
                ds_mod._SafeRedirect().redirect_request(None, None, 302, "", {}, "http://ds.example.com/b.pdf")

    def test_private_hosts_resolved(self):
        for ip in ("10.0.0.5", "127.0.0.1", "169.254.169.254", "::1", "fe80::1", "::ffff:192.168.1.1"):
            fam = 10 if ":" in ip else 2
            with mock.patch("socket.getaddrinfo", return_value=[(fam, 1, 6, "", (ip, 443))]):
                with self.assertRaises(ds_mod._Blocked, msg=ip):
                    ds_mod._check_url("https://innocent.example.com/x.pdf")

    def test_max_bytes_streaming(self):
        body = b"%PDF" + b"x" * 5000
        with PUBLIC_DNS, mock.patch.dict(os.environ, {"CR_DS_MAX_BYTES": "2000"}):
            data, note = ds_mod.download("https://ds.example.com/big.pdf",
                                         opener=_FakeOpener(_FakeResp(body, length=False)))
        self.assertIsNone(data)
        self.assertIn("CR_DS_MAX_BYTES", note)

    def test_total_deadline(self):
        body = b"%PDF" + b"x" * 5000  # 6 chunks x 0.3 s > 1 s total, although each read is fast enough
        with PUBLIC_DNS, mock.patch.dict(os.environ, {"CR_DS_TIMEOUT_S": "1"}):
            data, note = ds_mod.download("https://ds.example.com/slow.pdf",
                                         opener=_FakeOpener(_FakeResp(body, delay=0.3)))
        self.assertIsNone(data)
        self.assertIn("CR_DS_TIMEOUT_S", note)

    def test_non_pdf_rejected(self):
        with PUBLIC_DNS:
            data, note = ds_mod.download("https://ds.example.com/p.png", opener=_FakeOpener(_FakeResp(b"\x89PNG", "image/png")))
            self.assertIsNone(data)
            data, note = ds_mod.download("https://ds.example.com/page", opener=_FakeOpener(_FakeResp(b"<html>hi</html>", "text/html")))
            self.assertIsNone(data)
            self.assertIn("did not return a PDF", note)

    def test_html_landing_page_follows_same_site_pdf(self):
        html = b'<a href="https://cdn.example.com/files/real.pdf?x=1">pdf</a><a href="https://evil.test/a.pdf">'
        op = _FakeOpener(_FakeResp(html, "text/html"), _FakeResp(b"%PDF-real"))
        with PUBLIC_DNS:
            data, note = ds_mod.download("https://www.example.com/datasheet/C1.pdf", opener=op)
        self.assertEqual(data, b"%PDF-real")
        self.assertEqual(op.urls[1], "https://cdn.example.com/files/real.pdf?x=1")

    def test_download_limit(self):
        with PUBLIC_DNS, mock.patch.dict(os.environ, {"CR_DS_MAX_DOWNLOADS": "1"}):
            ds_mod.download("https://ds.example.com/1.pdf", opener=_FakeOpener(_FakeResp(b"%PDF1")))
            data, note = ds_mod.download("https://ds.example.com/2.pdf", opener=_FakeOpener(_FakeResp(b"%PDF2")))
        self.assertIsNone(data)
        self.assertIn("datasheet not fetched (limit)", note)

    def test_no_download_flag_uses_file_only(self):
        with tempfile.TemporaryDirectory() as out:
            os.makedirs(os.path.join(out, "items", "s"))
            with open(os.path.join(out, "items", "s", "datasheet.pdf"), "wb") as f:
                f.write(b"%PDF-local")
            item = {"datasheet": {"url": "https://ds.example.com/x.pdf", "local": None, "file": "items/s/datasheet.pdf"}}
            with mock.patch.object(ds_mod, "download", side_effect=AssertionError("must not download")):
                sh = ds_mod.resolve(item, out, None, None, False, 40, cr.safe_join)
                self.assertTrue(sh.pdf.startswith(b"%PDF-local"))
                item["datasheet"]["file"] = None
                sh = ds_mod.resolve(item, out, None, None, False, 40, cr.safe_join)
                self.assertIsNone(sh.pdf)
                self.assertIn("download disabled", sh.note)


# ---------------------------------------------------------------------------
# end-to-end on a mock OUT built from this repo's PR range (or synthetic data)
# ---------------------------------------------------------------------------

def _have_git_range():
    try:
        subprocess.run(["git", "-C", REPO, "rev-parse", "origin/main"], check=True, capture_output=True)
        return True
    except (subprocess.CalledProcessError, FileNotFoundError):
        return False


def build_synthetic_out(out):
    """Minimal OUT without git: one footprint + one symbol pointing at it."""
    items = []
    for kind, lib, name, text, lr in (("footprint", "Custom_Test", "R_0603_1608Metric", FP_OK, [1, FP_OK.count("\n")]),
                                      ("symbol", "Custom_Test", "AMP1", SYM, [4, 19])):
        slug = f"{kind}__{lib}__{name}"
        d = os.path.join(out, "items", slug)
        os.makedirs(d, exist_ok=True)
        ext = "kicad_mod" if kind == "footprint" else "kicad_sym"
        with open(os.path.join(d, f"head.{ext}"), "w") as f:
            f.write(text)
        with open(os.path.join(d, "head.png"), "wb") as f:
            f.write(make_mock_out.tiny_png())
        with open(os.path.join(d, "datasheet.pdf"), "wb") as f:
            f.write(b"%PDF-1.4\n% fake\n")
        items.append({"id": f"{kind}:{lib}:{name}", "slug": slug, "kind": kind, "library": lib, "name": name,
                      "status": "added", "path": f"lib_x/{name}", "line_range": {"head": lr, "base": None},
                      "properties": {"head": {"Footprint": "Custom_Test:R_0603_1608Metric"} if kind == "symbol" else {}, "base": None},
                      "datasheet": {"url": None, "local": "datasheets/x.pdf", "file": f"items/{slug}/datasheet.pdf"},
                      "model3d": [{"path_raw": "${KICAD_LIBS_DIR}/lib_3d/Custom_Resistor/R_0603.step", "exists": True}],
                      "renders": {"head": {"png": f"items/{slug}/head.png"}, "base": None},
                      "source": {"head": f"items/{slug}/head.{ext}", "base": None}, "warnings": []})
    items.append({"id": "footprint:Custom_Test:Gone", "slug": "footprint__Custom_Test__Gone", "kind": "footprint",
                  "library": "Custom_Test", "name": "Gone", "status": "deleted", "path": "lib_x/Gone",
                  "line_range": {"head": None, "base": [1, 3]}, "source": {"head": None, "base": None}})
    with open(os.path.join(out, "manifest.json"), "w") as f:
        json.dump({"schema": 1, "items": items, "unreferenced_changed_3d_files": ["lib_3d/Custom_Module/Orphan.step"]}, f)


class FakeStream:
    def __init__(self, msg):
        self.msg = msg

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def get_final_message(self):
        return self.msg


class FakeClient:
    """Stands in for anthropic.Anthropic(); records every request."""

    def __init__(self, reply_fn):
        self.calls = []
        outer = self

        class _Messages:
            def stream(self_inner, **params):
                outer.calls.append(params)
                return FakeStream(reply_fn(params))

        self.beta = types.SimpleNamespace(messages=_Messages())


def fake_message(payload, stop_reason="end_turn", model="claude-fable-5-1"):
    return types.SimpleNamespace(
        content=[types.SimpleNamespace(type="thinking", thinking=""),
                 types.SimpleNamespace(type="text", text=json.dumps(payload) if not isinstance(payload, str) else payload)],
        stop_reason=stop_reason, stop_details=None, model=model, _request_id="req_test",
        usage=types.SimpleNamespace(input_tokens=1000, output_tokens=500, cache_creation_input_tokens=3000,
                                    cache_read_input_tokens=0))


AI_REPLY = {
    "verdict": "fail", "summary": "Pad 1 is too small versus the datasheet land pattern.",
    "findings": [
        {"severity": "error", "category": "land-pattern", "target": "this_item",
         "message": "Pad width 0.88 mm vs datasheet 0.95 mm", "line": 20, "suggestion": "Use 0.95 mm"},
        {"severity": "warning", "category": "pinout", "target": "this_item",
         "message": "cites a line outside the item", "line": 99999, "suggestion": ""},
    ],
    "checks": [{"name": "Pad size vs land pattern", "result": "fail", "detail": "0.88 vs 0.95"},
               {"name": "Pin count vs datasheet", "result": "unknown", "detail": "not shown"}],
}


class EndToEndTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.out = os.path.join(self.tmp, "out")
        build_synthetic_out(self.out)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def args(self, *extra):
        return cr.parse_args(["--out", self.out, "--no-download", "--cache-dir", os.path.join(self.tmp, "cache"), *extra])

    def load(self):
        with open(os.path.join(self.out, "review.json")) as f:
            return json.load(f)

    def assert_contract(self, review):
        self.assertEqual(review["schema"], 1)
        for k in ("model", "generated_at", "summary_markdown", "items"):
            self.assertIn(k, review)
        for iid, e in review["items"].items():
            self.assertIn(e["verdict"], ("pass", "warn", "fail"))
            self.assertIsInstance(e["summary"], str)
            self.assertIn("datasheet_used", e)
            for f in e["findings"]:
                self.assertIn(f["severity"], ("error", "warning", "info"))
                self.assertIn(f["category"], prompts.FINDING_CATEGORIES + ["klc"])
                self.assertTrue(f["message"])
                self.assertIn("path", f)
                self.assertTrue(f["line"] is None or isinstance(f["line"], int))
            for c in e["checks"]:
                self.assertIn(c["result"], ("pass", "fail", "unknown"))

    def test_no_llm(self):
        self.assertEqual(cr.run(self.args("--no-llm")), 0)
        r = self.load()
        self.assert_contract(r)
        self.assertEqual(r["items"]["footprint:Custom_Test:Gone"]["verdict"], "pass")
        sym = r["items"]["symbol:Custom_Test:AMP1"]
        self.assertEqual(sym["verdict"], "fail")
        self.assertTrue(any("no matching pad" in f["message"] for f in sym["findings"]))
        self.assertEqual(len(r["pr_findings"]), 1)
        self.assertEqual(r["pr_findings"][0]["path"], "lib_3d/Custom_Module/Orphan.step")
        md = open(os.path.join(self.out, "review.md")).read()
        self.assertIn("Orphan.step", md)
        self.assertIn("| Component | Status | Verdict | Top findings |", md)
        self.assertIn("Custom_Test:AMP1", md)

    def test_missing_key_degrades(self):
        with mock.patch.dict(os.environ, {"ANTHROPIC_API_KEY": "", "ANTHROPIC_AUTH_TOKEN": ""}):
            self.assertEqual(cr.run(self.args()), 0)
            self.assertIn("ANTHROPIC_API_KEY is not set", self.load()["summary_markdown"])
            self.assertEqual(cr.run(self.args("--require-llm")), 2)

    def test_dry_run_writes_requests(self):
        self.assertEqual(cr.run(self.args("--dry-run", "--model", "claude-fable-5-1")), 0)
        req_dir = os.path.join(self.out, "ai-requests")
        files = sorted(os.listdir(req_dir))
        self.assertEqual(files, ["footprint__Custom_Test__R_0603_1608Metric.json", "symbol__Custom_Test__AMP1.json"])
        with open(os.path.join(req_dir, files[0])) as f:
            dump = json.load(f)
        p = dump["params"]
        self.assertEqual(p["model"], "claude-fable-5-1")
        self.assertNotIn("thinking", p)  # Fable 5.1: thinking is always on; don't send it
        self.assertEqual(p["fallbacks"], "default")
        self.assertEqual(p["betas"], [cr.FALLBACK_BETA])
        self.assertEqual(p["output_config"]["format"]["schema"], prompts.OUTPUT_SCHEMA)
        self.assertEqual(p["output_config"]["effort"], "high")
        self.assertEqual(p["system"][0]["cache_control"], {"type": "ephemeral"})
        content = p["messages"][0]["content"]
        self.assertEqual(content[0]["type"], "document")
        self.assertTrue(content[0]["source"]["data"].startswith("<elided application/pdf"))
        self.assertTrue(any(b["type"] == "image" for b in content))
        text = content[-1]["text"]
        self.assertIn('<source file="lib_x/R_0603_1608Metric">', text)
        self.assertIn("1| (footprint", text)
        self.assertIn("<paired_items>", text)
        self.assertIn("<deterministic_findings>", text)
        self.assertGreater(dump["estimated_input_tokens"], 500)
        self.assert_contract(self.load())

    def test_llm_merge_with_fake_client(self):
        client = FakeClient(lambda params: fake_message(AI_REPLY))
        with mock.patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test"}):
            self.assertEqual(cr.run(self.args("--jobs", "1"), client_factory=lambda: client), 0)
        self.assertEqual(len(client.calls), 2)  # deleted item is not sent
        r = self.load()
        self.assert_contract(r)
        self.assertEqual(r["model"], "claude-fable-5-1")
        fp = r["items"]["footprint:Custom_Test:R_0603_1608Metric"]
        self.assertEqual(fp["verdict"], "fail")
        self.assertEqual(fp["summary"], AI_REPLY["summary"])
        self.assertEqual(fp["datasheet_used"], "datasheets/x.pdf")
        pad = next(f for f in fp["findings"] if f["category"] == "land-pattern")
        self.assertEqual(pad["line"], 20)
        self.assertEqual(pad["suggestion"], "Use 0.95 mm")
        outside = next(f for f in fp["findings"] if "outside the item" in f["message"])
        self.assertIsNone(outside["line"])
        self.assertIn("usage", r)
        self.assertGreater(r["usage"]["cost"], 0)
        # the model saw numbered repo lines for the symbol (symbol opens at file line 4)
        sym_call = next(c for c in client.calls if "AMP1" in c["messages"][0]["content"][-1]["text"]
                        and "Review the symbol" in c["messages"][0]["content"][-1]["text"])
        self.assertIn('4| \t(symbol "AMP1"', sym_call["messages"][0]["content"][-1]["text"])

    def test_refusal_and_bad_json(self):
        replies = iter([fake_message("", stop_reason="refusal"), fake_message("{not json")])
        client = FakeClient(lambda params: next(replies))
        with mock.patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test"}):
            self.assertEqual(cr.run(self.args("--jobs", "1"), client_factory=lambda: client), 0)
        r = self.load()
        self.assert_contract(r)
        notes = [f["message"] for e in r["items"].values() for f in e["findings"] if "AI review unavailable" in f["message"]]
        self.assertEqual(len(notes), 2, notes)

    def test_api_errors_are_per_item(self):
        import anthropic
        import httpx2

        def boom(params):
            req = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
            raise anthropic.InternalServerError("overloaded", response=httpx2.Response(529, request=req), body=None)

        client = FakeClient(boom)
        with mock.patch.dict(os.environ, {"ANTHROPIC_API_KEY": "test"}):
            self.assertEqual(cr.run(self.args(), client_factory=lambda: client), 0)
        self.assert_contract(self.load())

    def test_manifest_missing(self):
        os.remove(os.path.join(self.out, "manifest.json"))
        self.assertEqual(cr.run(self.args("--no-llm")), 2)


@unittest.skipUnless(_have_git_range(), "needs origin/main in the repo")
class RepoMockOutTests(unittest.TestCase):
    """Runs against the real PR files of the demo branch (origin/main..HEAD)."""

    def test_repo_mock_out(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "out")
            m = make_mock_out.build(REPO, "origin/main", "HEAD", out)
            if not m["items"]:
                self.skipTest("no KiCad items changed in origin/main..HEAD")
            self.assertEqual(cr.run(cr.parse_args(["--out", out, "--no-llm", "--repo", REPO])), 0)
            with open(os.path.join(out, "review.json")) as f:
                review = json.load(f)
            self.assertEqual(set(review["items"]), {i["id"] for i in m["items"]})


try:  # the SDK is only needed for the tests that exercise the API-call path
    import anthropic  # noqa: F401
except ImportError:
    for _t in ("test_api_errors_are_per_item", "test_llm_merge_with_fake_client", "test_refusal_and_bad_json"):
        setattr(EndToEndTests, _t, unittest.skip("anthropic not installed")(getattr(EndToEndTests, _t)))


if __name__ == "__main__":
    unittest.main()
