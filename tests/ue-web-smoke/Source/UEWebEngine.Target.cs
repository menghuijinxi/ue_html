using System.IO;
using UnrealBuildTool;

[SupportedPlatforms("Web")]
public class UEWebEngineTarget : UEWebApplicationTarget
{
    public UEWebEngineTarget(TargetInfo target) : base(target)
    {
        LaunchModuleName = "UEWebEngine";
        bCompileAgainstEngine = true;
        bCompileAgainstCoreUObject = true;
        bUseUnityBuild = !(target.Arguments?.HasOption("-WebEngineCompileProbe") ?? false);
        bUseAdaptiveUnityBuild = false;
        bBuildRequiresCookedData = true;
        bCompileFreeType = false;
        bBuildDeveloperTools = false;
        bCompileRecast = false;
        bCompileNavmeshSegmentLinks = false;
        bCompileNavmeshClusterLinks = false;
        bUseLoggingInShipping = true;
        AdditionalLinkerArguments += " -g2 -sSTACK_SIZE=4194304";
        string Workspace = Path.GetFullPath(Path.Combine(ProjectFile.Directory.FullName, "../.."));
        AdditionalLinkerArguments += " --use-port=\"" +
            Path.Combine(Workspace, "reference-engine/Engine/Platforms/Web/Build/emdawnwebgpu-ue.port.py")
                .Replace('\\', '/') + "\"";
    }
}
