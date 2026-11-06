"""Render the retained mouse-input measurements and five-view review sheet."""
import json
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root / '.tools/perf-plot-deps'))
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from PIL import Image, ImageDraw

results = root / 'tests/web-platform/results'
report = json.loads((root / 'tests/web-platform/evidence/villa-mouse-query-20261106.json').read_text())
colors = {'control': '#557fa3', 'candidate': '#d78a40'}
fig, axes = plt.subplots(1, 2, figsize=(11, 4), layout='constrained')
for kind in colors:
    values = []
    for window in report['normal'][kind]['windows']:
        raw = json.loads((results / (window['tag'] + '.json')).read_text())
        times = raw['runs'][0]['measurement']
        values.extend(b - a for a, b in zip(times, times[1:]))
    values.sort()
    axes[0].plot([100 * (i + 1) / len(values) for i in range(len(values))], values,
                 label=kind, color=colors[kind])
axes[0].set(xlim=(90, 100), xlabel='Frame-time percentile', ylabel='Submission interval (ms)',
            title='Tail frame time: all stalls retained')
axes[0].legend()
windows = [report['normal'][kind]['windows'][i] for kind, i in
           [('control', 0), ('candidate', 0), ('candidate', 1), ('control', 1)]]
axes[1].bar(['A1', 'B1', 'B2', 'A2'], [w['result']['low1'] for w in windows],
            color=[colors[k] for k in ['control', 'candidate', 'candidate', 'control']])
axes[1].set(ylabel='1% Low (FPS)', ylim=(0, 60), title='No stable improvement in mouse-turn lows')
for ax in axes:
    ax.grid(axis='y', alpha=.2)
fig.savefig(results / 'mouse-query-tail-20261106.png', dpi=160)

sheet = Image.new('RGB', (1000, 5 * 305), '#182026')
draw = ImageDraw.Draw(sheet)
for column, kind in enumerate(['control', 'candidate']):
    for row, view in enumerate(report['validation'][kind]['tour']):
        with Image.open(view['image']['file']) as source:
            source.thumbnail((492, 277))
            sheet.paste(source, (column * 500 + 4, row * 305 + 24))
        draw.text((column * 500 + 8, row * 305 + 5), kind + ' / ' + view['name'], fill='white')
sheet.save(results / 'mouse-query-views-20261106.jpg', quality=90)
