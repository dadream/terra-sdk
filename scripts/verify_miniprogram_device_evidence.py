#!/usr/bin/env python3
"""Validate local Mini Program device evidence without storing credentials."""

import argparse
import datetime as dt
import json
import math
import re
import struct
import sys
import tempfile
import zlib
from pathlib import Path


CAPABILITY_SCHEMA = "terra.miniprogram.capabilities.v1"
EVIDENCE_SCHEMA = "terra.miniprogram.device-evidence.v1"
METRICS_SCHEMA = "terra.miniprogram.performance.v1"
RUNTIME_SCHEMA = "terra.miniprogram.globe-runtime.v1"
THRESHOLDS_SCHEMA = "terra.miniprogram.reference-thresholds.v1"
TIANDITU_REVIEW_SCHEMA = "terra.miniprogram.tianditu-review.v1"

DEVICES = ("devtools", "android", "ios")
BLUE_MARBLE_ACTIONS = ("initial", "zoom", "tilt_45", "yaw", "reset")
REQUIRED_TIANDITU_DOMAINS = {
    "t{}.tianditu.gov.cn".format(index) for index in range(8)
}
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"

# Reports must never contain a credential property or a signed query value. The
# check intentionally reports only the file and pattern name, never the value.
CREDENTIAL_PATTERNS = (
    ("credential query", re.compile(
        rb"[?&](?:tk|token|access_token|api_key|apikey|secret)=[^&\s\"']+",
        re.IGNORECASE)),
    ("credential JSON property", re.compile(
        rb"[\"'](?:tk|token|access_token|api_key|apikey|secret)[\"']\s*:",
        re.IGNORECASE)),
    ("Tianditu credential storage key", re.compile(
        rb"tianditu[_-]?token", re.IGNORECASE)),
)
TEXT_SUFFIXES = {".json", ".log", ".md", ".txt"}


def is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and \
        math.isfinite(value)


def positive_number(value):
    return is_number(value) and value > 0


def parse_timestamp(value):
    if not isinstance(value, str) or not value:
        return False
    try:
        dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        return True
    except ValueError:
        return False


def parse_milestones(value):
    requested = []
    for item in value.split(","):
        milestone = item.strip().upper()
        if milestone and milestone not in requested:
            requested.append(milestone)
    allowed = {"M1", "M6", "M7"}
    invalid = [item for item in requested if item not in allowed]
    if invalid or not requested:
        raise ValueError("milestones must be a nonempty subset of M1,M6,M7")
    if "M7" in requested:
        return ("M1", "M6", "M7")
    if "M6" in requested:
        return ("M1", "M6")
    return ("M1",)


def load_json_file(path):
    with path.open("r", encoding="utf-8") as source:
        return json.load(source)


def write_json_file(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as target:
        json.dump(value, target, indent=2, sort_keys=True)
        target.write("\n")


def write_png(path, width, height, seed):
    """Write a small RGB PNG fixture for the verifier self-test."""

    rows = []
    for y in range(height):
        row = bytearray([0])
        for x in range(width):
            row.extend(((seed + x * 3) % 256, (seed + y * 5) % 256,
                        (seed + x + y) % 256))
        rows.append(bytes(row))

    def chunk(kind, payload):
        return (struct.pack(">I", len(payload)) + kind + payload +
                struct.pack(">I", zlib.crc32(kind + payload) & 0xffffffff))

    data = bytearray(PNG_SIGNATURE)
    data.extend(chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8,
                                             2, 0, 0, 0)))
    data.extend(chunk(b"IDAT", zlib.compress(b"".join(rows))))
    data.extend(chunk(b"IEND", b""))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def decode_png(path):
    """Return sampled RGB pixels from a standard 8-bit RGB/RGBA PNG."""

    data = path.read_bytes()
    if not data.startswith(PNG_SIGNATURE):
        raise ValueError("not a PNG file")

    position = len(PNG_SIGNATURE)
    width = height = bit_depth = color_type = interlace = None
    compressed = bytearray()
    while position < len(data):
        if position + 12 > len(data):
            raise ValueError("truncated PNG chunk")
        length = struct.unpack(">I", data[position:position + 4])[0]
        kind = data[position + 4:position + 8]
        end = position + 12 + length
        if end > len(data):
            raise ValueError("truncated PNG payload")
        payload = data[position + 8:position + 8 + length]
        expected_crc = struct.unpack(">I", data[position + 8 + length:end])[0]
        if zlib.crc32(kind + payload) & 0xffffffff != expected_crc:
            raise ValueError("invalid PNG CRC")
        position = end
        if kind == b"IHDR":
            if len(payload) != 13:
                raise ValueError("invalid PNG IHDR")
            width, height, bit_depth, color_type, _, _, interlace = \
                struct.unpack(">IIBBBBB", payload)
        elif kind == b"IDAT":
            compressed.extend(payload)
        elif kind == b"IEND":
            break

    if width is None or height is None:
        raise ValueError("missing PNG IHDR")
    if bit_depth != 8 or color_type not in (2, 6) or interlace != 0:
        raise ValueError("PNG must be non-interlaced 8-bit RGB or RGBA")
    if not compressed:
        raise ValueError("missing PNG image data")

    channels = 4 if color_type == 6 else 3
    stride = width * channels
    raw = zlib.decompress(bytes(compressed))
    expected_size = height * (stride + 1)
    if len(raw) != expected_size:
        raise ValueError("unexpected PNG scanline size")

    rows = []
    previous = bytearray(stride)
    offset = 0
    for _ in range(height):
        filter_type = raw[offset]
        offset += 1
        scanline = raw[offset:offset + stride]
        offset += stride
        reconstructed = bytearray(stride)
        for index, value in enumerate(scanline):
            left = reconstructed[index - channels] if index >= channels else 0
            up = previous[index]
            up_left = previous[index - channels] if index >= channels else 0
            if filter_type == 0:
                result = value
            elif filter_type == 1:
                result = (value + left) & 0xff
            elif filter_type == 2:
                result = (value + up) & 0xff
            elif filter_type == 3:
                result = (value + ((left + up) // 2)) & 0xff
            elif filter_type == 4:
                predictor = left + up - up_left
                left_distance = abs(predictor - left)
                up_distance = abs(predictor - up)
                up_left_distance = abs(predictor - up_left)
                base = left if left_distance <= up_distance and \
                    left_distance <= up_left_distance else \
                    up if up_distance <= up_left_distance else up_left
                result = (value + base) & 0xff
            else:
                raise ValueError("unsupported PNG filter")
            reconstructed[index] = result
        rows.append(reconstructed)
        previous = reconstructed

    total_pixels = width * height
    sample_stride = max(1, total_pixels // 10000)
    samples = []
    pixel_index = 0
    for row in rows:
        for index in range(0, len(row), channels):
            if pixel_index % sample_stride == 0:
                samples.append(tuple(row[index:index + 3]))
            pixel_index += 1
    unique = len(set(samples))
    mean = sum(sum(pixel) / 3.0 for pixel in samples) / max(1, len(samples))
    return {
        "width": width,
        "height": height,
        "unique": unique,
        "mean": mean,
        "samples": samples,
    }


def image_difference(first, second):
    if first["width"] != second["width"] or \
            first["height"] != second["height"]:
        return None
    sample_count = min(len(first["samples"]), len(second["samples"]))
    if sample_count == 0:
        return 0.0
    total = 0.0
    for index in range(sample_count):
        a = first["samples"][index]
        b = second["samples"][index]
        total += (abs(a[0] - b[0]) + abs(a[1] - b[1]) +
                  abs(a[2] - b[2])) / 3.0
    return total / sample_count


def camera_value(report, name):
    camera = report.get("camera") if isinstance(report, dict) else None
    value = camera.get(name) if isinstance(camera, dict) else None
    return value if is_number(value) else None


class EvidenceValidator:
    def __init__(self, evidence_dir, milestones):
        self.root = Path(evidence_dir).resolve()
        self.milestones = milestones
        self.summary = {
            "schema": "terra.miniprogram.device-evidence-summary.v1",
            "evidence_dir": str(self.root),
            "checked_milestones": list(milestones),
            "passed": True,
            "checks": [],
        }
        self.thresholds_checked = False
        self.thresholds = None

    def check(self, name, passed, detail, device=None):
        entry = {"name": name, "passed": bool(passed), "detail": detail}
        if device:
            entry["device"] = device
        self.summary["checks"].append(entry)
        if not passed:
            self.summary["passed"] = False
        return bool(passed)

    def path(self, relative_path):
        candidate = (self.root / relative_path).resolve()
        if candidate != self.root and self.root not in candidate.parents:
            raise ValueError("evidence path escapes the evidence directory")
        return candidate

    def load_json(self, relative_path, name, device=None):
        path = self.path(relative_path)
        if not path.is_file():
            self.check(name, False, "missing {}".format(relative_path), device)
            return None
        try:
            value = load_json_file(path)
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            self.check(name, False, "cannot parse {}: {}".format(
                relative_path, error), device)
            return None
        if not isinstance(value, dict):
            self.check(name, False, "{} must contain a JSON object".format(
                relative_path), device)
            return None
        return value

    def screenshot(self, relative_path, name, device):
        path = self.path(relative_path)
        if not path.is_file():
            self.check(name, False, "missing {}".format(relative_path), device)
            return None
        try:
            result = decode_png(path)
        except (OSError, ValueError, zlib.error) as error:
            self.check(name, False, "invalid {}: {}".format(
                relative_path, error), device)
            return None
        dimensions_ok = result["width"] >= 64 and result["height"] >= 64
        nonblank = result["unique"] > 1
        self.check(name, dimensions_ok and nonblank,
                   "{}x{}, {} sampled colors".format(result["width"],
                                                       result["height"],
                                                       result["unique"]), device)
        return result

    def check_timestamp(self, value, name, device=None):
        self.check(name, parse_timestamp(value), "capturedAt is an ISO timestamp",
                   device)

    def check_no_credentials(self):
        if not self.root.is_dir():
            self.check("credential scan", False, "evidence directory is missing")
            return
        findings = []
        for path in sorted(self.root.rglob("*")):
            if not path.is_file() or path.suffix.lower() not in TEXT_SUFFIXES:
                continue
            try:
                data = path.read_bytes()
            except OSError:
                findings.append((path, "unreadable evidence file"))
                continue
            for label, pattern in CREDENTIAL_PATTERNS:
                if pattern.search(data):
                    findings.append((path, label))
        for path, label in findings:
            self.check("credential scan", False,
                       "{} in {}".format(label, path.relative_to(self.root)))
        if not findings:
            self.check("credential scan", True,
                       "no credential properties or query values found")

    def check_manifest(self):
        manifest = self.load_json("manifest.json", "evidence manifest")
        if manifest is None:
            return
        self.check("evidence manifest schema",
                   manifest.get("schema") == EVIDENCE_SCHEMA,
                   "schema must be {}".format(EVIDENCE_SCHEMA))
        self.check_timestamp(manifest.get("capturedAt"),
                             "evidence manifest timestamp")
        self.check("evidence manifest reviewer",
                   isinstance(manifest.get("reviewer"), str) and
                   bool(manifest.get("reviewer").strip()),
                   "reviewer is recorded")
        devices = manifest.get("devices")
        self.check("evidence manifest devices",
                   isinstance(devices, list) and set(DEVICES).issubset(devices),
                   "devtools, android, and ios are declared")
        declared = manifest.get("milestones")
        self.check("evidence manifest milestones",
                   isinstance(declared, list) and
                   set(self.milestones).issubset(set(declared)),
                   "requested milestones are declared")

    def check_capability(self, device):
        report = self.load_json("{}/capabilities.json".format(device),
                                "capability report", device)
        image = self.screenshot("{}/probe.png".format(device),
                                "probe screenshot", device)
        if report is None:
            return
        self.check("capability schema", report.get("schema") == CAPABILITY_SCHEMA,
                   "schema must be {}".format(CAPABILITY_SCHEMA), device)
        self.check_timestamp(report.get("capturedAt"), "capability timestamp",
                             device)
        system = report.get("system")
        self.check("capability system", isinstance(system, dict),
                   "system information is present", device)
        platform = system.get("platform", "") if isinstance(system, dict) else ""
        if device in ("android", "ios"):
            self.check("capability platform", device in str(platform).lower(),
                       "reported platform is {}".format(device), device)

        webgl = report.get("webgl")
        self.check("WebGL result", isinstance(webgl, dict) and
                   webgl.get("passed") is True, "WebGL passed", device)
        if isinstance(webgl, dict):
            self.check("WebGL framebuffer", positive_number(
                (webgl.get("framebuffer") or {}).get("varyingSamples")),
                "framebuffer has varying samples", device)
            self.check("WebGL dimensions", positive_number(webgl.get("width")) and
                       positive_number(webgl.get("height")),
                       "WebGL framebuffer dimensions are positive", device)
            self.check("WebGL texture limit", positive_number(
                webgl.get("maxTextureSize")),
                "maximum texture size is positive", device)

        wasm = report.get("wasm")
        self.check("Wasm result", isinstance(wasm, dict) and
                   wasm.get("passed") is True and wasm.get("result") == 42,
                   "WXWebAssembly returned 42", device)
        network = report.get("network")
        self.check("HTTPS ArrayBuffer result", isinstance(network, dict) and
                   network.get("passed") is True and
                   positive_number(network.get("byteLength")),
                   "configured HTTPS ArrayBuffer request passed", device)
        if image is not None:
            self.check("probe screenshot dimensions", image["width"] >= 64 and
                       image["height"] >= 64, "probe screenshot is usable", device)

    def check_thresholds(self):
        if self.thresholds_checked:
            return self.thresholds
        self.thresholds_checked = True
        thresholds = self.load_json("thresholds.json", "reference thresholds")
        if thresholds is None:
            return None
        self.check("reference thresholds schema",
                   thresholds.get("schema") == THRESHOLDS_SCHEMA,
                   "schema must be {}".format(THRESHOLDS_SCHEMA))
        values = thresholds.get("devices")
        self.check("reference threshold devices", isinstance(values, dict) and
                   all(device in values for device in ("android", "ios")),
                   "android and ios thresholds are defined")
        if not isinstance(values, dict):
            return None
        for device in ("android", "ios"):
            threshold = values.get(device)
            self.check("{} frame threshold".format(device),
                       isinstance(threshold, dict) and positive_number(
                           threshold.get("max_p95_frame_time_ms")),
                       "maximum p95 frame time is positive", device)
            self.check("{} memory threshold".format(device),
                       isinstance(threshold, dict) and positive_number(
                           threshold.get("max_peak_memory_mb")),
                       "maximum peak memory is positive", device)
            self.check("{} stability threshold".format(device),
                       isinstance(threshold, dict) and positive_number(
                           threshold.get("min_stable_duration_seconds")),
                       "minimum stable duration is positive", device)
        self.thresholds = values
        return self.thresholds

    def check_metrics(self, device, thresholds):
        metrics = self.load_json("{}/metrics.json".format(device),
                                 "performance metrics", device)
        if metrics is None or not isinstance(thresholds, dict):
            return
        self.check("performance metrics schema",
                   metrics.get("schema") == METRICS_SCHEMA,
                   "schema must be {}".format(METRICS_SCHEMA), device)
        self.check_timestamp(metrics.get("capturedAt"), "performance timestamp",
                             device)
        self.check("performance method", isinstance(metrics.get("method"), str) and
                   bool(metrics.get("method").strip()),
                   "measurement method is recorded", device)
        scenario = (metrics.get("scenarios") or {}).get("blue_marble")
        threshold = thresholds.get(device) or {}
        frame_limit = threshold.get("max_p95_frame_time_ms")
        memory_limit = threshold.get("max_peak_memory_mb")
        stability_limit = threshold.get("min_stable_duration_seconds")
        self.check("Blue Marble p95 frame time", isinstance(scenario, dict) and
                   positive_number(scenario.get("p95_frame_time_ms")) and
                   positive_number(frame_limit) and
                   scenario.get("p95_frame_time_ms") <= frame_limit,
                   "p95 frame time is within the frozen threshold", device)
        self.check("Blue Marble peak memory", isinstance(scenario, dict) and
                   positive_number(scenario.get("peak_memory_mb")) and
                   positive_number(memory_limit) and
                   scenario.get("peak_memory_mb") <= memory_limit,
                   "peak memory is within the frozen threshold", device)
        self.check("Blue Marble stability", isinstance(scenario, dict) and
                   positive_number(scenario.get("stable_duration_seconds")) and
                   positive_number(stability_limit) and
                   scenario.get("stable_duration_seconds") >= stability_limit,
                   "stable duration meets the frozen threshold", device)

    def check_runtime_common(self, report, device, label, imagery_id):
        if report is None:
            return False
        self.check("{} schema".format(label), report.get("schema") == RUNTIME_SCHEMA,
                   "schema must be {}".format(RUNTIME_SCHEMA), device)
        self.check("{} imagery".format(label), report.get("imageryId") == imagery_id,
                   "imagery profile is {}".format(imagery_id), device)
        self.check("{} dataset".format(label), isinstance(report.get("datasetId"),
                   str) and bool(report.get("datasetId")),
                   "dataset ID is present", device)
        camera = report.get("camera")
        self.check("{} camera".format(label), isinstance(camera, dict) and
                   all(is_number(camera.get(value)) for value in
                       ("distance", "tiltRadians", "yawRadians")),
                   "camera state is finite", device)
        return True

    def check_success_runtime(self, device, directory, action, imagery_id):
        base = "{}/{}/{}".format(device, directory, action)
        label = "{} {}".format(directory, action)
        report = self.load_json(base + ".json", label + " report", device)
        image = self.screenshot(base + ".png", label + " screenshot", device)
        if not self.check_runtime_common(report, device, label, imagery_id):
            return report, image
        frame = report.get("frame")
        renderer = report.get("renderer")
        terrain = report.get("terrain")
        draws = renderer.get("draws") if isinstance(renderer, dict) else None
        textures = renderer.get("textures") if isinstance(renderer, dict) else None
        self.check("{} render frame".format(label), isinstance(frame, dict) and
                   positive_number(frame.get("patchCount")) and
                   positive_number(frame.get("vertexCount")),
                   "frame contains visible terrain geometry", device)
        self.check("{} draws".format(label), isinstance(draws, dict) and
                   positive_number(draws.get("submitted")),
                   "renderer submitted terrain draws", device)
        self.check("{} healthy".format(label), report.get("contextLost") is False and
                   not report.get("error") and isinstance(terrain, dict) and
                   terrain.get("failedRequestCount") == 0 and
                   isinstance(textures, dict) and textures.get("failed") == 0,
                   "runtime has no unresolved resource failures", device)
        return report, image

    def check_action_images(self, device, first_name, first, second_name, second):
        if first is None or second is None:
            return
        delta = image_difference(first, second)
        self.check("{} screenshot dimensions {} to {}".format(
            device, first_name, second_name), delta is not None,
            "fixed-action screenshots use one viewport", device)
        if delta is not None:
            self.check("{} screenshot difference {} to {}".format(
                device, first_name, second_name), delta >= 0.05,
                "mean sampled RGB difference is {:.3f}".format(delta), device)

    def check_blue_marble_actions(self, device):
        reports = {}
        images = {}
        for action in BLUE_MARBLE_ACTIONS:
            report, image = self.check_success_runtime(device, "blue_marble",
                                                       action, "blue-marble")
            reports[action] = report
            images[action] = image

        initial = reports.get("initial")
        zoom = reports.get("zoom")
        tilt = reports.get("tilt_45")
        yaw = reports.get("yaw")
        reset = reports.get("reset")
        if all(value is not None for value in (initial, zoom, tilt, yaw, reset)):
            initial_distance = camera_value(initial, "distance")
            zoom_distance = camera_value(zoom, "distance")
            tilt_value = camera_value(tilt, "tiltRadians")
            yaw_before = camera_value(tilt, "yawRadians")
            yaw_after = camera_value(yaw, "yawRadians")
            initial_tilt = camera_value(initial, "tiltRadians")
            initial_yaw = camera_value(initial, "yawRadians")
            reset_distance = camera_value(reset, "distance")
            reset_tilt = camera_value(reset, "tiltRadians")
            reset_yaw = camera_value(reset, "yawRadians")
            values = (initial_distance, zoom_distance, tilt_value, yaw_before,
                      yaw_after, initial_tilt, initial_yaw, reset_distance,
                      reset_tilt, reset_yaw)
            if all(value is not None for value in values):
                self.check("{} zoom state".format(device),
                           abs(zoom_distance - initial_distance) /
                           max(1.0, abs(initial_distance)) >= 0.01,
                           "zoom changes camera distance", device)
                self.check("{} 45 degree tilt state".format(device),
                           abs(tilt_value + math.pi / 4.0) <= 0.02,
                           "tilt action sets -45 degrees", device)
                yaw_delta = (yaw_after - yaw_before + math.pi) % \
                    (2.0 * math.pi) - math.pi
                self.check("{} yaw state".format(device), abs(yaw_delta) >= 0.05,
                           "yaw gesture changes camera heading", device)
                reset_matches = abs(reset_distance - initial_distance) <= \
                    max(1e-6, abs(initial_distance) * 1e-9) and \
                    abs(reset_tilt - initial_tilt) <= 1e-6 and \
                    abs(reset_yaw - initial_yaw) <= 1e-6
                self.check("{} reset state".format(device), reset_matches,
                           "reset restores the initial SDK camera state", device)
        self.check_action_images(device, "initial", images.get("initial"), "zoom",
                                 images.get("zoom"))
        self.check_action_images(device, "zoom", images.get("zoom"), "tilt_45",
                                 images.get("tilt_45"))
        self.check_action_images(device, "tilt_45", images.get("tilt_45"), "yaw",
                                 images.get("yaw"))

    def check_context_and_network(self, device, directory, imagery_id,
                                  require_context):
        if require_context:
            report = self.load_json("{}/{}/context_lost.json".format(
                device, directory), "{} context-lost report".format(directory),
                device)
            self.screenshot("{}/{}/context_lost.png".format(device, directory),
                            "{} context-lost screenshot".format(directory), device)
            if self.check_runtime_common(report, device, directory + " context lost",
                                         imagery_id):
                diagnostics = report.get("diagnostics") or []
                kinds = {item.get("kind") for item in diagnostics
                         if isinstance(item, dict)}
                self.check("{} context lost state".format(device),
                           report.get("contextLost") is True and
                           "webgl_context_lost" in kinds,
                           "report records an actual WebGL context loss", device)
            restored, _ = self.check_success_runtime(device, directory,
                                                      "context_restored", imagery_id)
            if restored is not None:
                diagnostics = restored.get("diagnostics") or []
                kinds = {item.get("kind") for item in diagnostics
                         if isinstance(item, dict)}
                self.check("{} context restored state".format(device),
                           "webgl_context_restored" in kinds,
                           "report records a WebGL context restoration", device)

        failed = self.load_json("{}/{}/weak_network_failed.json".format(
            device, directory), "{} weak-network failure report".format(directory),
            device)
        self.screenshot("{}/{}/weak_network_failed.png".format(device, directory),
                        "{} weak-network failure screenshot".format(directory),
                        device)
        if self.check_runtime_common(failed, device, directory + " weak network",
                                     imagery_id):
            terrain = failed.get("terrain") or {}
            renderer = failed.get("renderer") or {}
            textures = renderer.get("textures") or {}
            self.check("{} weak-network failure state".format(device),
                       positive_number(terrain.get("failedRequestCount")) or
                       positive_number(textures.get("failed")) or
                       bool(failed.get("error")),
                       "bounded retries report a visible resource failure", device)
        self.check_success_runtime(device, directory, "weak_network_recovered",
                                   imagery_id)

    def check_m1(self):
        for device in DEVICES:
            self.check_capability(device)
        self.check_thresholds()

    def check_m6(self):
        thresholds = self.check_thresholds()
        for device in ("android", "ios"):
            self.check_metrics(device, thresholds)
        for device in DEVICES:
            self.check_blue_marble_actions(device)
        for device in ("android", "ios"):
            self.check_context_and_network(device, "blue_marble", "blue-marble",
                                           require_context=True)

    def check_tianditu_review(self):
        review = self.load_json("tianditu_review.json", "Tianditu review")
        if review is None:
            return
        self.check("Tianditu review schema",
                   review.get("schema") == TIANDITU_REVIEW_SCHEMA,
                   "schema must be {}".format(TIANDITU_REVIEW_SCHEMA))
        self.check_timestamp(review.get("reviewedAt"), "Tianditu review timestamp")
        for key in ("frontendCredentialAuthorized", "terrainRequestDomainReviewed",
                    "providerTermsReviewed", "attributionVisible",
                    "screenshotsReviewedWithoutCredentials"):
            self.check("Tianditu {}".format(key), review.get(key) is True,
                       "{} is confirmed".format(key))
        self.check("Tianditu cache policy",
                   review.get("persistentTileCacheEnabled") is False,
                   "persistent tile cache remains disabled")
        domains = review.get("requestDomains")
        domain_set = set(domains) if isinstance(domains, list) else set()
        missing = sorted(REQUIRED_TIANDITU_DOMAINS - domain_set)
        self.check("Tianditu request domains", not missing,
                   "all t0 through t7 imagery domains are reviewed")

    def check_m7(self):
        self.check_tianditu_review()
        for device in DEVICES:
            initial, initial_image = self.check_success_runtime(
                device, "tianditu", "initial", "tianditu-img-c")
            tilt, tilt_image = self.check_success_runtime(
                device, "tianditu", "tilt_45", "tianditu-img-c")
            if initial is not None and tilt is not None:
                tilt_value = camera_value(tilt, "tiltRadians")
                self.check("{} Tianditu tilt state".format(device),
                           tilt_value is not None and
                           abs(tilt_value + math.pi / 4.0) <= 0.02,
                           "Tianditu imagery is captured at -45 degrees", device)
            self.check_action_images(device, "Tianditu initial", initial_image,
                                     "Tianditu tilt", tilt_image)
        for device in ("android", "ios"):
            self.check_context_and_network(device, "tianditu", "tianditu-img-c",
                                           require_context=False)
            self.check_success_runtime(device, "blue_marble", "fallback",
                                       "blue-marble")

    def run(self):
        if not self.root.is_dir():
            self.check("evidence directory", False,
                       "{} does not exist".format(self.root))
            return self.summary
        self.check("evidence directory", True, "evidence directory exists")
        self.check_no_credentials()
        self.check_manifest()
        if "M1" in self.milestones:
            self.check_m1()
        if "M6" in self.milestones:
            self.check_m6()
        if "M7" in self.milestones:
            self.check_m7()
        return self.summary


def build_self_test_evidence(root):
    timestamp = "2026-01-01T00:00:00Z"
    write_json_file(root / "manifest.json", {
        "schema": EVIDENCE_SCHEMA,
        "capturedAt": timestamp,
        "reviewer": "self-test",
        "devices": list(DEVICES),
        "milestones": ["M1", "M6", "M7"],
    })
    write_json_file(root / "thresholds.json", {
        "schema": THRESHOLDS_SCHEMA,
        "devices": {
            "android": {
                "max_p95_frame_time_ms": 33.4,
                "max_peak_memory_mb": 256,
                "min_stable_duration_seconds": 60,
            },
            "ios": {
                "max_p95_frame_time_ms": 33.4,
                "max_peak_memory_mb": 256,
                "min_stable_duration_seconds": 60,
            },
        },
    })
    write_json_file(root / "tianditu_review.json", {
        "schema": TIANDITU_REVIEW_SCHEMA,
        "reviewedAt": timestamp,
        "frontendCredentialAuthorized": True,
        "terrainRequestDomainReviewed": True,
        "providerTermsReviewed": True,
        "attributionVisible": True,
        "screenshotsReviewedWithoutCredentials": True,
        "persistentTileCacheEnabled": False,
        "requestDomains": sorted(REQUIRED_TIANDITU_DOMAINS),
    })

    def runtime(imagery, camera, context_lost=False, failed=False, diagnostic=None):
        diagnostics = [] if diagnostic is None else [{"kind": diagnostic, "detail": {}}]
        return {
            "schema": RUNTIME_SCHEMA,
            "datasetId": "globe",
            "imageryId": imagery,
            "frame": {
                "patchCount": 4,
                "requestCount": 0,
                "loadedRecordCount": 4,
                "failedRecordCount": 0,
                "drawCount": 1,
                "vertexCount": 2145,
            },
            "camera": camera,
            "budget": {"devicePixelRatio": 1},
            "terrain": {"failedRequestCount": 1 if failed else 0},
            "renderer": {
                "draws": {"submitted": 1, "queued": 0},
                "textures": {"failed": 0},
            },
            "contextLost": context_lost,
            "error": "",
            "diagnostics": diagnostics,
        }

    cameras = {
        "initial": {"distance": 20000000.0, "tiltRadians": 0.0, "yawRadians": 0.0},
        "zoom": {"distance": 16400000.0, "tiltRadians": 0.0, "yawRadians": 0.0},
        "tilt_45": {"distance": 16400000.0, "tiltRadians": -math.pi / 4.0,
                    "yawRadians": 0.0},
        "yaw": {"distance": 16400000.0, "tiltRadians": -math.pi / 4.0,
                "yawRadians": 0.5},
        "reset": {"distance": 20000000.0, "tiltRadians": 0.0, "yawRadians": 0.0},
    }
    for device_index, device in enumerate(DEVICES):
        platform = "devtools" if device == "devtools" else device
        write_json_file(root / device / "capabilities.json", {
            "schema": CAPABILITY_SCHEMA,
            "capturedAt": timestamp,
            "system": {"platform": platform},
            "webgl": {
                "passed": True,
                "width": 640,
                "height": 480,
                "maxTextureSize": 4096,
                "framebuffer": {"varyingSamples": 12},
            },
            "wasm": {"passed": True, "result": 42},
            "network": {"passed": True, "byteLength": 16},
        })
        write_png(root / device / "probe.png", 64, 64, 10 + device_index)
        if device in ("android", "ios"):
            write_json_file(root / device / "metrics.json", {
                "schema": METRICS_SCHEMA,
                "capturedAt": timestamp,
                "method": "self-test",
                "scenarios": {"blue_marble": {
                    "p95_frame_time_ms": 16.7,
                    "peak_memory_mb": 64,
                    "stable_duration_seconds": 120,
                }},
            })
        for action_index, action in enumerate(BLUE_MARBLE_ACTIONS):
            write_json_file(root / device / "blue_marble" / (action + ".json"),
                            runtime("blue-marble", cameras[action]))
            write_png(root / device / "blue_marble" / (action + ".png"),
                      64, 64, 30 + action_index + device_index * 10)
        for action_index, action in enumerate(("initial", "tilt_45")):
            write_json_file(root / device / "tianditu" / (action + ".json"),
                            runtime("tianditu-img-c", cameras[action]))
            write_png(root / device / "tianditu" / (action + ".png"),
                      64, 64, 100 + action_index + device_index * 10)
        if device in ("android", "ios"):
            for directory, imagery in (("blue_marble", "blue-marble"),
                                       ("tianditu", "tianditu-img-c")):
                if directory == "blue_marble":
                    write_json_file(root / device / directory / "context_lost.json",
                                    runtime(imagery, cameras["initial"], True, False,
                                            "webgl_context_lost"))
                    write_png(root / device / directory / "context_lost.png", 64, 64,
                              150 + device_index)
                    write_json_file(root / device / directory / "context_restored.json",
                                    runtime(imagery, cameras["initial"], False, False,
                                            "webgl_context_restored"))
                    write_png(root / device / directory / "context_restored.png", 64,
                              64, 160 + device_index)
                write_json_file(root / device / directory / "weak_network_failed.json",
                                runtime(imagery, cameras["initial"], False, True))
                write_png(root / device / directory / "weak_network_failed.png", 64,
                          64, 170 + device_index)
                write_json_file(root / device / directory / "weak_network_recovered.json",
                                runtime(imagery, cameras["initial"]))
                write_png(root / device / directory / "weak_network_recovered.png", 64,
                          64, 180 + device_index)
            write_json_file(root / device / "blue_marble" / "fallback.json",
                            runtime("blue-marble", cameras["initial"]))
            write_png(root / device / "blue_marble" / "fallback.png", 64, 64,
                      190 + device_index)


def run_self_test():
    with tempfile.TemporaryDirectory(prefix="terra-device-evidence-") as directory:
        root = Path(directory)
        build_self_test_evidence(root)
        summary = EvidenceValidator(root, ("M1", "M6", "M7")).run()
        if not summary["passed"]:
            raise RuntimeError("valid evidence fixture was rejected")
        capability_path = root / "android" / "capabilities.json"
        capability = load_json_file(capability_path)
        capability["unexpected"] = {"token": "redacted-is-still-a-leak"}
        write_json_file(capability_path, capability)
        rejected = EvidenceValidator(root, ("M1",)).run()
        if rejected["passed"]:
            raise RuntimeError("credential property fixture was accepted")
        capability.pop("unexpected")
        write_json_file(capability_path, capability)
        thresholds_path = root / "thresholds.json"
        thresholds = load_json_file(thresholds_path)
        thresholds["devices"]["android"]["max_p95_frame_time_ms"] = "invalid"
        write_json_file(thresholds_path, thresholds)
        rejected = EvidenceValidator(root, ("M1",)).run()
        if rejected["passed"]:
            raise RuntimeError("invalid threshold fixture was accepted")


def main(argv):
    parser = argparse.ArgumentParser(
        description="Validate local WeChat Mini Program M1/M6/M7 device evidence.")
    parser.add_argument("--evidence-dir", default="testdata/miniprogram/evidence/local",
                        help="ignored local evidence directory")
    parser.add_argument("--milestones", default="M1,M6,M7",
                        help="comma-separated milestones; later milestones include prerequisites")
    parser.add_argument("--summary", default=None,
                        help="write JSON summary here (defaults inside evidence dir)")
    parser.add_argument("--self-test", action="store_true",
                        help="run an isolated synthetic verifier test")
    args = parser.parse_args(argv)

    if args.self_test:
        run_self_test()
        print("Mini Program device evidence verifier self-test passed.")
        return 0

    try:
        milestones = parse_milestones(args.milestones)
    except ValueError as error:
        parser.error(str(error))
    validator = EvidenceValidator(args.evidence_dir, milestones)
    summary = validator.run()
    summary_path = Path(args.summary) if args.summary else \
        Path(args.evidence_dir) / "device_evidence_summary.json"
    if Path(args.evidence_dir).is_dir() or args.summary:
        write_json_file(summary_path, summary)
    failed = [check for check in summary["checks"] if not check["passed"]]
    if summary["passed"]:
        print("Mini Program device evidence passed: {} checks.".format(
            len(summary["checks"])))
        return 0
    print("Mini Program device evidence failed: {} of {} checks failed.".format(
        len(failed), len(summary["checks"])), file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
