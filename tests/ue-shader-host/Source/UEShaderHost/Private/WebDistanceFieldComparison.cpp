#include "CoreMinimal.h"
#include "AssetCompilingManager.h"
#include "Components/LightComponent.h"
#include "Components/SkyLightComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Containers/Ticker.h"
#include "DistanceFieldAtlas.h"
#include "Dom/JsonObject.h"
#include "Editor.h"
#include "Engine/StaticMesh.h"
#include "EngineUtils.h"
#include "GPUProfiler.h"
#include "HAL/FileManager.h"
#include "HAL/IConsoleManager.h"
#include "ImageUtils.h"
#include "LevelEditorViewport.h"
#include "Misc/CommandLine.h"
#include "Misc/CoreDelegates.h"
#include "Misc/FileHelper.h"
#include "Misc/Parse.h"
#include "Materials/MaterialInterface.h"
#include "ProfilingDebugging/CsvProfiler.h"
#include "RHIStats.h"
#include "SceneView.h"
#include "Serialization/JsonSerializer.h"
#include "Settings/LevelEditorViewportSettings.h"
#include "Slate/SceneViewport.h"
#include "StaticMeshResources.h"
#include "UnrealClient.h"

namespace
{
void SetComparisonCVar(const TCHAR* Name, int32 Value)
{
    auto* Variable = IConsoleManager::Get().FindConsoleVariable(Name);
    checkf(Variable, TEXT("Missing comparison CVar: %s"), Name);
    Variable->Set(Value, ECVF_SetByCode);
    check(Variable->GetInt() == Value);
}

void SaveComparisonJSON(const TSharedPtr<FJsonObject>& Value, const FString& File)
{
    FString Text;
    check(FJsonSerializer::Serialize(Value.ToSharedRef(), TJsonWriterFactory<>::Create(&Text)));
    check(FFileHelper::SaveStringToFile(Text, *File));
}

TArray<TSharedPtr<FJsonValue>> NumberArray(const TArray<double>& Values)
{
    TArray<TSharedPtr<FJsonValue>> Result;
    for (double Value : Values)
        Result.Add(MakeShared<FJsonValueNumber>(Value));
    return Result;
}

struct FDistanceFieldComparison : TSharedFromThis<FDistanceFieldComparison>
{
    TSharedPtr<FJsonObject> Settings;
    TSharedPtr<FJsonObject> Report = MakeShared<FJsonObject>();
    TArray<TSharedPtr<FJsonValue>> Runs;
    TArray<double> GPUTime;
    TArray<double> FrameTime;
    FRHIGPUFrameTimeHistory::FState GPUHistory;
    TSharedFuture<FString> CSV;
    TSharedPtr<FJsonObject> Current;
    int32 Case = -1;
    int32 Frame = 0;
    bool Initialized = false;
    bool Capturing = false;
    bool Finishing = false;

    void Inventory(UWorld* World)
    {
        TArray<TSharedPtr<FJsonValue>> Lights;
        TArray<TSharedPtr<FJsonValue>> Meshes;
        TArray<TSharedPtr<FJsonValue>> Instances;
        TSet<UStaticMesh*> Seen;
        int32 Components = 0;
        int32 ValidComponents = 0;
        for (TActorIterator<AActor> It(World); It; ++It)
        {
            TInlineComponentArray<ULightComponent*> ActorLights(*It);
            for (auto* Light : ActorLights)
            {
                auto Item = MakeShared<FJsonObject>();
                Item->SetStringField(TEXT("path"), Light->GetPathName());
                Item->SetStringField(TEXT("class"), Light->GetClass()->GetName());
                Item->SetNumberField(TEXT("mobility"), int32(Light->Mobility));
                Item->SetBoolField(TEXT("castShadows"), Light->CastShadows);
                Item->SetBoolField(TEXT("distanceFieldShadows"), Light->bUseRayTracedDistanceFieldShadows);
                Item->SetNumberField(TEXT("intensity"), Light->Intensity);
                Lights.Add(MakeShared<FJsonValueObject>(Item));
            }
            if (auto* Sky = It->FindComponentByClass<USkyLightComponent>())
            {
                auto Item = MakeShared<FJsonObject>();
                Item->SetStringField(TEXT("path"), Sky->GetPathName());
                Item->SetStringField(TEXT("class"), Sky->GetClass()->GetName());
                Item->SetNumberField(TEXT("mobility"), int32(Sky->Mobility));
                Item->SetBoolField(TEXT("castShadows"), Sky->CastShadows);
                Item->SetNumberField(TEXT("intensity"), Sky->Intensity);
                Item->SetNumberField(TEXT("occlusionMaxDistance"), Sky->OcclusionMaxDistance);
                Lights.Add(MakeShared<FJsonValueObject>(Item));
            }
            TInlineComponentArray<UStaticMeshComponent*> ActorMeshes(*It);
            for (auto* Component : ActorMeshes)
            {
                UStaticMesh* Mesh = Component->GetStaticMesh();
                if (!Mesh || !Mesh->GetRenderData() || Mesh->GetRenderData()->LODResources.IsEmpty())
                    continue;
                const auto* Data = Mesh->GetRenderData()->LODResources[0].DistanceFieldData;
                ++Components;
                ValidComponents += Data && Data->IsValid();
                auto Instance = MakeShared<FJsonObject>();
                Instance->SetStringField(TEXT("component"), Component->GetPathName());
                Instance->SetStringField(TEXT("mesh"), Mesh->GetPathName());
                const FVector Center = Component->Bounds.Origin;
                const FVector Extent = Component->Bounds.BoxExtent;
                Instance->SetArrayField(TEXT("center"), NumberArray({Center.X, Center.Y, Center.Z}));
                Instance->SetArrayField(TEXT("extent"), NumberArray({Extent.X, Extent.Y, Extent.Z}));
                TArray<TSharedPtr<FJsonValue>> Materials;
                for (auto* Material : Component->GetMaterials())
                {
                    Materials.Add(MakeShared<FJsonValueString>(Material ? Material->GetPathName() : TEXT("")));
                }
                Instance->SetArrayField(TEXT("materials"), Materials);
                Instances.Add(MakeShared<FJsonValueObject>(Instance));
                if (Seen.Contains(Mesh))
                    continue;
                Seen.Add(Mesh);
                auto Item = MakeShared<FJsonObject>();
                Item->SetStringField(TEXT("path"), Mesh->GetPathName());
                Item->SetBoolField(TEXT("valid"), Data && Data->IsValid());
                if (Data)
                {
                    Item->SetNumberField(TEXT("cpuResidentBytes"), double(Data->GetResourceSizeBytes()));
                    Item->SetNumberField(TEXT("alwaysLoadedBytes"), Data->AlwaysLoadedMip.Num());
                    Item->SetNumberField(TEXT("streamableBytes"), double(Data->StreamableMips.GetBulkDataSize()));
                }
                Meshes.Add(MakeShared<FJsonValueObject>(Item));
            }
        }
        Report->SetArrayField(TEXT("lights"), Lights);
        Report->SetArrayField(TEXT("meshes"), Meshes);
        Report->SetArrayField(TEXT("instances"), Instances);
        Report->SetNumberField(TEXT("meshComponents"), Components);
        Report->SetNumberField(TEXT("componentsWithDistanceFields"), ValidComponents);
        Report->SetNumberField(TEXT("featureLevel"), int32(World->GetFeatureLevel()));
        Report->SetStringField(TEXT("adapter"), GRHIGlobals.GpuInfo.AdapterName);
        auto Variables = MakeShared<FJsonObject>();
        for (const TCHAR* Name : {TEXT("r.GenerateMeshDistanceFields"), TEXT("r.AOQuality"),
            TEXT("r.AOGlobalDistanceField"), TEXT("r.AOObjectDistanceField"),
            TEXT("r.AOSpecularOcclusionMode"), TEXT("r.DistanceFields.SupportEvenIfHardwareRayTracingSupported"),
            TEXT("r.RayTracing"), TEXT("r.Shadow.Virtual.Enable"), TEXT("r.AntiAliasingMethod"),
            TEXT("r.Streaming.PoolSize"), TEXT("r.DynamicGlobalIlluminationMethod"), TEXT("r.ReflectionMethod")})
            if (auto* Variable = IConsoleManager::Get().FindConsoleVariable(Name))
                Variables->SetNumberField(Name, Variable->GetFloat());
        Report->SetObjectField(TEXT("variables"), Variables);
    }

    bool Tick(float Delta)
    {
        if (!GEditor || !GCurrentLevelEditingViewportClient ||
            !GCurrentLevelEditingViewportClient->Viewport)
            return true;
        auto* Client = GCurrentLevelEditingViewportClient;
        UWorld* World = Client->GetWorld();
        if (!World || World->GetPackage()->GetName() != Settings->GetStringField(TEXT("map")))
            return true;
        const FString Output = Settings->GetStringField(TEXT("output"));
        if (!Initialized)
        {
            GetMutableDefault<ULevelEditorViewportSettings>()->AspectRatioAxisConstraint =
                AspectRatio_MaintainXFOV;
            Client->SetRealtime(true);
            Client->SetGameView(true);
            Client->EngineShowFlags.SetSelectionOutline(false);
            Client->EngineShowFlags.SetEyeAdaptation(true);
            static_cast<FSceneViewport*>(Client->Viewport)->SetFixedViewportSize(
                Settings->GetIntegerField(TEXT("width")), Settings->GetIntegerField(TEXT("height")));
            bool Frozen = false;
            Settings->TryGetBoolField(TEXT("visualClock"), Frozen);
            SetComparisonCVar(TEXT("r.RenderTimeFrozen"), Frozen ? 1 : 0);
            FAssetCompilingManager::Get().FinishAllCompilation();
            Inventory(World);
            Initialized = true;
        }
        Client->Invalidate();
        uint64 Cycles = 0;
        while (GPUHistory.PopFrameCycles(Cycles) != FRHIGPUFrameTimeHistory::EResult::Empty)
            if (Capturing && Cycles > 0)
                GPUTime.Add(FPlatformTime::ToMilliseconds64(Cycles));
        if (Finishing)
        {
            if (!CSV.IsReady())
                return true;
            Current->SetStringField(TEXT("csv"), CSV.Get());
            Runs.Add(MakeShared<FJsonValueObject>(Current));
            Capturing = false;
            Finishing = false;
            Frame = 0;
        }
        if (Frame == 0)
        {
            const auto& Cases = Settings->GetArrayField(TEXT("cases"));
            if (++Case >= Cases.Num())
            {
                Report->SetArrayField(TEXT("runs"), Runs);
                Report->SetBoolField(TEXT("completed"), true);
                SaveComparisonJSON(Report, Output + TEXT("-capture.json"));
                FPlatformMisc::RequestExit(false);
                return false;
            }
            const auto& Entry = Cases[Case]->AsObject();
            SetComparisonCVar(TEXT("r.DistanceFieldAO"), Entry->GetIntegerField(TEXT("ao")));
            SetComparisonCVar(TEXT("r.DistanceFieldShadowing"), Entry->GetIntegerField(TEXT("shadows")));
            const TSharedPtr<FJsonObject>* Variables = nullptr;
            if (Entry->TryGetObjectField(TEXT("variables"), Variables))
                for (const auto& Pair : (*Variables)->Values)
                    SetComparisonCVar(*Pair.Key, int32(Pair.Value->AsNumber()));
            Client->ExposureSettings.bFixed = Entry->GetBoolField(TEXT("fixedExposure"));
            Client->ExposureSettings.FixedEV100 = Entry->GetNumberField(TEXT("ev100"));
            Client->SetViewLocation(FVector(Entry->GetNumberField(TEXT("x")),
                Entry->GetNumberField(TEXT("y")), Entry->GetNumberField(TEXT("z"))));
            Client->SetViewRotation(FRotator(Entry->GetNumberField(TEXT("pitch")),
                Entry->GetNumberField(TEXT("yaw")), 0));
            Client->ViewFOV = Entry->GetNumberField(TEXT("fov"));
            Current = MakeShared<FJsonObject>();
            Current->SetObjectField(TEXT("case"), Entry);
            GPUTime.Reset();
            FrameTime.Reset();
            UE_LOG(LogTemp, Display, TEXT("WEB_DF_COMPARE: begin=%s ao=%d shadows=%d fixed=%d"),
                *Entry->GetStringField(TEXT("name")), Entry->GetIntegerField(TEXT("ao")),
                Entry->GetIntegerField(TEXT("shadows")), int32(Client->ExposureSettings.bFixed));
        }
        ++Frame;
        const int32 Warmup = Settings->GetIntegerField(TEXT("warmup"));
        if (Frame == Warmup / 2 && Case == 0)
        {
            GEngine->Exec(World, TEXT("r.AOListMemory"));
            SetComparisonCVar(TEXT("r.DistanceFields.LogAtlasStats"), 1);
        }
        if (Frame <= Warmup || FAssetCompilingManager::Get().GetNumRemainingAssets() > 0)
            return true;
        if (!Capturing)
        {
            GPUTime.Reset();
            FrameTime.Reset();
            FCsvProfiler::Get()->BeginCapture(-1, FPaths::GetPath(Output),
                FPaths::GetCleanFilename(Output) + TEXT("-") +
                Current->GetObjectField(TEXT("case"))->GetStringField(TEXT("name")) + TEXT(".csv"));
            Capturing = true;
        }
        FrameTime.Add(Delta * 1000.0);
        if (FrameTime.Num() < Settings->GetIntegerField(TEXT("samples")))
            return true;
        Capturing = false;
        CSV = FCsvProfiler::Get()->EndCapture();
        FlushRenderingCommands();
        Current->SetArrayField(TEXT("gpuMs"), NumberArray(GPUTime));
        Current->SetArrayField(TEXT("frameMs"), NumberArray(FrameTime));
        FTextureMemoryStats Memory;
        RHIGetTextureMemoryStats(Memory);
        Current->SetNumberField(TEXT("streamingTextureBytes"), double(Memory.StreamingMemorySize));
        Current->SetNumberField(TEXT("nonStreamingTextureBytes"), double(Memory.NonStreamingMemorySize));
        FSceneViewFamilyContext Family(FSceneViewFamily::ConstructionValues(
            Client->Viewport, World->Scene, Client->EngineShowFlags).SetRealtimeUpdate(true));
        auto* View = Client->CalcSceneView(&Family);
        Current->SetNumberField(TEXT("lastExposure"), View->GetLastEyeAdaptationExposure());
        Current->SetNumberField(TEXT("giMethod"), int32(View->FinalPostProcessSettings.DynamicGlobalIlluminationMethod));
        Current->SetNumberField(TEXT("reflectionMethod"), int32(View->FinalPostProcessSettings.ReflectionMethod));
        Current->SetNumberField(TEXT("aoIntensity"), View->FinalPostProcessSettings.AmbientOcclusionIntensity);
        Current->SetNumberField(TEXT("antiAliasingMethod"), int32(View->AntiAliasingMethod));
        Current->SetNumberField(TEXT("screenPercentage"),
            IConsoleManager::Get().FindConsoleVariable(TEXT("r.ScreenPercentage"))->GetFloat());
        Current->SetNumberField(TEXT("viewWidth"), View->UnscaledViewRect.Width());
        Current->SetNumberField(TEXT("viewHeight"), View->UnscaledViewRect.Height());
        TArray<FColor> Pixels;
        check(GetViewportScreenShot(Client->Viewport, Pixels));
        const FIntPoint Size = Client->Viewport->GetSizeXY();
        check(Pixels.Num() == Size.X * Size.Y);
        for (FColor& Pixel : Pixels)
            Pixel.A = 255;
        TArray64<uint8> PNG;
        FImageUtils::PNGCompressImageArray(Size.X, Size.Y, Pixels, PNG);
        const FString Image = Output + TEXT("-") +
            Current->GetObjectField(TEXT("case"))->GetStringField(TEXT("name")) + TEXT(".png");
        check(FFileHelper::SaveArrayToFile(PNG, *Image));
        Current->SetStringField(TEXT("image"), Image);
        if (Case == 0)
        {
            UE_LOG(LogTemp, Display, TEXT("WEB_DF_COMPARE: distance-field resource allocation snapshot"));
            GEngine->Exec(World, TEXT("rhi.DumpResourceMemory all Name=DistanceField"));
        }
        UE_LOG(LogTemp, Display, TEXT("WEB_DF_COMPARE: image=%s samples=%d gpuSamples=%d gi=%d reflections=%d"),
            *Image, FrameTime.Num(), GPUTime.Num(),
            int32(View->FinalPostProcessSettings.DynamicGlobalIlluminationMethod),
            int32(View->FinalPostProcessSettings.ReflectionMethod));
        Finishing = true;
        return true;
    }
};
}

void StartWebDistanceFieldComparison()
{
    FString Input;
    if (IsRunningCommandlet() ||
        !FParse::Value(FCommandLine::Get(), TEXT("WebDistanceFieldComparison="), Input))
        return;
    FCoreDelegates::OnFEngineLoopInitComplete.AddLambda([Input] {
        auto Capture = MakeShared<FDistanceFieldComparison>();
        FString JSON;
        check(FFileHelper::LoadFileToString(JSON, *Input));
        check(FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(JSON), Capture->Settings));
        FTSTicker::GetCoreTicker().AddTicker(FTickerDelegate::CreateLambda(
            [Capture](float Delta) { return Capture->Tick(Delta); }));
    });
}
