import copy
import unittest

from analyze_capacity import analyze


class CapacityEvidenceTest(unittest.TestCase):
    def fixture(self):
        sample = dict(timeMs=1000, managedBytes=100, managedMaximumBytes=1000, partitionBytes=40,
                      partitionReservedBytes=20, partitionCpuBytes=10, partitionCapacityBytes=100,
                      inputBytes=1, maximumInputBytes=10, inputHighWaterBytes=4,
                      pipelineBytes=5, maximumPipelineBytes=20, requests=0, queued=4,
                      waitingInput=0, worldPreparing=False, meshOutputPlan=False,
                      partitionActive=True, partitionUploads=0,
                      groupState={'kind': 'display', 'phase': 'outputs'})
        return dict(settled=False, durationMs=30000, withinOriginalDeadline=False,
                    final={'metrics': {'lifetimeHighWaterBytes': 250}}, cleanup={'managedBytes': 0},
                    pipeline=dict(truncated=False, samples=[sample], images=[], groups=[
                        {'unfunded': 1, 'partitionShortfallBytes': 20}],
                        work={'imageAdmission:1': dict(name='imageAdmission', waiting=5,
                                                      waiting_with_display_outputs=5,
                                                      waiting_with_uv_producer=5)}))

    def test_local_shortfall_is_not_hidden_by_global_headroom(self):
        result = analyze(self.fixture())
        self.assertEqual(result['managed']['ledgerPeakBytes'], 250)
        self.assertEqual(result['maximumPartitionShortfallBytes'], 20)
        self.assertEqual(result['input']['recordedPeakBytes'], 4)
        self.assertEqual(result['seconds'][0]['groupPhases'], {'display:outputs': 1})
        self.assertEqual(result['waitingAttempts']['waiting'], 5)
        self.assertFalse(result['sdkProductAccepted'])

    def test_sampled_peaks_use_their_own_capacity(self):
        report = self.fixture()
        later = copy.deepcopy(report['pipeline']['samples'][0])
        later.update(timeMs=2000, partitionBytes=100, partitionCapacityBytes=200)
        report['pipeline']['samples'].append(later)
        result = analyze(report)
        self.assertEqual(result['partition']['sampledPeakBytes'], 130)
        self.assertEqual(result['partition']['sampledPeakFraction'], .7)

    def test_missing_and_truncated_evidence_never_becomes_zero_pressure(self):
        report = self.fixture()
        del report['pipeline']['samples'][0]['groupState']
        with self.assertRaises(ValueError):
            analyze(report)
        report = self.fixture()
        report['pipeline']['truncated'] = True
        with self.assertRaises(ValueError):
            analyze(report)


if __name__ == '__main__':
    unittest.main()
