#include "CoreMinimal.h"
#include "AssetCompilingManager.h"
#include "Components/DirectionalLightComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Containers/Ticker.h"
#include "Dom/JsonObject.h"
#include "Editor.h"
#include "Engine/StaticMesh.h"
#include "Engine/StaticMeshActor.h"
#include "Engine/Texture2D.h"
#include "EngineUtils.h"
#include "HAL/IConsoleManager.h"
#include "ImageUtils.h"
#include "LevelEditorViewport.h"
#include "Materials/MaterialInterface.h"
#include "Misc/CommandLine.h"
#include "Misc/CoreDelegates.h"
#include "Misc/FileHelper.h"
#include "Misc/Parse.h"
#include "PrimitiveSceneProxy.h"
#include "Rendering/NaniteResources.h"
#include "SceneView.h"
#include "SceneViewExtension.h"
#include "Serialization/JsonSerializer.h"
#include "ShaderCompiler.h"
#include "Settings/LevelEditorViewportSettings.h"
#include "Slate/SceneViewport.h"
#include "StaticMeshResources.h"
#include "UnrealClient.h"
#include "UObject/UObjectIterator.h"

namespace
{
class FNativeComparisonViewExtension : public FSceneViewExtensionBase
{
public:
    FNativeComparisonViewExtension(const FAutoRegister& Register) : FSceneViewExtensionBase(Register) {}
    FMatrix Projection = FMatrix::Identity;
    int32 Phase = -1, AA = -1;
    bool Realtime = false, TemporalAA = false;
    float MaterialMipBias = 0;
    const FRenderTarget* Target = nullptr;
    virtual void SetupViewFamily(FSceneViewFamily& Family) override
    {
        // An offscreen editor can mark its viewport non-realtime even after
        // SetRealtime, which silently substitutes FXAA for the game's TSR.
        if (Target && Family.RenderTarget == Target)
            Family.bRealtimeUpdate = true;
    }
    virtual void PostRenderViewFamily_RenderThread(FRDGBuilder&, FSceneViewFamily& Family) override
    {
        if (!Target || Family.RenderTarget != Target || Family.Views.Num() != 1 || Family.Views[0]->bIsSceneCapture) return;
        const auto& View = *Family.Views[0];
        Projection = View.ViewMatrices.GetViewToClip();
        Phase = View.GetDistanceFieldTemporalSampleIndex();
        AA = int32(View.AntiAliasingMethod);
        Realtime = Family.bRealtimeUpdate;
        TemporalAA = Family.EngineShowFlags.TemporalAA;
        MaterialMipBias = View.MaterialTextureMipBias;
    }
};
TSharedPtr<FNativeComparisonViewExtension, ESPMode::ThreadSafe> NativeComparisonView;
}

// Opt-in desktop viewport capture. The original world is changed only in memory.
void StartWebNativeComparison()
{
    FString Input;
    if (IsRunningCommandlet() ||
        !FParse::Value(FCommandLine::Get(), TEXT("WebNativeComparison="), Input))
        return;
    FCoreDelegates::OnFEngineLoopInitComplete.AddLambda([Input] {
        NativeComparisonView = FSceneViewExtensions::NewExtension<FNativeComparisonViewExtension>();
        FString JSON;
        TSharedPtr<FJsonObject> Settings;
        check(FFileHelper::LoadFileToString(JSON, *Input));
        check(FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(JSON), Settings));
        FTSTicker::GetCoreTicker().AddTicker(FTickerDelegate::CreateLambda(
            [Settings, Step = 0, Warmup = 0, StableSamples = TArray<int32>{0, 0, 0, 0},
             PreviousPixels = TArray<TArray<FColor>>{TArray<FColor>(), TArray<FColor>(), TArray<FColor>(), TArray<FColor>()},
             StabilityChecks = TArray<TSharedPtr<FJsonValue>>(), Sun = TWeakObjectPtr<UDirectionalLightComponent>()]
            (float) mutable {
                if (!GEditor || !GCurrentLevelEditingViewportClient ||
                    !GCurrentLevelEditingViewportClient->Viewport)
                    return true;
                auto* Client = GCurrentLevelEditingViewportClient;
                UWorld* World = Client->GetWorld();
                FString Map = TEXT("/Engine/Maps/Templates/Template_Default");
                Settings->TryGetStringField(TEXT("map"), Map);
                if (!World || World->GetPackage()->GetName() != Map)
                    return true;
                const bool ExistingScene = Map != TEXT("/Engine/Maps/Templates/Template_Default");
                bool MaterialTimeOnly = false;
                Settings->TryGetBoolField(TEXT("materialTimeOnly"), MaterialTimeOnly);
                const bool CaptureTemporalPhases = ExistingScene || MaterialTimeOnly;
                const auto& Views = Settings->GetArrayField(TEXT("views"));
                if (Step == 0)
                {
                    if (FParse::Param(FCommandLine::Get(), TEXT("WebNativeMobilePreview")))
                        GEditor->SetPreviewPlatform(FPreviewPlatformInfo(ERHIFeatureLevel::ES3_1,
                            SP_PCD3D_ES3_1, NAME_None, FName(TEXT("PCD3D_ES31")), NAME_None, true,
                            FName(TEXT("PCD3D_ES3_1"))), false);
                    else
                        GEditor->SetPreviewPlatform(FPreviewPlatformInfo(
                            FParse::Param(FCommandLine::Get(), TEXT("WebNativeNaniteComparison")) ?
                                ERHIFeatureLevel::SM6 : ERHIFeatureLevel::SM5, GMaxRHIShaderPlatform), false);
                    GetMutableDefault<ULevelEditorViewportSettings>()->AspectRatioAxisConstraint =
                        AspectRatio_MaintainXFOV;
                    UStaticMesh* Sphere = ExistingScene ? nullptr : LoadObject<UStaticMesh>(nullptr,
                        TEXT("/Game/DefaultTemplateSamples/SM_TestSphere.SM_TestSphere"));
                    check(ExistingScene || Sphere);
                    const TArray<TSharedPtr<FJsonValue>>* Samples = nullptr;
                    Settings->TryGetArrayField(TEXT("samples"), Samples);
                    if (Samples && !ExistingScene)
                        for (const auto& Value : *Samples)
                        {
                            const auto& Sample = Value->AsObject();
                            auto* Material = LoadObject<UMaterialInterface>(nullptr,
                                *Sample->GetStringField(TEXT("material")));
                            check(Material);
                            auto* Actor = World->SpawnActor<AStaticMeshActor>();
                            auto* Mesh = Actor->GetStaticMeshComponent();
                            Mesh->SetMobility(EComponentMobility::Movable);
                            Mesh->SetCollisionEnabled(ECollisionEnabled::NoCollision);
                            Mesh->SetStaticMesh(Sphere);
                            Mesh->SetMaterial(0, Material);
                            Actor->Tags.Add(TEXT("WebNativeSample"));
                            Actor->SetActorLocation(FVector(Sample->GetNumberField(TEXT("x")),
                                Sample->GetNumberField(TEXT("y")), Sample->GetNumberField(TEXT("z"))));
                            Actor->SetActorScale3D(FVector(Sample->GetNumberField(TEXT("radius")) / 50));
                        }
                    for (TActorIterator<AActor> It(World); It; ++It)
                        if (auto* Light = It->FindComponentByClass<UDirectionalLightComponent>())
                            Sun = Light;
                    Client->SetRealtime(true);
                    Client->SetGameView(true);
                    if (CaptureTemporalPhases)
                    {
                        Client->AddRealtimeOverride(true, FText::FromString(TEXT("Native Nanite comparison")));
                        Client->EngineShowFlags.SetAntiAliasing(true);
                        Client->EngineShowFlags.SetTemporalAA(true);
                    }
                    Client->EngineShowFlags.SetSelectionOutline(false);
                    if (ExistingScene)
                        Client->EngineShowFlags.SetEyeAdaptation(true);
                    int32 Width = 1600, Height = 900;
                    Settings->TryGetNumberField(TEXT("width"), Width);
                    Settings->TryGetNumberField(TEXT("height"), Height);
                    check(Width > 0 && Height > 0);
                    static_cast<FSceneViewport*>(Client->Viewport)->SetFixedViewportSize(Width, Height);
                    FlushRenderingCommands();
                    NativeComparisonView->Target = Client->Viewport;
                    FAssetCompilingManager::Get().FinishAllCompilation();
                    IConsoleManager::Get().FindConsoleVariable(TEXT("r.RenderTimeFrozen"))->Set(MaterialTimeOnly ? 0 : 1, ECVF_SetByCode);
                    IConsoleManager::Get().FindConsoleVariable(TEXT("r.Test.OverrideTimeMaterialExpressions"))->Set(MaterialTimeOnly ? 0.0f : -1.0f, ECVF_SetByCode);
                    Step = 1;
                }
                const int32 Index = (Step - 1) / 2;
                if (Index >= Views.Num())
                {
                    FPlatformMisc::RequestExit(false);
                    return false;
                }
                const auto& View = Views[Index]->AsObject();
                if (Step % 2 == 1)
                {
                    bool NaniteEnabled;
                    if (View->TryGetBoolField(TEXT("nanite"), NaniteEnabled))
                        IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite"))->Set(NaniteEnabled ? 1 : 0, ECVF_SetByCode);
                    Client->SetViewLocation(FVector(View->GetNumberField(TEXT("x")),
                        View->GetNumberField(TEXT("y")), View->GetNumberField(TEXT("z"))));
                    Client->SetViewRotation(FRotator(View->GetNumberField(TEXT("pitch")),
                        View->GetNumberField(TEXT("yaw")), 0));
                    Client->ViewFOV = View->GetNumberField(TEXT("fov"));
                    if (!ExistingScene)
                    {
                        const auto* MeshPath = View->GetBoolField(TEXT("dense")) ?
                            TEXT("/Game/DefaultTemplateSamples/SM_TestSphere.SM_TestSphere") :
                            TEXT("/Engine/BasicShapes/Sphere.Sphere");
                        auto* Sphere = LoadObject<UStaticMesh>(nullptr, MeshPath);
                        check(Sphere);
                        for (TActorIterator<AStaticMeshActor> It(World); It; ++It)
                            if (It->Tags.Contains(TEXT("WebNativeSample")))
                                It->GetStaticMeshComponent()->SetStaticMesh(Sphere);
                        UE_LOG(LogTemp, Display, TEXT("WEB_NATIVE_COMPARE: mesh=%s triangles=%u"),
                            MeshPath, Sphere->GetRenderData()->LODResources[0].GetNumTriangles());
                        if (Sun.IsValid() && View->HasField(TEXT("bias")))
                        {
                            Sun->SetShadowBias(View->GetNumberField(TEXT("bias")));
                            Sun->SetShadowSlopeBias(View->GetNumberField(TEXT("slope")));
                            Sun->SetCastShadows(View->GetBoolField(TEXT("cast")));
                        }
                    }
                    Warmup = 0;
                    for (int32 Phase = 0; Phase < 4; ++Phase) { StableSamples[Phase] = 0; PreviousPixels[Phase].Reset(); }
                    StabilityChecks.Reset();
                    ++Step;
                }
                // Warm up a real viewport, including exposure and realtime sky capture.
                Client->Invalidate();
                if (++Warmup < 240 || FAssetCompilingManager::Get().GetNumRemainingAssets() > 0 ||
                    (GShaderCompilingManager && GShaderCompilingManager->IsCompiling()) ||
                    (CaptureTemporalPhases && Warmup % 120 >= 4))
                    return true;
                FlushRenderingCommands();
                TArray<FColor> Pixels;
                check(GetViewportScreenShot(Client->Viewport, Pixels));
                const FIntPoint Size = Client->Viewport->GetSizeXY();
                check(Pixels.Num() == Size.X * Size.Y);
                for (FColor& Pixel : Pixels)
                    Pixel.A = 255;
                FSceneViewFamilyContext Family(FSceneViewFamily::ConstructionValues(
                    Client->Viewport, World->Scene, Client->EngineShowFlags).SetRealtimeUpdate(true));
                const auto* RenderView = Client->CalcSceneView(&Family);
                if (CaptureTemporalPhases)
                {
                    const uint32 Phase = NativeComparisonView->Phase; check(Phase < 4);
                    int32 PendingTextures = 0, ResidentMips = 0, RequestedMips = 0;
                    for (TObjectIterator<UTexture2D> It; It; ++It)
                    {
                        const auto& State = It->GetStreamableResourceState();
                        PendingTextures += It->HasPendingInitOrStreaming() ? 1 : 0;
                        ResidentMips += State.NumResidentLODs; RequestedMips += State.NumRequestedLODs;
                    }
                    double MeanDifference = 255.0;
                    if (PreviousPixels[Phase].Num() == Pixels.Num())
                    {
                        uint64 Sum = 0;
                        for (int32 I = 0; I < Pixels.Num(); ++I)
                            Sum += FMath::Abs(int32(Pixels[I].R) - PreviousPixels[Phase][I].R) +
                                FMath::Abs(int32(Pixels[I].G) - PreviousPixels[Phase][I].G) +
                                FMath::Abs(int32(Pixels[I].B) - PreviousPixels[Phase][I].B);
                        MeanDifference = double(Sum) / (Pixels.Num() * 3.0);
                    }
                    StableSamples[Phase] = MeanDifference < 0.05 && !PendingTextures && ResidentMips == RequestedMips ? StableSamples[Phase] + 1 : 0;
                    auto Check = MakeShared<FJsonObject>();
                    Check->SetNumberField(TEXT("warmupFrames"), Warmup);
                    Check->SetNumberField(TEXT("phase"), Phase);
                    Check->SetNumberField(TEXT("jitterX"), NativeComparisonView->Projection.M[2][0]);
                    Check->SetNumberField(TEXT("jitterY"), NativeComparisonView->Projection.M[2][1]);
                    Check->SetNumberField(TEXT("antiAliasingMethod"), NativeComparisonView->AA);
                    Check->SetBoolField(TEXT("realtime"), NativeComparisonView->Realtime);
                    Check->SetBoolField(TEXT("temporalAA"), NativeComparisonView->TemporalAA);
                    Check->SetNumberField(TEXT("materialMipBias"), NativeComparisonView->MaterialMipBias);
                    Check->SetNumberField(TEXT("antiAliasingCVar"), IConsoleManager::Get().FindConsoleVariable(TEXT("r.AntiAliasingMethod"))->GetInt());
                    Check->SetNumberField(TEXT("meanDifference"), MeanDifference);
                    Check->SetNumberField(TEXT("pendingTextures"), PendingTextures);
                    Check->SetNumberField(TEXT("residentMips"), ResidentMips);
                    Check->SetNumberField(TEXT("requestedMips"), RequestedMips);
                    Check->SetNumberField(TEXT("stableSamples"), StableSamples[Phase]);
                    StabilityChecks.Add(MakeShared<FJsonValueObject>(Check));
                    UE_LOG(LogTemp, Display, TEXT("WEB_NATIVE_STABILITY: view=%s phase=%u frames=%d mean=%g pending=%d mips=%d/%d stable=%d"),
                        *View->GetStringField(TEXT("name")), Phase, Warmup, MeanDifference, PendingTextures, ResidentMips, RequestedMips, StableSamples[Phase]);
                    PreviousPixels[Phase] = Pixels;
                    if (Warmup < 600 || StableSamples.ContainsByPredicate([](int32 Count) { return Count < 3; })) return true;
                    Pixels = PreviousPixels[0];
                }
                TArray64<uint8> PNG;
                FImageUtils::PNGCompressImageArray(Size.X, Size.Y, Pixels, PNG);
                const FString Output = Settings->GetStringField(TEXT("output")) +
                    TEXT("-") + View->GetStringField(TEXT("name")) + TEXT(".png");
                check(FFileHelper::SaveArrayToFile(PNG, *Output));
                int32 NaniteSamples = 0, SampleCount = 0;
                for (TActorIterator<AStaticMeshActor> It(World); It; ++It)
                    if (It->Tags.Contains(TEXT("WebNativeSample")))
                    {
                        ++SampleCount;
                        const auto* Proxy = It->GetStaticMeshComponent()->SceneProxy;
                        if (Proxy && Proxy->IsNaniteMesh()) ++NaniteSamples;
                    }
                auto Capture = MakeShared<FJsonObject>();
                Capture->SetNumberField(TEXT("featureLevel"), int32(World->GetFeatureLevel()));
                Capture->SetNumberField(TEXT("samples"), SampleCount);
                Capture->SetNumberField(TEXT("naniteSamples"), NaniteSamples);
                if (CaptureTemporalPhases)
                {
                    Capture->SetArrayField(TEXT("stability"), StabilityChecks);
                    Capture->SetBoolField(TEXT("renderTimeFrozen"), IConsoleManager::Get().FindConsoleVariable(TEXT("r.RenderTimeFrozen"))->GetBool());
                    Capture->SetNumberField(TEXT("materialTime"), IConsoleManager::Get().FindConsoleVariable(TEXT("r.Test.OverrideTimeMaterialExpressions"))->GetFloat());
                    TArray<TSharedPtr<FJsonValue>> Textures;
                    for (TObjectIterator<UTexture2D> It; It; ++It)
                    {
                        if (!It->GetPathName().StartsWith(TEXT("/Game/"))) continue;
                        const auto& State = It->GetStreamableResourceState();
                        auto Item = MakeShared<FJsonObject>();
                        Item->SetStringField(TEXT("path"), It->GetPathName());
                        Item->SetNumberField(TEXT("width"), It->GetSizeX());
                        Item->SetNumberField(TEXT("height"), It->GetSizeY());
                        Item->SetNumberField(TEXT("residentMips"), State.NumResidentLODs);
                        Item->SetNumberField(TEXT("requestedMips"), State.NumRequestedLODs);
                        Item->SetNumberField(TEXT("maxMips"), State.MaxNumLODs);
                        Item->SetNumberField(TEXT("filter"), int32(It->Filter));
                        Textures.Add(MakeShared<FJsonValueObject>(Item));
                    }
                    Capture->SetArrayField(TEXT("textures"), Textures);
                    Capture->SetBoolField(TEXT("temporalSequencesFrozen"), IConsoleManager::Get().FindConsoleVariable(TEXT("r.Test.FreezeTemporalSequences"))->GetBool());
                    TArray<TSharedPtr<FJsonValue>> PhaseImages;
                    for (int32 Phase = 0; Phase < 4; ++Phase)
                    {
                        const FString PhaseFile = Output.LeftChop(4) + FString::Printf(TEXT("-phase%d.png"), Phase);
                        TArray64<uint8> PhasePNG;
                        FImageUtils::PNGCompressImageArray(Size.X, Size.Y, PreviousPixels[Phase], PhasePNG);
                        check(FFileHelper::SaveArrayToFile(PhasePNG, *PhaseFile));
                        auto Item = MakeShared<FJsonObject>(); Item->SetNumberField(TEXT("phase"), Phase);
                        Item->SetStringField(TEXT("file"), PhaseFile); PhaseImages.Add(MakeShared<FJsonValueObject>(Item));
                    }
                    Capture->SetArrayField(TEXT("phaseImages"), PhaseImages);
                    int32 AssetComponents = 0, NaniteProxies = 0;
                    TArray<TSharedPtr<FJsonValue>> Components;
                    for (TActorIterator<AActor> It(World); It; ++It)
                    {
                        TInlineComponentArray<UStaticMeshComponent*> Meshes(*It);
                        for (const auto* Mesh : Meshes)
                        {
                            const UStaticMesh* Asset = Mesh->GetStaticMesh();
                            const auto* Data = Asset ? Asset->GetRenderData() : nullptr;
                            if (!Data || !Data->NaniteResourcesPtr || !Data->NaniteResourcesPtr->NumClusters) continue;
                            ++AssetComponents;
                            const bool IsNanite = Mesh->SceneProxy && Mesh->SceneProxy->IsNaniteMesh();
                            NaniteProxies += IsNanite ? 1 : 0;
                            auto Item = MakeShared<FJsonObject>();
                            Item->SetStringField(TEXT("component"), Mesh->GetPathName());
                            Item->SetStringField(TEXT("mesh"), Asset->GetPathName());
                            Item->SetBoolField(TEXT("naniteProxy"), IsNanite);
                            Item->SetNumberField(TEXT("clusters"), Data->NaniteResourcesPtr->NumClusters);
                            TArray<TSharedPtr<FJsonValue>> Materials;
                            for (int32 Slot = 0; Slot < Mesh->GetNumMaterials(); ++Slot)
                            {
                                const auto* Material = Mesh->GetMaterial(Slot);
                                auto Info = MakeShared<FJsonObject>();
                                Info->SetStringField(TEXT("path"), GetPathNameSafe(Material));
                                Info->SetStringField(TEXT("naniteOverride"), Material ? GetPathNameSafe(Material->GetNaniteOverride()) : TEXT("None"));
                                Materials.Add(MakeShared<FJsonValueObject>(Info));
                            }
                            Item->SetArrayField(TEXT("materials"), Materials);
                            Components.Add(MakeShared<FJsonValueObject>(Item));
                        }
                    }
                    Capture->SetNumberField(TEXT("naniteAssetComponents"), AssetComponents);
                    Capture->SetNumberField(TEXT("naniteSceneProxies"), NaniteProxies);
                    Capture->SetArrayField(TEXT("components"), Components);
                }
                Capture->SetNumberField(TEXT("width"), Size.X);
                Capture->SetNumberField(TEXT("height"), Size.Y);
                Capture->SetNumberField(TEXT("shadowBias"), Sun.IsValid() ? Sun->ShadowBias : -1);
                Capture->SetNumberField(TEXT("shadowSlopeBias"), Sun.IsValid() ? Sun->ShadowSlopeBias : -1);
                Capture->SetObjectField(TEXT("view"), View);
                // CalcSceneView has not passed through renderer temporal-jitter
                // setup yet, so ProjectionNoAA still contains its initial value.
                const FMatrix& Projection = RenderView->ViewMatrices.GetViewToClip();
                Capture->SetNumberField(TEXT("projectionX"), Projection.M[0][0]);
                Capture->SetNumberField(TEXT("projectionY"), Projection.M[1][1]);
                FString CaptureJSON;
                FJsonSerializer::Serialize(Capture, TJsonWriterFactory<>::Create(&CaptureJSON));
                check(FFileHelper::SaveStringToFile(CaptureJSON, *(Output + TEXT(".json"))));
                UE_LOG(LogTemp, Display, TEXT("WEB_NATIVE_COMPARE: image=%s size=%dx%d feature=%d bias=%g slope=%g fov=%g camera=%s"),
                    *Output, Size.X, Size.Y, int32(World->GetFeatureLevel()),
                    Sun.IsValid() ? Sun->ShadowBias : -1, Sun.IsValid() ? Sun->ShadowSlopeBias : -1,
                    Client->ViewFOV, *Client->GetViewLocation().ToString());
                ++Step;
                return true;
            }));
    });
}
