const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

// Match the installed host's UBT APIs; only change the two isolated modules.
const engine = process.argv[2] || process.env.UE_ENGINE_ROOT || 'H:/UE_5.8/Engine';
const source = path.join(engine, 'Source/Programs/UnrealBuildTool/Configuration/UEBuildTarget.cs');
const output = path.join(__dirname, 'native-ubt/build/UEBuildTarget.cs');
const text = fs.readFileSync(source, 'utf8');
const marker = 'ModuleRules RulesObject = CreateModuleRulesAndSetDefaults(ModuleName, ReferenceChain, Logger);';
assert.equal(text.split(marker).length, 2, 'Installed UBT module creation hook changed');
const patch = `
			if ((ModuleName == "RenderCore" &&
				Environment.GetEnvironmentVariable("UE_WEB_NATIVE_RENDERCORE") == "1") ||
				(ModuleName == "Renderer" &&
				Environment.GetEnvironmentVariable("UE_WEB_NATIVE_RENDERER") == "1"))
			{
				RulesObject.bUsePrecompiled = false;
				RulesObject.bUseUnity = true;
				RulesObject.PrivateDefinitions.Add("PLATFORM_WEB=0");
			}
`;
fs.mkdirSync(path.dirname(output), {recursive: true});
fs.writeFileSync(output, text.replace(marker, marker + patch));
console.log(`Prepared native UBT from ${source}`);
