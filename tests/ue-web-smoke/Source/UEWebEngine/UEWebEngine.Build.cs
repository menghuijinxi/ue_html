using UnrealBuildTool;

public class UEWebEngine : ModuleRules
{
    public UEWebEngine(ReadOnlyTargetRules target) : base(target)
    {
        PCHUsage = PCHUsageMode.NoPCHs;
        PrivateDependencyModuleNames.AddRange(new[] { "Core", "CoreUObject", "ApplicationCore", "Engine", "Launch", "WebGPURHI", "RenderCore", "RHI", "UMG" });
    }
}
