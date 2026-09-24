#!/usr/bin/env python3
"""Write a small contract-conformant site dir (manifest.json, review.json, PNG/SVG renders)
modelled on PR #8, plus a PR-files JSON, for testing the CI scripts without the real tools.

Usage: make_mock.py OUT_DIR   (writes OUT_DIR/site/ and OUT_DIR/pr_files.json)
"""
import json
import re
import struct
import sys
import zlib
from pathlib import Path


def png(path: Path, rgb) -> None:
    w = h = 8
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
                     + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def slugify(kind, lib, name):
    return re.sub(r"[^A-Za-z0-9._-]", "_", f"{kind}__{lib}__{name}")


ITEMS = [
    ("footprint", "Custom_Buzzer_Beeper", "MagneticBuzzer_9.6mm_5mm_right-angle", "added",
     "lib_fp/Custom_Buzzer_Beeper.pretty/MagneticBuzzer_9.6mm_5mm_right-angle.kicad_mod", [1, 223]),
    ("footprint", "Custom_Button_Switch_SMD", "SW_SPST_Same-Sky_TS32_with-boss", "added",
     "lib_fp/Custom_Button_Switch_SMD.pretty/SW_SPST_Same-Sky_TS32_with-boss.kicad_mod", [1, 307]),
    ("footprint", "Custom_Connector_Card", "microSD_SHOU-HAN_TF-PUSH", "added",
     "lib_fp/Custom_Connector_Card.pretty/microSD_SHOU-HAN_TF-PUSH.kicad_mod", [1, 461]),
    ("footprint", "Custom_Package_SO", "SOIC-8-1EP_3.9x4.9mm_P1.27mm_EP2.41x3.3mm", "added",
     "lib_fp/Custom_Package_SO.pretty/SOIC-8-1EP_3.9x4.9mm_P1.27mm_EP2.41x3.3mm.kicad_mod", [1, 385]),
    ("symbol", "Custom_Audio", "NS4168", "added", "lib_sch/Custom_Audio.kicad_sym", [5, 180]),
    ("footprint", "Custom_Module", "SH1421", "modified",
     "lib_fp/Custom_Module.pretty/SH1421.kicad_mod", [1, 140]),
]

REVIEW = {
    "footprint:Custom_Buzzer_Beeper:MagneticBuzzer_9.6mm_5mm_right-angle": ("warn", [
        ("warning", "silkscreen", "Pin 1 marker is under the buzzer body outline and will be hidden once placed.", 196, "Move the pin-1 dot outside the courtyard edge."),
        ("info", "3d-model", "3D model offset looks correct (checked against datasheet drawing).", None, None)]),
    "footprint:Custom_Button_Switch_SMD:SW_SPST_Same-Sky_TS32_with-boss": ("pass", []),
    "footprint:Custom_Connector_Card:microSD_SHOU-HAN_TF-PUSH": ("fail", [
        ("error", "land-pattern", "Card-detect pad `CD` is 0.8 mm wide; datasheet recommends **1.0 mm**.", 120, "Set pad size to (1.0 1.2)."),
        ("warning", "courtyard", "Courtyard clearance is 0.1 mm on the card-insertion side (KLC F5.3 asks for 0.25 mm).", 9999, None)]),
    "footprint:Custom_Package_SO:SOIC-8-1EP_3.9x4.9mm_P1.27mm_EP2.41x3.3mm": ("pass", [
        ("info", "klc", "Exposed pad has 6 thermal vias, OK.", None, None)]),
    "symbol:Custom_Audio:NS4168": ("warn", [
        ("warning", "pinout", "Pin 3 `CTRL` is typed `passive`; datasheet describes it as an input <script>alert(1)</script> @someone ![x](https://evil.example/x.png).", 130, None)]),
    "footprint:Custom_Module:SH1421": ("pass", [
        ("warning", "fab", "Modified pad on a line outside the diff: should go to the sticky comment only.", 3, None)]),
}


def main(out: Path) -> None:
    site = out / "site"
    items = []
    for kind, lib, name, status, path, rng in ITEMS:
        slug = slugify(kind, lib, name)
        renders = {}
        for side, colour in (("head", (40, 160, 60)), ("base", (160, 60, 40))):
            if (side == "base" and status == "added") or (side == "head" and status == "deleted"):
                renders[side] = None
                continue
            png(site / "items" / slug / f"{side}.png", colour)
            (site / "items" / slug / f"{side}.svg").write_text(
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>')
            renders[side] = {"svg": f"items/{slug}/{side}.svg", "png": f"items/{slug}/{side}.png", "layers": {}}
        diff = None
        if status == "modified":
            png(site / "items" / slug / "diff.png", (200, 200, 60))
            diff = f"items/{slug}/diff.png"
        items.append({
            "id": f"{kind}:{lib}:{name}", "slug": slug, "kind": kind, "library": lib, "name": name,
            "status": status, "path": path,
            "line_range": {"head": rng, "base": rng if status == "modified" else None},
            "properties": {"head": {"Reference": "U", "Value": name}, "base": None},
            "datasheet": {"url": "https://example.com/ds.pdf", "local": None},
            "model3d": [], "stats": {"head": {}, "base": {}}, "renders": renders, "diff_png": diff,
            "glb": {"head": None, "base": None}, "text_diff": None, "source": {"head": None, "base": None},
            "warnings": ["render: model file not found lib_3d/x.step"] if kind == "footprint" and status == "modified" else [],
        })
    manifest = {"schema": 1, "repo": "PantsForBirds/kicad-libs", "pr": 8,
                "base_sha": "c5c2cdf" + "0" * 33, "head_sha": "1627ad2136c15edddf09c6034d03ee3de04acf9b",
                "generated_at": "2026-09-24T00:00:00Z", "kicad_version": "10.0.0", "items": items}
    review = {"schema": 1, "generator": "deterministic checks + KLC", "generated_at": "2026-09-24T00:00:00Z",
              "summary_markdown": "Mock review: **1 fail**, 2 warn. The microSD card-detect pad needs attention.",
              "items": {},
              "pr_findings": [{"severity": "warning", "category": "3d-model", "path": "lib_3d/Custom_Module/SH1421-C.step",
                               "line": None, "message": "3D model file `lib_3d/Custom_Module/SH1421-C.step` is added/changed "
                               "in this PR but no footprint references it."}]}
    for iid, (verdict, fs) in REVIEW.items():
        path = next(i["path"] for i in items if i["id"] == iid)
        review["items"][iid] = {"verdict": verdict, "summary": f"Mock summary for {iid.split(':')[-1]}.",
                                "datasheet_used": None, "checks": [{"name": "Pin count matches datasheet", "result": "fail" if verdict == "fail" else "pass"}],
                                "findings": [{"severity": s, "category": c, "message": m, "path": path, "line": l,
                                              **({"suggestion": sg} if sg else {})} for s, c, m, l, sg in fs]}
    (site / "manifest.json").write_text(json.dumps(manifest, indent=1))
    (site / "review.json").write_text(json.dumps(review, indent=1))
    files = [{"filename": i["path"], "status": i["status"],
              "additions": i["line_range"]["head"][1] if i["status"] == "added" else 2,
              "patch": None if i["status"] == "added" and "Connector_Card" in i["path"] else
              (f"@@ -0,0 +1,{i['line_range']['head'][1]} @@\n" + "+x\n" * i["line_range"]["head"][1]
               if i["status"] == "added" else "@@ -10,4 +10,5 @@\n x\n-y\n+z\n+w\n x\n x\n")}
             for i in items]
    (out / "pr_files.json").write_text(json.dumps(files, indent=1))


if __name__ == "__main__":
    main(Path(sys.argv[1]))
