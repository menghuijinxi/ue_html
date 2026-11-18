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
            "MeshDescription", "StaticMeshDescription", "SkeletalMeshDescription", "AnimationCore", "QuadricMeshReduction", "NaniteUtilities"
        });
        PrivateIncludePaths.Add(System.IO.Path.Combine(EngineDirectory, "Source/Runtime/RenderCore/Internal"));
        PrivateIncludePaths.Add(System.IO.Path.Combine(EngineDirectory, "Source/Runtime/Renderer/Private"));
        PrivateIncludePaths.Add(System.IO.Path.Combine(EngineDirectory, "Source/Runtime/Engine/Internal"));
        PrivateIncludePaths.Add(System.IO.Path.Combine(EngineDirectory, "Source/Developer/NaniteBuilder/Private"));
        PrivateIncludePaths.Add(System.IO.Path.Combine(EngineDirectory, "Source/Developer/MeshSimplifier/Private"));
        PrivateIncludePaths.Add(System.IO.Path.GetFullPath(System.IO.Path.Combine(ModuleDirectory, "../../../../reference-engine/Engine/Source/Developer/NaniteBuilder/Private")));
        PrivateIncludePathModuleNames.Add("WebGPURHI");
        PrivateIncludePathModuleNames.Add("NaniteBuilder");
        DynamicallyLoadedModuleNames.Add("WebGPURHI");
        AddEngineThirdPartyPrivateStaticDependencies(Target, "SPIRVReflect");
    }
}
