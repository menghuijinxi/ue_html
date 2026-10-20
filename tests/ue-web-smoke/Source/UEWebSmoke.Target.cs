using UnrealBuildTool;

[SupportedPlatforms("Web")]
public class UEWebSmokeTarget : TargetRules
{
    public UEWebSmokeTarget(TargetInfo target) : base(target)
    {
        Type = TargetType.Program;
        DefaultBuildSettings = BuildSettingsVersion.V7;
        IncludeOrderVersion = EngineIncludeOrderVersion.Unreal5_8;
        LinkType = TargetLinkType.Monolithic;
        LaunchModuleName = "UEWebSmoke";
        bBuildDeveloperTools = false;
        bBuildWithEditorOnlyData = false;
        bCompileAgainstEngine = false;
        bCompileAgainstCoreUObject = false;
        bCompileAgainstApplicationCore = false;
        bCompileICU = false;
        bCompileCEF3 = false;
        bIsBuildingConsoleApplication = true;
        bUseUnityBuild = false;
        bUsePCHFiles = false;
        AdditionalLinkerArguments = "-Wl,--error-limit=0";
    }
}
