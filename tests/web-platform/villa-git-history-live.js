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
  warm2: {folder: 'villa-tsr-turn-prewarm2-20261113', label: '⑤ 预热第二批 · 诊断',
    expected: {indirectDrawReuse: 2, vsmPageOptimization: 3}},
};

if (new URLSearchParams(location.search).get('comparison') === 'merge') {
  globalThis.__villaHistoryVariants = {
    baseline: {folder: 'villa-pso-eager-20261117-d/release', label: '合并前老版',
      expected: {indirectDrawReuse: 2, vsmPageOptimization: 3}},
    merged: {folder: 'villa-nanite-merged-20261118-raw-mouse', label: '合并后鼠标对照版',
      expected: {indirectDrawReuse: 2, vsmPageOptimization: 3}},
    r8: {folder: 'villa-nanite-merged-20261118-atlas-r8', label: '合并后 · R8 距离场',
      expected: {indirectDrawReuse: 2, vsmPageOptimization: 3}},
    native: {folder: 'villa-native-atlas-20261119', label: '合并后 · 自适应距离场',
      expected: {indirectDrawReuse: 2, vsmPageOptimization: 3}},
    temporaloff: {folder: 'villa-radiosity-temporal-off-20261119-b', label: 'R8 · 关闭间接光时间累积',
      expected: {indirectDrawReuse: 2, vsmPageOptimization: 3}},
  };
  globalThis.__villaComparisonPlayerStart = {x: -20, y: 200, pitch: 12, yaw: -35};
  document.title = document.querySelector('h1').textContent = 'Triplex Villa · 客厅性能对照';
  document.querySelector('.modes').replaceChildren(...Object.entries(__villaHistoryVariants).map(([mode, variant]) => {
    const label = document.createElement('label'), radio = document.createElement('input');
    const text = document.createElement('span');
    Object.assign(radio, {type: 'radio', name: 'mode', value: mode});
    text.textContent = variant.label;
    label.append(radio, text);
    return label;
  }));
  const reset = document.getElementById('reset');
  reset.title = '恢复客厅起点';
  reset.setAttribute('aria-label', reset.title);
  document.getElementById('viewpoint').value = 'living';
}
