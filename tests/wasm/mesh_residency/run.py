"""Collect a private ownership diagnostic; never report release acceptance."""
from pathlib import Path
import argparse
import html
import json
import re
import signal
import socket
import subprocess
import time

root = Path(__file__).resolve().parents[3]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--fixture-site", required=True, type=Path)
parser.add_argument("--wasm", required=True, type=Path)
parser.add_argument("--browser", required=True, type=Path)
parser.add_argument("--output", required=True, type=Path)
parser.add_argument("--port", type=int, default=18767)
args = parser.parse_args()
output = args.output.absolute()
server = client = None
receipt = {"passed": False, "collected": False, "offline": True,
           "purpose": "Native ownership diagnostic, not release acceptance"}


def interrupted(signum, frame):
    raise KeyboardInterrupt()


signal.signal(signal.SIGINT, interrupted)
signal.signal(signal.SIGTERM, interrupted)
subprocess.run(["mountpoint", "-q", str(root / "viewer_verify_output")], check=True)
if args.port == 18766:
    raise ValueError("The manual service port cannot be used for a diagnostic")
with socket.socket() as check:
    check.bind(("127.0.0.1", args.port))
subprocess.run(["node", str(Path(__file__).with_name("prepare.js")),
                str(args.fixture_site.absolute()), str(args.wasm.absolute()), str(output)], check=True)
try:
    with (output / "server.log").open("w") as log:
        server = subprocess.Popen(["python3", "-m", "http.server", str(args.port), "--bind", "127.0.0.1",
                                   "--directory", str(output / "site")], stdout=log, stderr=subprocess.STDOUT)
        receipt["serverPid"] = server.pid
        for attempt in range(50):
            if server.poll() is not None:
                raise RuntimeError("Static fixture server exited")
            with socket.socket() as check:
                if check.connect_ex(("127.0.0.1", args.port)) == 0:
                    break
            time.sleep(.1)
        else:
            raise RuntimeError("Static fixture server did not listen")
        with (output / "runner.log").open("w") as log:
            client = subprocess.Popen(["node", str(root / "scripts/run_chromium_evidence.js"),
                "--browser", str(args.browser.absolute()), "--profile", str(output / "profile"),
                "--url", "http://127.0.0.1:%d/" % args.port, "--dom-output", str(output / "dom.html"),
                "--log-output", str(output / "browser.log"), "--progress-output", str(output / "progress.txt"),
                "--progress-element", "status", "--timeout", "240", "--width", "1280", "--height", "900"],
                stdout=log, stderr=subprocess.STDOUT)
            receipt["browserRunnerPid"] = client.pid
            receipt["exitCode"] = client.wait(timeout=270)
        match = re.search(r'<pre id="summary">(.*?)</pre>', (output / "dom.html").read_text(), re.S)
        if match is None:
            raise RuntimeError("Diagnostic report is missing")
        report = json.loads(html.unescape(match.group(1)))
        (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        if (len(report.get("memoryReplay", {}).get("samples", [])) != 24 or
            report["checks"][-1]["detail"] != "Native mesh residency diagnostic collected; not release acceptance"):
            raise RuntimeError("Diagnostic did not reach all original replay samples")
        receipt["collected"] = True
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
    (output / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt))
    if not receipt["profileRemoved"] or receipt.get("forcedStop"):
        raise RuntimeError("Diagnostic cleanup was not proven")
