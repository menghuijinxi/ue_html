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
        // Final Wasm/JS optimization is independent of C++ object optimization.
        // Keep it explicit while validating memory64/shared-memory codegen.
        int WebLinkOptimization = target.Arguments?.GetIntegerOrDefault("-WebLinkOptimization=", 0) ?? 0;
        if (WebLinkOptimization < 0 || WebLinkOptimization > 2)
            throw new BuildException("WebLinkOptimization must be 0, 1 or 2.");
        if (WebLinkOptimization > 0)
            AdditionalLinkerArguments += " -O" + WebLinkOptimization;
        // Isolate the O2 Wasm optimization from export/JS name minification.
        if (target.Arguments?.HasOption("-WebKeepLinkNames") ?? false)
            AdditionalLinkerArguments += " -g3";
        // Allocator-only experiment: reuse the same UE objects and Cook.
        string Workspace = Path.GetFullPath(Path.Combine(ProjectFile.Directory.FullName, "../.."));
        if (target.Arguments?.HasOption("-WebAllocationProbe") ?? false)
            AdditionalLinkerArguments += " -Wl,--whole-archive,\"" +
                Path.Combine(Workspace, ".tools/web-allocation-probe/probe.a").Replace('\\', '/') +
                "\",--no-whole-archive,--wrap=malloc,--wrap=calloc,--wrap=realloc,--wrap=free,--wrap=posix_memalign,--wrap=malloc_usable_size";
        if (target.Arguments?.HasOption("-WebMimalloc") ?? false)
            AdditionalLinkerArguments += " -sMALLOC=mimalloc -Wl,--whole-archive,\"" +
                Path.Combine(Workspace, ".tools/web-mimalloc-ue/libmimalloc-ue-mt.a").Replace('\\', '/') +
                "\",--no-whole-archive";
        AdditionalLinkerArguments += " --use-port=\"" +
            Path.Combine(Workspace, "reference-engine/Engine/Platforms/Web/Build/emdawnwebgpu-ue.port.py")
                .Replace('\\', '/') + "\"";
    }
}
