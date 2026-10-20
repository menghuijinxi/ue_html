using UnrealBuildTool;

public class WebGPUShaderFormat : ModuleRules
{
    public WebGPUShaderFormat(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.NoPCHs;
        bUseUnity = false;
        PrivateDependencyModuleNames.AddRange(new string[] {
            "Core", "CoreUObject", "RHI", "RenderCore", "TargetPlatform", "Json",
            "ShaderCompilerCommon"
        });
        PrivateIncludePathModuleNames.Add("VulkanRHI");
        DynamicallyLoadedModuleNames.Add("VulkanShaderFormat");
        AddEngineThirdPartyPrivateStaticDependencies(Target, "SPIRVReflect");
    }
}
