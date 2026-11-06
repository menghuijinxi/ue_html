"""Render the retained views and every static timing window for human review."""
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
    for column, bits in enumerate([64, 32]):
        file = root / f'parity-address{bits}-compute-gpu-20261106-tour-{view}.png'
        im = Image.open(file).convert('RGB')
        assert im.size in [(1280, 720), (1281, 721)]  # Canvas locator may include its border.
        arrays.append(np.asarray(im).astype(float))
        im.thumbnail((640, 360))
        contact.paste(im, (column * 640, row * 385 + 25))
        draw.text((column * 640 + 8, row * 385 + 6),
                  f'{view} / {"control" if bits == 64 else "candidate"}', fill='white')
    assert arrays[0].shape == arrays[1].shape
    mask = np.ones(arrays[0].shape[:2], dtype=bool)
    mask[:240, :280] = False  # Exclude the live performance overlay.
    a, b = (array[mask] for array in arrays)
    delta = np.abs(a - b)
    metrics.append(dict(view=view, meanAbsoluteChannelDifference=float(delta.mean()),
                        channelFractionOver8=float((delta > 8).mean()),
                        meanRGBControl=float(a.mean()), meanRGBCandidate=float(b.mean())))
contact.save(root / 'parity-memory-visual-20261106.jpg', quality=92)
(root / 'parity-memory-visual-20261106.json').write_text(json.dumps(dict(
    hudExcluded=[0, 0, 280, 240], views=metrics,
    boundary='Descriptive image differences, not automatic visual acceptance. Temporal lighting and AA can differ.'
), indent=2) + '\n', encoding='utf8')

windows = [(64, 'normal-1'), (32, 'normal-1'), (32, 'normal-2'), (64, 'normal-2'),
           (64, 'postcleanup'), (32, 'postcleanup')]
fig, axes = plt.subplots(6, 1, figsize=(13, 11), layout='constrained')
for ax, (bits, name) in zip(axes, windows):
    report = json.loads((root / f'parity-address{bits}-compute-{name}-20261106.json').read_text(encoding='utf8'))
    run = report['runs'][0]
    times = np.array([f['at'] for f in run['capture']['frames']])
    intervals = np.diff(times)
    s = run['result']
    ax.plot((times[1:] - times[0]) / 1000, intervals, linewidth=.45,
            color='#248578' if bits == 32 else '#61758a')
    ax.axhline(33.333, color='#ae693a', linestyle='--', linewidth=.7)
    ax.set_ylim(0, max(75, intervals.max() * 1.05))
    ax.set_xlim(0, report['seconds'])
    ax.set_ylabel('ms')
    ax.grid(alpha=.15)
    ax.set_title(f'{"Candidate" if bits == 32 else "Control"} / {name}: '
                 f'{s["fps"]:.2f} FPS, 1% low {s["low1"]:.2f}, max {s["max"]:.2f} ms', loc='left', fontsize=10)
axes[-1].set_xlabel('Seconds within each independent window')
fig.suptitle('TriplexHouseVilla: all static windows, no long frames removed\n'
             'RHI submission intervals; not physical presentation times', fontsize=13)
fig.savefig(root / 'parity-memory-frame-times-20261106.png', dpi=140)
print(json.dumps(metrics))
