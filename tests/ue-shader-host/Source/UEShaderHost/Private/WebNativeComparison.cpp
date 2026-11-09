#include "CoreMinimal.h"
#include "AssetCompilingManager.h"
#include "Components/DirectionalLightComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Containers/Ticker.h"
#include "Dom/JsonObject.h"
#include "Editor.h"
#include "Engine/StaticMesh.h"
#include "Engine/StaticMeshActor.h"
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
#include "SceneView.h"
#include "Serialization/JsonSerializer.h"
#include "Settings/LevelEditorViewportSettings.h"
#include "Slate/SceneViewport.h"
#include "StaticMeshResources.h"
#include "UnrealClient.h"

// Opt-in desktop viewport capture. The original world is changed only in memory.
void StartWebNativeComparison()
{
    FString Input;
    if (IsRunningCommandlet() ||
        !FParse::Value(FCommandLine::Get(), TEXT("WebNativeComparison="), Input))
        return;
    FCoreDelegates::OnFEngineLoopInitComplete.AddLambda([Input] {
        FString JSON;
        TSharedPtr<FJsonObject> Settings;
        check(FFileHelper::LoadFileToString(JSON, *Input));
        check(FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(JSON), Settings));
        FTSTicker::GetCoreTicker().AddTicker(FTickerDelegate::CreateLambda(
            [Settings, Step = 0, Warmup = 0, Sun = TWeakObjectPtr<UDirectionalLightComponent>()]
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
                    Client->EngineShowFlags.SetSelectionOutline(false);
                    if (ExistingScene)
                        Client->EngineShowFlags.SetEyeAdaptation(true);
                    int32 Width = 1600, Height = 900;
                    Settings->TryGetNumberField(TEXT("width"), Width);
                    Settings->TryGetNumberField(TEXT("height"), Height);
                    check(Width > 0 && Height > 0);
                    static_cast<FSceneViewport*>(Client->Viewport)->SetFixedViewportSize(Width, Height);
                    FAssetCompilingManager::Get().FinishAllCompilation();
                    IConsoleManager::Get().FindConsoleVariable(TEXT("r.RenderTimeFrozen"))->Set(1, ECVF_SetByCode);
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
                    ++Step;
                }
                // Warm up a real viewport, including exposure and realtime sky capture.
                Client->Invalidate();
                if (++Warmup < 240 || FAssetCompilingManager::Get().GetNumRemainingAssets() > 0)
                    return true;
                FlushRenderingCommands();
                TArray<FColor> Pixels;
                check(GetViewportScreenShot(Client->Viewport, Pixels));
                const FIntPoint Size = Client->Viewport->GetSizeXY();
                check(Pixels.Num() == Size.X * Size.Y);
                for (FColor& Pixel : Pixels)
                    Pixel.A = 255;
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
                Capture->SetNumberField(TEXT("width"), Size.X);
                Capture->SetNumberField(TEXT("height"), Size.Y);
                Capture->SetNumberField(TEXT("shadowBias"), Sun.IsValid() ? Sun->ShadowBias : -1);
                Capture->SetNumberField(TEXT("shadowSlopeBias"), Sun.IsValid() ? Sun->ShadowSlopeBias : -1);
                Capture->SetObjectField(TEXT("view"), View);
                FSceneViewFamilyContext Family(FSceneViewFamily::ConstructionValues(
                    Client->Viewport, World->Scene, Client->EngineShowFlags).SetRealtimeUpdate(true));
                const auto* RenderView = Client->CalcSceneView(&Family);
                // CalcSceneView has not passed through renderer temporal-jitter
                // setup yet, so ProjectionNoAA still contains its initial value.
                const FMatrix& Projection = RenderView->ViewMatrices.GetProjectionMatrix();
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
