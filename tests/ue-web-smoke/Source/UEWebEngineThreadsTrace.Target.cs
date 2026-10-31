using UnrealBuildTool;

[SupportedPlatforms("Web")]
public class UEWebEngineThreadsTraceTarget : UEWebEngineThreadsTarget
{
    public UEWebEngineThreadsTraceTarget(TargetInfo target) : base(target)
    {
        GlobalDefinitions.Add("UE_WEB_TRACE=1");
    }
}
