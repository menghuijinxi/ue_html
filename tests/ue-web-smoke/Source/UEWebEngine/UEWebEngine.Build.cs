using UnrealBuildTool;
using System.IO;

public class UEWebEngine : ModuleRules
{
    public UEWebEngine(ReadOnlyTargetRules target) : base(target)
    {
        PCHUsage = PCHUsageMode.NoPCHs;
        // Runtime probes keep file-local state in anonymous namespaces. Keep
        // this small application module separate when UE regenerates unity
        // batches after adding new probes; engine modules retain unity builds.
        bUseUnity = false;
        PrivateDependencyModuleNames.AddRange(new[] { "Core", "CoreUObject", "ApplicationCore", "Engine", "Launch", "WebGPURHI", "RenderCore", "RHI", "Json", "UMG", "Slate", "SlateCore", "EnhancedInput", "Renderer" });
        PrivateIncludePaths.Add(Path.Combine(EngineDirectory, "Source/Runtime/Engine/Private"));
        PrivateIncludePaths.Add(Path.Combine(EngineDirectory, "Source/Runtime/Engine/Internal"));
    }
}
