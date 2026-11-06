"""Retain visual comparisons and every window of the periodic-stall crossover."""
from pathlib import Path
import json
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / '.tools' / 'perf-plot-deps'))
import numpy as np
from PIL import Image, ImageDraw
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

root = Path(__file__).resolve().parent / 'results'
views = ['right', 'back', 'left', 'room', 'return']
contact = Image.new('RGB', (1280, 385 * len(views)), '#161a1d')
draw = ImageDraw.Draw(contact)
metrics = []
for row, view in enumerate(views):
    arrays = []
    for column, name in enumerate(['control', 'transient']):
        file = root / f'periodic-owner-{name}-gpu-20261106-tour-{view}.png'
        im = Image.open(file).convert('RGB')
        arrays.append(np.asarray(im).astype(float))
        im.thumbnail((640, 360))
        contact.paste(im, (column * 640, row * 385 + 25))
        draw.text((column * 640 + 8, row * 385 + 6), f'{view} / {name}', fill='white')
    assert arrays[0].shape == arrays[1].shape
    mask = np.ones(arrays[0].shape[:2], dtype=bool)
    mask[:240, :280] = False
    a, b = (array[mask] for array in arrays)
    delta = np.abs(a - b)
    metrics.append(dict(view=view, meanAbsoluteChannelDifference=float(delta.mean()),
                        channelFractionOver8=float((delta > 8).mean())))
contact.save(root / 'periodic-visual-comparison-20261106.jpg', quality=92)
(root / 'periodic-visual-comparison-20261106.json').write_text(json.dumps(dict(
    hudExcluded=[0, 0, 280, 240], views=metrics,
    boundary='Temporal AA/lighting can differ. This comparison is descriptive, not automatic visual acceptance. GPU diagnostic used four credits; final timing uses three.'
), indent=2) + '\n', encoding='utf8')

windows = [('b1', 0), ('a1', 0), ('a1', 1), ('b2', 0)]
fig, axes = plt.subplots(4, 1, figsize=(13, 9), layout='constrained')
for ax, (tag, index) in zip(axes, windows):
    r = json.loads((root / f'periodic-final-{tag}-20261106.json').read_text())['runs'][index]
    times = np.array([f['at'] for f in r['capture']['frames']])
    intervals = np.diff(times)
    s = r['result']
    ax.plot((times[1:] - times[0]) / 1000, intervals, linewidth=.5,
            color='#248578' if tag.startswith('b') else '#61758a')
    ax.axhline(33.333, color='#ae693a', linestyle='--', linewidth=.7)
    ax.set_ylim(0, 55)
    ax.set_xlim(0, 60)
    ax.set_ylabel('ms')
    ax.grid(alpha=.15)
    ax.set_title(f'{"Candidate" if tag.startswith("b") else "Control"}: '
                 f'{s["fps"]:.2f} FPS, 1% low {s["low1"]:.2f}, max {s["max"]:.2f} ms', loc='left', fontsize=10)
axes[-1].set_xlabel('Seconds within each independent window')
fig.suptitle('TriplexHouseVilla: B / A / A / B, all intervals retained\n'
             'RHI submissions; periodic stalls reduced, not eliminated', fontsize=13)
fig.savefig(root / 'periodic-frame-times-20261106.png', dpi=140)
print(json.dumps(metrics))
