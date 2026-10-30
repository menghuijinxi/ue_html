#include "Common/TargetPlatformBase.h"
#include "Common/TargetPlatformControlsBase.h"
#include "DataDrivenShaderPlatformInfo.h"
#include "Interfaces/ITargetPlatformModule.h"
#include "Interfaces/ITargetPlatformSettingsModule.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "Modules/ModuleManager.h"
#include "TextureResource.h"
#include "Engine/VolumeTexture.h"
#include "Engine/TextureCube.h"
#include "Engine/TextureLightProfile.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "Components/SkyLightComponent.h"
#include "Materials/Material.h"
#include "MaterialDomain.h"
#include "Materials/MaterialExpressionShadingPathSwitch.h"
#include "UObject/UObjectIterator.h"
#include "UObject/ObjectSaveContext.h"
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
        const bool BC = FParse::Param(FCommandLine::Get(), TEXT("WebTextureCompressionBC")) ||
            FParse::Param(FCommandLine::Get(), TEXT("WebProjectSettingsCook"));
        for (FName& Format : Layers)
        {
            const FString Name = Format.ToString();
            if (Texture->IsA<UVolumeTexture>() &&
                FParse::Param(FCommandLine::Get(), TEXT("WebDefaultCloudDensityCook")) &&
                Texture->GetPathName() == TEXT("/Engine/EngineSky/VolumetricClouds/VT_PerlinWorley_Balanced.VT_PerlinWorley_Balanced"))
            {
                // The executed default material reads red and green; preserve both at half precision.
                Format = TEXT("WebCloudRG16F");
            }
            else if (Texture->IsA<UVolumeTexture>() &&
                FParse::Param(FCommandLine::Get(), TEXT("WebDefaultCloudDensityCook")) &&
                Texture->GetPathName() == TEXT("/Engine/EngineSky/VolumetricClouds/VT_Lightning.VT_Lightning"))
            {
                Format = TEXT("R16F");
            }
            else if (Texture->IsA<UVolumeTexture>())
                Format = TEXT("RGBA16F");
            else if (BC && Name == TEXT("RGBA16F") && Texture->IsA<UTextureCube>() &&
                Texture->CompressionSettings == TC_HDR && !Texture->CompressionNone &&
                FParse::Param(FCommandLine::Get(), TEXT("WebCompressHDRCubemaps")))
                Format = TEXT("BC6H");
            else if (!BC && (Name == TEXT("BC6H") || Name == TEXT("BC6H_SF16")))
                Format = TEXT("RGBA16F");
            else if (!BC && (Name.StartsWith(TEXT("DXT")) || Name.StartsWith(TEXT("BC")) || Name == TEXT("AutoDXT")))
                Format = TEXT("BGRA8");
        }
    }
    virtual void GetTextureFormatModuleHints(TArray<FName>& Modules) const override
    {
        Modules.AddUnique(TEXT("TextureFormatUncompressed"));
        Modules.AddUnique(TEXT("TextureFormatWebCloud"));
        if (FParse::Param(FCommandLine::Get(), TEXT("WebTextureCompressionBC")) ||
            FParse::Param(FCommandLine::Get(), TEXT("WebProjectSettingsCook")))
        {
            Modules.AddUnique(TEXT("TextureFormatDXT"));
            Modules.AddUnique(TEXT("TextureFormatIntelISPCTexComp"));
        }
    }
    virtual FName GetWaveFormat(const USoundWave*) const override { return NAME_None; }
    virtual void GetAllWaveFormats(TArray<FName>&) const override {}
    virtual void GetWaveFormatModuleHints(TArray<FName>&) const override {}
};

class FWebTargetPlatformModule final : public ITargetPlatformModule
{
public:
    virtual void StartupModule() override
    {
        if (FParse::Param(FCommandLine::Get(), TEXT("WebGPUCook")))
        {
            // Normalize linear IES assets for both rendering paths without saving source assets.
            LoadedHandle = FCoreUObjectDelegates::OnAssetLoaded.AddRaw(this, &FWebTargetPlatformModule::PrepareCloud);
            for (TObjectIterator<UMaterial> It; It; ++It)
                PrepareCloud(*It);
            for (TObjectIterator<UTextureLightProfile> It; It; ++It)
                PrepareCloud(*It);
            SavingHandle = FCoreUObjectDelegates::OnObjectPreSave.AddLambda(
                [this](UObject* Object, FObjectPreSaveContext Context) {
                    if (Context.IsCooking() && Object->IsA<UWorld>())
                        PrepareCloud(Object);
                });
        }
    }
    virtual void ShutdownModule() override
    {
        FCoreUObjectDelegates::OnAssetLoaded.Remove(LoadedHandle);
        FCoreUObjectDelegates::OnObjectPreSave.Remove(SavingHandle);
    }
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
    void PrepareCloud(UObject* Object)
    {
        if (auto* World = Cast<UWorld>(Object);
            World && FParse::Param(FCommandLine::Get(), TEXT("WebProjectDisableSkyLightCook")))
        {
            int32 Disabled = 0;
            for (TActorIterator<AActor> It(World); It; ++It)
            {
                TInlineComponentArray<USkyLightComponent*> Components(*It);
                for (USkyLightComponent* Component : Components)
                {
                    Component->SetVisibility(false);
                    ++Disabled;
                }
            }
            UE_LOG(LogTemp, Display, TEXT("WEB_PROJECT_COOK: disabledSkyLights=%d map=%s"),
                Disabled, *World->GetPathName());
        }
        if (auto* Profile = Cast<UTextureLightProfile>(Object); Profile && Profile->SRGB)
        {
            // IES intensities are linear; RGBA16F has no sRGB GPU format.
            Profile->SRGB = false;
            UE_LOG(LogTemp, Display, TEXT("WEB_TEXTURE_COOK: linear IES profile %s"), *Profile->GetPathName());
        }
        // Only the mobile Cook needs the source-branch cloud material override.
        if (!FParse::Param(FCommandLine::Get(), TEXT("WebGPUES31Cook")))
            return;
        UMaterial* Material = Cast<UMaterial>(Object);
        if (!Material || Material->MaterialDomain != MD_Volume || !Material->GetUsageByFlag(MATUSAGE_VolumetricCloud) ||
            PreparedClouds.Contains(Material))
            return;
        PreparedClouds.Add(Material);
        for (UMaterialExpression* Expression : Material->GetExpressions())
        {
            if (auto* Switch = Cast<UMaterialExpressionShadingPathSwitch>(Expression))
            {
                const auto& Full = Switch->Inputs[ERHIShadingPath::Deferred].IsConnected() ?
                    Switch->Inputs[ERHIShadingPath::Deferred] : Switch->Default;
                Switch->Inputs[ERHIShadingPath::Mobile] = Full;
                UE_LOG(LogTemp, Display, TEXT("WEB_CLOUD_COOK: full volume branch %s input=%s"),
                    *Switch->GetPathName(), *GetPathNameSafe(Full.Expression));
            }
        }
    }
    FDelegateHandle LoadedHandle;
    FDelegateHandle SavingHandle;
    TSet<TWeakObjectPtr<UMaterial>> PreparedClouds;
    TUniquePtr<FWebCookControls> Controls;
};

IMPLEMENT_MODULE(FWebTargetPlatformModule, WebCookTargetPlatform);
