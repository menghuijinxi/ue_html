'use strict';
// Diagnostic: per-frame render-thread time by function for two profiles written
// by profile-web-render-cpu.cjs, largest differences first. Inclusive time counts
// a function once per stack. Sampling profiles; use the ranking, not single values.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const [a, b] = process.argv.slice(2), rows = Number(process.argv[4] || 40), filter = process.argv[5] ? new RegExp(process.argv[5]) : null;
assert(a && b, 'usage: compare-render-cpu.cjs <tag A> <tag B> [rows] [name regexp]');
function load(tag) {
  const base = path.join(__dirname, 'results', (/^(render|rhi)-cpu-/.test(tag) ? tag : 'render-cpu-' + tag));
  const report = JSON.parse(fs.readFileSync(base + '.json', 'utf8')), profile = JSON.parse(fs.readFileSync(base + '.cpuprofile', 'utf8'));
  const frames = report.after.frames - report.before.frames, nodes = new Map(profile.nodes.map(n => [n.id, n])), parent = new Map();
  for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
  const name = n => (n.callFrame.functionName || '(anonymous)').replace(/\(.*$/, '').slice(0, 110);
  const self = new Map(), total = new Map();
  for (let i = 0; i < profile.samples.length; i++) {
    const ms = profile.timeDeltas[i] / 1000, seen = new Set();
    let id = profile.samples[i]; const leaf = name(nodes.get(id)); self.set(leaf, (self.get(leaf) || 0) + ms);
    for (; id !== undefined; id = parent.get(id)) { const n = name(nodes.get(id)); if (!seen.has(n)) { seen.add(n); total.set(n, (total.get(n) || 0) + ms); } }
  }
  return {frames, self, total, fps: report.sampledFPS};
}
const A = load(a), B = load(b);
console.log(`A=${a} frames ${A.frames} (${A.fps.toFixed(1)} fps)   B=${b} frames ${B.frames} (${B.fps.toFixed(1)} fps)   ms per frame`);
for (const kind of ['total', 'self']) {
  const names = new Set([...A[kind].keys(), ...B[kind].keys()]);
  const list = [...names].filter(n => !filter || filter.test(n)).map(n => ({n, a: (A[kind].get(n) || 0) / A.frames, b: (B[kind].get(n) || 0) / B.frames}))
    .sort((x, y) => Math.abs(y.a - y.b) - Math.abs(x.a - x.b)).slice(0, rows);
  console.log(`--- ${kind}: A, B, A-B`);
  for (const r of list) console.log(r.a.toFixed(3).padStart(7), r.b.toFixed(3).padStart(7), (r.a - r.b).toFixed(3).padStart(7), ' ', r.n);
}
