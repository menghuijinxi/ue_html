#include "Common/TargetPlatformSettingsBase.h"
#include "Interfaces/ITargetPlatformSettingsModule.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "Modules/ModuleManager.h"
#include "StaticMeshResources.h"
#include "HAL/IConsoleManager.h"
#include "RenderUtils.h"
#include "ShaderPlatformCachedIniValue.h"
#include "WebCookProperties.h"

class FWebCookSettings final : public TTargetPlatformSettingsBase<FWebCookProperties>
{
public:
    explicit FWebCookSettings(bool InWebGPU, bool InES31) : bWebGPU(InWebGPU), bES31(InES31)
    {
        StaticMeshLODSettings.Initialize(this);
    }

    virtual bool SupportsFeature(ETargetPlatformFeatures Feature) const override
    {
        return bWebGPU && (Feature == ETargetPlatformFeatures::TextureStreaming ||
            (Feature == ETargetPlatformFeatures::DistanceFieldAO && UsesDistanceFields()) ||
            (Feature == ETargetPlatformFeatures::LumenGI && UsesDistanceFields() && SupportsLumen()) ||
            Feature == (bES31 ? ETargetPlatformFeatures::MobileRendering :
                ETargetPlatformFeatures::DeferredRendering));
    }
    virtual bool UsesRayTracing() const override { return false; }
    virtual bool UsesDistanceFields() const override
    {
        static FTargetPlatformCachedIniValue<int32> Generate(TEXT("r.GenerateMeshDistanceFields"));
        return bWebGPU && !bES31 && (FParse::Param(FCommandLine::Get(), TEXT("WebDistanceFieldsCook")) ||
            (FParse::Param(FCommandLine::Get(), TEXT("WebProjectSettingsCook")) &&
                Generate.Get(FName(TEXT("Web"))) != 0));
    }

    virtual void GetReflectionCaptureFormats(TArray<FName>& Formats) const override
    {
        Formats.Add(bES31 ? FName(TEXT("EncodedHDR")) : FName(TEXT("FullHDR")));
    }

    virtual void GetAllPossibleShaderFormats(TArray<FName>& Formats) const override
    {
        if (bWebGPU)
            Formats.AddUnique(bES31 ? TEXT("SF_WEBGPU_ES31") : TEXT("SF_WEBGPU_SM5"));
    }
    virtual void GetAllTargetedShaderFormats(TArray<FName>& Formats) const override
    {
        GetAllPossibleShaderFormats(Formats);
    }
    virtual void GetShaderFormatModuleHints(TArray<FName>& Modules) const override
    {
        if (bWebGPU)
            Modules.AddUnique(TEXT("WebGPUShaderFormat"));
    }
    virtual const UTextureLODSettings& GetTextureLODSettings() const override
    {
        check(TextureLODSettings);
        return *TextureLODSettings;
    }
    virtual void RegisterTextureLODSettings(const UTextureLODSettings* Settings) override
    {
        TextureLODSettings = Settings;
    }
    virtual const FStaticMeshLODSettings& GetStaticMeshLODSettings() const override
    {
        return StaticMeshLODSettings;
    }

private:
    bool SupportsLumen() const
    {
        if (!bWebGPU || bES31)
            return false;
        const EShaderPlatform Platform =
            FDataDrivenShaderPlatformInfo::GetShaderPlatformFromName(TEXT("SP_WEBGPU_SM5"));
        return Platform != SP_NumPlatforms && DoesPlatformSupportLumenGI(Platform);
    }

    bool bWebGPU;
    bool bES31;
    const UTextureLODSettings* TextureLODSettings = nullptr;
    FStaticMeshLODSettings StaticMeshLODSettings;
};

class FWebTargetPlatformSettingsModule final : public ITargetPlatformSettingsModule
{
protected:
    virtual void GetTargetPlatformSettings(TArray<ITargetPlatformSettings*>& Settings) override
    {
        const bool bNullRHI = FParse::Param(FCommandLine::Get(), TEXT("WebNullRHICook"));
        const bool bWebGPU = FParse::Param(FCommandLine::Get(), TEXT("WebGPUCook"));
        if (!bNullRHI && !bWebGPU)
            return;
        checkf(bNullRHI != bWebGPU, TEXT("Select exactly one Web Cook mode."));
        Settings.Add(new FWebCookSettings(bWebGPU,
            FParse::Param(FCommandLine::Get(), TEXT("WebGPUES31Cook"))));
    }
};

IMPLEMENT_MODULE(FWebTargetPlatformSettingsModule, WebCookTargetPlatformSettings);
