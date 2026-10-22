using UnrealBuildTool;

public class TextureFormatWebCloud : ModuleRules
{
    public TextureFormatWebCloud(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.NoPCHs;
        bUseUnity = false;
        PrivateIncludePathModuleNames.AddRange(new string[] { "TextureCompressor", "TextureFormat" });
        PrivateDependencyModuleNames.AddRange(new string[] { "Core", "ImageCore", "TextureBuild" });
    }
}
