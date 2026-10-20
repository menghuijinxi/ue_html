#include "Common/TargetPlatformBase.h"
#include "Common/TargetPlatformControlsBase.h"
#include "Common/TargetPlatformSettingsBase.h"
#include "GenericPlatform/GenericPlatformProperties.h"
#include "Interfaces/ITargetPlatformModule.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "Modules/ModuleManager.h"
#include "StaticMeshResources.h"
#include "WebGPUShaderCode.h"

struct FWebGPUShaderHostProperties : FGenericPlatformProperties
{
    static const char *PlatformName()
    {
        return "WebGPUShaderHost";
    }
    static const char *IniPlatformName()
    {
        return "WebGPUShaderHost";
    }
    static bool HasEditorOnlyData()
    {
        return false;
    }
    static bool RequiresCookedData()
    {
        return true;
    }
    static bool IsServerOnly()
    {
        return false;
    }
    static bool IsClientOnly()
    {
        return false;
    }
    static bool SupportsBuildTarget(EBuildTargetType)
    {
        return false;
    }
};

class FWebGPUShaderHostSettings final : public TTargetPlatformSettingsBase<FWebGPUShaderHostProperties>
{
  public:
    // This discovers a host compiler; runtime platform configuration requires the source-engine Web extension.
    virtual FConfigCacheIni *GetConfigSystem() const override
    {
        return GConfig;
    }
    virtual bool SupportsFeature(ETargetPlatformFeatures) const override
    {
        return false;
    }
    virtual bool UsesRayTracing() const override
    {
        return false;
    }
    virtual bool UsesDistanceFields() const override
    {
        return false;
    }
    virtual void GetAllPossibleShaderFormats(TArray<FName> &Formats) const override
    {
        Formats.AddUnique(UE::WebGPUShader::ES31Format);
        Formats.AddUnique(UE::WebGPUShader::SM5Format);
    }
    virtual void GetAllTargetedShaderFormats(TArray<FName> &Formats) const override
    {
        GetAllPossibleShaderFormats(Formats);
    }
    virtual void GetShaderFormatModuleHints(TArray<FName> &Modules) const override
    {
        Modules.AddUnique(TEXT("WebGPUShaderFormat"));
    }
    virtual const UTextureLODSettings &GetTextureLODSettings() const override
    {
        check(TextureLODSettings);
        return *TextureLODSettings;
    }
    virtual void RegisterTextureLODSettings(const UTextureLODSettings *Settings) override
    {
        TextureLODSettings = Settings;
    }
    virtual const FStaticMeshLODSettings &GetStaticMeshLODSettings() const override
    {
        return StaticMeshLODSettings;
    }

  private:
    const UTextureLODSettings *TextureLODSettings = nullptr;
    FStaticMeshLODSettings StaticMeshLODSettings;
};

class FWebGPUShaderHostControls final : public TTargetPlatformControlsBase<FWebGPUShaderHostProperties>
{
  public:
    explicit FWebGPUShaderHostControls(ITargetPlatformSettings *Settings) : TTargetPlatformControlsBase(Settings)
    {
    }

    virtual void EnableDeviceCheck(bool) override
    {
    }
    virtual void GetAllDevices(TArray<ITargetDevicePtr> &) const override
    {
    }
    virtual ITargetDevicePtr GetDefaultDevice() const override
    {
        return nullptr;
    }
    virtual ITargetDevicePtr GetDevice(const FTargetDeviceId &) override
    {
        return nullptr;
    }
    virtual bool GenerateStreamingInstallManifest(const TMultiMap<FString, int32> &, const TSet<int32> &) const override
    {
        return false;
    }
    virtual bool IsSdkInstalled(bool, FString &Documentation) const override
    {
        Documentation.Reset();
        return false;
    }
    virtual bool PackageBuild(const FString &) override
    {
        return false;
    }
    virtual bool CanSupportRemoteShaderCompile() const override
    {
        return false;
    }
    virtual bool RequiresTempTarget(bool, EBuildConfiguration, bool, FText &Reason) const override
    {
        Reason = FText::FromString(TEXT("Shader compiler host only; Web runtime build is not implemented."));
        return false;
    }
    virtual void GetTextureFormats(const UTexture *, TArray<TArray<FName>> &) const override
    {
    }
    virtual FName GetWaveFormat(const USoundWave *) const override
    {
        return NAME_None;
    }
    virtual void GetAllWaveFormats(TArray<FName> &) const override
    {
    }
    virtual void GetWaveFormatModuleHints(TArray<FName> &) const override
    {
    }
};

class FWebGPUShaderHostTargetPlatformModule final : public ITargetPlatformModule
{
  protected:
    virtual void GetTargetPlatforms(TArray<ITargetPlatform *> &Platforms) override
    {
        if (FParse::Param(FCommandLine::Get(), TEXT("WebNullRHICook")) ||
            FParse::Param(FCommandLine::Get(), TEXT("WebGPUCook")))
            return;
        if (!Settings)
        {
            Settings = MakeUnique<FWebGPUShaderHostSettings>();
            Controls = MakeUnique<FWebGPUShaderHostControls>(Settings.Get());
        }
        Platforms.Add(new FTargetPlatformMerged(Settings.Get(), Controls.Get()));
    }

  private:
    TUniquePtr<FWebGPUShaderHostSettings> Settings;
    TUniquePtr<FWebGPUShaderHostControls> Controls;
};

IMPLEMENT_MODULE(FWebGPUShaderHostTargetPlatformModule, WebGPUShaderHostTargetPlatform);
