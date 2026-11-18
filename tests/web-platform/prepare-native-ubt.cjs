const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {assertProjectOutput, assertProjectOutputTree} = require('./project-output.cjs');

// Match the installed host's UBT APIs and write generated copies only.
const engine = process.argv[2] || process.env.UE_ENGINE_ROOT || 'H:/UE_5.8/Engine';
const source = path.join(engine, 'Source/Programs/UnrealBuildTool/Configuration/UEBuildTarget.cs');
const output = assertProjectOutput(path.join(__dirname, 'native-ubt/build/UEBuildTarget.cs'));
const text = fs.readFileSync(source, 'utf8');
const marker = 'ModuleRules RulesObject = CreateModuleRulesAndSetDefaults(ModuleName, ReferenceChain, Logger);';
assert.equal(text.split(marker).length, 2, 'Installed UBT module creation hook changed');
const patch = `
			if ((ModuleName == "RenderCore" &&
				Environment.GetEnvironmentVariable("UE_WEB_NATIVE_RENDERCORE") == "1") ||
				(ModuleName == "Renderer" &&
				Environment.GetEnvironmentVariable("UE_WEB_NATIVE_RENDERER") == "1") ||
				(ModuleName == "NaniteBuilder" &&
				Environment.GetEnvironmentVariable("UE_WEB_NATIVE_NANITEBUILDER") == "1"))
			{
				RulesObject.bUsePrecompiled = false;
				RulesObject.bUseUnity = true;
				if (Environment.GetEnvironmentVariable("UE_WEB_NATIVE_NO_OPTIMIZE") == "1")
				{
					RulesObject.OptimizeCode = ModuleRules.CodeOptimization.Never;
				}
				RulesObject.PrivateDefinitions.Add("PLATFORM_WEB=0");
				if (ModuleName == "NaniteBuilder")
				{
					// Installed module constructors skip third-party dependencies while
					// bUsePrecompiled is still true; restore them for this isolated build.
					RulesObject.PrivateDependencyModuleNames.AddRange(new string[] { "metis", "MikkTSpace", "Embree" });
				}
			}
`;
fs.mkdirSync(path.dirname(output), {recursive: true});
fs.writeFileSync(output, text.replace(marker, marker + patch));
const mainSource = path.join(engine, 'Source/Programs/UnrealBuildTool/UnrealBuildTool.cs');
const mainOutput = assertProjectOutput(path.join(__dirname, 'native-ubt/build/UnrealBuildTool.cs'));
const traceRoot = assertProjectOutputTree(path.join(__dirname, 'results/native-ubt-traces'));
const main = fs.readFileSync(mainSource, 'utf8');
const tracePath = /FileReference\.Combine\(Unreal\.EngineProgramSavedDirectory, [^\r\n]*"Trace\.uba"\)/g;
assert.equal([...main.matchAll(tracePath)].length, 2, 'Installed UBT trace hook changed');
fs.writeFileSync(mainOutput, main.replace(tracePath,
  () => `new FileReference(${JSON.stringify(path.join(traceRoot, 'Trace.uba'))})`));
console.log(`Prepared native UBT from ${source}`);
