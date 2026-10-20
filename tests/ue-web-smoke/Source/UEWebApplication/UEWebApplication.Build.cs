using UnrealBuildTool;

public class UEWebApplication : ModuleRules
{
    public UEWebApplication(ReadOnlyTargetRules target) : base(target)
    {
        PCHUsage = PCHUsageMode.NoPCHs;
        PrivateDependencyModuleNames.AddRange(new[] { "Core", "ApplicationCore" });
    }
}
