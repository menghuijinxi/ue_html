"""Retain every turn-frame sample and paired views for review."""
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
fig, axes = plt.subplots(4, 1, figsize=(13, 10), layout='constrained')
for ax, tag in zip(axes, ['a1', 'b1', 'b2', 'a2']):
    report = json.loads((root / f'turning-clear-{tag}-20261106.json').read_text())
    phase = next(p for p in report['runs'][0]['phases'] if p['name'] == 'turning')
    times = np.array(phase['data']['times'])
    dt = np.diff(times)
    tail = np.sort(dt)[-int(np.ceil(len(dt) * .01)):]
    ax.plot((times[1:] - times[0]) / 1000, dt, linewidth=.45,
            color='#228977' if tag.startswith('b') else '#596e91')
    ax.axhline(33.333, color='#b66a30', linestyle='--', linewidth=.7)
    ax.set_xlim(0, 30)
    ax.set_ylim(0, max(55, dt.max() * 1.05))
    ax.set_ylabel('RHI interval (ms)')
    ax.grid(alpha=.16)
    ax.set_title(f'{tag.upper()} / {"candidate" if tag.startswith("b") else "control"}: '
                 f'{1000 / dt.mean():.2f} FPS, low {1000 / tail.mean():.2f}, max {dt.max():.2f} ms', loc='left')
axes[-1].set_xlabel('Seconds; fixed 360-degree camera turn')
fig.savefig(root / 'turning-clear-frames-20261106.png', dpi=140)

views = ['right', 'back', 'left', 'room', 'return']
contact = Image.new('RGB', (1280, 385 * len(views)), '#161a1d')
draw = ImageDraw.Draw(contact)
metrics = []
for row, view in enumerate(views):
    arrays = []
    for column, kind in enumerate(['control', 'candidate']):
        file = root / f'turning-clear-{kind}-validation-20261106-tour-{view}.png'
        im = Image.open(file).convert('RGB')
        arrays.append(np.asarray(im).astype(float))
        im.thumbnail((640, 360))
        contact.paste(im, (column * 640, row * 385 + 25))
        draw.text((column * 640 + 8, row * 385 + 6), f'{view} / {kind}', fill='white')
    assert arrays[0].shape == arrays[1].shape
    mask = np.ones(arrays[0].shape[:2], dtype=bool)
    mask[:240, :280] = False
    delta = np.abs(arrays[0][mask] - arrays[1][mask])
    metrics.append(dict(view=view, meanAbsoluteChannelDifference=float(delta.mean()),
                        channelFractionOver8=float((delta > 8).mean())))
contact.save(root / 'turning-clear-views-20261106.jpg', quality=92)
(root / 'turning-clear-views-20261106.json').write_text(json.dumps(dict(
    hudExcluded=[0, 0, 280, 240], views=metrics,
    boundary='Descriptive differences including temporal AA/lighting, not automatic visual acceptance.'
), indent=2) + '\n')
