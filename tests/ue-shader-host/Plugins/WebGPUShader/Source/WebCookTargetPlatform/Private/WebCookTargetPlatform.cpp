#include "Common/TargetPlatformBase.h"
#include "Common/TargetPlatformControlsBase.h"
#include "DataDrivenShaderPlatformInfo.h"
#include "Interfaces/ITargetPlatformModule.h"
#include "Interfaces/ITargetPlatformSettingsModule.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "Modules/ModuleManager.h"
#include "TextureResource.h"
#include "WebCookProperties.h"

class FWebCookControls final : public TTargetPlatformControlsBase<FWebCookProperties>
{
public:
    explicit FWebCookControls(ITargetPlatformSettings* Settings) : TTargetPlatformControlsBase(Settings) {}

    virtual void EnableDeviceCheck(bool) override {}
    virtual void GetAllDevices(TArray<ITargetDevicePtr>&) const override {}
    virtual ITargetDevicePtr GetDefaultDevice() const override { return nullptr; }
    virtual ITargetDevicePtr GetDevice(const FTargetDeviceId&) override { return nullptr; }
    virtual bool GenerateStreamingInstallManifest(const TMultiMap<FString, int32>&, const TSet<int32>&) const override
    {
        return false;
    }
    virtual bool IsSdkInstalled(bool, FString& Documentation) const override
    {
        Documentation.Reset();
        return FParse::Param(FCommandLine::Get(), TEXT("WebNullRHICook")) ||
            FParse::Param(FCommandLine::Get(), TEXT("WebGPUCook"));
    }
    virtual bool PackageBuild(const FString&) override { return false; }
    virtual bool CanSupportRemoteShaderCompile() const override { return false; }
    virtual void GetTextureFormats(const UTexture* Texture, TArray<TArray<FName>>& Formats) const override
    {
        TArray<FName>& Layers = Formats.AddDefaulted_GetRef();
        GetDefaultTextureFormatNamePerLayer(Layers, TargetPlatformSettings, this, Texture, false, 4, false);
        for (FName& Format : Layers)
        {
            const FString Name = Format.ToString();
            if (Name == TEXT("BC6H") || Name == TEXT("BC6H_SF16"))
                Format = TEXT("RGBA16F");
            else if (Name.StartsWith(TEXT("DXT")) || Name.StartsWith(TEXT("BC")) || Name == TEXT("AutoDXT"))
                Format = TEXT("BGRA8");
        }
    }
    virtual void GetTextureFormatModuleHints(TArray<FName>& Modules) const override
    {
        Modules.AddUnique(TEXT("TextureFormatUncompressed"));
    }
    virtual FName GetWaveFormat(const USoundWave*) const override { return NAME_None; }
    virtual void GetAllWaveFormats(TArray<FName>&) const override {}
    virtual void GetWaveFormatModuleHints(TArray<FName>&) const override {}
};

class FWebTargetPlatformModule final : public ITargetPlatformModule
{
protected:
    virtual void GetTargetPlatforms(TArray<ITargetPlatform*>& Platforms) override
    {
        const bool bNullRHI = FParse::Param(FCommandLine::Get(), TEXT("WebNullRHICook"));
        const bool bWebGPU = FParse::Param(FCommandLine::Get(), TEXT("WebGPUCook"));
        const bool bES31 = FParse::Param(FCommandLine::Get(), TEXT("WebGPUES31Cook"));
        if (!bNullRHI && !bWebGPU)
            return;
        checkf(bNullRHI != bWebGPU, TEXT("Select exactly one Web Cook mode."));
        if (!Controls)
        {
            if (bWebGPU)
            {
                FDataDrivenShaderPlatformInfo::Initialize();
                const EShaderPlatform Platform = FDataDrivenShaderPlatformInfo::GetShaderPlatformFromName(
                    bES31 ? TEXT("SP_WEBGPU_ES31") : TEXT("SP_WEBGPU_SM5"));
                UE_LOG(LogTemp, Display, TEXT("WEB_COOK: shader registration platform=%u name=%s"),
                    uint32(Platform), Platform != SP_NumPlatforms ?
                        *FDataDrivenShaderPlatformInfo::GetPlatformName(Platform).ToString() : TEXT("unregistered"));
                checkf(Platform == EShaderPlatform(bES31 ? 46 : 47) &&
                    FDataDrivenShaderPlatformInfo::GetPlatformName(Platform) == FName(TEXT("Web")),
                    TEXT("WebGPU Cook requires the isolated Web platform map."));
                UE_LOG(LogTemp, Display, TEXT("WEB_COOK: WebGPU wasm64 packages; platform=%u propertiesHash=%u mobile=%d; no audio."),
                    uint32(Platform), FDataDrivenShaderPlatformInfo::GetShaderPlatformPropertiesHash(Platform), bES31);
            }
            else
            {
                UE_LOG(LogTemp, Display, TEXT("WEB_COOK: NullRHI-only wasm64 packages; no WebGPU shaders or audio."));
            }
            const auto Settings = FModuleManager::LoadModuleChecked<ITargetPlatformSettingsModule>(
                TEXT("WebCookTargetPlatformSettings")).GetTargetPlatformSettings();
            check(Settings.Num() == 1);
            Controls = MakeUnique<FWebCookControls>(Settings[0]);
        }
        Platforms.Add(new FTargetPlatformMerged(Controls->GetTargetPlatformSettings(), Controls.Get()));
    }

private:
    TUniquePtr<FWebCookControls> Controls;
};

IMPLEMENT_MODULE(FWebTargetPlatformModule, WebCookTargetPlatform);
