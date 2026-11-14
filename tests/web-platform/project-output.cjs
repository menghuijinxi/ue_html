'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const projectRoot = path.resolve(__dirname, '../..');
const realRoot = fs.realpathSync(projectRoot);
const temporary = path.join(__dirname, 'build/test-tmp');

function within(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) &&
    relative !== '..' && !relative.startsWith('..' + path.sep));
}

function assertProjectOutput(value) {
  assert(typeof value === 'string' && value.length, 'An output path is required');
  const target = path.resolve(value);
  assert(within(projectRoot, target), 'Output must stay inside the project: ' + target);
  let current = projectRoot;
  for (const part of path.relative(projectRoot, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      fs.lstatSync(current);
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
    // Inspect existing ancestors too, including dangling links and junctions.
    const real = fs.realpathSync(current);
    assert(within(realRoot, real), 'Output resolves outside the project: ' + current + ' -> ' + real);
  }
  return target;
}

function assertProjectOutputTree(value, seen = new Set()) {
  const target = assertProjectOutput(value);
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) return target;
  const real = fs.realpathSync(target);
  if (seen.has(real)) return target;
  seen.add(real);
  for (const entry of fs.readdirSync(target, {withFileTypes: true})) {
    const child = path.join(target, entry.name);
    if (entry.isDirectory() || entry.isSymbolicLink()) assertProjectOutputTree(child, seen);
  }
  return target;
}

function initializeProjectOutput(outputs = []) {
  const cache = path.join(__dirname, 'build/cache');
  const env = {TEMP: temporary, TMP: temporary, TMPDIR: temporary,
    'UE-LocalDataCachePath': path.join(cache, 'ddc'),
    'UE-ZenDataPath': path.join(cache, 'zen'),
    'UE-ZenSubprocessDataPath': path.join(cache, 'zen'),
    'UE-SharedDataCachePath': 'None'};
  for (const output of [path.join(__dirname, 'build'), path.join(__dirname, 'results'),
    path.join(__dirname, 'evidence'), path.join(projectRoot, '.tools'), ...outputs])
    assertProjectOutput(output);
  const directories = [...new Set(Object.values(env).filter(value => value !== 'None'))];
  for (const directory of directories) assertProjectOutputTree(directory);
  for (const directory of directories) fs.mkdirSync(directory, {recursive: true});
  Object.assign(process.env, env);
  return env;
}

module.exports = {projectRoot, assertProjectOutput, assertProjectOutputTree, initializeProjectOutput};

if (require.main === module) {
  try {
    const [mode, ...outputs] = process.argv.slice(2);
    assert(['--check', '--tree', '--environment'].includes(mode), 'Select --check, --tree or --environment');
    if (mode === '--environment') console.log(JSON.stringify(initializeProjectOutput(outputs)));
    else for (const output of outputs)
      (mode === '--tree' ? assertProjectOutputTree : assertProjectOutput)(output);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
