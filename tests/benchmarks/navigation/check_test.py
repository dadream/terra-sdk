import copy
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("check_navigation", ROOT / "scripts/check_navigation.py")
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


class Acceptance(unittest.TestCase):
    def setUp(self):
        self.config = json.loads((ROOT / "testdata/benchmarks/beijing-oblique-flight-v1.json").read_text())
        final = {"metrics": {"terrainError": 1, "terrainThreshold": 1.25, "imageryError": 1.25},
                 "state": {"resources": {"limitedByCapacity": False}, "renderer": {"quality": {
                     **dict.fromkeys(("cameraCurrent", "terrainSelectionCurrent", "covered",
                                      "geometryTargetComplete", "targetMet", "settled"), True), "missingCount": 0}}}}
        self.report = {"configuration": self.config, "status": "collected", "motionExecuted": True,
                       "settled": True, "withinOriginalDeadline": True, "blankSamples": 0, "missingSamples": 0,
                       "cleanup": {"runtimeDestroyed": True, "producerStopped": True,
                                   "canvasRemoved": True, "managedBytes": 0},
                       "phases": [{"name": "preparation", "status": "ready", "durationMs": 2000, "final": final},
                                  {"name": "motion", "status": "complete", "durationMs": 8100},
                                  {"name": "settlement", "status": "ready", "durationMs": 3000, "final": copy.deepcopy(final)}]}

    def test_ready(self):
        self.assertTrue(checker.assess(self.report, self.config)["passed"])

    def test_collection_is_not_acceptance(self):
        for key, value in [("settled", False), ("motionExecuted", False), ("blankSamples", 1), ("missingSamples", 1)]:
            report = {**self.report, key: value}
            self.assertFalse(checker.assess(report, self.config)["passed"], key)

    def test_deadline_cleanup_precision(self):
        cases = [copy.deepcopy(self.report) for _ in range(4)]
        cases[0]["phases"][-1]["durationMs"] = 30001
        cases[1]["cleanup"]["managedBytes"] = 522150
        cases[2]["phases"][-1]["final"]["metrics"]["imageryError"] = 1.5
        cases[3]["terrain"] = {"missingKeys": ["2/1/2/3"]}
        for report in cases:
            self.assertFalse(checker.assess(report, self.config)["passed"])


if __name__ == "__main__":
    unittest.main()
