'use strict';
globalThis.__villaHistoryVariants = {
  adaptive: {folder: 'villa-git-adaptive-20261113', label: '② 正式自适应基线',
    expected: {indirectDrawReuse: null, vsmPageOptimization: null}},
  disabled: {folder: 'villa-indirect-disabled-20261113', label: '③ 复用全关',
    expected: {indirectDrawReuse: 0, vsmPageOptimization: null}},
  templates: {folder: 'villa-indirect-templates-20261113', label: '③ 仅命令模板',
    expected: {indirectDrawReuse: 1, vsmPageOptimization: null}},
  bindings: {folder: 'villa-indirect-bindings-20261113', label: '③ 仅绑定复用',
    expected: {indirectDrawReuse: 3, vsmPageOptimization: null}},
  combined: {folder: 'villa-git-indirect-20261113', label: '③ 全部开启原版',
    expected: {indirectDrawReuse: 2, vsmPageOptimization: null}},
};
