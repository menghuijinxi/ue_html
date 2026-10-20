#include "WebMinimalMapCommandlet.h"

#include "Engine/World.h"
#include "GameFramework/GameModeBase.h"
#include "GameFramework/WorldSettings.h"
#include "HAL/FileManager.h"
#include "Misc/PackageName.h"
#include "Misc/Paths.h"
#include "UObject/Package.h"
#include "UObject/SavePackage.h"

UWebMinimalMapCommandlet::UWebMinimalMapCommandlet()
{
    IsClient = false;
    IsServer = false;
    IsEditor = true;
    LogToConsole = true;
}

int32 UWebMinimalMapCommandlet::Main(const FString& Params)
{
    const TCHAR* PackageName = TEXT("/Game/WebMinimal");
    UPackage* Package = CreatePackage(PackageName);
    UWorld::InitializationValues Values;
    Values.AllowAudioPlayback(false).RequiresHitProxies(false).CreatePhysicsScene(false)
        .CreateNavigation(false).CreateAISystem(false).ShouldSimulatePhysics(false)
        .CreateFXSystem(false).SetTransactional(false).SetDefaultGameMode(AGameModeBase::StaticClass());
    UWorld* World = UWorld::CreateWorld(EWorldType::Editor, false, TEXT("WebMinimal"),
        Package, true, ERHIFeatureLevel::ES3_1, &Values);
    if (!World)
        return 1;
    World->SetFlags(RF_Public | RF_Standalone);
    World->GetWorldSettings()->bEnableWorldBoundsChecks = false;
    const FString Filename = FPackageName::LongPackageNameToFilename(
        PackageName, FPackageName::GetMapPackageExtension());
    IFileManager::Get().MakeDirectory(*FPaths::GetPath(Filename), true);
    FSavePackageArgs SaveArgs;
    SaveArgs.TopLevelFlags = RF_Public | RF_Standalone;
    const bool Saved = UPackage::SavePackage(Package, World, *Filename, SaveArgs);
    UE_LOG(LogTemp, Display, TEXT("P3_MINIMAL_MAP saved=%d package=%s file=%s"),
        Saved, PackageName, *Filename);
    World->DestroyWorld(false);
    return Saved ? 0 : 1;
}
