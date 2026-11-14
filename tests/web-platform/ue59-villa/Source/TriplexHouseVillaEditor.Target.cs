using UnrealBuildTool;
using System.Collections.Generic;

public class TriplexHouseVillaEditorTarget : TargetRules
{
    public TriplexHouseVillaEditorTarget(TargetInfo Target) : base(Target)
    {
        Type = TargetType.Editor;
        DefaultBuildSettings = BuildSettingsVersion.Latest;
        IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
        ExtraModuleNames.Add("TriplexHouseVilla");
    }
}
