using UnrealBuildTool;

public class UEShaderHostEditorTarget : TargetRules
{
    public UEShaderHostEditorTarget(TargetInfo Target) : base(Target)
    {
        Type = TargetType.Editor;
        DefaultBuildSettings = BuildSettingsVersion.V7;
        IncludeOrderVersion = EngineIncludeOrderVersion.Unreal5_8;
        ExtraModuleNames.Add("UEShaderHost");
    }
}
