using UnrealBuildTool;

public class TriplexHouseVilla : ModuleRules
{
    public TriplexHouseVilla(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
        PublicDependencyModuleNames.AddRange(new[] { "Core", "CoreUObject", "Engine", "InputCore" });
    }
}
