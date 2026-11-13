'use strict';
globalThis.__villaHistoryVariants = {
  old: {folder: 'villa-vsm-sampling-adaptive-20261112', label: '① 旧自适应 · 835b776'},
  adaptive: {folder: 'villa-git-adaptive-20261113', label: '② 正式自适应 · 2abb246',
    expected: {indirectDrawReuse: null, vsmPageOptimization: null}},
  indirect: {folder: 'villa-git-indirect-20261113', label: '③ 间接绘制复用 · 410778f',
    expected: {indirectDrawReuse: 2, vsmPageOptimization: null}},
  pages: {folder: 'villa-git-pages-20261113', label: '④ 页标记同步 · 23d4f43',
    expected: {indirectDrawReuse: 2, vsmPageOptimization: 3}},
  large: {folder: 'villa-tsr-tiles-20261112', label: '⑤ TSR 大分块 · 628ac0e',
    expected: {indirectDrawReuse: 2, vsmPageOptimization: 3}},
  small: {folder: 'villa-tsr-small-20261112', label: '⑥ TSR 小分块 · 1c25b77',
    expected: {indirectDrawReuse: 2, vsmPageOptimization: 3}},
  warm: {folder: 'villa-tsr-turn-prewarm-20261113', label: '⑤ 补齐转向预热 · 诊断',
    expected: {indirectDrawReuse: 2, vsmPageOptimization: 3}},
};
