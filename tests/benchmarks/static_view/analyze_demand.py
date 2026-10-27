#!/usr/bin/env python3
"""Attribute observed requests to immutable requirement versions, offline only."""
import argparse
from collections import Counter, defaultdict
import json
from pathlib import Path


def ancestors(key):
    level, matrix, row, column = map(int, key.split('/'))
    while level:
        level -= 1
        matrix -= 1
        row //= 2
        column //= 2
        yield f'{level}/{matrix}/{row}/{column}'


def analyze(report):
    if not report['settled']:
        raise ValueError('An unsettled view has no final target reference')
    trace = report['pipeline']
    if trace['truncated']:
        raise ValueError('Truncated observation cannot prove request provenance')
    final = set(report['final']['sets']['targetImages'])
    final_ancestors = {ancestor for key in final for ancestor in ancestors(key)}
    demands = {row['id']: row for row in trace['demands']}
    counts, phases, requests = Counter(), defaultdict(Counter), []
    for image in trace['images']:
        key = image['key']
        demand = demands.get(image.get('demandId'))
        category = 'final' if key in final else 'ancestor' if key in final_ancestors else \
            'finer-than-final' if final.intersection(ancestors(key)) else 'other'
        used = image.get('displayMs') is not None
        phase = 'unknown' if demand is None else 'preview' if demand['preview'] else \
            'complete' if demand['complete'] else 'fitted' if demand['fitted'] else 'coverage'
        sequence = None if demand is None else demand.get('sequence')
        label = f'{sequence}:{phase}'
        counts[category] += 1
        if not used:
            counts[category + '-no-draw'] += 1
        phases[label]['requests'] += 1
        phases[label][category] += 1
        if not used:
            phases[label]['no-draw'] += 1
        requests.append({'key': key, 'category': category, 'drawObserved': used,
                         'requestMs': image['requestMs'], 'demandId': image.get('demandId'),
                         'sequence': sequence, 'phase': phase,
                         'target': image.get('target'), 'targetFlags': image.get('targetFlags'),
                         'refinable': None if demand is None else demand.get('refinable'),
                         'root': image.get('root'), 'coverage': image.get('coverage'),
                         'candidate': image.get('candidate'), 'forecast': image.get('forecast')})
    unique = Counter(image['key'] for image in trace['images'])
    return {'schema': 'terra.request-demand-analysis.v1', 'sdkProductAccepted': False,
            'scope': 'Post-observer requests. Draw use is renderSurface submission intent, not a completed GPU/display receipt. Non-final does not alone mean unnecessary.',
            'settled': report['settled'], 'durationMs': report['durationMs'],
            'lastMeshMs': report['postCreation']['lastMeshMs'],
            'firstCompleteForLastMeshMs': report['postCreation']['firstCompleteForLastMeshMs'],
            'requestCount': len(trace['images']), 'uniqueKeys': len(unique),
            'repeatedKeys': sum(n - 1 for n in unique.values()), 'finalTargets': len(final),
            'peakManagedBytes': max(s['highWaterBytes'] for s in report['samples']),
            'counts': dict(counts), 'phases': dict(phases), 'requests': requests}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('report', type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    result = analyze(json.loads(args.report.read_text()))
    with args.output.open('x') as output:
        output.write(json.dumps(result, indent=2) + '\n')
    print(json.dumps({k: v for k, v in result.items() if k not in ['requests', 'scope']}))
