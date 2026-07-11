#!/usr/bin/env python3
import argparse
import base64
import html
import json
import os
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


def load_json(path, default):
    try:
        with path.open("r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def rel(path, base):
    return os.path.relpath(path.resolve(), base.resolve()).replace(os.sep, "/")


def image_src(path, root, embed):
    if embed:
        data = base64.b64encode(path.read_bytes()).decode("ascii")
        return f"data:image/png;base64,{data}"
    return rel(path, root)


def maybe_img(path, root, embed):
    if path.exists():
        return f'<img src="{html.escape(image_src(path, root, embed))}" alt="{html.escape(path.name)}">'
    return '<div class="missing">missing</div>'


def main():
    parser = argparse.ArgumentParser(description="Render a CBDAM viewer baseline comparison report.")
    parser.add_argument("--baseline-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--report", default=None)
    parser.add_argument("--embed-images", action="store_true")
    args = parser.parse_args()

    baseline_dir = Path(args.baseline_dir)
    output_dir = Path(args.output_dir)
    report_path = Path(args.report) if args.report else output_dir / "report.html"
    summary = load_json(output_dir / "summary.json", {"passed": False, "checks": []})
    normalized = load_json(output_dir / "normalized_log.json", {"events": [], "lines": []})

    rows = []
    for capture in CAPTURES:
        baseline_img = baseline_dir / f"{capture}.png"
        current_img = output_dir / f"{capture}.png"
        diff_img = output_dir / f"diff_{capture}.png"
        base_state = load_json(baseline_dir / f"state_{capture}.json", {})
        current_state = load_json(output_dir / f"state_{capture}.json", {})
        state_keys = sorted(set(base_state.keys()) | set(current_state.keys()))
        state_lines = []
        for key in state_keys:
            if base_state.get(key) != current_state.get(key):
                state_lines.append(
                    f"<tr><td>{html.escape(key)}</td><td>{html.escape(str(base_state.get(key)))}</td>"
                    f"<td>{html.escape(str(current_state.get(key)))}</td></tr>"
                )
        state_body = "".join(state_lines) if state_lines else '<tr><td colspan="3">No state differences recorded.</td></tr>'
        rows.append(
            "<section class=\"capture\">"
            f"<h2>{html.escape(capture)}</h2>"
            "<div class=\"grid\">"
            f"<figure><figcaption>Baseline</figcaption>{maybe_img(baseline_img, report_path.parent, args.embed_images)}</figure>"
            f"<figure><figcaption>Current</figcaption>{maybe_img(current_img, report_path.parent, args.embed_images)}</figure>"
            f"<figure><figcaption>Diff</figcaption>{maybe_img(diff_img, report_path.parent, args.embed_images)}</figure>"
            "</div>"
            "<details><summary>State differences</summary>"
            "<table><thead><tr><th>Field</th><th>Baseline</th><th>Current</th></tr></thead>"
            f"<tbody>{state_body}</tbody></table>"
            "</details>"
            "</section>"
        )

    checks = "".join(
        f"<tr class=\"{'pass' if c.get('passed') else 'fail'}\"><td>{html.escape(c.get('name', ''))}</td>"
        f"<td>{'PASS' if c.get('passed') else 'FAIL'}</td><td><pre>{html.escape(json.dumps(c.get('detail'), ensure_ascii=False, indent=2))}</pre></td></tr>"
        for c in summary.get("checks", [])
    )
    events = "".join(
        f"<tr><td>{html.escape(str(e.get('line')))}</td><td>{html.escape(e.get('event', ''))}</td>"
        f"<td>{html.escape(e.get('text', ''))}</td></tr>"
        for e in normalized.get("events", [])
    )

    report = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>CBDAM Viewer Baseline Report</title>
<style>
body {{ font-family: system-ui, sans-serif; margin: 24px; color: #18202a; background: #f7f8fa; }}
h1, h2 {{ margin: 0 0 12px; }}
.status {{ display: inline-block; padding: 6px 10px; border-radius: 4px; font-weight: 700; }}
.pass .status, .status.pass {{ background: #d9f2df; color: #0f6b2d; }}
.fail .status, .status.fail {{ background: #ffe1df; color: #9f2117; }}
.capture {{ margin: 24px 0; padding: 16px; background: white; border: 1px solid #d8dee7; border-radius: 6px; }}
.grid {{ display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }}
figure {{ margin: 0; }}
figcaption {{ font-weight: 700; margin-bottom: 6px; }}
img {{ max-width: 100%; border: 1px solid #c8d0da; background: #e9edf2; }}
.missing {{ min-height: 120px; display: grid; place-items: center; border: 1px dashed #b6bec9; color: #687384; }}
table {{ width: 100%; border-collapse: collapse; margin-top: 12px; background: white; }}
th, td {{ border: 1px solid #d8dee7; padding: 6px 8px; text-align: left; vertical-align: top; }}
pre {{ white-space: pre-wrap; margin: 0; }}
tr.fail {{ background: #fff0ef; }}
tr.pass {{ background: #f1fbf3; }}
</style>
</head>
<body class="{'pass' if summary.get('passed') else 'fail'}">
<h1>CBDAM Viewer Baseline Report</h1>
<p><span class="status {'pass' if summary.get('passed') else 'fail'}">{'PASS' if summary.get('passed') else 'FAIL'}</span></p>
<h2>Summary Checks</h2>
<table><thead><tr><th>Check</th><th>Status</th><th>Detail</th></tr></thead><tbody>{checks}</tbody></table>
<h2>Log Contract Events</h2>
<table><thead><tr><th>Line</th><th>Event</th><th>Text</th></tr></thead><tbody>{events}</tbody></table>
{''.join(rows)}
</body>
</html>
"""
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(report, encoding="utf-8")


if __name__ == "__main__":
    main()
