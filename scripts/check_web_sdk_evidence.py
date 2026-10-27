#!/usr/bin/env python3
import argparse
import base64
import hashlib
import html
from html.parser import HTMLParser
import json
import math
from pathlib import Path
import re
import struct

from verify_miniprogram_device_evidence import decode_png, image_difference


EXPECTED_CAPTURES = [
    "initial_world",
    "beijing_top",
    "beijing_zoom",
    "beijing_tilt_45",
    "beijing_heading_30",
    "beijing_north_45",
    "beijing_top_north",
    "reset_world",
    "context_restored",
]

MAX_RESET_MEAN_DIFFERENCE = 8.0


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


def validate_canvas_presentation(item):
    presentation = item.get("canvasPresentation", {})
    phases = presentation.get("phases", [])
    if (presentation.get("schema") != "terra.canvas-presentation.v1"
            or [phase.get("phase") for phase in phases] != ["preparation", "motion", "settlement", "complete"]):
        raise SystemExit("Navigation canvas presentation phases are missing or incomplete")
    viewport = item.get("viewport", {})
    sizes = {"cssWidth": "cssWidth", "cssHeight": "cssHeight", "bufferWidth": "physicalWidth",
             "bufferHeight": "physicalHeight", "devicePixelRatio": "devicePixelRatio"}
    finite = lambda value: isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
    for phase in phases:
        if (phase.get("connected") is not True or phase.get("sampledUnobscured") is not True
                or phase.get("documentVisibility") != "visible"):
            raise SystemExit("Navigation canvas was detached, hidden or obscured")
        if any(not finite(phase.get(key)) or not finite(viewport.get(source))
               or phase[key] <= 0 or abs(phase[key] - viewport[source]) >= 0.01 for key, source in sizes.items()):
            raise SystemExit("Navigation canvas presentation differs from the SDK viewport")
        if (any(not finite(phase.get(key)) for key in ("left", "top", "windowWidth", "windowHeight", "displayDevicePixelRatio"))
                or phase["left"] < 0 or phase["top"] < 0 or phase["displayDevicePixelRatio"] <= 0
                or phase["left"] + phase["cssWidth"] > phase["windowWidth"]
                or phase["top"] + phase["cssHeight"] > phase["windowHeight"]):
            raise SystemExit("Navigation canvas was outside the presented viewport")


def validate_memory_replay(replay):
    samples = replay.get("samples", [])
    if replay.get("warmupLaps") != 1 or replay.get("viewsPerLap") != 8 or len(samples) != 24:
        raise SystemExit("Memory replay requires one fixed warmup and two measured eight-view laps")
    native_keys = ("nativeMeshBytes", "decodedRecordBytes", "heightBytes", "imageryInputBytes",
                   "imageryReferenceBytes", "imageryOutputBytes")
    for index, sample in enumerate(samples):
        if (sample.get("lap") != index // 8 or sample.get("view") != index % 8
                or sample.get("warmup") is not (index < 8)):
            raise SystemExit("Memory replay sample sequence differs")
        memory = sample.get("memoryBytes")
        if (not isinstance(memory, int) or isinstance(memory, bool) or memory <= 0
                or not isinstance(sample.get("meshIdentity"), str) or not sample["meshIdentity"]):
            raise SystemExit("Memory replay allocation or immutable mesh identity is missing")
        ownership = sample.get("ownership", {})
        if any(type(ownership.get(key)) is not int or ownership[key] < 0 for key in
               ("nativeMeshBytes", "decodedRecordBytes", "heightBytes", "topologyNodes",
                "imageryInputBytes", "imageryReferenceBytes", "imageryOutputBytes",
                "measurementHistoryBytes", "nativeModels")):
            raise SystemExit("Memory replay native ownership snapshot is missing or invalid")
        capacity = sample.get("capacity", {})
        if (any(type(capacity.get(key)) is not int or capacity[key] < 0 for key in
                ("bytes", "maximumBytes", "highWaterBytes", "reservedBytes", "residentBytes", "retiredBytes")) or
            capacity["maximumBytes"] <= 0 or
            capacity["bytes"] != sum(capacity[key] for key in ("reservedBytes", "residentBytes", "retiredBytes")) or
            not capacity["bytes"] <= capacity["highWaterBytes"] <= capacity["maximumBytes"]):
            raise SystemExit("Memory replay owned phases exceed capacity or disagree with the ledger")
        native = capacity.get("native", {})
        if (any(type(native.get(key)) is not int or native[key] != ownership[key] for key in native_keys) or
            sum(native[key] for key in native_keys) > capacity["residentBytes"]):
            raise SystemExit("Memory replay Native payload differs from resident credit")
        if index and (capacity["maximumBytes"] != samples[index-1]["capacity"]["maximumBytes"] or
                      capacity["highWaterBytes"] < samples[index-1]["capacity"]["highWaterBytes"] or
                      memory < samples[index-1]["memoryBytes"]):
            raise SystemExit("Memory replay reset its budget or allocation history")
        work = sample.get("work", {})
        if (work.get("worldPreparing") is not False or work.get("pendingRender") is not False
                or any(type(work.get(key)) is not int or work[key] != 0 for key in
                       ("worldMaintenance", "pendingWork", "pendingAnimations", "pendingInputs", "nativeRequests"))):
            raise SystemExit("Memory replay sampled before available-cut background work drained")
    first, second = samples[8:16], samples[16:24]
    if any(a["meshIdentity"] != b["meshIdentity"] for a, b in zip(first, second)):
        raise SystemExit("Memory replay measured different immutable mesh sets")
    refund = replay.get("nativeReclamation", {})
    required = refund.get("required", {})
    if (any(type(required.get(key)) is not int or required[key] <= 0 for key in
            ("drawCount", "meshCount", "uvCount", "positionBytes", "uvBytes")) or
        required["uvCount"] > required["meshCount"] or required["meshCount"] > required["drawCount"]):
        raise SystemExit("Native reclamation required payload is missing or invalid")
    if (any(type(refund.get(key)) is not int or refund[key] <= 0 for key in
            ("beforeBytes", "releasedBytes", "afterBytes", "ledgerBytes", "beforeSequence", "afterSequence")) or
        refund["beforeBytes"] - refund["releasedBytes"] != refund["afterBytes"] or
        refund["afterBytes"] != required["positionBytes"] + required["uvBytes"] or
        refund["ledgerBytes"] != refund["afterBytes"]):
        raise SystemExit("Native reclamation did not refund exactly the idle cache")
    pixels = refund.get("pixelsBefore", {})
    if (refund["beforeSequence"] != refund["afterSequence"] or
        refund.get("beforeIdentity") != samples[-1]["meshIdentity"] or
        refund.get("afterIdentity") != refund["beforeIdentity"] or
        any(type(pixels.get(key)) is not int or pixels[key] < 0 for key in
            ("width", "height", "fnv1a32", "nonBackgroundPixels", "sampledColorCount")) or
        pixels["nonBackgroundPixels"] <= 10000 or pixels["sampledColorCount"] < 3 or
        pixels["width"] * pixels["height"] < pixels["nonBackgroundPixels"] or
        refund.get("pixelsAfter") != pixels):
        raise SystemExit("Native reclamation changed the presented cut or actual pixels")
    first_max = max(sample["memoryBytes"] for sample in first)
    second_max = max(sample["memoryBytes"] for sample in second)
    expected_heap = {"firstMaximumBytes": first_max, "secondMaximumBytes": second_max,
                     "growthBytes": second_max-first_max, "plateau": second_max <= first_max}
    if replay.get("heapCapacity") != expected_heap:
        raise SystemExit("Memory replay omitted or misreported Wasm allocation growth")


def validate_network_navigation(network, execution, faults):
    if network.get("schema") != "terra.network-navigation.v1" or not network.get("passed"):
        raise SystemExit("Network navigation evidence is missing or failed")
    scenarios = network.get("scenarios", [])
    if [item.get("scenario") for item in scenarios] != ["flight", "oblique", "roam"]:
        raise SystemExit("Network navigation scenario set is incomplete")
    for item in scenarios:
        validate_canvas_presentation(item)
        settlement = item.get("settlement", {})
        quality = settlement.get("final", {}).get("quality", {})
        outcome = item.get("networkOutcome")
        target = (outcome == "target-met" and settlement.get("status") == "stable"
                  and quality.get("targetMet"))
        if (not item.get("samples") or item.get("blankSamples") != 0
                or item.get("missingSamples") != 0 or item.get("terrainMeshChangeCount", 0) <= 0
                or not target):
            raise SystemExit("Network navigation did not preserve coverage, progress and convergence")
    if network.get("execution") != execution or network.get("faults") is not faults:
        raise SystemExit("Navigation execution adapter or network profile differs")
    if network.get("releasedResourceBytes") != 0:
        raise SystemExit("Navigation retained managed resources after destruction")
    traffic = network.get("traffic", {})
    if not faults and (traffic.get("transient503") != 0 or traffic.get("bodyBytes", 0) <= 0):
        raise SystemExit("Navigation without injected faults did not deliver clean imagery")
    if faults and (traffic.get("terrain503", 0) < 8 or traffic.get("terrainRetrySuccess", 0) < 8
            or any(traffic.get(key, 0) <= 0 for key in
                   ("imagery503", "imageryRetrySuccess", "reordered", "bodyChunks", "bodyBytes"))
            or network.get("imageBytes", 0) <= 4096):
        raise SystemExit("Network replay did not exercise retries, disorder and streamed decoding")
    if network.get("terrain", {}).get("missingKeys") != []:
        raise SystemExit("Network replay requested uncaptured terrain")
    for receipt in ("afterDestroy", "finalTraffic"):
        state = network.get(receipt, {})
        if any(state.get(key) != 0 for key in ("active", "timers", "activeTerrain", "activeImagery")):
            raise SystemExit("Network replay retained jobs at " + receipt)
    if network["afterDestroy"].get("cancelled", 0) <= traffic.get("cancelled", 0):
        raise SystemExit("SDK destruction did not cancel the live source-change probe")


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

    validate_memory_replay(report.get("memoryReplay", {}))

    navigation = report.get("navigationScenarios", [])
    if [item.get("scenario") for item in navigation] != ["flight", "oblique", "roam"]:
        raise SystemExit("Presented navigation scenario set is incomplete")
    for item in navigation:
        validate_canvas_presentation(item)
    validate_network_navigation(report.get("networkNavigation", {}), "worker", True)
    validate_network_navigation(report.get("localNavigation", {}), "direct", True)
    validate_network_navigation(report.get("localNavigationNoFaults", {}), "direct", False)

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
        terrain_draws = capture_by_name[name].get("state", {}).get(
            "frame", {}
        ).get("drawCount", 0)
        minimum_non_background = max(100, terrain_draws * 100)
        if frame.get("nonBackgroundPixels", 0) <= minimum_non_background:
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

    initial = camera(capture_by_name, "initial_world")
    focus = camera(capture_by_name, "beijing_top")
    zoom = camera(capture_by_name, "beijing_zoom")
    tilt = camera(capture_by_name, "beijing_tilt_45")
    yaw = camera(capture_by_name, "beijing_heading_30")
    north = camera(capture_by_name, "beijing_north_45")
    top = camera(capture_by_name, "beijing_top_north")
    reset = camera(capture_by_name, "reset_world")
    for item in (initial, focus, zoom, tilt, yaw, north, top, reset):
        if not (
            close(item["longitudeDegrees"], 116.4074, 1e-12)
            and close(item["latitudeDegrees"], 39.9042, 1e-12)
        ):
            raise SystemExit("A globe capture does not target Beijing")
    if not focus["distance"] < initial["distance"]:
        raise SystemExit("Beijing focus did not reduce camera distance")
    if not zoom["distance"] < focus["distance"]:
        raise SystemExit("Zoom capture did not reduce camera distance")
    if not close(tilt["tiltRadians"], -3.141592653589793 / 4, 1e-12):
        raise SystemExit("Tilt capture is not -45 degrees")
    if not close(yaw["yawRadians"], 3.141592653589793 / 6, 1e-12):
        raise SystemExit("Heading capture is not 30 degrees")
    if not close(north["yawRadians"], 0, 1e-12):
        raise SystemExit("North-up capture has a nonzero heading")
    if not close(top["tiltRadians"], 0, 1e-12):
        raise SystemExit("Top-down capture has a nonzero pitch")
    if not (
        close(reset["distance"], initial["distance"], 1e-9)
        and close(reset["tiltRadians"], initial["tiltRadians"], 1e-12)
        and close(reset["yawRadians"], initial["yawRadians"], 1e-12)
    ):
        raise SystemExit("Reset camera does not match initial camera")
    if not report.get("retry", {}).get("scheduled"):
        raise SystemExit("Transient terrain retry was not scheduled")
    if not report.get("retry", {}).get("recovered"):
        raise SystemExit("Transient terrain retry did not recover")

    for first, second in (
        ("initial_world", "beijing_top"),
        ("beijing_top", "beijing_zoom"),
        ("beijing_zoom", "beijing_tilt_45"),
        ("beijing_tilt_45", "beijing_heading_30"),
        ("beijing_heading_30", "beijing_north_45"),
        ("beijing_north_45", "beijing_top_north"),
    ):
        if image_difference(decoded_images[first], decoded_images[second]) <= 0.1:
            raise SystemExit("{} and {} PNGs are unexpectedly similar".format(
                first, second
            ))
    reset_difference = image_difference(
        decoded_images["initial_world"], decoded_images["reset_world"]
    )
    # Terrain can refine between the first view and reset; compare the overall
    # image while the state checks above enforce exact camera equivalence.
    if reset_difference > MAX_RESET_MEAN_DIFFERENCE:
        raise SystemExit(
            "Reset PNG differs from the initial view by {:.3f}/255".format(
                reset_difference
            )
        )
    if image_difference(decoded_images["reset_world"],
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
