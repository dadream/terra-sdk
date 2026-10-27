#!/usr/bin/env python3
"""Bounded offline joint-capacity diagnostic. Collection is not product acceptance."""
from pathlib import Path
import argparse
import hashlib
import html
import json
import re
import signal
import socket
import subprocess
import time


def main():
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("reference", "wasm", "tile", "browser", "output"):
        parser.add_argument("--" + name, required=True, type=Path)
    parser.add_argument("--managed-bytes", type=int, default=805306368)
    parser.add_argument("--terrain-mesh-bytes", type=int, default=67108864)
    parser.add_argument("--pose-count", type=int, default=10)
    parser.add_argument("--sdk-defaults", action="store_true", help="Omit public capacity overrides; assert SDK defaults match the expected byte limits")
    parser.add_argument("--visibility", choices=("renderer", "all-visible"), default="renderer",
                        help="Keep SDK GPU occlusion, or explicitly disable it for comparison with the all-visible Native oracle")
    parser.add_argument("--observation-seconds", type=int, default=30)
    parser.add_argument("--reclaim-idle", action="store_true", help="After primary samples, audit actual idle refunds and unchanged pixels")
    parser.add_argument("--port", type=int, default=18767)
    args = parser.parse_args()
    output = args.output.absolute()
    if not 1024 <= args.port <= 65535 or args.port == 18766:
        raise ValueError("Use an unoccupied diagnostic port, never the manual service")
    with socket.socket() as check:
        check.bind(("127.0.0.1", args.port))
    options = {key: str(getattr(args, key).absolute()) for key in ("reference", "wasm", "tile", "output")}
    options.update(managedBytes=args.managed_bytes, terrainMeshBytes=args.terrain_mesh_bytes,
                   poseCount=args.pose_count, observationSeconds=args.observation_seconds, reclaimIdle=args.reclaim_idle,
                   useSdkDefaults=args.sdk_defaults, visibility=args.visibility)
    subprocess.run(["node", str(root / "tests/benchmarks/joint_capacity/prepare.js"), json.dumps(options)], check=True)
    inputs = json.loads((output / "inputs.json").read_text())
    server = client = None
    receipt = {"passed": False, "collected": False, "offline": True, "sdkProductAccepted": False}

    def interrupted(signum, frame):
        raise KeyboardInterrupt()

    signal.signal(signal.SIGINT, interrupted)
    signal.signal(signal.SIGTERM, interrupted)
    try:
        with (output / "server.log").open("w") as log:
            server = subprocess.Popen(["python3", "-m", "http.server", str(args.port), "--bind", "127.0.0.1",
                                       "--directory", str(output / "site")], stdout=log, stderr=subprocess.STDOUT)
        receipt["serverPid"] = server.pid
        for attempt in range(50):
            if server.poll() is not None:
                raise RuntimeError("Fixture server exited")
            with socket.socket() as check:
                if check.connect_ex(("127.0.0.1", args.port)) == 0:
                    break
            time.sleep(.1)
        else:
            raise RuntimeError("Fixture server did not listen")
        timeout = args.pose_count * args.observation_seconds + 60
        with (output / "runner.log").open("w") as log:
            client = subprocess.Popen(["node", str(root / "scripts/run_chromium_evidence.js"),
                "--browser", str(args.browser.absolute()), "--profile", str(output / "profile"),
                "--url", "http://127.0.0.1:%d/" % args.port, "--dom-output", str(output / "dom.html"),
                "--log-output", str(output / "browser.log"), "--progress-output", str(output / "progress.json"),
                "--progress-element", "report", "--timeout", str(timeout), "--width", "1280", "--height", "900"],
                stdout=log, stderr=subprocess.STDOUT)
            receipt["browserRunnerPid"] = client.pid
            receipt["exitCode"] = client.wait(timeout=timeout + 30)
        match = re.search(r'<pre id="report"[^>]*>(.*?)</pre>', (output / "dom.html").read_text(), re.S)
        if match is None:
            raise RuntimeError("Capacity report missing")
        report = json.loads(html.unescape(match.group(1)))
        (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        if receipt["exitCode"] != 0 or report["status"] != "collected":
            raise RuntimeError("Capacity diagnostic failed")
        comparison_path = output / "reference-comparison.json"
        subprocess.run(["node", str(root / "tests/benchmarks/joint_capacity/compare_reference.js"),
                        str(args.reference.absolute()), str(output / "report.json"), str(comparison_path)], check=True)
        comparison = json.loads(comparison_path.read_text())
        receipt["terrainReferenceMatches"] = comparison["allTerrainSetsMatch"]
        receipt["rawImageSetsMatch"] = comparison["allPresentedImageSetsMatch"]
        receipt["imageryReferenceComparable"] = comparison["allImageComparisonsComparable"]
        receipt["imageryReferenceMatches"] = comparison["allImageReferencesMatch"]
        receipt["collected"] = True
        receipt["withinOriginalDeadline"] = report["withinOriginalDeadline"]
        receipt["fullRouteCompleted"] = report["fullRouteCompleted"]
    finally:
        for owned in (client, server):
            if owned is not None and owned.poll() is None:
                owned.terminate()
                try:
                    owned.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    owned.kill()
                    owned.wait()
                    receipt["forcedStop"] = True
        receipt["clientStopped"] = client is None or client.poll() is not None
        receipt["serverStopped"] = server is None or server.poll() is not None
        receipt["profileRemoved"] = not (output / "profile").exists()
        receipt["inputsUnchanged"] = all(hashlib.sha256((output / "site" / name).read_bytes()).hexdigest() == row["sha256"]
                                         for name, row in inputs["assets"].items())
        (output / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
        print(json.dumps(receipt))
        if not receipt["profileRemoved"] or receipt.get("forcedStop") or not receipt["inputsUnchanged"]:
            raise RuntimeError("Diagnostic cleanup or input integrity not proven")


if __name__ == "__main__":
    main()
