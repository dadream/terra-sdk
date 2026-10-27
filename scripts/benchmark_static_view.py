#!/usr/bin/env python3
"""Offline cold-view capacity and execution comparison; not product acceptance."""
from pathlib import Path
import argparse
import base64
import hashlib
import html
import json
import os
import re
import signal
import socket
import subprocess
import time


def main(scene="static_view"):
    if scene not in ("static_view", "navigation"):
        raise ValueError("Unknown browser benchmark scene")
    navigation = scene == "navigation"
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description="Offline fixed-path navigation collection" if navigation else __doc__)
    for name in ("wasm", "tile", "browser", "output"):
        parser.add_argument("--" + name, required=True, type=Path)
    parser.add_argument("--backend", choices=("both", "worker", "direct"), default="both")
    parser.add_argument("--repetitions", type=int, default=1)
    parser.add_argument("--observation-seconds", type=int, default=30 if navigation else 60)
    parser.add_argument("--managed-bytes", type=int)
    parser.add_argument("--terrain-mesh-bytes", type=int)
    parser.add_argument("--partition-bytes", type=int, help="Public UV capacity override for controlled comparisons")
    parser.add_argument("--trace-pipeline", action="store_true")
    parser.add_argument("--sdk-snapshot", type=Path, help="Archived inputs.json; verifies JS hashes and identical Wasm")
    if navigation:
        parser.add_argument("--case", choices=("oblique", "zoom"), default="oblique", dest="navigation_case")
        parser.add_argument("--capture-terrain", help="Explicit bounded terrain acquisition; never an offline acceptance run")
        parser.add_argument("--live-imagery", action="store_true", help="Real Tianditu images through the fixed49 proxy; timing is not offline")
        parser.add_argument("--visual", action="store_true", help="Bounded submitted-canvas captures; do not use for timing comparison")
    parser.add_argument("--decode-tasks", choices=(1, 4), type=int,
                        help="Diagnostic cap on browser decoders; not a public SDK option")
    parser.add_argument("--port", type=int, default=0 if navigation else 18767)
    args = parser.parse_args()
    if navigation and (args.observation_seconds != 30 or args.decode_tasks is not None):
        raise ValueError("Navigation keeps the original30s endpoint deadlines and configured decoders")
    if not 1 <= args.repetitions <= 5 or args.port != 0 and not 1024 <= args.port <= 65535 or args.port == 18766:
        raise ValueError("Use 1..5 cold repetitions and a diagnostic port other than18766")
    with socket.socket() as check:
        check.bind(("127.0.0.1", args.port))
        args.port = check.getsockname()[1]
    output = args.output.absolute()
    options = {key: str(getattr(args, key).absolute()) for key in ("wasm", "tile", "output")}
    options.update(observationSeconds=args.observation_seconds, capacity={}, tracePipeline=args.trace_pipeline)
    if navigation:
        options["navigationCase"] = args.navigation_case
        options["liveImagery"] = args.live_imagery
        options["visual"] = args.visual
        if args.capture_terrain:
            options["terrainUpstream"] = args.capture_terrain
    if args.sdk_snapshot is not None:
        options["sdkSnapshot"] = str(args.sdk_snapshot.absolute())
    if args.decode_tasks is not None:
        options["decodeTasks"] = args.decode_tasks
    for key, value in (("maximumResourceBytes", args.managed_bytes),
                       ("maximumTerrainMeshBytes", args.terrain_mesh_bytes),
                       ("maximumPartitionBytes", args.partition_bytes)):
        if value is not None:
            options["capacity"][key] = value
    subprocess.run(["node", str(root / "tests/benchmarks" / scene / "prepare.js"), json.dumps(options)], check=True)
    inputs = json.loads((output / "inputs.json").read_text())
    receipt = {"schema": "terra.navigation-collection.v1" if navigation else "terra.static-view-collection.v1",
               "offline": not (options.get("terrainUpstream") or options.get("liveImagery")), "collected": False, "port": args.port,
               "collectorSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
               "sdkProductAccepted": False, "runs": []}
    server = client = None
    reports = []

    def interrupted(signum, frame):
        raise KeyboardInterrupt()

    def stop(process):
        if process is not None and process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
                receipt["forcedStop"] = True

    signal.signal(signal.SIGINT, interrupted)
    signal.signal(signal.SIGTERM, interrupted)
    try:
        with (output / "server.log").open("w") as log:
            command = ["node", str(root / "tests/benchmarks/navigation/capture_server.js"), str(output), str(args.port)] \
                if options.get("terrainUpstream") or options.get("liveImagery") else ["python3", "-m", "http.server", str(args.port), "--bind", "127.0.0.1",
                                                        "--directory", str(output / "site")]
            server = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT,
                                      start_new_session=True)
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
        backends = ["worker", "direct"] if args.backend == "both" else [args.backend]
        for repetition in range(args.repetitions):
            # Alternate order across repeats; each sample still has a fresh process/profile/runtime.
            for backend in backends if repetition % 2 == 0 else reversed(backends):
                name = "%s-%d" % (backend, repetition + 1)
                folder = output / name
                folder.mkdir()
                if navigation:
                    config = inputs["configuration"]
                    motions = config.get("motions") or [config["motion"]]
                    timeout = ((len(motions) + 1) * config["acceptanceMs"] +
                               sum(m["durationMs"] + 1000 for m in motions)) / 1000 + 45
                else:
                    timeout = args.observation_seconds + 45
                print("Starting " + name, flush=True)
                with (folder / "runner.log").open("w") as log:
                    client = subprocess.Popen(["node", str(root / "scripts/run_chromium_evidence.js"),
                        "--browser", str(args.browser.absolute()), "--profile", str(folder / "profile"),
                        "--url", "http://127.0.0.1:%d/?backend=%s" % (args.port, backend),
                        "--dom-output", str(folder / "dom.html"), "--log-output", str(folder / "browser.log"),
                        "--progress-output", str(folder / "progress.json"), "--progress-element", "report",
                        "--timeout", str(timeout), "--width", "1360", "--height", "1000"],
                        stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                    code = client.wait(timeout=timeout + 30)
                match = re.search(r'<pre id="report"[^>]*>(.*?)</pre>', (folder / "dom.html").read_text(), re.S)
                if match is None:
                    raise RuntimeError("Missing browser benchmark report")
                report = json.loads(html.unescape(match.group(1)))
                for index, frame in enumerate(report.get("visualFrames", [])):
                    prefix = "data:image/png;base64,"
                    if not frame.get("image", "").startswith(prefix):
                        raise RuntimeError("Invalid canvas capture")
                    data = base64.b64decode(frame.pop("image")[len(prefix):], validate=True)
                    image_name = "frame-%02d.png" % index
                    (folder / image_name).write_bytes(data)
                    frame.update(file=image_name, sha256=hashlib.sha256(data).hexdigest())
                (folder / "report.json").write_text(json.dumps(report, indent=2) + "\n")
                row = {"id": name, "backend": backend, "runnerPid": client.pid, "exitCode": code,
                       "status": report["status"], "durationMs": report.get("durationMs"),
                       "settled": report.get("settled", False),
                       "withinOriginalDeadline": report.get("withinOriginalDeadline", False),
                       "runtimeCleanup": report.get("cleanup"), "profileRemoved": not (folder / "profile").exists()}
                if navigation:
                    row["motionExecuted"] = report.get("motionExecuted", False)
                    row["missingTerrainKeys"] = report.get("terrain", {}).get("missingKeys", [])
                receipt["runs"].append(row)
                print(json.dumps(row), flush=True)
                if code or report["status"] != "collected":
                    raise RuntimeError("Browser benchmark collection failed: " + name)
                reports.append(report)
        receipt["collected"] = True
        receipt["withinOriginalDeadline"] = all(row["withinOriginalDeadline"] for row in receipt["runs"])
        # Literal final-set equality is separate from timing and visual acceptance.
        # If depth occlusion differs, mark the comparison ineligible, not a pass.
        first = reports[0]
        comparison = {"scope": "Cold runs with identical declared scene/inputs/policy; intermediate publication order can differ",
                      "allSettled": all(r["settled"] for r in reports), "pairs": []}
        for report in reports[1:]:
            counts = {}
            for key, values in first["final"]["sets"].items():
                a, b = set(values), set(report["final"]["sets"][key])
                counts[key] = {"first": len(a), "current": len(b), "onlyFirst": sorted(a-b), "onlyCurrent": sorted(b-a)}
            comparable = first["settled"] and report["settled"] and all(
                r["final"]["state"]["renderer"]["quality"].get("occludedMeshCount") == 0 for r in (first, report))
            comparison["pairs"].append({"backend": report["backend"], "comparable": comparable,
                "sameSets": all(not row["onlyFirst"] and not row["onlyCurrent"] for row in counts.values()), "sets": counts})
        (output / "comparison.json").write_text(json.dumps(comparison, indent=2) + "\n")
    finally:
        stop(client)
        stop(server)
        receipt["serverStopped"] = server is None or server.poll() is not None
        receipt["clientStopped"] = client is None or client.poll() is not None
        receipt["profilesRemoved"] = not list(output.glob("*/profile"))
        receipt["inputsUnchanged"] = all(hashlib.sha256((output / "site" / name).read_bytes()).hexdigest() == row["sha256"]
                                         for name, row in inputs["assets"].items())
        if options.get("terrainUpstream") or options.get("liveImagery"):
            capture_file = output / "capture.json"
            capture = json.loads(capture_file.read_text()) if capture_file.exists() else {}
            receipt["acquisitionClosed"] = capture.get("cleanup") == {"activeRequests": 0, "sockets": 0}
            receipt["captureErrors"] = capture.get("errors", ["Missing acquisition cleanup receipt"])
        (output / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
        print(json.dumps(receipt), flush=True)
        if receipt.get("forcedStop") or not receipt["profilesRemoved"] or not receipt["inputsUnchanged"] or \
                (options.get("terrainUpstream") or options.get("liveImagery")) and (not receipt["acquisitionClosed"] or receipt["captureErrors"]):
            raise RuntimeError("Cleanup or input integrity not proven")


if __name__ == "__main__":
    main()
