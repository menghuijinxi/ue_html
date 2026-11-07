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
        if (Target.bBuildEditor)
        {
            PrivateDependencyModuleNames.AddRange(new string[] { "CoreUObject", "Engine", "TargetPlatform", "WebGPUShaderFormat" });
            PrivateIncludePaths.Add(Path.Combine(EngineDirectory, "Source/Runtime/Engine/Internal"));
            PrivateIncludePaths.Add(Path.Combine(ModuleDirectory, "../../Intermediate/NaniteUploaderProbe"));
            PrivateIncludePaths.Add(Path.Combine(EngineDirectory, "Source/Runtime/Engine/Private"));
            PrivateIncludePaths.Add(Path.GetFullPath(Path.Combine(ModuleDirectory,
                "../../../../../../reference-engine/Engine/Source/Runtime/RenderCore/Public")));
            string UploaderSource = Path.GetFullPath(Path.Combine(ModuleDirectory,
                "../../../../../../reference-engine/Engine/Source/Runtime/Engine/Private/Nanite"));
            string UploaderProbe = Path.GetFullPath(Path.Combine(ModuleDirectory, "../../Intermediate/NaniteUploaderProbe"));
            Directory.CreateDirectory(UploaderProbe);
            foreach (string Name in new[] { "NaniteStreamingPageUploader.h", "NaniteStreamingPageUploader.cpp" })
            {
                string Input = Path.Combine(UploaderSource, Name);
                ExternalDependencies.Add(Input);
                string Text = File.ReadAllText(Input).Replace("FStreamingPageUploader", "FWebProbeStreamingPageUploader")
                    .Replace("FTranscodePageToGPU_CS", "FWebProbeTranscodePageToGPU_CS")
                    .Replace("r.Nanite.Streaming.", "r.WebProbe.Nanite.Streaming.");
                string Output = Path.Combine(UploaderProbe, Name);
                if (!File.Exists(Output) || File.ReadAllText(Output) != Text) File.WriteAllText(Output, Text);
            }
        }
        PrivateIncludePaths.Add(Path.Combine(EngineDirectory, "Source/Runtime/RHICore/Internal"));
        PrivateIncludePaths.Add(Path.Combine(EngineDirectory, "Source/Runtime/RHI/Internal"));
        PrivateIncludePaths.Add(Path.Combine(EngineDirectory, "Source/Runtime/RenderCore/Private"));
        PrivateIncludePaths.Add(Path.GetFullPath(Path.Combine(ModuleDirectory,
            "../../../../../../reference-engine/Engine/Source/Runtime/Renderer/Private/Nanite")));
        string Dawn = Path.GetFullPath(Path.Combine(ModuleDirectory, "../../../../../../.tools/dawn-v20261009.190412"));
        string DawnHost = Path.GetFullPath(Path.Combine(ModuleDirectory, "../../../../../../.tools/ue58-dawn-host"));
        PrivateIncludePaths.Add(Path.Combine(Dawn, "include"));
        PrivateDefinitions.Add("WGPU_SHARED_LIBRARY=1");
        PublicAdditionalLibraries.Add(Path.Combine(DawnHost, "WebGPUHost.lib"));
        RuntimeDependencies.Add("$(PluginDir)/Binaries/Win64/WebGPUHost.dll", Path.Combine(DawnHost, "WebGPUHost.dll"));
        PublicSystemLibraries.Add("user32.lib");
    }
}
