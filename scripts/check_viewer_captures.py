#!/usr/bin/env python3
import argparse
import json
import math
import re
import struct
import sys
import zlib
from pathlib import Path


CAPTURES = [
    "initial_birdview",
    "birdview_zoom_in",
    "tilted_45",
    "tilted_zoom_out",
    "tilted_rotate",
    "statistics",
    "reset",
]

DIFF_PAIRS = [
    ("initial_birdview", "birdview_zoom_in"),
    ("birdview_zoom_in", "tilted_45"),
    ("tilted_45", "tilted_zoom_out"),
    ("tilted_zoom_out", "tilted_rotate"),
]


def load_json(path):
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, sort_keys=True)
        f.write("\n")


def normalize_log(log_path):
    event_patterns = [
        ("process_started", re.compile(r"^\[viewer\] process_started$")),
        ("terrain_connected", re.compile(r"^\[viewer\] terrain_connected\b")),
        ("terrain_mode_detected", re.compile(r"^\[viewer\] terrain_connected projection=")),
        ("update_thread_started", re.compile(r"^\[viewer\] update_thread_started$")),
        ("texture_layer_connected", re.compile(r"^\[viewer\] texture_layer_connected\b")),
        ("opengl_initialized", re.compile(r"^\[viewer\] opengl_initialized$")),
        ("initial_camera_set", re.compile(r"^\[viewer\] initial_camera_set\b")),
        ("verify_action_started", re.compile(r"VERIFY_ACTION_START")),
        ("verify_action_finished", re.compile(r"VERIFY_ACTION_DONE")),
        ("capture_written", re.compile(r"VERIFY_CAPTURE_WRITTEN")),
        ("process_exited", re.compile(r"VERIFY_PROCESS_EXIT")),
    ]
    lines = []
    events = []
    if not log_path.exists():
        return {"events": events, "lines": lines}
    for line_no, raw in enumerate(log_path.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
        line = raw.strip()
        lines.append({"line": line_no, "text": line})
        for event, pattern in event_patterns:
            if pattern.search(line):
                events.append({"event": event, "line": line_no, "text": line})
    return {"events": events, "lines": lines}


def read_png(path):
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG file")
    pos = 8
    width = height = None
    color_type = None
    bit_depth = None
    compressed = bytearray()
    while pos < len(data):
        length = struct.unpack(">I", data[pos:pos + 4])[0]
        ctype = data[pos + 4:pos + 8]
        payload = data[pos + 8:pos + 8 + length]
        pos += 12 + length
        if ctype == b"IHDR":
            width, height, bit_depth, color_type = struct.unpack(">IIBB", payload[:10])
        elif ctype == b"IDAT":
            compressed.extend(payload)
        elif ctype == b"IEND":
            break
    if width is None or height is None:
        raise ValueError("missing PNG IHDR")
    if bit_depth != 8 or color_type not in (2, 6):
        return {"width": width, "height": height, "pixels": None}

    raw = zlib.decompress(bytes(compressed))
    channels = 4 if color_type == 6 else 3
    stride = width * channels
    rows = []
    prev = [0] * stride
    i = 0
    for _ in range(height):
        filter_type = raw[i]
        i += 1
        scan = list(raw[i:i + stride])
        i += stride
        recon = [0] * stride
        for x, value in enumerate(scan):
            left = recon[x - channels] if x >= channels else 0
            up = prev[x]
            up_left = prev[x - channels] if x >= channels else 0
            if filter_type == 0:
                recon[x] = value
            elif filter_type == 1:
                recon[x] = (value + left) & 0xff
            elif filter_type == 2:
                recon[x] = (value + up) & 0xff
            elif filter_type == 3:
                recon[x] = (value + ((left + up) // 2)) & 0xff
            elif filter_type == 4:
                p = left + up - up_left
                pa = abs(p - left)
                pb = abs(p - up)
                pc = abs(p - up_left)
                pr = left if pa <= pb and pa <= pc else up if pb <= pc else up_left
                recon[x] = (value + pr) & 0xff
            else:
                raise ValueError("unsupported PNG filter")
        rows.append(recon)
        prev = recon
    pixels = []
    for row in rows:
        for x in range(0, len(row), channels):
            pixels.append(tuple(row[x:x + 3]))
    return {"width": width, "height": height, "pixels": pixels}


def write_png_rgb(path, width, height, pixels):
    rows = []
    for y in range(height):
        start = y * width
        row = bytearray([0])
        for r, g, b in pixels[start:start + width]:
            row.extend([r, g, b])
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(ctype, payload):
        return (
            struct.pack(">I", len(payload)) +
            ctype +
            payload +
            struct.pack(">I", zlib.crc32(ctype + payload) & 0xffffffff)
        )

    data = bytearray(b"\x89PNG\r\n\x1a\n")
    data.extend(chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)))
    data.extend(chunk(b"IDAT", zlib.compress(raw)))
    data.extend(chunk(b"IEND", b""))
    path.write_bytes(bytes(data))


def write_diff_png(baseline_path, current_path, diff_path):
    if not baseline_path.exists() or not current_path.exists():
        return False
    baseline = read_png(baseline_path)
    current = read_png(current_path)
    if baseline["pixels"] is None or current["pixels"] is None:
        return False
    if baseline["width"] != current["width"] or baseline["height"] != current["height"]:
        return False
    pixels = []
    for a, b in zip(baseline["pixels"], current["pixels"]):
        pixels.append(tuple(min(255, abs(a[i] - b[i]) * 4) for i in range(3)))
    write_png_rgb(diff_path, current["width"], current["height"], pixels)
    return True


def image_stats(path):
    png = read_png(path)
    pixels = png["pixels"]
    if pixels is None:
        return {"width": png["width"], "height": png["height"], "unique": 0, "mean": 0.0}
    sample_step = max(1, len(pixels) // 20000)
    sample = pixels[::sample_step]
    unique = len(set(sample))
    mean = sum(sum(px) / 3.0 for px in sample) / max(1, len(sample))
    return {"width": png["width"], "height": png["height"], "unique": unique, "mean": mean, "sample": sample}


def mean_abs_diff(a_stats, b_stats):
    a = a_stats.get("sample") or []
    b = b_stats.get("sample") or []
    n = min(len(a), len(b))
    if n == 0:
        return 0.0
    total = 0.0
    for i in range(n):
        total += sum(abs(a[i][c] - b[i][c]) for c in range(3)) / 3.0
    return total / n


def state_distance(a, b):
    pa = a.get("camera_position")
    pb = b.get("camera_position")
    if not isinstance(pa, list) or not isinstance(pb, list) or len(pa) != 3 or len(pb) != 3:
        return None
    return math.sqrt(sum((float(pa[i]) - float(pb[i])) ** 2 for i in range(3)))


def main():
    parser = argparse.ArgumentParser(description="Validate CBDAM viewer capture outputs.")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--baseline-dir", required=True)
    parser.add_argument("--log-file", default=None)
    parser.add_argument("--contract", default=None)
    parser.add_argument("--width", type=int, default=1280)
    parser.add_argument("--height", type=int, default=720)
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    baseline_dir = Path(args.baseline_dir)
    log_file = Path(args.log_file) if args.log_file else output_dir / "viewer.log"
    contract_path = Path(args.contract) if args.contract else baseline_dir / "log_contract.json"

    summary = {"passed": True, "checks": [], "captures": {}, "diffs": [], "log": {}}

    def check(name, passed, detail):
        summary["checks"].append({"name": name, "passed": bool(passed), "detail": detail})
        if not passed:
            summary["passed"] = False

    normalized = normalize_log(log_file)
    write_json(output_dir / "normalized_log.json", normalized)
    contract = load_json(contract_path) if contract_path.exists() else {}
    event_names = {e["event"] for e in normalized["events"]}
    required = contract.get("required_events", [])
    missing = [e for e in required if e not in event_names]
    forbidden_hits = []
    for pattern in contract.get("forbidden_patterns", []):
        rx = re.compile(pattern)
        for line in normalized["lines"]:
            if rx.search(line["text"]):
                forbidden_hits.append({"pattern": pattern, **line})
    ignored = contract.get("ignored_patterns", [])
    ignored_rx = [re.compile(p) for p in ignored]
    known_event_lines = {e["line"] for e in normalized["events"]}
    unknown = [
        line for line in normalized["lines"]
        if line["line"] not in known_event_lines and not any(rx.search(line["text"]) for rx in ignored_rx)
    ]
    line_count = len(normalized["lines"])
    allowed_unknown = int(contract.get("allowed_unknown_lines", 0))
    max_lines = int(contract.get("max_lines", 0))
    summary["log"] = {
        "missing_required_events": missing,
        "forbidden_hits": forbidden_hits,
        "line_count": line_count,
        "max_lines": max_lines,
        "unknown_line_count": len(unknown),
        "allowed_unknown_lines": allowed_unknown,
    }
    check("log_contract", not missing and not forbidden_hits and len(unknown) <= allowed_unknown, summary["log"])
    check("log_line_budget", max_lines <= 0 or line_count <= max_lines, summary["log"])

    image_stat_cache = {}
    state_cache = {}
    for capture in CAPTURES:
        png_path = output_dir / f"{capture}.png"
        state_path = output_dir / f"state_{capture}.json"
        check(f"{capture}_png_exists", png_path.exists(), str(png_path))
        check(f"{capture}_state_exists", state_path.exists(), str(state_path))
        if png_path.exists():
            try:
                stats = image_stats(png_path)
                image_stat_cache[capture] = stats
                summary["captures"][capture] = {k: v for k, v in stats.items() if k != "sample"}
                check(f"{capture}_dimensions", stats["width"] == args.width and stats["height"] == args.height, summary["captures"][capture])
                check(f"{capture}_non_blank", stats["unique"] >= 32, summary["captures"][capture])
                write_diff_png(baseline_dir / f"{capture}.png", png_path, output_dir / f"diff_{capture}.png")
            except Exception as exc:
                check(f"{capture}_png_readable", False, str(exc))
        if state_path.exists():
            try:
                state_cache[capture] = load_json(state_path)
            except Exception as exc:
                check(f"{capture}_state_readable", False, str(exc))

    for left, right in DIFF_PAIRS:
        if left in image_stat_cache and right in image_stat_cache:
            diff = mean_abs_diff(image_stat_cache[left], image_stat_cache[right])
            summary["diffs"].append({"left": left, "right": right, "mean_abs_diff": diff})
            check(f"{left}_vs_{right}_changed", diff >= 1.0, diff)

    if "initial_birdview" in state_cache and "reset" in state_cache:
        dist = state_distance(state_cache["initial_birdview"], state_cache["reset"])
        check("reset_state_close", dist is None or dist <= 1.0, {"camera_distance": dist})

    write_json(output_dir / "summary.json", summary)
    return 0 if summary["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
