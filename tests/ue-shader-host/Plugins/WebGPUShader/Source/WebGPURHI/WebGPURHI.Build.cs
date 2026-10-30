using System.IO;
using UnrealBuildTool;

public class WebGPURHI : ModuleRules
{
    public WebGPURHI(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.NoPCHs;
        bUseUnity = false;
        if (Target.Platform == UnrealTargetPlatform.Win64 &&
            System.Environment.GetEnvironmentVariable("WEBGPU_NATIVE_PROBE_NO_OPTIMIZE") == "1")
            OptimizeCode = CodeOptimization.Never;
        PrivateDependencyModuleNames.AddRange(new string[] { "Core", "RHI", "RHICore", "RenderCore", "Json" });
        PrivateIncludePaths.Add(Path.Combine(EngineDirectory, "Source/Runtime/RHICore/Internal"));
        string Dawn = Path.GetFullPath(Path.Combine(ModuleDirectory, "../../../../../../.tools/dawn-v20261009.190412"));
        string DawnHost = Path.GetFullPath(Path.Combine(ModuleDirectory, "../../../../../../.tools/ue58-dawn-host"));
        PrivateIncludePaths.Add(Path.Combine(Dawn, "include"));
        PrivateDefinitions.Add("WGPU_SHARED_LIBRARY=1");
        PublicAdditionalLibraries.Add(Path.Combine(DawnHost, "WebGPUHost.lib"));
        PublicSystemLibraries.Add("user32.lib");
    }
}
