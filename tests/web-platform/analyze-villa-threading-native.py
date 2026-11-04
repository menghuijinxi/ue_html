import csv
import json
import math
import statistics
import sys
from pathlib import Path


def summarize(values):
    ordered = sorted(values)
    slow = ordered[-max(1, math.ceil(len(ordered) * .01)):]
    return dict(count=len(values), mean=statistics.mean(values), p50=statistics.median(values),
                p95=ordered[int((len(ordered) - 1) * .95)], p99=ordered[int((len(ordered) - 1) * .99)],
                low1Fps=1000/statistics.mean(slow) if sum(slow) else None,
                over33ms=sum(v > 1000/30 for v in values))


def main():
    prefix = Path(sys.argv[1])
    report = json.loads(prefix.with_suffix('.json').read_text(encoding='utf-8-sig'))
    assert report['pass'] and report['configUnchanged']
    csv.field_size_limit(10_000_000)
    pooled = {}
    view_reference = None
    for run in report['runs']:
        with Path(run['csv']).open(encoding='utf-8-sig', newline='') as stream:
            reader = csv.DictReader(stream)
            rows = list(reader)[:run['csvFrames']]
        assert len(rows) == run['csvFrames']
        measured = rows[run['warmupFrames']:run['warmupFrames'] + run['measureFrames']]
        columns = ['FrameTime', 'GameThreadTime', 'RenderThreadTime', 'RHIThreadTime', 'GPUTime', 'RHI/DrawCalls']
        run['metrics'] = {c: summarize([float(r[c]) for r in measured]) for c in columns if c in rows[0]}
        for name, metrics in run['metrics'].items():
            if name != 'FrameTime':
                metrics.pop('low1Fps')
                metrics.pop('over33ms')
        run['fps'] = 1000/run['metrics']['FrameTime']['mean']
        views = {c: sorted(set(r[c] for r in measured)) for c in rows[0] if c and c.startswith('View/') and c not in ('View/Speed', 'View/Speed2D')}
        assert all(len(v) == 1 for v in views.values()), 'Camera moved'
        if view_reference is None: view_reference = views
        assert view_reference == views, 'Different camera between modes'
        run['camera'] = views
        pooled.setdefault(run['mode'], []).extend(float(r['FrameTime']) for r in measured)
    report['summary'] = {mode: dict(fps=1000/statistics.mean(values), frameMs=summarize(values)) for mode, values in pooled.items()}
    prefix.with_name(prefix.name + '-analysis.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'runs': [{'mode': r['mode'], 'fps': r['fps']} for r in report['runs']], 'summary': report['summary']}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
