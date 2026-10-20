using UnrealBuildTool;

public class UEWebSmoke : ModuleRules
{
    public UEWebSmoke(ReadOnlyTargetRules target) : base(target)
    {
        PCHUsage = PCHUsageMode.NoPCHs;
        PrivateDependencyModuleNames.Add("Core");
    }
}
