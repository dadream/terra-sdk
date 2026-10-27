#!/usr/bin/env python3
"""Read bounded stage observations without running a browser or a service."""
import argparse
from collections import Counter
import json
from pathlib import Path


def analyze(report):
    trace = report['pipeline']
    samples = trace['samples']
    fields = ('managedBytes', 'managedMaximumBytes', 'partitionBytes', 'partitionReservedBytes',
              'partitionCpuBytes', 'partitionCapacityBytes', 'inputBytes', 'maximumInputBytes',
              'inputHighWaterBytes', 'pipelineBytes', 'maximumPipelineBytes', 'groupState')
    if trace['truncated'] or not samples or any(any(k not in s for k in fields) for s in samples):
        raise ValueError('Complete stage-capacity observation is required; missing is not zero')

    def stage(used, capacity):
        pairs = [(used(s), s[capacity]) for s in samples]
        if any(limit <= 0 for _, limit in pairs):
            raise ValueError('Capacity must be finite and positive')
        return {'configuredBytes': sorted({limit for _, limit in pairs}),
                'sampledPeakBytes': max(size for size, _ in pairs),
                'sampledPeakFraction': max(size / limit for size, limit in pairs)}

    waiting = Counter()
    for row in trace['work'].values():
        if row['name'] == 'imageAdmission':
            waiting.update({k: v for k, v in row.items() if k.startswith('waiting_with_') or
                            k in ('waiting', 'blocked', 'ready', 'world_waiting', 'private_waiting', 'handoff_waiting')})
    groups = trace['groups']
    funded = [g for g in groups if 'fundedMs' in g]
    seconds = []
    for second in sorted({int(s['timeMs'] // 1000) for s in samples}):
        rows = [s for s in samples if int(s['timeMs'] // 1000) == second]
        phases = Counter('none' if not s['groupState'] else
                         s['groupState']['kind'] + ':' + s['groupState']['phase'] for s in rows)
        seconds.append({'second': second, 'samples': len(rows),
                        'requestsStarted': sum(int(i['requestMs'] // 1000) == second for i in trace['images']),
                        'maximumActiveRequests': max(s['requests'] for s in rows),
                        'maximumQueuedRequests': max(s['queued'] for s in rows),
                        'maximumInputWaiting': max(s['waitingInput'] for s in rows),
                        'worldPreparingSamples': sum(bool(s['worldPreparing']) for s in rows),
                        'meshPlanSamples': sum(bool(s['meshOutputPlan']) for s in rows),
                        'uvProducerSamples': sum(bool(s['partitionActive']) for s in rows),
                        'uvUploadSamples': sum(bool(s['partitionUploads']) for s in rows),
                        'groupPhases': dict(phases)})
    return {'schema': 'terra.stage-capacity-analysis.v1', 'sdkProductAccepted': False,
            'scope': 'Post-observer samples and actual calls. Wait counters overlap and count attempts, not unique requests or critical-path time. Sampled peaks can miss transients; no refusal does not prove arbitrary workloads fit.',
            'settled': report['settled'], 'durationMs': report['durationMs'],
            'withinOriginalDeadline': report['withinOriginalDeadline'],
            'managed': {**stage(lambda s: s['managedBytes'], 'managedMaximumBytes'),
                        'ledgerPeakBytes': report['final']['metrics']['lifetimeHighWaterBytes']},
            'partition': stage(lambda s: s['partitionBytes'] + s['partitionReservedBytes'] +
                              s['partitionCpuBytes'], 'partitionCapacityBytes'),
            'input': {**stage(lambda s: s['inputBytes'], 'maximumInputBytes'),
                      'recordedPeakBytes': max(s['inputHighWaterBytes'] for s in samples)},
            'pipeline': stage(lambda s: s['pipelineBytes'], 'maximumPipelineBytes'),
            'unfundedGroups': sum(bool(g.get('unfunded')) for g in groups),
            'maximumPartitionShortfallBytes': max((g.get('partitionShortfallBytes', 0) for g in groups), default=0),
            'observedSharedShortfallBytes': max((g.get('sharedShortfallBytes', 0) for g in groups), default=0),
            'fundedGroups': len(funded), 'waitingAttempts': dict(waiting), 'seconds': seconds,
            'cleanup': report['cleanup']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('report', type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    result = analyze(json.loads(args.report.read_text()))
    with args.output.open('x') as output:
        output.write(json.dumps(result, indent=2) + '\n')
    print(json.dumps({k: v for k, v in result.items() if k not in ('seconds', 'scope')}))
