#!/usr/bin/env python3
import argparse
import base64
import hashlib
import html
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import struct

from verify_miniprogram_device_evidence import decode_png, image_difference


EXPECTED_CAPTURES = [
    "initial",
    "zoom",
    "tilt_45",
    "yaw_30",
    "reset",
    "context_restored",
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
    signature = b"\x89PNG\r\n\x1a\n"
    if not payload.startswith(signature) or len(payload) < 24:
        raise ValueError("capture is not a valid PNG")
    return struct.unpack(">II", payload[16:24])


def camera(captures, name):
    return captures[name]["state"]["camera"]


def close(left, right, tolerance):
    return abs(float(left) - float(right)) <= tolerance


def make_report_html(report, images):
    figures = []
    capture_by_name = {item["name"]: item for item in report["captures"]}
    for name in EXPECTED_CAPTURES:
        frame = capture_by_name[name]["framebuffer"]
        figures.append(
            "<figure><img alt=\"{} Terra globe capture\" src=\"{}\">"
            "<figcaption><span>{}</span><span>fnv1a32 {}</span>"
            "</figcaption></figure>".format(
                html.escape(name),
                html.escape(images[name], quote=True),
                html.escape(name),
                frame["fnv1a32"],
            )
        )
    summary = html.escape(json.dumps(report, indent=2, sort_keys=True))
    template = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Terra Web SDK Evidence Report</title>
<style>
body{margin:0;background:#101418;color:#e8edf2;font-family:Segoe UI,Arial,sans-serif}
header{padding:20px 28px;border-bottom:1px solid #35404a;background:#182027}
h1{margin:0;font-size:20px;letter-spacing:0}main{padding:24px 28px}
.status{color:#72d49b;margin-top:6px;font-size:14px}
.captures{display:grid;grid-template-columns:repeat(3,minmax(280px,1fr));gap:16px}
figure{margin:0;border:1px solid #35404a;border-radius:6px;overflow:hidden;background:#182027}
img{display:block;width:100%;aspect-ratio:16/9;object-fit:contain}
figcaption{display:flex;justify-content:space-between;padding:10px 12px;color:#bac6d0;font-size:13px}
pre{margin-top:20px;padding:16px;border-top:1px solid #35404a;color:#bac6d0;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.55 Consolas,monospace}
</style></head><body><header><h1>Terra Web SDK Evidence</h1>
<div class="status">Automated evidence passed</div></header><main>
<section class="captures">CAPTURE_FIGURES</section><pre>REPORT_SUMMARY</pre></main></body></html>
"""
    return template.replace("CAPTURE_FIGURES", "".join(figures)).replace(
        "REPORT_SUMMARY", summary
    )


def main():
    parser = argparse.ArgumentParser(
        description="Validate and materialize Terra Web SDK browser evidence"
    )
    parser.add_argument("dom", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    raw_dom = args.dom.read_text(encoding="utf-8")
    parsed = EvidenceParser()
    parsed.feed(raw_dom)
    if not parsed.result_parts:
        raise SystemExit("Web SDK evidence JSON is missing from browser DOM")
    report = json.loads("".join(parsed.result_parts))
    if report.get("schema") != "terra.web-sdk.evidence.v1":
        raise SystemExit("Unexpected Web SDK evidence schema")
    if not report.get("passed"):
        failed = [item for item in report.get("checks", []) if not item.get("passed")]
        raise SystemExit("Web SDK harness failed: {}".format(failed))
    if not report.get("checks") or not all(
        item.get("passed") for item in report["checks"]
    ):
        raise SystemExit("Web SDK report contains a failed or empty check set")

    capture_items = report.get("captures", [])
    capture_names = [item.get("name") for item in capture_items]
    if capture_names != EXPECTED_CAPTURES:
        raise SystemExit("Unexpected capture sequence: {}".format(capture_names))
    if sorted(parsed.images) != sorted(EXPECTED_CAPTURES):
        raise SystemExit("Browser DOM does not contain the complete capture set")

    args.output.mkdir(parents=True, exist_ok=True)
    capture_by_name = {item["name"]: item for item in capture_items}
    summary_files = []
    decoded_images = {}
    for name in EXPECTED_CAPTURES:
        source = parsed.images[name]
        prefix = "data:image/png;base64,"
        if not source.startswith(prefix):
            raise SystemExit("{} is not an embedded PNG".format(name))
        payload = base64.b64decode(source[len(prefix):], validate=True)
        width, height = png_dimensions(payload)
        frame = capture_by_name[name]["framebuffer"]
        if (width, height) != (640, 360):
            raise SystemExit("{} has unexpected dimensions {}x{}".format(
                name, width, height
            ))
        if frame.get("nonBackgroundPixels", 0) <= 500:
            raise SystemExit("{} appears blank".format(name))
        path = args.output / (name + ".png")
        path.write_bytes(payload)
        decoded = decode_png(path)
        if decoded["unique"] < 3:
            raise SystemExit("{} PNG has insufficient pixel variation".format(name))
        decoded_images[name] = decoded
        summary_files.append({
            "name": path.name,
            "bytes": len(payload),
            "sha256": hashlib.sha256(payload).hexdigest(),
        })

    initial = camera(capture_by_name, "initial")
    zoom = camera(capture_by_name, "zoom")
    tilt = camera(capture_by_name, "tilt_45")
    yaw = camera(capture_by_name, "yaw_30")
    reset = camera(capture_by_name, "reset")
    if not zoom["distance"] < initial["distance"]:
        raise SystemExit("Zoom capture did not reduce camera distance")
    if not close(tilt["tiltRadians"], -3.141592653589793 / 4, 1e-12):
        raise SystemExit("Tilt capture is not -45 degrees")
    if not close(yaw["yawRadians"], 3.141592653589793 / 6, 1e-12):
        raise SystemExit("Yaw capture is not 30 degrees")
    if not (
        close(reset["distance"], initial["distance"], 1e-9)
        and close(reset["tiltRadians"], initial["tiltRadians"], 1e-12)
        and close(reset["yawRadians"], initial["yawRadians"], 1e-12)
    ):
        raise SystemExit("Reset camera does not match initial camera")
    if not report.get("retry", {}).get("recovered"):
        raise SystemExit("Transient terrain retry did not recover")

    for first, second in (("initial", "zoom"), ("zoom", "tilt_45"),
                          ("tilt_45", "yaw_30")):
        if image_difference(decoded_images[first], decoded_images[second]) <= 0.1:
            raise SystemExit("{} and {} PNGs are unexpectedly similar".format(
                first, second
            ))
    if image_difference(decoded_images["initial"], decoded_images["reset"]) > 0.1:
        raise SystemExit("Reset PNG does not match the initial view")
    if image_difference(decoded_images["reset"],
                        decoded_images["context_restored"]) > 0.1:
        raise SystemExit("Context-restored PNG does not match reset")

    sensitive = re.compile(r"(?:^|[?&])(?:tk|token|key)=[^&\s]+", re.IGNORECASE)
    if sensitive.search(raw_dom):
        raise SystemExit("Browser evidence contains a credential-like query value")

    (args.output / "report.json").write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    (args.output / "summary.json").write_text(
        json.dumps({
            "schema": "terra.web-sdk.summary.v1",
            "passed": True,
            "captures": summary_files,
            "report": "report.html",
        }, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    (args.output / "report.html").write_text(
        make_report_html(report, parsed.images), encoding="utf-8"
    )
    print("Web SDK evidence passed: {}".format(args.output / "report.html"))


if __name__ == "__main__":
    main()
