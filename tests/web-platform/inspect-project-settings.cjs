const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const walk = directory => fs.existsSync(directory) ? fs.readdirSync(directory, {withFileTypes: true})
  .flatMap(entry => entry.isDirectory() ? walk(path.join(directory, entry.name)) :
    entry.name.endsWith('.ini') ? [path.join(directory, entry.name)] : []) : [];
const enabled = value => /^(?:true|1)$/i.test(value || '');
function inspect(project) {
  project = path.resolve(project);
  const directory = path.dirname(project);
  const config = path.join(directory, 'Config');
  const sources = [...walk(config), ...walk(path.join(directory, 'Platforms/Web/Config'))];
  const settings = {};
  const sections = new Map(['/Script/Engine.RendererSettings', '/Script/Engine.RendererOverrideSettings',
    'SystemSettings'].map(name => [name, {}]));
  // Read only this target's layers, in hierarchy order, not other platforms' INIs.
  const effectiveSources = ['Config/DefaultEngine.ini', 'Config/Web/WebEngine.ini',
    'Platforms/Web/Config/WebEngine.ini'].map(file => path.join(directory, file)).filter(fs.existsSync);
  for (const source of effectiveSources) {
    let section = '';
    for (const line of fs.readFileSync(source, 'utf8').split(/\r?\n/)) {
      const heading = /^\s*\[([^\]]+)\]/.exec(line);
      if (heading) section = heading[1];
      const entry = /^\s*([^;#=\s]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (entry && sections.has(section)) sections.get(section)[entry[1]] = entry[2];
    }
  }
  // CVar set-by priority wins over INI layer order across different sections.
  for (const values of sections.values()) Object.assign(settings, values);
  assert(!enabled(settings['r.Shadow.Virtual.Enable']), 'Virtual shadow maps are not supported by this Web target');
  const diffuseGI = settings['r.DynamicGlobalIlluminationMethod'] === '1';
  const reflections = settings['r.ReflectionMethod'] === '1';
  const supported = !/^(?:false|0)$/i.test(settings['r.Lumen.Supported'] || '1');
  const lumenEnabled = supported && (diffuseGI || reflections);
  const distanceFields = enabled(settings['r.GenerateMeshDistanceFields']);
  if (lumenEnabled) {
    assert(!enabled(settings['r.ForwardShading']), 'Experimental Web Lumen requires deferred rendering');
    assert(distanceFields, 'Experimental Web software Lumen requires project Generate Mesh Distance Fields');
  }
  return {project, sourceFiles: [project, ...sources].map(audit), effectiveSources, settings, distanceFields,
    lumen: {enabled: lumenEnabled, diffuseGI, reflections, supported,
      tracing: lumenEnabled ? 'software-distance-fields' : null, experimental: true},
    rendererOverrides: []};
}
module.exports = inspect;
if (require.main === module) {
  const report = inspect(process.argv[2]);
  fs.writeFileSync(process.argv[3], JSON.stringify(report, null, 2));
  console.log(JSON.stringify({project: report.project, distanceFields: report.distanceFields,
    lumen: report.lumen, rendererOverrides: []}));
}
