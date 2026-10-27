using UnrealBuildTool;

public class UEWebThreads : ModuleRules
{
    public UEWebThreads(ReadOnlyTargetRules target) : base(target)
    {
        PCHUsage = PCHUsageMode.NoPCHs;
        PrivateDependencyModuleNames.Add("Core");
    }
}
