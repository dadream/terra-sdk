from copy import deepcopy
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
from check_web_sdk_evidence import validate_canvas_presentation


viewport = {"cssWidth": 640, "cssHeight": 360, "physicalWidth": 640, "physicalHeight": 360, "devicePixelRatio": 1}
phase = {"connected": True, "sampledUnobscured": True, "documentVisibility": "visible",
         "left": 8, "top": 8, "windowWidth": 1280, "windowHeight": 1000,
         "cssWidth": 640, "cssHeight": 360, "bufferWidth": 640, "bufferHeight": 360,
         "devicePixelRatio": 1, "displayDevicePixelRatio": 1}
evidence = {"viewport": viewport, "canvasPresentation": {"schema": "terra.canvas-presentation.v1",
            "phases": [dict(phase, phase=name) for name in ["preparation", "motion", "settlement", "complete"]]}}
validate_canvas_presentation(evidence)


def rejected(value):
    try:
        validate_canvas_presentation(value)
    except SystemExit:
        return
    raise AssertionError("Invalid canvas presentation was accepted")


rejected({"viewport": viewport})
for key, value in [("connected", False), ("sampledUnobscured", False), ("documentVisibility", "hidden"),
                   ("left", -1), ("top", -1), ("windowWidth", 647), ("windowHeight", 367),
                   ("cssWidth", 639), ("bufferWidth", 641), ("devicePixelRatio", 2),
                   ("windowWidth", float("inf")), ("windowHeight", None), ("displayDevicePixelRatio", 0)]:
    invalid = deepcopy(evidence)
    invalid["canvasPresentation"]["phases"][1][key] = value
    rejected(invalid)
for names in [["preparation", "settlement", "complete"], ["preparation", "motion", "motion", "complete"]]:
    invalid = deepcopy(evidence)
    invalid["canvasPresentation"]["phases"] = [dict(phase, phase=name) for name in names]
    rejected(invalid)
print("Canvas presentation evidence rejects missing phases, detached/hidden/obscured views, invalid sizes and viewport escape")
