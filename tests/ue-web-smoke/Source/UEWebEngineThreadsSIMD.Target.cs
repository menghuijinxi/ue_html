using UnrealBuildTool;

[SupportedPlatforms("Web")]
public class UEWebEngineThreadsSIMDTarget : UEWebEngineThreadsTarget
{
    public UEWebEngineThreadsSIMDTarget(TargetInfo target) : base(target)
    {
        // Separate objects keep the scalar baseline immutable. This enables
        // LLVM auto-vectorization; UE's explicit SSE/NEON path is unchanged.
        AdditionalCompilerArguments += " -msimd128";
        AdditionalLinkerArguments += " -msimd128";
    }
}
