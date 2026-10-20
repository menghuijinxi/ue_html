#include "WebShaderPlatformProbe.h"

#include "DataDrivenShaderPlatformInfo.h"
#include "Dom/JsonObject.h"
#include "Misc/DataDrivenPlatformInfoRegistry.h"
#include "Misc/FileHelper.h"
#include "RHI.h"
#include "Serialization/JsonSerializer.h"
#include "WebGPUShaderCode.h"

EShaderPlatform ResolveProbeShaderPlatform(const FString &Params, const FString &OutputDirectory, bool Mobile,
                                           EShaderPlatform NativePlatform)
{
    if (!FParse::Param(*Params, TEXT("WebShaderPlatform")))
        return NativePlatform;
    const FName Name(Mobile ? TEXT("SP_WEBGPU_ES31") : TEXT("SP_WEBGPU_SM5"));
    const FName Format = Mobile ? UE::WebGPUShader::ES31Format : UE::WebGPUShader::SM5Format;
    const EShaderPlatform Platform = FDataDrivenShaderPlatformInfo::GetShaderPlatformFromName(Name);
    if (Platform == SP_NumPlatforms || !FDataDrivenShaderPlatformInfo::IsValid(Platform))
    {
        UE_LOG(LogTemp, Error, TEXT("Web static map/DDPI missing: %s"), *Name.ToString());
        return SP_NumPlatforms;
    }
    const bool Pass = static_cast<uint32>(Platform) == (Mobile ? 46u : 47u) &&
                      FDataDrivenShaderPlatformInfo::GetName(Platform) == Name &&
                      FDataDrivenShaderPlatformInfo::GetPlatformName(Platform) == FName(TEXT("WebGPU")) &&
                      LegacyShaderPlatformToShaderFormat(Platform) == Format &&
                      ShaderFormatToLegacyShaderPlatform(Format) == Platform &&
                      FDataDrivenShaderPlatformInfo::GetMaxFeatureLevel(Platform) ==
                          (Mobile ? ERHIFeatureLevel::ES3_1 : ERHIFeatureLevel::SM5) &&
                      FDataDrivenShaderPlatformInfo::GetSupportsUniformBufferObjects(Platform) &&
                      !FDataDrivenShaderPlatformInfo::GetSupportsTypedBufferSRVs(Platform) &&
                      !FDataDrivenShaderPlatformInfo::GetSupportsManualVertexFetch(Platform) &&
                      !FDataDrivenShaderPlatformInfo::GetSupportsGPUScene(Platform) &&
                      !FDataDrivenShaderPlatformInfo::GetSupportsRayTracing(Platform) &&
                      !FDataDrivenShaderPlatformInfo::GetSupportsNanite(Platform) &&
                      !FDataDrivenShaderPlatformInfo::GetSupportsLumenGI(Platform) &&
                      !FDataDrivenShaderPlatformInfo::GetSupportsBindless(Platform) &&
                      !FDataDrivenShaderPlatformInfo::GetIsPreviewPlatform(Platform);
    TSharedRef<FJsonObject> Json = MakeShared<FJsonObject>();
    Json->SetBoolField(TEXT("pass"), Pass);
    Json->SetStringField(TEXT("name"), Name.ToString());
    Json->SetStringField(TEXT("platformName"), TEXT("WebGPU"));
    Json->SetStringField(TEXT("format"), Format.ToString());
    Json->SetNumberField(TEXT("enum"), Platform);
    Json->SetNumberField(TEXT("propertiesHash"),
                         FDataDrivenShaderPlatformInfo::GetShaderPlatformPropertiesHash(Platform));
    Json->SetStringField(TEXT("featureLevel"), Mobile ? TEXT("ES3_1") : TEXT("SM5"));
    Json->SetBoolField(TEXT("runtimeCookEnabled"),
                       FDataDrivenPlatformInfoRegistry::GetPlatformInfo(FName(TEXT("WebGPU"))).bEnabledForUse);
    Json->SetBoolField(TEXT("isPreviewPlatform"), FDataDrivenShaderPlatformInfo::GetIsPreviewPlatform(Platform));
    FString Text;
    FJsonSerializer::Serialize(Json, TJsonWriterFactory<>::Create(&Text));
    FFileHelper::SaveStringToFile(Text, *(OutputDirectory / TEXT("platform-registration.json")),
                                  FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM);
    UE_LOG(LogTemp, Display, TEXT("P1_PLATFORM %s enum=%d pass=%d"), *Name.ToString(), Platform, Pass);
    return Pass ? Platform : SP_NumPlatforms;
}
