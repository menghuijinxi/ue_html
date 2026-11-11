using UnrealBuildTool;
using System.IO;
public class WebCurveFixture : ModuleRules {
 public WebCurveFixture(ReadOnlyTargetRules Target):base(Target){
  PCHUsage=PCHUsageMode.UseExplicitOrSharedPCHs;
  PrivateDependencyModuleNames.AddRange(new string[]{"Core","CoreUObject","Engine","RenderCore","RHI","UnrealEd","Json","NaniteBuilder","TargetPlatform","ShaderCompilerCommon","WebGPUShaderFormat"});
  PrivateDependencyModuleNames.AddRange(new string[]{"HairStrandsCore","MeshDescription","Renderer"});
  PrivateIncludePaths.Add(Path.Combine(EngineDirectory,"Source/Runtime/Renderer/Private"));
  PrivateIncludePaths.Add(Path.Combine(EngineDirectory,"Source/Runtime/Renderer/Internal"));
  PrivateIncludePaths.Add(Path.Combine(EngineDirectory,"Source/Runtime/RenderCore/Internal"));
  PrivateIncludePaths.Add(Path.Combine(EngineDirectory,"Source/Runtime/Engine/Internal"));
  PrivateIncludePaths.Add(Path.Combine(EngineDirectory,"Plugins/Runtime/HairStrands/Source/HairStrandsCore/Private"));
 }
}
