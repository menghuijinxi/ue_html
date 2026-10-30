const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const project = path.resolve(process.argv[2]);
const config = path.join(path.dirname(project), 'Config');
const walk = directory => fs.existsSync(directory) ? fs.readdirSync(directory, {withFileTypes: true})
  .flatMap(entry => entry.isDirectory() ? walk(path.join(directory, entry.name)) :
    entry.name.endsWith('.ini') ? [path.join(directory, entry.name)] : []) : [];
const sources = walk(config);
const settings = {};
for (const source of sources.filter(file => /(?:DefaultEngine|WebEngine)\.ini$/i.test(file))) {
  let section = '';
  for (const line of fs.readFileSync(source, 'utf8').split(/\r?\n/)) {
    const heading = /^\s*\[([^\]]+)\]/.exec(line);
    if (heading) section = heading[1];
    const entry = /^\s*([^;#=\s]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (entry && (section === '/Script/Engine.RendererSettings' || section === 'SystemSettings'))
      settings[entry[1]] = entry[2];
  }
}
const enabled = value => /^(?:true|1)$/i.test(value || '');
assert(!enabled(settings['r.Shadow.Virtual.Enable']) &&
  settings['r.DynamicGlobalIlluminationMethod'] !== '1' &&
  settings['r.ReflectionMethod'] !== '1', 'This Web target requires project settings without Lumen or virtual shadows');
const report = {project, sourceFiles: [project, ...sources].map(audit), settings,
  distanceFields: enabled(settings['r.GenerateMeshDistanceFields']), rendererOverrides: []};
fs.writeFileSync(process.argv[3], JSON.stringify(report, null, 2));
console.log(JSON.stringify({project, distanceFields: report.distanceFields, rendererOverrides: []}));
