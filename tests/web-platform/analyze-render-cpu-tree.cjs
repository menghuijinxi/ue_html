'use strict';
// Diagnostic: prints the call tree of a render-thread .cpuprofile written by
// profile-web-render-cpu.cjs, folding single-child chains, so the cost of one
// renderer phase can be read with its callers. Sampling profile; not FPS evidence.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const tag = process.argv[2], minimum = Number(process.argv[3] || 60), filter = process.argv[4] ? new RegExp(process.argv[4]) : null;
assert(/^[a-z0-9-]+$/.test(tag || ''), 'usage: analyze-render-cpu-tree.cjs <tag> [minimum ms] [root name regexp]');
// The tag may carry the thread prefix of profile-web-render-cpu.cjs (rhi-cpu-...); render-cpu- is assumed otherwise.
const profile = JSON.parse(fs.readFileSync(path.join(__dirname, 'results', (/^(render|rhi)-cpu-/.test(tag) ? tag : 'render-cpu-' + tag) + '.cpuprofile'), 'utf8'));
const nodes = new Map(profile.nodes.map(n => [n.id, {...n, self: 0, total: 0}]));
const deltas = profile.timeDeltas; let last = 0;
for (let i = 0; i < profile.samples.length; i++) { const d = deltas[i] / 1000; const n = nodes.get(profile.samples[i]); n.self += d; last = i; }
const root = nodes.get(profile.nodes[0].id);
(function sum(n) { n.total = n.self; for (const c of n.children || []) n.total += sum(nodes.get(c)); return n.total; })(root);
const name = n => (n.callFrame.functionName || '(anonymous)').replace(/\(.*$/, '').slice(0, 96);
function print(n, depth) {
  // Fold chains whose only significant child carries nearly all the time.
  let children = (n.children || []).map(c => nodes.get(c)).filter(c => c.total >= minimum).sort((a, b) => b.total - a.total);
  console.log(' '.repeat(depth * 2) + n.total.toFixed(0).padStart(6) + ' ' + (n.self >= minimum ? '[self ' + n.self.toFixed(0) + '] ' : '') + name(n));
  while (children.length === 1 && children[0].total > n.total * .97 && children[0].self < minimum) { n = children[0]; children = (n.children || []).map(c => nodes.get(c)).filter(c => c.total >= minimum).sort((a, b) => b.total - a.total); }
  for (const c of children) print(c, depth + 1);
}
if (!filter) print(root, 0);
else for (const n of nodes.values()) if (filter.test(name(n)) && n.total >= minimum) print(n, 0);
