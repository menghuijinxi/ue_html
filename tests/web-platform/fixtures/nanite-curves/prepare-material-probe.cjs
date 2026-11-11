'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('../../content-file-metadata.cjs');
const root=path.resolve(__dirname,'../../../..'),engine=path.join(root,'reference-engine/Engine');
const draft=engine,output=path.join(__dirname,'material-shader-root');
const current=path.join(root,'.tools/ue58-nanite-cook-host/Engine/Shaders');
const read=f=>fs.readFileSync(f,'utf8').replace(/\r\n/g,'\n');
const write=(f,s)=>{fs.mkdirSync(path.dirname(f),{recursive:true});if(fs.existsSync(f))assert.equal(fs.statSync(f).nlink,1);fs.writeFileSync(f,s);};
// Only the Nanite directory is overlaid. Other shader directories are read-only
// junctions; files in the writable parents are independent copies.
function stage(source,destination,level=0){
 fs.mkdirSync(destination,{recursive:true});assert.equal(fs.realpathSync(destination),path.resolve(destination));
 for(const e of fs.readdirSync(source,{withFileTypes:true})){
  const from=path.join(source,e.name),to=path.join(destination,e.name);
  if(e.isDirectory()){
   if(level===0&&e.name==='Private'||level===1&&e.name==='Nanite')stage(from,to,level+1);
   else if(!fs.existsSync(to))fs.symlinkSync(from,to,'junction');
  }else{if(fs.existsSync(to))assert.equal(fs.statSync(to).nlink,1);fs.copyFileSync(from,to);}
 }
}
stage(current,output);
// The prepared Cook host contains the installed-version shader patches.
// Compile exactly those files, rather than overwriting native 5.8.1 shaders.
const shaderInputs=fs.readdirSync(path.join(current,'Private/Nanite')).filter(n=>n.startsWith('WebNanite')||['NaniteDataDecode.ush','NaniteRasterizer.usf','NaniteAttributeDecode.ush'].includes(n)).map(name=>({source:audit(path.join(current,'Private/Nanite',name)),target:audit(path.join(output,'Private/Nanite',name))}));
const materialHeader='Source/Runtime/Engine/Public/Rendering/NaniteWebMaterial.h';
const probeRoot=path.join(root,'tests/ue-shader-host/Source/UEShaderHost/Private');
const skin=read(path.join(probeRoot,'WebNaniteSkinningProbe.cpp'));
let material=skin.slice(skin.indexOf('UMaterial* CreateWebNaniteSkinMaterial'),skin.indexOf('// Authored two-bone'));
material=material.replaceAll('CreateWebNaniteSkinMaterial','CreateWebCurveMaterial').replaceAll('NaniteSkinMaterial','NaniteCurveMaterial').replaceAll('WebNaniteSkinning','WebNaniteCurves');
material=material.replace('Material->SetMaterialUsage(MATUSAGE_SkeletalMesh);','Material->SetMaterialUsage(MATUSAGE_Curves); Material->SetMaterialUsage(MATUSAGE_HairStrands);');
material=material.replace('{\n    const FString Name',`{\n    if (Index >= 5) {\n        const TCHAR* Kind=Index < 7 ? TEXT("Small") : Index < 9 ? TEXT("Streaming") : TEXT("Long256");\n        const FString Asset=FString::Printf(TEXT("/Game/WebNaniteCurves/NaniteGroom%sMaterial%d.NaniteGroom%sMaterial%d"),\n            Kind, (Index-5)%2, Kind, (Index-5)%2);\n        auto* Result=LoadObject<UMaterial>(nullptr,*Asset);check(Result);return Result;\n    }\n    const FString Name`);
const prog=read(path.join(probeRoot,'WebNaniteProgrammableProbe.cpp'));
let raster=prog.slice(prog.indexOf('class FWebNaniteProgrammableProbeMaterial'),prog.indexOf('int32 RunWebNaniteProgrammableProbe('));
raster=raster.replaceAll('CreateWebNaniteSkinMaterial','CreateWebCurveMaterial').replaceAll('RunWebNaniteSkinningMaterials','RunWebCurveRasterMaterials');
raster=raster.replace('const bool Assembly = FParse::Param(*Params, TEXT("WebNaniteAssemblyShaders"));','const bool Assembly = false;');
raster=raster.replace('CaseIndex<(Assembly?10:5)','CaseIndex<11').replace('CreateWebCurveMaterial(CaseIndex % 5)','CreateWebCurveMaterial(CaseIndex)').replace('Material->bUsedWithSkeletalMesh = !Assembly || CaseIndex < 5;','Material->bUsedWithSkeletalMesh = false;');
const base=read(path.join(probeRoot,'WebNaniteMaterialProbe.cpp'));
let basepass=base.slice(base.indexOf('class FWebNaniteProbeMaterial'),base.indexOf('int32 RunWebNaniteMaterialProbe('));
basepass=basepass.replaceAll('CreateWebNaniteSkinMaterial','CreateWebCurveMaterial').replaceAll('RunWebNaniteSkinningBasePass','RunWebCurveBasePass');
basepass=basepass.replace('const bool Assembly = FParse::Param(*Params, TEXT("WebNaniteAssemblyShaders"));','const bool Assembly = false;');
basepass=basepass.replace('CaseIndex < (Assembly ? 10 : 5)','CaseIndex < 11').replace('CreateWebCurveMaterial(CaseIndex % 5)','CreateWebCurveMaterial(CaseIndex)').replace('Material->bUsedWithSkeletalMesh = !Assembly || CaseIndex < 5;','Material->bUsedWithSkeletalMesh = false;');
const cpp=path.join(__dirname,'fixture-host/Source/WebCurveFixture/Private/WebCurveMaterialShaders.cpp');
const include=f=>path.relative(path.dirname(cpp),f).replaceAll('\\','/');
const headers=['CoreMinimal.h','Interfaces/IShaderFormat.h','Interfaces/ITargetPlatformManagerModule.h','MaterialShared.h','Materials/Material.h',
 'MeshMaterialShader.h','Misc/FileHelper.h','Misc/Parse.h','Serialization/JsonSerializer.h','ShaderCompiler.h','ShaderCompilerJobTypes.h',
 'ShaderPreprocessTypes.h','VertexFactory.h','WebGPUShaderCode.h','Algo/AllOf.h','UObject/Package.h',
 ...['Constant','VectorParameter','ScalarParameter','TextureCoordinate','ComponentMask','PreviousFrameSwitch','VertexColor','Multiply'].map(s=>'Materials/MaterialExpression'+s+'.h')];
write(cpp,headers.map(h=>'#include "'+h+'"').join('\n')+'\n#define WEB_NANITE_MATERIAL_SHADER_ONLY 1\n#define WEB_NANITE_PROGRAMMABLE_SHADER_ONLY 1\n'+
 [path.join(draft,'Source/Runtime/Engine/Private/Nanite/NaniteWebVertexFactory.cpp'),path.join(draft,'Source/Runtime/Renderer/Private/Nanite/NaniteWebProgrammableRaster.cpp')]
 .map(f=>'#include "'+include(f)+'"').join('\n')+'\n'+material+raster+basepass+`
int32 RunWebCurveMaterialShaders(const FString& Params) {
 FString Output;if(!FParse::Value(*Params,TEXT("Output="),Output))return 1;
 if(RunWebCurveRasterMaterials(TEXT("-Output=")+Output/TEXT("raster")))return 1;
 return RunWebCurveBasePass(TEXT("-Output=")+Output/TEXT("basepass"));
}
`);
const report={pass:true,draftOnly:false,production:true,source:audit(__filename),shaderInputs,probe:audit(cpp),
 draftInputs:[materialHeader,'Source/Runtime/Engine/Private/Nanite/NaniteWebVertexFactory.cpp',
 'Source/Runtime/Renderer/Private/Nanite/NaniteWebProgrammableRaster.cpp'].map(f=>audit(path.join(draft,f))),
 inputs:['WebNaniteSkinningProbe.cpp','WebNaniteProgrammableProbe.cpp','WebNaniteMaterialProbe.cpp'].map(f=>audit(path.join(probeRoot,f)))};
write(path.join(__dirname,'material-probe.json'),JSON.stringify(report,null,2)+'\n');
console.log({pass:true,shaderInputs:shaderInputs.length,cpp});
