using UnrealBuildTool;

public class WebCookTargetPlatformSettings : ModuleRules
{
    public WebCookTargetPlatformSettings(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.NoPCHs;
        bUseUnity = false;
        PrivateDependencyModuleNames.AddRange(new string[] {
            "Core", "CoreUObject", "Engine", "RHI", "RenderCore",
            "TargetPlatform", "DesktopPlatform"
        });
    }
}
