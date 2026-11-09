'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const tag = option('tag');
assert(tag && /^[a-z0-9-]+$/.test(tag), 'Provide the completed benchmark tag');
const output = path.join(__dirname, 'results', 'ue59-official-villa', tag);
const report = JSON.parse(fs.readFileSync(path.join(output, 'results.json'), 'utf8'));
assert(report.pass, 'Wait for the benchmark to finish successfully before opening its profiles');
const profiles = path.join(__dirname, 'build', 'ue59-benchmark-profiles', tag);

async function main() {
  const extracted = [];
  for (const tier of [...new Set(report.results.map(result => result.tierRan))]) {
    const context = await chromium.launchPersistentContext(path.join(profiles, tier), {
      executablePath: report.executablePath, headless: true, serviceWorkers: 'block',
    });
    try {
      const page = context.pages()[0] || await context.newPage();
      const target = new URL('/wasm-tiers.json', report.url);
      await page.goto(target.href);
      // Read the completed game's OPFS logs without booting another game or changing its settings.
      const logs = await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const directory = await root.getDirectoryHandle('logs');
        const files = [];
        for await (const [name, handle] of directory.entries()) {
          if (handle.kind !== 'file' || !name.endsWith('.log')) continue;
          const file = await handle.getFile();
          files.push({ name, modified: file.lastModified, size: file.size, text: await file.text() });
        }
        return files.sort((a, b) => b.modified - a.modified);
      });
      assert(logs.length, `No saved logs for ${tier}`);
      const latest = logs[0];
      fs.writeFileSync(path.join(output, `${tier}-saved-engine.log`), latest.text);
      const relevant = latest.text.split(/\r?\n/).filter(line =>
        /(?:t\.MaxFPS|r\.VSync|r\.ScreenPercentage|sg\.ResolutionQuality|r\.DynamicRes\.OperationMode|r\.AntiAliasingMethod|r\.DynamicGlobalIlluminationMethod|r\.Lumen\.(?:DiffuseIndirect|Reflections)\.Allow|r\.ReflectionMethod|r\.Shadow\.Virtual\.Enable|r\.Streaming\.(?:PoolSize|UseFixedPoolSize)|sg\.(?:GlobalIllumination|Reflection|Shadow)Quality)\s*=/i.test(line) ||
        /(?:GameMode|DefaultPawnClass|PlayerController.*Pawn|World.*URL|Game class is|Bringing World|LoadMap:)/i.test(line));
      extracted.push({
        tier, sourceFile: latest.name, modified: latest.modified,
        logFiles: logs.map(({ text, ...metadata }) => metadata), relevant,
      });
      console.log(JSON.stringify({ tier, sourceFile: latest.name, bytes: latest.size, relevant }));
    } finally {
      await context.close();
    }
  }
  fs.writeFileSync(path.join(output, 'saved-engine-diagnostics.json'), JSON.stringify(extracted, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
