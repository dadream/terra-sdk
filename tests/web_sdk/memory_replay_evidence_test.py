from copy import deepcopy
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
from check_web_sdk_evidence import validate_memory_replay


work = {"worldPreparing": False, "worldMaintenance": 0, "pendingWork": 0,
        "pendingRender": False, "pendingAnimations": 0, "pendingInputs": 0, "nativeRequests": 0}
ownership = {key: 0 for key in ("nativeMeshBytes", "decodedRecordBytes", "heightBytes", "topologyNodes",
                              "imageryInputBytes", "imageryReferenceBytes", "imageryOutputBytes",
                              "measurementHistoryBytes", "nativeModels")}
native_keys = ("nativeMeshBytes", "decodedRecordBytes", "heightBytes", "imageryInputBytes",
               "imageryReferenceBytes", "imageryOutputBytes")
capacity = {"bytes": 1000, "maximumBytes": 2000, "highWaterBytes": 1500,
            "reservedBytes": 100, "residentBytes": 800, "retiredBytes": 100,
            "native": {key: 0 for key in native_keys}}
replay = {"warmupLaps": 1, "viewsPerLap": 8, "samples": [
    {"lap": index // 8, "view": index % 8, "warmup": index < 8,
     "memoryBytes": 24 * 1024 * 1024, "meshIdentity": str(index % 8),
     "ownership": dict(ownership), "work": dict(work), "capacity": deepcopy(capacity)}
    for index in range(24)]}
replay["heapCapacity"] = {"firstMaximumBytes": 24*1024*1024, "secondMaximumBytes": 24*1024*1024,
                          "growthBytes": 0, "plateau": True}
pixels = {"width": 640, "height": 360, "fnv1a32": 123, "nonBackgroundPixels": 20000, "sampledColorCount": 8}
replay["nativeReclamation"] = {
    "required": {"drawCount": 3, "meshCount": 2, "uvCount": 1, "positionBytes": 144, "uvBytes": 48},
    "beforeBytes": 1024, "releasedBytes": 832, "afterBytes": 192, "ledgerBytes": 192,
    "beforeSequence": 100, "afterSequence": 100, "beforeIdentity": "7", "afterIdentity": "7",
    "pixelsBefore": pixels, "pixelsAfter": dict(pixels)}
validate_memory_replay(replay)


def rejected(value):
    try:
        validate_memory_replay(value)
    except SystemExit:
        return
    raise AssertionError("Invalid memory replay was accepted")


rejected({})
for key in ownership:
    for value in (None, True, -1, 0.5, float("inf")):
        invalid = deepcopy(replay)
        invalid["samples"][12]["ownership"][key] = value
        rejected(invalid)
    invalid = deepcopy(replay)
    del invalid["samples"][12]["ownership"][key]
    rejected(invalid)
for key in work:
    invalid = deepcopy(replay)
    invalid["samples"][12]["work"][key] = True if type(work[key]) is bool else 1
    rejected(invalid)
    del invalid["samples"][12]["work"][key]
    rejected(invalid)
for key, value in [("lap", 3), ("view", 9), ("warmup", True), ("memoryBytes", None),
                   ("memoryBytes", 0), ("memoryBytes", float("inf")), ("meshIdentity", None)]:
    invalid = deepcopy(replay)
    invalid["samples"][12][key] = value
    rejected(invalid)
for count in [16, 23, 25]:
    invalid = deepcopy(replay)
    invalid["samples"] = (invalid["samples"] * 2)[:count]
    rejected(invalid)
invalid = deepcopy(replay)
invalid["samples"][23]["memoryBytes"] += 65536
# Growth must remain visible, even when it does not indicate retained payload.
rejected(invalid)
invalid["heapCapacity"].update(secondMaximumBytes=24*1024*1024+65536, growthBytes=65536, plateau=False)
validate_memory_replay(invalid)
for key in ("bytes", "maximumBytes", "highWaterBytes", "reservedBytes", "residentBytes", "retiredBytes"):
    for value in (None, True, -1, 0.5):
        invalid = deepcopy(replay)
        invalid["samples"][12]["capacity"][key] = value
        rejected(invalid)
for values in ({"bytes": 1001}, {"highWaterBytes": 999}, {"highWaterBytes": 2001},
               {"maximumBytes": 3000}, {"highWaterBytes": 1499}, {"maximumBytes": 0}):
    invalid = deepcopy(replay)
    invalid["samples"][12]["capacity"].update(values)
    rejected(invalid)
for key in native_keys:
    invalid = deepcopy(replay)
    invalid["samples"][12]["capacity"]["native"][key] = 1
    rejected(invalid)
    invalid = deepcopy(replay)
    invalid["samples"][12]["capacity"]["native"][key] = 801
    invalid["samples"][12]["ownership"][key] = 801
    rejected(invalid)
invalid = deepcopy(replay)
invalid["samples"][12]["memoryBytes"] -= 65536
rejected(invalid)
invalid = deepcopy(replay)
del invalid["heapCapacity"]
rejected(invalid)
invalid = deepcopy(replay)
invalid["samples"][23]["meshIdentity"] = "different"
rejected(invalid)
for key, value in [("warmupLaps", 2), ("viewsPerLap", 9)]:
    invalid = deepcopy(replay)
    invalid[key] = value
    rejected(invalid)
for key in ("beforeBytes", "releasedBytes", "afterBytes", "ledgerBytes", "beforeSequence", "afterSequence"):
    for value in (None, True, -1, 0, 0.5):
        invalid = deepcopy(replay)
        invalid["nativeReclamation"][key] = value
        rejected(invalid)
    invalid = deepcopy(replay)
    invalid["nativeReclamation"][key] += 1
    rejected(invalid)
for key in ("drawCount", "meshCount", "uvCount", "positionBytes", "uvBytes"):
    invalid = deepcopy(replay)
    del invalid["nativeReclamation"]["required"][key]
    rejected(invalid)
for key, value in [("nativeReclamation", {}), ("nativeReclamation", {"passed": True})]:
    invalid = deepcopy(replay)
    invalid[key] = value
    rejected(invalid)
for key, value in [("afterIdentity", "leaked"), ("pixelsAfter", {**pixels, "fnv1a32": 124})]:
    invalid = deepcopy(replay)
    invalid["nativeReclamation"][key] = value
    rejected(invalid)
invalid = deepcopy(replay)
invalid["nativeReclamation"]["pixelsBefore"] = invalid["nativeReclamation"]["pixelsAfter"] = {**pixels, "nonBackgroundPixels": 0}
rejected(invalid)
print("Memory evidence requires bounded and reconciled ownership, exact Native refunds and unchanged pixels; heap growth stays explicit")
