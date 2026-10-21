#include "CoreMinimal.h"
#include "LaunchEngineLoop.h"
#include "Misc/CoreDelegates.h"
#include "Misc/DelayedAutoRegister.h"
#include "Misc/CommandLine.h"
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
#include "Stats/StatsData.h"

static_assert(WITH_ENGINE && !ENABLE_LOW_LEVEL_MEM_TRACKER);

IMPLEMENT_APPLICATION(UEWebEngine, "UEWebEngine");

namespace
{
int32 Frames = 0;
bool UseWebGPU = false;
bool RenderScene = false;
bool DefaultTemplate = false;
TWeakObjectPtr<APlayerController> TemplateController;

const TCHAR* StartupMap()
{
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

extern "C" EMSCRIPTEN_KEEPALIVE int WebDefaultSceneTestMode(int Mode)
{
    FTaskTagScope Scope(ETaskTag::EGameThread);
    if (!DefaultTemplate || !GEngine || Mode < 0 || Mode > 3)
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
        TInlineComponentArray<UStaticMeshComponent*> Components(*It);
        for (auto* Component : Components)
            if (Component->GetStaticMesh() &&
                Component->GetStaticMesh()->GetName() == TEXT("SM_SkySphere"))
                Component->SetVisibility(Mode != 2);
    }
    return 1;
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
