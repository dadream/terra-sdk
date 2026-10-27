#!/usr/bin/env python3
"""Judge fixed Web navigation collection; exit zero only on functional acceptance."""
import argparse
import hashlib
import json
from pathlib import Path


def assess(report, config):
    failures = []

    def require(value, message):
        if not value:
            failures.append(message)

    require(report.get("configuration") == config, "Declared navigation case differs")
    require(not report.get("acquisition"), "Acquisition cannot pass offline acceptance")
    require(config.get("acceptanceMs") == 30000 and config.get("stableMs") == 250,
            "Endpoint deadline or stable window changed")
    require(config.get("terrainPixelError") == config.get("imageryPixelError") == 1.25,
            "Precision changed")
    require(report.get("status") == "collected", "Collection failed")
    require(report.get("motionExecuted") is True and report.get("settled") is True and
            report.get("withinOriginalDeadline") is True, "Motion or endpoint convergence failed")
    require(not report.get("errors") and not report.get("error"), "Runtime failure")
    require(report.get("blankSamples") == 0 and report.get("missingSamples") == 0,
            "Motion sampled missing coverage")
    require(not report.get("terrain", {}).get("missingKeys"), "Missing terrain inputs")
    cleanup = report.get("cleanup", {})
    require(all(cleanup.get(k) is True for k in ("runtimeDestroyed", "producerStopped", "canvasRemoved"))
            and cleanup.get("managedBytes") == 0 and not report.get("cleanupErrors"), "Cleanup incomplete")
    phases = report.get("phases", [])
    motions = config.get("motions") or [config["motion"]]
    movement = [p for p in phases if p["name"] == "motion"]
    endpoints = [p for p in phases if p["name"] in ("preparation", "settlement")]
    require(len(movement) == len(motions), "Not all motion legs executed")
    require(len(endpoints) == len(motions) + 1, "Not all endpoints observed")
    for index, phase in enumerate(movement):
        require(index < len(motions) and phase.get("status") == "complete" and
                0 < phase.get("durationMs", 0) <= motions[index]["durationMs"] + 1000,
                "Motion watchdog failed: " + str(index))
    for index, phase in enumerate(endpoints):
        limit = config.get("sourceLimits", {}).get(str(index - 1)) if index else None
        limited = phase.get("status") == "source-limited" and limit is not None
        require((phase.get("status") == "ready" or limited) and 0 < phase.get("durationMs", 0) <= 30000,
                "Endpoint timeout: " + str(index))
        final = phase.get("final", {})
        m, state = final.get("metrics", {}), final.get("state", {})
        renderer = state.get("renderer", {})
        q = renderer.get("quality", {})
        require(all(q.get(k) is True for k in ("cameraCurrent", "terrainSelectionCurrent", "covered",
                                             "geometryTargetComplete")) and
                (limited or q.get("targetMet") is True and q.get("settled") is True) and
                q.get("missingCount") == 0, "Endpoint quality incomplete: " + str(index))
        if limited:
            require(q.get("limitationReasons") == ["source-level"] and q.get("quiescent") is True and
                    q.get("refinableMeasurementCount") == 0 and q.get("resolvedLevelMinimum") ==
                    q.get("resolvedLevelMaximum") == limit["sourceLevel"], "Unproven source limit: " + str(index))
        require(isinstance(m.get("terrainError"), (float, int)) and
                m["terrainError"] <= m.get("terrainThreshold", -1) * 1.001 and
                isinstance(m.get("imageryError"), (float, int)) and
                m["imageryError"] <= (limit["maximumPixelError"] if limited else 1.25) * 1.001 and
                not state.get("resources", {}).get("limitedByCapacity", True),
                "Endpoint precision or capacity failed: " + str(index))
    if config["id"] == "taian-rapid-zoom-v1" and len(endpoints) == 3:
        first = endpoints[0].get("final", {}).get("sets", {})
        last = endpoints[-1].get("final", {}).get("sets", {})
        require(bool(first) and first.keys() == last.keys() and
                all(set(value) == set(last[key]) for key, value in first.items()),
                "Global roundtrip changed converged sets")
    return {"passed": not failures, "failures": failures,
            "endpointMs": [p.get("durationMs") for p in endpoints],
            "endpointStates": [p.get("status") for p in endpoints],
            "peakManagedBytes": report.get("final", {}).get("metrics", {}).get("lifetimeHighWaterBytes"),
            "scope": "Fixed Web functional convergence and state coverage; visual/live acceptance is separate"}


def inspect(folder, live=False):
    root = Path(__file__).resolve().parents[1]
    receipt = json.loads((folder / "receipt.json").read_text())
    inputs = json.loads((folder / "inputs.json").read_text())
    names = {"beijing-oblique-flight-v1": "beijing-oblique-flight-v1.json",
             "taian-rapid-zoom-v1": "taian-rapid-zoom-v1.json"}
    config = json.loads((root / "testdata/benchmarks" / names[inputs["configuration"]["id"]]).read_text())
    rows = []
    for row in receipt.get("runs", []):
        report = json.loads((folder / row["id"] / "report.json").read_text())
        result = assess(report, config)
        if bool(report.get("liveImagery")) != live:
            result["passed"] = False
            result["failures"].append("Live/offline observation differs from requested gate")
        rows.append({"id": row["id"], **result})
    integrity = all(hashlib.sha256((folder / "site" / name).read_bytes()).hexdigest() == asset["sha256"]
                    for name, asset in inputs["assets"].items())
    cleanup = receipt.get("offline") is (not live) and all(receipt.get(k) is True for k in
                  ("collected", "serverStopped", "clientStopped", "profilesRemoved", "inputsUnchanged"))
    if live:
        cleanup = cleanup and receipt.get("acquisitionClosed") is True and not receipt.get("captureErrors")
    cleanup = cleanup and not receipt.get("forcedStop") and all(
        row.get("exitCode") == 0 and row.get("profileRemoved") is True for row in receipt.get("runs", []))
    return {"directory": str(folder), "passed": bool(rows) and integrity and cleanup and
            all(row["passed"] for row in rows), "inputsVerified": integrity, "collectionClosed": cleanup,
            "runs": rows}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true", help="Require closed live proxy as well as runtime cleanup")
    parser.add_argument("directories", nargs="+", type=Path)
    args = parser.parse_args()
    results = []
    for folder in args.directories:
        try:
            results.append(inspect(folder, args.live))
        except (OSError, ValueError, KeyError, TypeError) as error:
            results.append({"directory": str(folder), "passed": False, "error": str(error)})
    print(json.dumps({"schema": "terra.web-navigation-acceptance.v1", "results": results,
                      "passed": all(r["passed"] for r in results)}, indent=2))
    return 0 if all(r["passed"] for r in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
