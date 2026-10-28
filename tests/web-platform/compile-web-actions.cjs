// Execute UBT-exported independent Web compile actions without the UBA process host.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const file = process.argv[2], parallel = Number(process.argv[3] || 8);
assert(file && Number.isInteger(parallel) && parallel >= 1 && parallel <= 16);
const graph = JSON.parse(fs.readFileSync(file, 'utf8'));
const root = path.resolve(__dirname, '../..');
const actions = graph.Actions.filter(action => action.Type === 'Compile');
assert(actions.length && actions.every(action => !action.PrerequisiteActions.length));
let next = 0, completed = 0, failed = false;
const results = [];
async function run() {
  while (!failed && next < actions.length) {
    const action = actions[next++];
    const args = /^"([^"]+\/em\+\+\.py)" @"([^"]+\.rsp)"$/.exec(action.CommandArguments);
    assert(args && args[1].startsWith(root.replaceAll('\\', '/') + '/.tools/emsdk/') &&
      args[2].startsWith(root.replaceAll('\\', '/') + '/tests/ue-web-smoke/Intermediate/'));
    assert(path.resolve(action.CommandPath) === path.join(root, '.tools/emsdk/python/3.13.3_64bit/python.exe'));
    const log = file + '.' + action.Id + '.log';
    const started = Date.now();
    const attempts = [];
    let result;
    for (let attempt = 0; attempt < 3; ++attempt) {
      const attemptLog = attempt ? log + '.retry' + attempt : log;
      const output = fs.openSync(attemptLog, 'w');
      result = await new Promise(resolve => {
        const child = cp.spawn(action.CommandPath, [args[1], '@' + args[2]], {
          cwd: action.WorkingDirectory, env: {...process.env, ...graph.Environment},
          windowsHide: true, stdio: ['ignore', output, output]
        });
        child.on('error', error => resolve({error: error.message, code: -1}));
        child.on('close', code => resolve({code}));
      });
      fs.closeSync(output);
      const text = fs.readFileSync(attemptLog, 'utf8');
      attempts.push({...result, log: attemptLog});
      if (result.code === 0 || !/clang frontend command failed due to signal|Stack dump:/.test(text)) break;
      console.log(`Compiler process crashed: ${action.StatusDescription}, attempt ${attempt + 1}/3`);
    }
    results.push({id: action.Id, source: action.StatusDescription, attempts, ...result,
      milliseconds: Date.now() - started});
    if (result.code !== 0) {
      failed = true;
      console.error(JSON.stringify(results.at(-1)));
      console.error(fs.readFileSync(log, 'utf8').slice(-10000));
    }
    ++completed;
    if (completed % 10 === 0 || completed === actions.length)
      console.log(`Web compile ${completed}/${actions.length}`);
  }
}
Promise.all(Array.from({length: parallel}, run)).then(() => {
  fs.writeFileSync(file + '.results.json', JSON.stringify({pass: !failed, parallel, results}, null, 2));
  process.exitCode = failed ? 1 : 0;
}).catch(error => { console.error(error); process.exitCode = 1; });
