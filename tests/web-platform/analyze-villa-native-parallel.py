"""Summarize UE's built-in CSV capture, using its scheduled ABBA frame windows."""
import argparse
import csv
import json
import math
import re
import statistics
from pathlib import Path


def distribution(values):
    ordered = sorted(values)
    return {
        'mean': statistics.mean(values),
        'median': statistics.median(values),
        'p95': ordered[math.ceil(len(ordered) * .95) - 1],
        'min': ordered[0], 'max': ordered[-1],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('prefix', type=Path, help='Path before -launch.json / .csv')
    args = parser.parse_args()
    prefix = str(args.prefix)
    launch = json.loads(Path(prefix + '-launch.json').read_text(encoding='utf-8-sig'))
    complete = json.loads(Path(prefix + '-complete.json').read_text(encoding='utf-8-sig'))
    assert complete['exitCode'] == 0 and complete['configUnchanged']
    log = Path(prefix + '.log').read_text(encoding='utf-8-sig')
    queried_settings = dict(re.findall(r'\]\s*([\w.]+) = "([^"]+)"\s+LastSetBy:', log))
    expected_defaults = {'r.RHICmd.ParallelTranslate.Enable': 'true', 'r.ParallelShadows': '1'}
    if any(p['experiment'] in ('draw-recording', 'mesh-setup', 'combined') for p in launch['phases']):
        expected_defaults.update({'r.RDG.ParallelExecute': '2', 'r.MeshDrawCommands.ParallelPassSetup': '1',
                                  'r.ParallelBasePass': '1', 'r.ParallelPrePass': '1',
                                  'r.ParallelVelocity': '1', 'r.ParallelTranslucency': '1'})
    assert all(queried_settings.get(name) == value for name, value in expected_defaults.items()), 'Unexpected project parallel defaults'
    if '-traceautostart=0' in launch['arguments']:
        assert 'Unreal Insights instance detected, auto-connecting' not in log
    csv.field_size_limit(10_000_000)
    with Path(prefix + '.csv').open(encoding='utf-8-sig', newline='') as stream:
        reader = csv.DictReader(stream)
        columns = reader.fieldnames
        rows = list(reader)
    # UE repeats the header and writes metadata after the captured frame rows.
    assert len(rows) == launch['csvFrames'] + 2
    assert rows[-2]['EVENTS'] == 'EVENTS'
    rows = rows[:launch['csvFrames']]
    metrics = ['FrameTime', 'GameThreadTime', 'RenderThreadTime', 'RHIThreadTime', 'GPUTime',
               'GameThreadTime_CriticalPath', 'RenderThreadTime_CriticalPath',
               'RHI/DrawCalls', 'RHI/PrimitivesDrawn', 'DrawCall/ShadowDepths', 'DrawCall/Lights',
               'GPUMem/LocalUsedMB', 'GPUMem/SystemUsedMB']
    assert all(name in columns for name in metrics)
    view_metrics = [name for name in columns if name.startswith('View/') and name not in ['View/Speed', 'View/Speed2D']]
    rt_metrics = [name for name in columns if name.startswith('Exclusive/RenderThread/')]
    for phase in launch['phases']:
        # csvExecCmds uses a 1-based capture frame; CSV data rows are 0-based.
        marker = rows[phase['commandFrame'] - 1]['EVENTS']
        assert f"CsvExecCommand : r.RHICmd.ParallelTranslate.Enable {phase['translate']}" in marker
        assert f"CsvExecCommand : r.ParallelShadows {phase['shadows']}" in marker
        for name, value in phase.get('flags', {}).items():
            assert f'CsvExecCommand : {name} {value}' in marker
    def phase_rows(phase):
        return rows[phase['startFrame'] - 1:phase['endFrameExclusive'] - 1]
    def summarize(selected):
        report = {'frames': len(selected)}
        for name in metrics:
            values = [float(row[name]) for row in selected]
            assert all(math.isfinite(v) and v >= 0 for v in values), name
            report[name] = distribution(values)
        report['fps'] = 1000 / report['FrameTime']['mean']
        report['framesOver16_67ms'] = sum(float(row['FrameTime']) > 1000/60 for row in selected)
        report['framesOver33_33ms'] = sum(float(row['FrameTime']) > 1000/30 for row in selected)
        report['viewRanges'] = {name: {'min': min(float(row[name]) for row in selected),
                                     'max': max(float(row[name]) for row in selected)} for name in view_metrics}
        exclusive = {name: statistics.mean(float(row[name]) for row in selected) for name in rt_metrics}
        report['topRenderThreadExclusiveMs'] = dict(sorted(exclusive.items(), key=lambda kv: kv[1], reverse=True)[:12])
        return report
    phases = [dict(phase, result=summarize(phase_rows(phase))) for phase in launch['phases']]
    experiments = {}
    for experiment in dict.fromkeys(p['experiment'] for p in launch['phases']):
        states = {}
        for state in ('on', 'off'):
            selected_phases = [p for p in launch['phases'] if p['experiment'] == experiment and p['state'].startswith(state)]
            states[state] = summarize([row for phase in selected_phases for row in phase_rows(phase)])
        states['onFpsGainPercent'] = (states['on']['fps'] / states['off']['fps'] - 1) * 100
        states['onFrameTimeReductionPercent'] = (1 - states['on']['FrameTime']['mean'] / states['off']['FrameTime']['mean']) * 100
        experiments[experiment] = states
    # Camera values must stay fixed within and between all measured windows.
    view_reference = phases[0]['result']['viewRanges']
    assert all(p['result']['viewRanges'] == view_reference for p in phases), 'Camera moved during capture'
    assert all(v['min'] == v['max'] for v in view_reference.values()), 'Camera changed within a window'
    restoration = rows[launch['phases'][-1]['endFrameExclusive'] - 1]['EVENTS']
    assert 'r.RHICmd.ParallelTranslate.Enable 1' in restoration and 'r.ParallelShadows 1' in restoration
    for name, value in launch['phases'][-1].get('flags', {}).items():
        assert f'CsvExecCommand : {name} {value}' in restoration
    environment_file = Path(prefix + '-environment.jsonl')
    samples = [json.loads(line) for line in environment_file.read_text(encoding='utf-8-sig').splitlines() if line]
    gpu_util = []
    for sample in samples:
        if sample['gpu']:
            gpu_util.append(float(sample['gpu'].split(',')[1].strip().removesuffix('%').strip()))
    external = {}
    for sample in samples:
        for process in sample['topCpu']:
            if process['pid'] != launch['pid']:
                external[process['name']] = max(external.get(process['name'], 0), process['cpuCores'])
    report = {
        'pass': True, 'launch': launch, 'complete': complete, 'csvColumns': len(columns), 'queriedSettings': queried_settings,
        'phases': phases, 'experiments': experiments,
        'environment': {'samples': len(samples), 'wholeRunGpuUtilizationPercent': distribution(gpu_util) if gpu_util else None,
                        'peakExternalCpuCores': dict(sorted(external.items(), key=lambda kv: kv[1], reverse=True)[:12])},
        'limitations': [
            'Standalone -game / RenderOffscreen using installed UE editor, not a cooked Shipping build.',
            'Default project renderer/scalability; output resolution fixed by launch args. Web uses a different shader platform / AA / internal resolution.',
            'CSV instrumentation and background desktop processes remain active. This measures this native scene, not the speedup a Web parallel implementation would achieve.',
            'RHIT does not include worker thread translation time; Game / Draw / RHI / GPU overlap and must not be summed.',
            'No outliers removed; each comparison has two equal frame-count windows per state.',
        ],
    }
    Path(prefix + '-analysis.json').write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print('experiment,state,FPS,Frame_ms,Game_ms,Draw_ms,RHIT_ms,GPU_ms,DrawCalls,ShadowDraws')
    for experiment, states in experiments.items():
        for state in ('on', 'off'):
            r = states[state]
            print(','.join([experiment, state, f"{r['fps']:.3f}"] + [f"{r[name]['mean']:.4f}" for name in
                ('FrameTime', 'GameThreadTime', 'RenderThreadTime', 'RHIThreadTime', 'GPUTime', 'RHI/DrawCalls', 'DrawCall/ShadowDepths')]))
        print(f"{experiment} enabled FPS gain: {states['onFpsGainPercent']:.2f}%")


if __name__ == '__main__':
    main()
