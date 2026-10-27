#!/usr/bin/env python3
import argparse
import base64
import hashlib
import html
from html.parser import HTMLParser
import json
from pathlib import Path
import struct

from verify_miniprogram_device_evidence import decode_png, image_difference


EXPECTED_CAPTURES = [
    "initial_45_texture",
    "bird_texture",
    "bird_zoom_texture",
    "tilt_45_height",
    "reset_texture",
]


class EvidenceParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.in_result = False
        self.result_parts = []
        self.images = {}

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag == "pre" and values.get("id") == "automation-result":
            self.in_result = True
        if tag == "img" and values.get("data-capture"):
            self.images[values["data-capture"]] = values.get("src", "")

    def handle_endtag(self, tag):
        if tag == "pre" and self.in_result:
            self.in_result = False

    def handle_data(self, data):
        if self.in_result:
            self.result_parts.append(data)


def png_dimensions(payload):
    if not payload.startswith(b"\x89PNG\r\n\x1a\n") or len(payload) < 24:
        raise ValueError("capture is not a valid PNG")
    return struct.unpack(">II", payload[16:24])


def close(left, right, tolerance):
    return abs(float(left) - float(right)) <= tolerance


def make_report_html(report, images):
    captures = {item["name"]: item for item in report["captures"]}
    figures = []
    for name in EXPECTED_CAPTURES:
        frame = captures[name]["framebuffer"]
        figures.append(
            '<figure><img alt="{} planar capture" src="{}">'
            '<figcaption><span>{}</span><span>fnv1a32 {}</span>'
            '</figcaption></figure>'.format(
                html.escape(name), html.escape(images[name], quote=True),
                html.escape(name), frame["fnv1a32"]
            )
        )
    summary = html.escape(json.dumps(report, indent=2, sort_keys=True))
    template = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Terra PS 1k Planar Evidence</title><style>
body{margin:0;background:#101418;color:#e8edf2;font-family:Segoe UI,Arial,sans-serif}
header{padding:20px 28px;border-bottom:1px solid #35404a;background:#182027}
h1{margin:0;font-size:20px;letter-spacing:0}.status{color:#72d49b;margin-top:6px;font-size:14px}
main{padding:24px 28px}.captures{display:grid;grid-template-columns:repeat(3,minmax(280px,1fr));gap:16px}
figure{margin:0;border:1px solid #35404a;border-radius:6px;overflow:hidden;background:#182027}
img{display:block;width:100%;aspect-ratio:16/9;object-fit:contain}
figcaption{display:flex;justify-content:space-between;padding:10px 12px;color:#bac6d0;font-size:13px}
pre{margin-top:20px;padding:16px;border-top:1px solid #35404a;color:#bac6d0;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.55 Consolas,monospace}
</style></head><body><header><h1>Terra PS 1k Planar Evidence</h1>
<div class="status">Automated evidence passed</div></header><main>
<section class="captures">FIGURES</section><pre>SUMMARY</pre></main></body></html>"""
    return template.replace("FIGURES", "".join(figures)).replace(
        "SUMMARY", summary
    )


def main():
    parser = argparse.ArgumentParser(
        description="Validate Terra PS 1k planar browser evidence"
    )
    parser.add_argument("dom", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    raw_dom = args.dom.read_text(encoding="utf-8")
    parsed = EvidenceParser()
    parsed.feed(raw_dom)
    if not parsed.result_parts:
        raise SystemExit("Planar evidence JSON is missing from browser DOM")
    report = json.loads("".join(parsed.result_parts))
    if report.get("schema") != "terra.web-sdk.planar-evidence.v1":
        raise SystemExit("Unexpected planar evidence schema")
    if not report.get("passed"):
        failed = [item for item in report.get("checks", [])
                  if not item.get("passed")]
        raise SystemExit("Planar Web harness failed: {}".format(failed))
    if not report.get("checks") or not all(
            item.get("passed") for item in report["checks"]):
        raise SystemExit("Planar report has a failed or empty check set")

    capture_items = report.get("captures", [])
    capture_names = [item.get("name") for item in capture_items]
    if capture_names != EXPECTED_CAPTURES:
        raise SystemExit("Unexpected planar captures: {}".format(capture_names))
    if sorted(parsed.images) != sorted(EXPECTED_CAPTURES):
        raise SystemExit("Browser DOM has an incomplete planar capture set")

    args.output.mkdir(parents=True, exist_ok=True)
    capture_by_name = {item["name"]: item for item in capture_items}
    decoded_images = {}
    summary_files = []
    for name in EXPECTED_CAPTURES:
        source = parsed.images[name]
        prefix = "data:image/png;base64,"
        if not source.startswith(prefix):
            raise SystemExit("{} is not an embedded PNG".format(name))
        payload = base64.b64decode(source[len(prefix):], validate=True)
        if png_dimensions(payload) != (640, 360):
            raise SystemExit("{} does not have 640x360 dimensions".format(name))
        framebuffer = capture_by_name[name]["framebuffer"]
        if framebuffer.get("nonBackgroundPixels", 0) <= 500:
            raise SystemExit("{} appears blank".format(name))
        path = args.output / (name + ".png")
        path.write_bytes(payload)
        decoded = decode_png(path)
        if decoded["unique"] < 3:
            raise SystemExit("{} has insufficient pixel variation".format(name))
        if name == "tilt_45_height" and decoded["unique"] < 16:
            raise SystemExit("height capture has insufficient elevation colors")
        decoded_images[name] = decoded
        summary_files.append({
            "name": path.name,
            "bytes": len(payload),
            "sha256": hashlib.sha256(payload).hexdigest(),
        })

    initial = capture_by_name["initial_45_texture"]["state"]
    bird = capture_by_name["bird_texture"]["state"]
    zoom = capture_by_name["bird_zoom_texture"]["state"]
    height = capture_by_name["tilt_45_height"]["state"]
    reset = capture_by_name["reset_texture"]["state"]
    for state in (initial, bird, zoom, height, reset):
        frame = state["frame"]
        if frame["drawCount"] != 4 or frame["vertexCount"] != 8580:
            raise SystemExit("Planar draw or vertex count changed")
    if not close(bird["camera"]["tiltRadians"], 0, 1e-12):
        raise SystemExit("Bird capture is not top-down")
    if not zoom["camera"]["distance"] < bird["camera"]["distance"]:
        raise SystemExit("Planar zoom did not reduce camera distance")
    if height.get("renderMode") != "height" or not close(
            height["camera"]["tiltRadians"], -3.141592653589793 / 4, 1e-12):
        raise SystemExit("Height capture is not the fixed -45 degree view")
    if not (close(reset["camera"]["distance"],
                  initial["camera"]["distance"], 1e-9)
            and close(reset["camera"]["tiltRadians"],
                      initial["camera"]["tiltRadians"], 1e-12)):
        raise SystemExit("Planar reset camera does not match initial camera")

    pairs = [
        ("initial_45_texture", "bird_texture"),
        ("bird_texture", "bird_zoom_texture"),
        ("bird_zoom_texture", "tilt_45_height"),
    ]
    for first, second in pairs:
        if image_difference(decoded_images[first], decoded_images[second]) <= 0.1:
            raise SystemExit("{} and {} are too similar".format(first, second))
    if image_difference(decoded_images["initial_45_texture"],
                        decoded_images["reset_texture"]) > 0.1:
        raise SystemExit("Planar reset image does not match initial image")

    (args.output / "report.json").write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    (args.output / "summary.json").write_text(
        json.dumps({
            "schema": "terra.web-sdk.planar-summary.v1",
            "passed": True,
            "captures": summary_files,
            "report": "report.html",
        }, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    (args.output / "report.html").write_text(
        make_report_html(report, parsed.images), encoding="utf-8"
    )
    print("Planar Web evidence passed: {}".format(
        args.output / "report.html"))


if __name__ == "__main__":
    main()
