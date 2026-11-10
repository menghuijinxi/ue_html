'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('./content-file-metadata.cjs');
const root=path.resolve(__dirname,'../..'),original=path.join(__dirname,'build/projects/nanite-full-scene');
const output=path.join(__dirname,'build/projects/nanite-native-capture');
const source=path.join(root,'tests/ue-shader-host/Source/UEShaderHost/Private/WebNativeComparison.cpp');
const descriptor=path.join(original,'TriplexHouseVilla.uproject');
const project=JSON.parse(fs.readFileSync(descriptor,'utf8'));
project.Modules=[{Name:'NativeNaniteCapture',Type:'Editor',LoadingPhase:'PostConfigInit'}];
project.Plugins=project.Plugins.filter(p=>p.Name!=='WebGPUShader');delete project.AdditionalPluginDirectories;
fs.mkdirSync(output,{recursive:true});
const content=path.join(output,'Content'),sourceContent=path.join(original,'Content');
if(!fs.existsSync(content))fs.symlinkSync(sourceContent,content,'junction');
assert.equal(fs.realpathSync(content),fs.realpathSync(sourceContent),'The native capture must use the converted scene assets');
fs.cpSync(path.join(original,'Config'),path.join(output,'Config'),{recursive:true});
const moduleRoot=path.join(output,'Source/NativeNaniteCapture');fs.mkdirSync(path.join(moduleRoot,'Private'),{recursive:true});
const generated=[];
function write(file,text){fs.writeFileSync(file,text);generated.push(audit(file));}
write(path.join(output,'TriplexHouseVilla.uproject'),JSON.stringify(project,null,2)+'\n');
write(path.join(output,'Source/NativeNaniteCaptureEditor.Target.cs'),`using UnrealBuildTool;
public class NativeNaniteCaptureEditorTarget : TargetRules
{
    public NativeNaniteCaptureEditorTarget(TargetInfo Target) : base(Target)
    {
        Type = TargetType.Editor;
        DefaultBuildSettings = BuildSettingsVersion.V7;
        IncludeOrderVersion = EngineIncludeOrderVersion.Unreal5_8;
        ExtraModuleNames.Add("NativeNaniteCapture");
    }
}
`);
write(path.join(moduleRoot,'NativeNaniteCapture.Build.cs'),`using UnrealBuildTool;
public class NativeNaniteCapture : ModuleRules
{
    public NativeNaniteCapture(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
        PrivateDependencyModuleNames.AddRange(new string[] { "Core", "CoreUObject", "Engine", "RenderCore", "RHI", "Json", "Renderer", "UnrealEd" });
    }
}
`);
write(path.join(moduleRoot,'Private/NativeNaniteCapture.cpp'),`#include "Modules/ModuleManager.h"
void StartWebNativeComparison();
class FNativeNaniteCaptureModule : public IModuleInterface
{
public:
    virtual void StartupModule() override { StartWebNativeComparison(); }
};
IMPLEMENT_MODULE(FNativeNaniteCaptureModule, NativeNaniteCapture)
`);
write(path.join(moduleRoot,'Private/WebNativeComparison.cpp'),fs.readFileSync(source));
const configs=[];
function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory())walk(f);else configs.push(audit(f));}}
walk(path.join(output,'Config'));
const report={pass:true,sources:[audit(__filename),audit(source),audit(descriptor)],generated,configs,
  project:path.join(output,'TriplexHouseVilla.uproject'),content:fs.realpathSync(content),
  boundary:'Separate native editor capture module; original converted Content is read through a junction, with no save or conversion operations.'};
fs.writeFileSync(path.join(__dirname,'results/nanite-native-capture-prepare.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({pass:true,project:report.project}));
