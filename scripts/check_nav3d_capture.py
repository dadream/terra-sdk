#!/usr/bin/env python3
import argparse
import json
import re
import sys
from pathlib import Path

from check_viewer_captures import image_stats, mean_abs_diff, read_png


REQUIRED_LOG_MARKERS = [
    "[nav3d] process_started",
    "[nav3d] terrain_projection_ready projection=spherical",
    "[terrain] geometry_root_ready connected=true",
    "[nav3d] config_loaded",
    "[nav3d] terrain_ready",
    "[nav3d] texture_layers_ready base_count=1",
    "[nav3d] update_thread_started",
    "[nav3d] renderer_initialized",
    "[nav3d] ui_ready",
    "[nav3d] verification_capture_written",
]

FORBIDDEN_LOG_PATTERNS = [
    re.compile(
        r"^\[(nav3d|terrain)\]\[(error|warning)\]",
        re.MULTILINE,
    ),
    re.compile(r"connected=false"),
    re.compile(r"OpenGL.*(failed|unsupported)", re.IGNORECASE),
    re.compile(r"Segmentation fault|Aborted|qFatal"),
    re.compile(r"HTTP error: curlcode="),
]


def vertical_region_stats(path):
    png = read_png(path)
    pixels = png["pixels"]
    if not pixels:
        return []

    width = png["width"]
    height = png["height"]
    split = height // 2
    result = []
    for name, start_y, end_y in (
        ("top", 0, split),
        ("bottom", split, height),
    ):
        region_pixels = pixels[start_y * width : end_y * width]
        sample_step = max(1, len(region_pixels) // 10000)
        sample = region_pixels[::sample_step]
        mean = sum(sum(pixel[:3]) / 3.0 for pixel in sample) / len(sample)
        result.append({"region": name, "unique": len(set(sample)), "mean": mean})
    return result


def main():
    parser = argparse.ArgumentParser(
        description="Validate a deterministic nav3d globe capture."
    )
    parser.add_argument("--capture", required=True)
    parser.add_argument("--log-file", required=True)
    parser.add_argument("--summary", required=True)
    parser.add_argument("--min-width", type=int, default=1000)
    parser.add_argument("--min-height", type=int, default=600)
    parser.add_argument("--baseline")
    parser.add_argument("--max-baseline-diff", type=float, default=2.0)
    parser.add_argument("--texture-mode", choices=("tms", "wmts"), default="tms")
    args = parser.parse_args()

    capture_path = Path(args.capture)
    baseline_path = Path(args.baseline) if args.baseline else None
    log_path = Path(args.log_file)
    summary_path = Path(args.summary)
    summary = {"passed": True, "checks": []}

    def check(name, passed, detail):
        summary["checks"].append(
            {"name": name, "passed": bool(passed), "detail": detail}
        )
        if not passed:
            summary["passed"] = False

    check("capture_exists", capture_path.exists(), str(capture_path))
    capture_stats = None
    if capture_path.exists():
        try:
            stats = image_stats(capture_path)
            capture_stats = stats
            public_stats = {key: value for key, value in stats.items() if key != "sample"}
            check(
                "capture_dimensions",
                stats["width"] >= args.min_width and stats["height"] >= args.min_height,
                public_stats,
            )
            check("capture_non_blank", stats["unique"] >= 32, public_stats)
            regions = vertical_region_stats(capture_path)
            check(
                "capture_vertical_coverage",
                len(regions) == 2
                and all(region["unique"] >= 32 for region in regions),
                regions,
            )
        except Exception as exc:
            check("capture_readable", False, str(exc))

    if baseline_path is not None:
        check("baseline_exists", baseline_path.exists(), str(baseline_path))
        if baseline_path.exists() and capture_stats is not None:
            try:
                baseline_stats = image_stats(baseline_path)
                dimensions_match = (
                    capture_stats["width"] == baseline_stats["width"]
                    and capture_stats["height"] == baseline_stats["height"]
                )
                check(
                    "baseline_dimensions",
                    dimensions_match,
                    {
                        "capture": [capture_stats["width"], capture_stats["height"]],
                        "baseline": [baseline_stats["width"], baseline_stats["height"]],
                    },
                )
                difference = mean_abs_diff(capture_stats, baseline_stats)
                check(
                    "capture_matches_baseline",
                    difference <= args.max_baseline_diff,
                    {
                        "mean_abs_diff": difference,
                        "maximum": args.max_baseline_diff,
                    },
                )
            except Exception as exc:
                check("baseline_readable", False, str(exc))

    check("log_exists", log_path.exists(), str(log_path))
    log_text = (
        log_path.read_text(encoding="utf-8", errors="replace")
        if log_path.exists()
        else ""
    )
    for marker in REQUIRED_LOG_MARKERS:
        check(f"log_marker:{marker}", marker in log_text, marker)
    texture_markers = (
        ["[terrain] texture_root_ready count="]
        if args.texture_mode == "tms"
        else [
            "[terrain] wmts_source_connected",
            "[terrain] wmts_tile_decoded",
        ]
    )
    for marker in texture_markers:
        check(f"log_marker:{marker}", marker in log_text, marker)
    for pattern in FORBIDDEN_LOG_PATTERNS:
        check(
            f"log_forbidden:{pattern.pattern}",
            pattern.search(log_text) is None,
            pattern.pattern,
        )

    summary_path.parent.mkdir(parents=True, exist_ok=True)
    summary_path.write_text(
        json.dumps(summary, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return 0 if summary["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
