using UnrealBuildTool;

[SupportedPlatforms("Web")]
public class UEWebApplicationTarget : UEWebSmokeTarget
{
    public UEWebApplicationTarget(TargetInfo target) : base(target)
    {
        LaunchModuleName = "UEWebApplication";
        bCompileAgainstApplicationCore = true;
        bCompileWithAccessibilitySupport = false;
    }
}
