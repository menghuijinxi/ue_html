using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using EpicGames.Core;
using Microsoft.Extensions.Logging;
using UnrealBuildBase;

namespace UnrealBuildTool;

internal sealed class WebToolchainSmokeMode : IToolMode<WebToolchainSmokeMode>
{
    public static string Name => "WebToolchainSmoke";
    public static ToolModeOptions Options => ToolModeOptions.BuildPlatformsForValidation | ToolModeOptions.XmlConfig;

#pragma warning disable CS0649
    [CommandLine("-Source=", Required = true)] public FileReference Source = null!;
    [CommandLine("-Output=", Required = true)] public DirectoryReference Output = null!;
    [CommandLine("-CoreTypes")] public bool CoreTypes;
    [CommandLine("-CoreObject=")] public FileReference? CoreObject;
#pragma warning restore CS0649

    private sealed class CaptureGraph(ILogger logger) : ForwardingActionGraphBuilder(new NullActionGraphBuilder(logger))
    {
        internal readonly List<IExternalAction> Actions = [];
        public override void AddAction(IExternalAction action) => Actions.Add(action);
    }

    public async Task<int> ExecuteAsync(CommandLineArguments arguments, ILogger logger)
    {
        UnrealBuildTool.InitialEnvironment = Environment.GetEnvironmentVariables();
        arguments.ApplyTo(this);
        arguments.CheckAllArgumentsUsed();
        if (CoreObject != null && !CoreTypes)
            throw new BuildException("-CoreObject requires -CoreTypes.");
        UEBuildPlatform platform = UEBuildPlatform.GetBuildPlatform(UnrealTargetPlatform.Web);
        if (platform.HasRequiredSDKsInstalled() != SDKStatus.Valid)
            throw new BuildException("Web SDK validation failed.");
        DirectoryReference.CreateDirectory(Output);
        UnrealArchitectures architectures = new(UnrealArch.Wasm64);
        CppCompileEnvironment compile = new(UnrealTargetPlatform.Web, CppConfiguration.Development,
            architectures, SourceFileMetadataCache.CreateHierarchy(null, logger));
        WebPlatform.SetWebDefinitions(compile);
        if (CoreTypes)
        {
            compile.UserIncludePaths.Add(DirectoryReference.Combine(Unreal.EngineSourceDirectory, "Runtime", "Core", "Public"));
            compile.UserIncludePaths.Add(DirectoryReference.Combine(Unreal.EngineDirectory, "Platforms", "Web", "Source", "Runtime", "Core", "Public"));
            compile.Definitions.AddRange(["UE_BUILD_DEVELOPMENT=1", "IS_MONOLITHIC=1", "WITH_EDITOR=0",
                "WITH_EDITORONLY_DATA=0", "UE_TRACE_ENABLED=0", "CORE_API=", "WITH_ENGINE=0",
                "WITH_UNREAL_DEVELOPER_TOOLS=0", "WITH_PLUGIN_SUPPORT=0", "IS_PROGRAM=1", "UBT_COMPILED_PLATFORM=Web"]);
            if (CoreObject != null)
            {
                compile.SystemIncludePaths.Add(DirectoryReference.Combine(Unreal.EngineSourceDirectory,
                    "ThirdParty", "zlib", "1.3", "include"));
                compile.UserIncludePaths.Add(DirectoryReference.Combine(Unreal.EngineSourceDirectory,
                    "Runtime", "TraceLog", "Public"));
                compile.Definitions.Add("TRACELOG_API=");
            }
        }
        WebToolChain toolchain = new(logger);
        CaptureGraph graph = new(logger);
        CPPOutput objects = toolchain.CompileAllCPPFiles(compile,
            [FileItem.GetItemByFileReference(Source)], Output, "WebToolchainSmoke", graph);
        LinkEnvironment archive = new(UnrealTargetPlatform.Web, CppConfiguration.Development, architectures);
        archive.bIsBuildingLibrary = true;
        archive.InputFiles.AddRange(objects.ObjectFiles);
        if (CoreObject != null)
            archive.InputFiles.Add(FileItem.GetItemByFileReference(CoreObject));
        archive.OutputFilePaths.Add(FileReference.Combine(Output, "web-ubt-smoke.a"));
        FileItem library = toolchain.LinkFiles(archive, false, graph);
        LinkEnvironment link = new(UnrealTargetPlatform.Web, CppConfiguration.Development, architectures);
        link.Libraries.Add(library.Location);
        if (CoreObject != null)
            link.SystemLibraries.Add("z");
        link.OutputFilePaths.Add(FileReference.Combine(Output, "web-ubt-smoke.js"));
        toolchain.LinkFiles(link, false, graph);
        List<LinkedAction> actions = graph.Actions.Select(action => new LinkedAction(action, null)).ToList();
        ActionGraph.Link(actions, logger);
        ActionGraph.ExportJson(actions, FileReference.Combine(Output, "actions.json"));
        ActionGraph.CreateDirectoriesForProducedItems(actions);
        BuildConfiguration config = new()
        {
            bAllowUBAExecutor = false, bAllowXGE = false, bAllowFASTBuild = false,
            bAllowSNDBS = false, MaxParallelActions = 2
        };
        await ActionGraph.ExecuteActionsAsync(config, actions, [], logger);
        logger.LogInformation("P3_WEB_UBT wasm64 compile/link actions completed: {Count}", actions.Count);
        return 0;
    }
}
