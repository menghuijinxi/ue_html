using UnrealBuildTool;

public class WebGPUShaderHostTargetPlatform : ModuleRules
{
    public WebGPUShaderHostTargetPlatform(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.NoPCHs;
        bUseUnity = false;
        PrivateDependencyModuleNames.AddRange(new string[] {
            "Core", "CoreUObject", "Engine", "RHI", "RenderCore",
            "TargetPlatform", "DesktopPlatform", "WebGPUShaderFormat"
        });
    }
}
