using UnrealBuildTool;

public class UEShaderHost : ModuleRules
{
    public UEShaderHost(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
        PrivateDependencyModuleNames.AddRange(new string[] {
            "Core", "CoreUObject", "Engine", "RenderCore", "RHI",
            "ShaderCompilerCommon", "TargetPlatform", "Json", "Renderer", "VulkanRHI",
            "WebGPUShaderFormat", "UnrealEd", "GeometryCore", "MeshConversion",
            "MeshDescription", "StaticMeshDescription"
        });
        PrivateIncludePaths.Add(System.IO.Path.Combine(EngineDirectory, "Source/Runtime/RenderCore/Internal"));
        PrivateIncludePathModuleNames.Add("WebGPURHI");
        DynamicallyLoadedModuleNames.Add("WebGPURHI");
        AddEngineThirdPartyPrivateStaticDependencies(Target, "SPIRVReflect");
    }
}
