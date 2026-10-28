(() => {
  const style = document.createElement('style');
  style.textContent = `
    #villa-lab {position:fixed;top:12px;left:12px;z-index:4;display:flex;align-items:center;
      gap:12px;max-width:calc(100% - 24px);padding:8px 12px;background:#202326ed;
      color:#f4f4f4;font:13px/1.5 system-ui,sans-serif;border:1px solid #62666a;border-radius:4px;
      box-sizing:border-box;flex-wrap:wrap}
    #villa-lab[hidden] {display:none}
    #villa-lab select {font:inherit;color:inherit;background:#34383c;border:1px solid #747a80;
      border-radius:3px;padding:4px;max-width:100%}
    #villa-lab label {display:flex;align-items:center;gap:5px}
    #villa-lab input {accent-color:#66d3b0}
  `;
  document.head.append(style);
  const panel = document.createElement('nav');
  panel.id = 'villa-lab';
  panel.hidden = true;
  panel.setAttribute('aria-label', '别墅材质对照');
  panel.innerHTML = `<strong>别墅材质对照</strong><select aria-label="模型">
    <option value="overview">总览</option></select>
    <label><input type="checkbox" checked>近景</label>`;
  document.body.append(panel);
  const select = panel.querySelector('select'), detail = panel.querySelector('input');
  const names = {'cupboard-door': '橱柜门', 'brick-wall': '砖墙', 'cupboard-body': '橱柜柜体',
    'dining-table': '木餐桌', sink: '水槽', pot: '金属锅'};
  let layout, busy = false;
  async function move() {
    if (!layout || busy) return;
    busy = true;
    select.disabled = detail.disabled = true;
    try {
      const sample = layout.samples.find(item => item.id === select.value);
      const camera = sample ? sample[detail.checked ? 'detailCamera' : 'camera'] : layout.camera;
      const result = globalThis.__webEngineRPC ?
        await __webEngineRPC('WebProjectViewTest', ...camera) : Module._WebProjectViewTest(...camera);
      if (result !== 1) throw new Error('Material comparison camera unavailable');
      globalThis.__villaMaterialLabView = {id: select.value, detail: detail.checked, camera};
    } catch (error) {
      panel.title = error.message;
      console.error(error);
    } finally {
      busy = false;
      select.disabled = detail.disabled = false;
    }
  }
  select.addEventListener('change', move);
  detail.addEventListener('change', move);
  fetch('layout.json').then(response => {
    if (!response.ok) throw new Error('Material comparison layout unavailable');
    return response.json();
  }).then(value => {
    layout = value;
    for (const sample of layout.samples) {
      const option = document.createElement('option');
      option.value = sample.id;
      option.textContent = names[sample.id] || sample.id;
      select.append(option);
    }
    const timer = setInterval(() => {
      if (globalThis.__webEngineFailure) { clearInterval(timer); return; }
      if (!globalThis.__webEngineReady || !globalThis.__webEngineFrames) return;
      clearInterval(timer);
      panel.hidden = false;
      move();
    }, 250);
  }).catch(error => console.error(error));
})();
