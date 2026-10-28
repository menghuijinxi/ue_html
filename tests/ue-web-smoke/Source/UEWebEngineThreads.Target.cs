using System.IO;
using UnrealBuildTool;

[SupportedPlatforms("Web")]
public class UEWebEngineThreadsTarget : UEWebEngineTarget
{
    public UEWebEngineThreadsTarget(TargetInfo target) : base(target)
    {
        GlobalDefinitions.Add("UE_WEB_THREADS=1");
        GlobalDefinitions.Add("UE_WEB_ENGINE_WORKER=1");
        AdditionalLinkerArguments += " -sINITIAL_MEMORY=134217728";
        AdditionalLinkerArguments += " -sINCOMING_MODULE_JS_API=arguments,canvas,locateFile,print,printErr,onAbort,onRuntimeInitialized,preRun,mainScriptUrlOrBlob";
        string Workspace = Path.GetFullPath(Path.Combine(ProjectFile.Directory.FullName, "../.."));
        AdditionalLinkerArguments += " --js-library=\"" +
            Path.Combine(Workspace, "reference-engine/Engine/Platforms/Web/Build/WebWorkerCanvas.js")
                .Replace('\\', '/') + "\"";
    }
}
