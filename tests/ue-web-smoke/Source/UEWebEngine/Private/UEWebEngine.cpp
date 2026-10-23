#include "CoreMinimal.h"
#include "LaunchEngineLoop.h"
#include "Misc/CoreDelegates.h"
#include "Misc/DelayedAutoRegister.h"
#include "Misc/CommandLine.h"
#include "Misc/App.h"
#include "HAL/PlatformTLS.h"
#include "HAL/LowLevelMemTracker.h"
#include "Modules/ModuleManager.h"
#include "HAL/IConsoleManager.h"
#include "RenderUtils.h"
#include "DataDrivenShaderPlatformInfo.h"
#include "ShaderCodeLibrary.h"
#include "Serialization/MemoryLayout.h"
#include "FileCache/FileCache.h"
#include "Misc/FileHelper.h"
#include "HAL/PlatformFileManager.h"
#include "SkeletalRenderPublic.h"
#include "WebGPUBrowser.h"
#include "Engine/Engine.h"
#include "Engine/World.h"
#include "UObject/Package.h"
#include <emscripten.h>
#include <emscripten/heap.h>
#include <cstdio>
#include "WebRenderScene.h"
#include "Components/SkyAtmosphereComponent.h"
#include "Components/VolumetricCloudComponent.h"
#include "Components/ExponentialHeightFogComponent.h"
#include "Components/SkyLightComponent.h"
#include "Components/LightComponent.h"
#include "Camera/CameraActor.h"
#include "Stats/StatsData.h"
#include "Engine/Texture2D.h"
#include "RHIStats.h"
#include "UObject/UObjectIterator.h"

static_assert(WITH_ENGINE && !ENABLE_LOW_LEVEL_MEM_TRACKER);

IMPLEMENT_APPLICATION(UEWebEngine, "UEWebEngine");

namespace
{
int32 Frames = 0;
bool UseWebGPU = false;
bool RenderScene = false;
bool DefaultTemplate = false;
bool VisualTestClock = false;
FString ProjectMap;
TWeakObjectPtr<APlayerController> TemplateController;

const TCHAR* StartupMap()
{
    if (!ProjectMap.IsEmpty())
        return *ProjectMap;
    return DefaultTemplate ? TEXT("/Engine/Maps/Templates/Template_Default") : TEXT("/Game/WebMinimal");
}

void LogWorld(UWorld* World)
{
    std::printf("P3_ENGINE_WORLD {\"package\":\"%s\",\"begunPlay\":%s,\"exitRequested\":%s}\n",
        World ? TCHAR_TO_UTF8(*World->GetPackage()->GetName()) : "",
        World && World->HasBegunPlay() ? "true" : "false",
        IsEngineExitRequested() ? "true" : "false");
}

void LogMaterialPolicy()
{
    const auto Read = [](const TCHAR* Name) {
        const IConsoleVariable* Variable = IConsoleManager::Get().FindConsoleVariable(Name);
        return Variable ? Variable->GetInt() : -1;
    };
    std::printf("P3_MATERIAL_POLICY {\"platform\":%u,\"mobile\":%s,\"dbuffer\":%s,"
        "\"dbufferSetting\":%d,\"mobileDBufferSetting\":%d,\"substrateSetting\":%d,"
        "\"substrateBlendable\":%s,\"mobileDeferred\":%s,\"fullDepthPrepass\":%s}\n",
        uint32(GMaxRHIShaderPlatform), IsMobilePlatform(GMaxRHIShaderPlatform) ? "true" : "false",
        IsUsingDBuffers(GMaxRHIShaderPlatform) ? "true" : "false",
        Read(TEXT("r.DBuffer")), Read(TEXT("r.Mobile.DBuffer")), Read(TEXT("r.Substrate")),
        Substrate::IsSubstrateBlendableGBufferEnabled(GMaxRHIShaderPlatform) ? "true" : "false",
        IsMobileDeferredShadingEnabled(GMaxRHIShaderPlatform) ? "true" : "false",
        MobileUsesFullDepthPrepass(GMaxRHIShaderPlatform) ? "true" : "false");
}

void VerifyFileCache()
{
    constexpr int32 BlockSize = 64 * 1024;
    constexpr int32 Blocks = 129;
    TArray<uint8> Bytes;
    Bytes.SetNumUninitialized(BlockSize * Blocks);
    for (int32 Index = 0; Index < Bytes.Num(); ++Index)
        Bytes[Index] = uint8(Index * 37 + (Index / BlockSize) * 13);
    const TCHAR* Filename = TEXT("/WebFileCacheProbe.bin");
    check(FFileHelper::SaveArrayToFile(Bytes, Filename));
    TArray<uint8> Actual;
    Actual.SetNumUninitialized(BlockSize);
    for (int32 Pass = 0; Pass < 3; ++Pass)
    {
        TUniquePtr<IFileCacheHandle> Handle(IFileCacheHandle::CreateFileCacheHandle(Filename));
        check(Handle);
        for (int32 Block = 0; Block < Blocks; ++Block)
        {
            FGraphEventArray Events;
            IMemoryReadStreamRef Stream = Handle->ReadData(Events, Block * BlockSize, BlockSize, AIOP_Normal);
            check(Stream);
            FTaskGraphInterface::Get().WaitUntilTasksComplete(Events);
            Stream->CopyTo(Actual.GetData(), 0, BlockSize);
            check(FMemory::Memcmp(Actual.GetData(), Bytes.GetData() + Block * BlockSize, BlockSize) == 0);
        }
        FGraphEventArray Events;
        IMemoryReadStreamRef Stream = Handle->ReadData(Events, BlockSize - 7, 17, AIOP_Normal);
        FTaskGraphInterface::Get().WaitUntilTasksComplete(Events);
        Stream->CopyTo(Actual.GetData(), 0, 17);
        check(FMemory::Memcmp(Actual.GetData(), Bytes.GetData() + BlockSize - 7, 17) == 0);
        Stream.SafeRelease();
        Handle->WaitAll();
    }
    check(FPlatformFileManager::Get().GetPlatformFile().DeleteFile(Filename));
    std::printf("P3_FILE_CACHE {\"pass\":true,\"handles\":3,\"blockReads\":387,\"crossBlockReads\":3,"
        "\"checkedBytes\":25362483}\n");
}

void EngineFrame(void*)
{
    FTaskTagScope Scope(ETaskTag::EGameThread);
    if (IsEngineExitRequested())
    {
        std::printf("P3_ENGINE_INIT_FAILED engine exit requested during Tick\n");
        emscripten_cancel_main_loop();
        return;
    }
    GEngineLoop.Tick();
    if (IsEngineExitRequested())
    {
        std::printf("P3_ENGINE_INIT_FAILED engine exit requested after Tick\n");
        emscripten_cancel_main_loop();
        return;
    }
    ++Frames;
    EM_ASM({ globalThis.__webEngineFrames = $0; }, Frames);
    if (Frames % 30 == 0)
    {
        FTextureMemoryStats Memory;
        RHIGetTextureMemoryStats(Memory);
        int32 Streamable = 0, Pending = 0, ResidentMips = 0, RequestedMips = 0, MaximumMips = 0;
        uint64 ResidentBytes = 0, FullBytes = 0;
        for (TObjectIterator<UTexture2D> It; It; ++It)
        {
            if (!It->IsStreamable())
                continue;
            const auto& State = It->GetStreamableResourceState();
            ++Streamable;
            Pending += It->HasPendingInitOrStreaming() ? 1 : 0;
            ResidentMips += State.NumResidentLODs;
            RequestedMips += State.NumRequestedLODs;
            MaximumMips += State.MaxNumLODs;
            ResidentBytes += It->CalcTextureMemorySize(State.NumResidentLODs);
            FullBytes += It->CalcTextureMemorySize(State.MaxNumLODs);
        }
        EM_ASM({
            globalThis.__webTextureStreaming = ({
                frame: $0, supported: !!$1, poolBytes: $2, poolAllocatedBytes: $3,
                nonPoolAllocatedBytes: $4, streamable: $5, pending: $6,
                residentMips: $7, requestedMips: $8, maximumMips: $9,
                residentBytes: $10, fullBytes: $11
            });
        }, Frames, GRHISupportsTextureStreaming, double(Memory.TexturePoolSize),
            double(Memory.StreamingMemorySize), double(Memory.NonStreamingMemorySize),
            Streamable, Pending, ResidentMips, RequestedMips, MaximumMips,
            double(ResidentBytes), double(FullBytes));
    }
    if (VisualTestClock)
    {
        const auto* Frozen = IConsoleManager::Get().FindConsoleVariable(TEXT("r.RenderTimeFrozen"));
        EM_ASM({
            globalThis.__webVisualTestClock = ({renderTimeFrozen: !!$0, deltaSeconds: $1});
        }, Frozen && Frozen->GetInt() != 0, FApp::GetDeltaTime());
    }
    if (APlayerController* Controller = TemplateController.Get())
    {
        FVector Location;
        FRotator Rotation;
        Controller->GetPlayerViewPoint(Location, Rotation);
        EM_ASM({
            globalThis.__webDefaultCamera = ({x: $0, y: $1, z: $2, pitch: $3, yaw: $4});
        }, Location.X, Location.Y, Location.Z, Rotation.Pitch, Rotation.Yaw);
    }
#if STATS
    if (Frames % 60 == 0 && !FPlatformProcess::SupportsMultithreading())
    {
        const FStatsThreadState& Stats = FStatsThreadState::GetLocalState();
        EM_ASM({
            globalThis.__webEngineRuntime = ({
                statsHistoryFrames: $0, gameFrame: $1, renderFrame: $2,
                endOfPipeFrame: $3, heapBytes: $4
            });
        }, Stats.History.Num(), double(Stats.CurrentGameFrame), double(Stats.CurrentRenderFrame),
            double(Stats.CurrentEndOfPipeFrame), double(emscripten_get_heap_size()));
    }
#endif
}
}

extern "C" EMSCRIPTEN_KEEPALIVE int WebTextureStreamingTestBudget(int MiB)
{
    FTaskTagScope Scope(ETaskTag::EGameThread);
    if (!UseWebGPU || MiB < 32 || MiB > 1024)
        return 0;
    auto* Pool = IConsoleManager::Get().FindConsoleVariable(TEXT("r.Streaming.PoolSize"));
    if (!Pool)
        return 0;
    Pool->Set(MiB, ECVF_SetByCode);
    return 1;
}

extern "C" EMSCRIPTEN_KEEPALIVE int WebOcclusionTestMode(int Enabled, int BufferedFrames)
{
    FTaskTagScope Scope(ETaskTag::EGameThread);
    auto* Variable = IConsoleManager::Get().FindConsoleVariable(TEXT("r.AllowOcclusionQueries"));
    auto* Buffering = IConsoleManager::Get().FindConsoleVariable(TEXT("r.NumBufferedOcclusionQueries"));
    if (!UseWebGPU || !Variable || !Buffering || (Enabled != 0 && Enabled != 1) ||
        BufferedFrames < 0 || BufferedFrames > 4)
        return 0;
    Variable->Set(Enabled, ECVF_SetByCode);
    if (BufferedFrames)
        Buffering->Set(BufferedFrames, ECVF_SetByCode);
    return 1;
}

extern "C" EMSCRIPTEN_KEEPALIVE int WebDefaultSceneTestMode(int Mode)
{
    FTaskTagScope Scope(ETaskTag::EGameThread);
    if (!DefaultTemplate || !GEngine || Mode < 0 || Mode > 4)
        return 0;
    UWorld* World = nullptr;
    for (const FWorldContext& Context : GEngine->GetWorldContexts())
        if (Context.WorldType == EWorldType::Game)
            World = Context.World();
    if (!World)
        return 0;
    static TMap<TWeakObjectPtr<UDirectionalLightComponent>, float> OriginalIntensities;
    for (TActorIterator<AActor> It(World); It; ++It)
    {
        if (auto* Light = (*It)->FindComponentByClass<UDirectionalLightComponent>())
        {
            const float Original = OriginalIntensities.FindOrAdd(Light, Light->Intensity);
            Light->SetIntensity(Original * (Mode == 3 ? 0.1f : 1.0f));
            Light->SetVisibility(Mode != 1);
        }
        if (auto* Atmosphere = (*It)->FindComponentByClass<USkyAtmosphereComponent>())
            Atmosphere->SetVisibility(Mode != 2);
        if (auto* Cloud = (*It)->FindComponentByClass<UVolumetricCloudComponent>())
            Cloud->SetVisibility(Mode != 2 && Mode != 4);
        TInlineComponentArray<UStaticMeshComponent*> Components(*It);
        for (auto* Component : Components)
            if (Component->GetStaticMesh() &&
                Component->GetStaticMesh()->GetName() == TEXT("SM_SkySphere"))
                Component->SetVisibility(Mode != 2);
    }
    return 1;
}

extern "C" EMSCRIPTEN_KEEPALIVE int WebProjectLightingTestMode(int Mode)
{
    FTaskTagScope Scope(ETaskTag::EGameThread);
    if (ProjectMap.IsEmpty() || !GEngine || Mode < 0 || Mode > 5)
        return 0;
    UWorld* World = nullptr;
    for (const FWorldContext& Context : GEngine->GetWorldContexts())
        if (Context.WorldType == EWorldType::Game)
            World = Context.World();
    if (!World)
        return 0;
    const TCHAR* Variables[] = {TEXT("r.AmbientOcclusionLevels"), TEXT("r.ReflectionCapture.Runtime"),
        TEXT("r.ShadowQuality")};
    static TArray<int32> OriginalSettings;
    if (OriginalSettings.IsEmpty())
        for (const TCHAR* Name : Variables)
            OriginalSettings.Add(IConsoleManager::Get().FindConsoleVariable(Name)->GetInt());
    for (int32 Index = 0; Index < 3; ++Index)
    {
        auto* Variable = IConsoleManager::Get().FindConsoleVariable(Variables[Index]);
        const int32 Value = Mode == Index + 3 ? (Index == 1 ? 1 : 0) : OriginalSettings[Index];
        if (Variable->GetInt() != Value)
            Variable->Set(Value, ECVF_SetByCode);
    }
    EM_ASM({
        globalThis.__webProjectLighting = ({mode: $0, aoLevels: $1, reflectionMode: $2,
            shadowQuality: $3, original: {aoLevels: $4, reflectionMode: $5, shadowQuality: $6}});
    }, Mode, IConsoleManager::Get().FindConsoleVariable(Variables[0])->GetInt(),
        IConsoleManager::Get().FindConsoleVariable(Variables[1])->GetInt(),
        IConsoleManager::Get().FindConsoleVariable(Variables[2])->GetInt(),
        OriginalSettings[0], OriginalSettings[1], OriginalSettings[2]);
    static TMap<TWeakObjectPtr<ULightComponentBase>, bool> Visibility;
    for (TActorIterator<AActor> It(World); It; ++It)
        for (UActorComponent* Component : (*It)->GetComponents())
            if (auto* Light = Cast<ULightComponentBase>(Component))
            {
                const bool Original = Visibility.FindOrAdd(Light, Light->GetVisibleFlag());
                const bool Sky = Light->IsA<USkyLightComponent>();
                const bool Local = !Sky && !Light->IsA<UDirectionalLightComponent>();
                Light->SetVisibility(Original && !(Mode == 1 && Sky) && !(Mode == 2 && Local));
            }
    return 1;
}

extern "C" EMSCRIPTEN_KEEPALIVE int WebProjectViewTest(double X, double Y, double Z, double Pitch, double Yaw)
{
    FTaskTagScope Scope(ETaskTag::EGameThread);
    APlayerController* Controller = TemplateController.Get();
    if (ProjectMap.IsEmpty() || !Controller || !FMath::IsFinite(X) || !FMath::IsFinite(Y) ||
        !FMath::IsFinite(Z) || !FMath::IsFinite(Pitch) || !FMath::IsFinite(Yaw))
        return 0;
    static TWeakObjectPtr<ACameraActor> Camera;
    if (!Camera.IsValid())
        Camera = Controller->GetWorld()->SpawnActor<ACameraActor>();
    if (!Camera.IsValid())
        return 0;
    Camera->SetActorLocationAndRotation(FVector(X, Y, Z), FRotator(Pitch, Yaw, 0));
    Controller->SetViewTarget(Camera.Get());
    return 1;
}

extern "C" EMSCRIPTEN_KEEPALIVE int WebDefaultCloudTracingTestMode(int Mode)
{
    FTaskTagScope Scope(ETaskTag::EGameThread);
    if (!DefaultTemplate || !GEngine || Mode < 0 || Mode > 1)
        return 0;
    IConsoleVariable* Variable = IConsoleManager::Get().FindConsoleVariable(TEXT("r.VolumetricRenderTarget"));
    if (!Variable)
        return 0;
    Variable->Set(Mode == 0 ? 1 : 0, ECVF_SetByCode);
    return 1;
}

extern "C" EMSCRIPTEN_KEEPALIVE int WebDefaultCloudBudgetTestMode(int Mode)
{
    FTaskTagScope Scope(ETaskTag::EGameThread);
    if (!DefaultTemplate || !GEngine || Mode < 0 || Mode > 10)
        return 0;
    const TCHAR* Names[] = {TEXT("r.VolumetricCloud.ViewRaySampleMaxCount"),
        TEXT("r.VolumetricCloud.Shadow.ViewRaySampleMaxCount"),
        TEXT("r.VolumetricCloud.StepSizeOnZeroConservativeDensity"),
        TEXT("r.VolumetricRenderTarget.WebTracingDownsampleFactor")};
    static TArray<float> Original;
    IConsoleVariable* Variables[4];
    for (int32 Index = 0; Index < 4; ++Index)
    {
        Variables[Index] = IConsoleManager::Get().FindConsoleVariable(Names[Index]);
        if (!Variables[Index])
            return 0;
    }
    if (Original.IsEmpty())
        for (const auto* Variable : Variables)
            Original.Add(Variable->GetFloat());
    for (int32 Index = 0; Index < 4; ++Index)
        Variables[Index]->Set(Original[Index], ECVF_SetByCode);
    if (Mode == 2 || Mode == 3 || Mode == 6 || Mode == 9)
        Variables[0]->Set(48.0f, ECVF_SetByCode);
    if (Mode == 5 || Mode == 10)
        Variables[0]->Set(32.0f, ECVF_SetByCode);
    if (Mode == 1 || Mode == 3 || Mode == 5 || Mode == 9 || Mode == 10)
        Variables[1]->Set(2.0f, ECVF_SetByCode);
    if (Mode == 6)
        Variables[1]->Set(4.0f, ECVF_SetByCode);
    if (Mode == 4)
        Variables[2]->Set(2.0f, ECVF_SetByCode);
    if (Mode == 7 || Mode == 8)
    {
        Variables[0]->Set(768.0f, ECVF_SetByCode);
        Variables[1]->Set(80.0f, ECVF_SetByCode);
        Variables[2]->Set(1.0f, ECVF_SetByCode);
        Variables[3]->Set(2.0f, ECVF_SetByCode);
    }
    if (Mode >= 8)
        Variables[3]->Set(4.0f, ECVF_SetByCode);
    EM_ASM({
        globalThis.__webDefaultCloudBudget = ({mode: $0, viewSamplesMax: $1,
            shadowSamplesMax: $2, emptyStep: $3, tracingDownsample: $4});
    }, Mode, Variables[0]->GetFloat(), Variables[1]->GetFloat(), Variables[2]->GetFloat(),
        Variables[3]->GetFloat());
    return 1;
}

extern "C" EMSCRIPTEN_KEEPALIVE int WebDefaultFogTestMode(int Mode)
{
    FTaskTagScope Scope(ETaskTag::EGameThread);
    if (!DefaultTemplate || !GEngine || Mode < 0 || Mode > 4)
        return 0;
    UWorld* World = nullptr;
    for (const FWorldContext& Context : GEngine->GetWorldContexts())
        if (Context.WorldType == EWorldType::Game)
            World = Context.World();
    if (!World)
        return 0;
    static TMap<TWeakObjectPtr<UExponentialHeightFogComponent>, FVector3f> OriginalParameters;
    int32 Count = 0;
    for (TActorIterator<AActor> It(World); It; ++It)
    {
        if (auto* Fog = (*It)->FindComponentByClass<UExponentialHeightFogComponent>())
        {
            const FVector3f Original = OriginalParameters.FindOrAdd(Fog,
                FVector3f(Fog->FogDensity, Fog->FogHeightFalloff, Fog->StartDistance));
            Fog->SetFogDensity(Original.X * (Mode == 2 ? 2.0f : 1.0f));
            Fog->SetFogHeightFalloff(Original.Y * (Mode == 4 ? 4.0f : 1.0f));
            Fog->SetStartDistance(Mode == 3 ? 50000.0f : Original.Z);
            Fog->SetVisibility(Mode != 1);
            ++Count;
            EM_ASM({
                globalThis.__webDefaultFog = ({density: $0, heightFalloff: $1, startDistance: $2,
                    visible: !!$3, volumetric: !!$4, height: $5});
            }, double(Fog->FogDensity), double(Fog->FogHeightFalloff), double(Fog->StartDistance),
                int(Fog->IsVisible()), int(Fog->bEnableVolumetricFog), double(Fog->GetComponentLocation().Z));
        }
    }
    return Count;
}

int32 StartEngine()
{
    FTaskTagScope Scope(ETaskTag::EGameThread);
    FWorldDelegates::OnPostWorldInitialization.AddLambda(
        [](UWorld* World, const UWorld::InitializationValues) {
            if (World->GetPackage()->GetName() == StartupMap())
                World->OnWorldBeginPlay.AddLambda([World] { LogWorld(World); });
        });
    FDelayedAutoRegisterHelper(EDelayedRegisterRunPhase::PreObjectSystemReady, LogMaterialPolicy);
    FPlatformTypeLayoutParameters Layout;
    Layout.InitializeForCurrent();
    std::printf("P3_ENGINE_LAYOUT {\"maxFieldAlignment\":%u,\"flags\":%u,\"pointerBytes\":%u}\n",
        Layout.MaxFieldAlignment, Layout.Flags, uint32(sizeof(void*)));
    const FString CommandLine = FString(StartupMap()) + (UseWebGPU ?
        TEXT(" -webgpu -WebRHIStartupProbe -WebMinimalStartup -es31 -windowed -onethread -norhithread -nosound -NoSplash -NoLoadingScreen -unattended -stdout") :
        TEXT(" -nullrhi -sm5 -onethread -norhithread -nosound -NoSplash -NoLoadingScreen -unattended -stdout"));
    const int32 PreInitResult = GEngineLoop.PreInit(*CommandLine);
    if (PreInitResult != 0)
    {
        std::printf("P3_ENGINE_PREINIT_FAILED %d\n", PreInitResult);
        return PreInitResult;
    }
    const int32 InitResult = GEngineLoop.Init();
    if (InitResult != 0)
    {
        std::printf("P3_ENGINE_INIT_FAILED %d\n", InitResult);
        return InitResult;
    }
    if (VisualTestClock)
    {
        auto* Frozen = IConsoleManager::Get().FindConsoleVariable(TEXT("r.RenderTimeFrozen"));
        check(Frozen);
        Frozen->Set(1, ECVF_SetByCode);
    }
    UWorld* World = nullptr;
    for (const FWorldContext& Context : GEngine->GetWorldContexts())
        if (Context.WorldType == EWorldType::Game)
            World = Context.World();
    const bool MapLoaded = World && World->GetPackage()->GetName() == StartupMap() &&
        World->HasBegunPlay();
    LogWorld(World);
    if (!MapLoaded || IsEngineExitRequested())
    {
        std::printf("P3_ENGINE_INIT_FAILED selected map did not begin play\n");
        return 1;
    }
    if (UseWebGPU && DefaultTemplate)
        TemplateController = SetWebTemplateCamera(World);
    else if (UseWebGPU && !ProjectMap.IsEmpty())
    {
        TemplateController = World->GetFirstPlayerController();
        int32 Meshes = 0, LitMeshes = 0, Actors = 0;
        for (TActorIterator<AActor> It(World); It; ++It)
        {
            ++Actors;
            TInlineComponentArray<UStaticMeshComponent*> Components(*It);
            for (const UStaticMeshComponent* Component : Components)
                if (Component->GetStaticMesh())
                {
                    ++Meshes;
                    if (const UMaterialInterface* Material = Component->GetMaterial(0);
                        Material && !Material->GetShadingModels().HasShadingModel(MSM_Unlit))
                        ++LitMeshes;
                }
        }
        std::printf("P3_RENDER_SCENE {\"map\":\"%s\",\"actors\":%d,\"meshes\":%d,"
            "\"litMeshes\":%d,\"camera\":%s,\"projectGameplayPreserved\":true}\n",
            TCHAR_TO_UTF8(*ProjectMap), Actors, Meshes, LitMeshes,
            TemplateController.IsValid() ? "true" : "false");
    }
    else if (UseWebGPU && RenderScene)
        CreateWebRenderScene(World);
    const auto* MobileGPUScene = IConsoleManager::Get().FindConsoleVariable(TEXT("r.Mobile.SupportGPUScene"));
    if (!UseWebGPU)
        VerifyFileCache();
    const auto* SkinningScene = IConsoleManager::Get().FindConsoleVariable(TEXT("r.GPUSkin.UseSceneExtension"));
    const EShaderPlatform WebPlatform = FDataDrivenShaderPlatformInfo::GetShaderPlatformFromName(TEXT("SP_WEBGPU_ES31"));
    check(WebPlatform != SP_NumPlatforms);
    std::printf("P3_ENGINE_READY {\"nullRHI\":%s,\"webGPUSceneEnabled\":%s,\"skinningSceneEnabled\":%s,"
        "\"mobileGPUSceneSetting\":%d,\"skinningSceneSetting\":%d,"
        "\"shaderPlatform\":%u,\"featureLevel\":%u,\"shaderCount\":%u,\"activeGPUSceneEnabled\":%s}\n",
        UseWebGPU ? "false" : "true", UseGPUScene(WebPlatform) ? "true" : "false",
        IsGPUSkinSceneExtensionEnabled() ? "true" : "false",
        MobileGPUScene ? MobileGPUScene->GetInt() : -1, SkinningScene ? SkinningScene->GetInt() : -1,
        uint32(GMaxRHIShaderPlatform), uint32(GMaxRHIFeatureLevel), FShaderCodeLibrary::GetShaderCount(),
        UseGPUScene(GMaxRHIShaderPlatform) ? "true" : "false");
    emscripten_set_main_loop_arg(EngineFrame, nullptr, 0, false);
    return 0;
}

int main(int argc, char** argv)
{
    GGameThreadId = FPlatformTLS::GetCurrentThreadId();
    GIsGameThreadIdInitialized = true;
    {
        FTaskTagScope Scope(ETaskTag::EGameThread);
        FCoreDelegates::GetPreMainInitDelegate().Broadcast();
    }
    for (int Index = 1; Index < argc; ++Index)
    {
        UseWebGPU |= FCStringAnsi::Strcmp(argv[Index], "-webgpu") == 0;
        RenderScene |= FCStringAnsi::Strcmp(argv[Index], "-WebRenderScene") == 0;
        DefaultTemplate |= FCStringAnsi::Strcmp(argv[Index], "-WebDefaultTemplate") == 0;
        VisualTestClock |= FCStringAnsi::Strcmp(argv[Index], "-WebVisualTestClock") == 0;
        constexpr const ANSICHAR* MapOption = "-WebProjectMap=";
        if (FCStringAnsi::Strncmp(argv[Index], MapOption, FCStringAnsi::Strlen(MapOption)) == 0)
        {
            ProjectMap = UTF8_TO_TCHAR(argv[Index] + FCStringAnsi::Strlen(MapOption));
            if (!ProjectMap.StartsWith(TEXT("/Game/")) || ProjectMap.Len() > 256 ||
                !ProjectMap.RightChop(6).GetCharArray().FilterByPredicate([](TCHAR Value) {
                    return Value && Value != '/' && Value != '_' && !FChar::IsAlnum(Value);
                }).IsEmpty())
            {
                std::printf("P3_ENGINE_PREINIT_FAILED invalid project map argument\n");
                return 1;
            }
        }
    }
    if (!UseWebGPU)
        return StartEngine();
    WebGPUPrepareBrowserDevice([](bool Ready) {
        EM_ASM({ globalThis.__webEngineGPUDeviceReady = !!$0; }, Ready);
        if (!Ready)
        {
            std::printf("P3_ENGINE_PREINIT_FAILED browser WebGPU device\n");
            return;
        }
        StartEngine();
    });
    return 0;
}
