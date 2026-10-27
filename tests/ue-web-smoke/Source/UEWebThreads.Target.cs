using UnrealBuildTool;

[SupportedPlatforms("Web")]
public class UEWebThreadsTarget : UEWebSmokeTarget
{
    public UEWebThreadsTarget(TargetInfo target) : base(target)
    {
        LaunchModuleName = "UEWebThreads";
        GlobalDefinitions.Add("UE_WEB_THREADS=1");
        AdditionalLinkerArguments += " -g2 -sSTACK_SIZE=4194304 -sINITIAL_MEMORY=67108864 -sMAXIMUM_MEMORY=536870912 -sEXIT_RUNTIME=1";
    }
}
