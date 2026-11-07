using UnrealBuildTool;
using System.IO;

public class UEWebEngine : ModuleRules
{
    public UEWebEngine(ReadOnlyTargetRules target) : base(target)
    {
        PCHUsage = PCHUsageMode.NoPCHs;
        PrivateDependencyModuleNames.AddRange(new[] { "Core", "CoreUObject", "ApplicationCore", "Engine", "Launch", "WebGPURHI", "RenderCore", "RHI", "Json", "UMG", "EnhancedInput" });
        PrivateIncludePaths.Add(Path.Combine(EngineDirectory, "Source/Runtime/Engine/Private"));
        PrivateIncludePaths.Add(Path.Combine(EngineDirectory, "Source/Runtime/Engine/Internal"));
    }
}
