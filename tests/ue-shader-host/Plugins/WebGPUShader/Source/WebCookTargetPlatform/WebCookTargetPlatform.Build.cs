using UnrealBuildTool;

public class WebCookTargetPlatform : ModuleRules
{
    public WebCookTargetPlatform(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.NoPCHs;
        bUseUnity = false;
        PrivateDependencyModuleNames.AddRange(new string[] {
            "Core", "CoreUObject", "Engine", "RHI", "RenderCore",
            "TargetPlatform", "DesktopPlatform", "WebCookTargetPlatformSettings"
        });
    }
}
