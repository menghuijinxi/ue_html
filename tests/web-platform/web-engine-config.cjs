const fs = require('node:fs');
const path = require('node:path');
const {audit} = require('./content-file-metadata.cjs');

function loadEngineConfig(root) {
  const sources = [
    ['reference-engine/Engine/Platforms/Web/Config/DataDrivenPlatformInfo.ini',
      '/Engine/Platforms/Web/Config/DataDrivenPlatformInfo.ini'],
    ['reference-engine/Engine/Platforms/Web/Config/WebEngine.ini',
      '/Engine/Platforms/Web/Config/WebEngine.ini'],
    ['.tools/ue58-web-build-host/Engine/Config/Windows/DataDrivenPlatformInfo.ini',
      '/Engine/Config/Windows/DataDrivenPlatformInfo.ini'],
    ...['Base.ini', 'BaseEngine.ini', 'BaseGame.ini', 'BaseInput.ini',
      'BaseDeviceProfiles.ini', 'BaseScalability.ini', 'BaseGameUserSettings.ini'].map(name =>
      [`.tools/ue58-web-build-host/Engine/Config/${name}`, `/Engine/Config/${name}`])
  ];
  const configFiles = sources.map(([source, virtualPath]) =>
    ({...audit(path.join(root, source)), virtualPath}));
  const bundle = configFiles.map(item => ({path: item.virtualPath, sha256: item.sha256,
    data: fs.readFileSync(item.file).toString('base64')}));
  return {configFiles, bundle};
}

module.exports = {loadEngineConfig};
