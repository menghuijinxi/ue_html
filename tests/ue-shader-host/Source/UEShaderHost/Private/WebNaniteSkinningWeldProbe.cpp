#include "CoreMinimal.h"
#include "Cluster.h"
#include "NaniteSkinningWeld.h"
#include "Dom/JsonObject.h"
#include "Misc/FileHelper.h"
#include "Serialization/JsonSerializer.h"

int32 RunWebNaniteSkinningWeldProbe(const FString& Output)
{
    using namespace Nanite;
    auto Report = MakeShared<FJsonObject>();
    TArray<TSharedPtr<FJsonValue>> Checks;
    bool Passed = true;
    auto Check = [&](const TCHAR* Name, bool Pass)
    {
        auto Result = MakeShared<FJsonObject>(); Result->SetStringField(TEXT("name"), Name); Result->SetBoolField(TEXT("pass"), Pass);
        Checks.Add(MakeShared<FJsonValueObject>(Result)); Passed &= Pass;
        UE_LOG(LogTemp, Display, TEXT("WEB_SKINNING_WELD name=%s pass=%d"), Name, Pass);
    };
    FVertexFormat Format; Format.NumBoneInfluences = 2; Format.NumTexCoords = 1;
    Nanite::FVertexArray Original(Format); Original.SetNum(1024);
    FRandomStream Random(614573);
    for (uint32 I = 0; I < Original.Num(); ++I)
    {
        Original.GetPosition(I) = FVector3f(Random.FRandRange(-100, 100), Random.FRandRange(-100, 100), Random.FRandRange(-100, 100));
        Original.GetNormal(I) = FVector3f(1, 0, 0); Original.GetUVs(I)[0] = FVector2f(0, 0);
        Original.GetBoneInfluences(I)[0] = FVector2f(0, float(I) / 1023);
        Original.GetBoneInfluences(I)[1] = FVector2f(1, 1 - float(I) / 1023);
    }
    const FSkinningWeld Weld(Original);
    Nanite::FVertexArray Query(Format); Query.SetNum(2048);
    for (uint32 I = 0; I < Query.Num(); ++I)
    {
        Query.GetPosition(I) = I < Original.Num() ? Original.GetPosition(I) :
            FVector3f(Random.FRandRange(-150, 150), Random.FRandRange(-150, 150), Random.FRandRange(-150, 150));
        Query.GetNormal(I) = FVector3f(0, 1, 0); Query.GetUVs(I)[0] = FVector2f(.25f, .75f);
        Query.GetBoneInfluences(I)[0] = Query.GetBoneInfluences(I)[1] = FVector2f(-1, -1);
    }
    const auto Before = Query.Array;
    Weld.Restore(Query);
    bool Nearest = true, Exact = true, Attributes = true;
    for (uint32 I = 0; I < Query.Num(); ++I)
    {
        uint32 Best = 0; double Distance = TNumericLimits<double>::Max();
        for (uint32 J = 0; J < Original.Num(); ++J)
        {
            const double D = (FVector3d(Query.GetPosition(I)) - FVector3d(Original.GetPosition(J))).SizeSquared();
            if (D < Distance) { Distance = D; Best = J; }
        }
        Nearest &= FMemory::Memcmp(Query.GetBoneInfluences(I), Original.GetBoneInfluences(Best), 2 * sizeof(FVector2f)) == 0;
        if (I < Original.Num()) Exact &= Best == I;
        Attributes &= FMemory::Memcmp(Query.Array.GetData() + I * Query.GetVertSize(),
            Before.GetData() + I * Query.GetVertSize(), Format.GetBoneInfluenceOffset() * sizeof(float)) == 0;
    }
    Check(TEXT("2048 nearest queries match exhaustive independent search"), Nearest);
    Check(TEXT("1024 exact positions retain original binding"), Exact);
    Check(TEXT("positions normals UVs remain byte identical"), Attributes);
    const auto Once = Query.Array; Weld.Restore(Query);
    Check(TEXT("restoring is idempotent"), Query.Array == Once);

    Nanite::FVertexArray Points(Format); Points.SetNum(6);
    const FVector3f Positions[] = {FVector3f(-1, 0, 0), FVector3f(1, 0, 0), FVector3f(0, 2, 0),
        FVector3f(0, 2, 0), FVector3f(0, -2, 0), FVector3f(0, -2, 0)};
    for (uint32 I = 0; I < Points.Num(); ++I)
    {
        Points.GetPosition(I) = Positions[I]; Points.GetNormal(I) = FVector3f(1, 0, 0); Points.GetUVs(I)[0] = FVector2f(0, 0);
        Points.GetBoneInfluences(I)[0] = FVector2f(0, 1); Points.GetBoneInfluences(I)[1] = FVector2f(1, 0);
    }
    Points.GetBoneInfluences(1)[0] = FVector2f(0, 0); Points.GetBoneInfluences(1)[1] = FVector2f(1, 1);
    // An intentional skin seam must survive; reordering equivalent slots must
    // not create a seam, and hard normals/UVs remain separate attributes.
    Points.GetBoneInfluences(3)[0] = FVector2f(0, 0); Points.GetBoneInfluences(3)[1] = FVector2f(1, 1);
    Swap(Points.GetBoneInfluences(5)[0], Points.GetBoneInfluences(5)[1]);
    const FSkinningWeld Seams(Points);
    Nanite::FVertexArray Merged = Points; Merged.SetNum(8);
    for (uint32 I = 6; I < 8; ++I)
    {
        Merged.GetPosition(I) = FVector3f(0, 0, 0); Merged.GetNormal(I) = FVector3f(0, I == 6 ? 1 : -1, 0);
        Merged.GetUVs(I)[0] = FVector2f(float(I), 0);
        Merged.GetBoneInfluences(I)[0] = FVector2f(0, I == 6 ? .25f : .75f);
        Merged.GetBoneInfluences(I)[1] = FVector2f(1, I == 6 ? .75f : .25f);
    }
    Seams.Restore(Merged);
    Check(TEXT("coincident collapsed wedges receive identical binding"), FMemory::Memcmp(Merged.GetBoneInfluences(6), Merged.GetBoneInfluences(7), 2 * sizeof(FVector2f)) == 0);
    Check(TEXT("equal distances choose deterministic original index"), FMemory::Memcmp(Merged.GetBoneInfluences(6), Points.GetBoneInfluences(0), 2 * sizeof(FVector2f)) == 0);
    Check(TEXT("deliberate original skin seam remains split"), Merged.GetBoneInfluences(2)[0].Y == 1 && Merged.GetBoneInfluences(3)[0].Y == 0);
    Check(TEXT("equivalent reordered bindings share a representation"), FMemory::Memcmp(Merged.GetBoneInfluences(4), Merged.GetBoneInfluences(5), 2 * sizeof(FVector2f)) == 0);
    Check(TEXT("normal and UV seam retained"), Merged.GetNormal(6).Y == 1 && Merged.GetNormal(7).Y == -1 && Merged.GetUVs(6)[0].X != Merged.GetUVs(7)[0].X);
    struct FInspectSimplifier : FMeshSimplifier
    {
        using FMeshSimplifier::FMeshSimplifier;
        bool Locked(const FVector3f& Position) const
        {
            int32 Count = 0; bool All = true;
            ForAllCorners(Position, [&](uint32 Corner) { ++Count; All &= (CornerFlags[Corner] & LockedVertMask) != 0; });
            return Count > 0 && All;
        }
    };
    uint32 Indices[] = {0, 1, 2, 0, 3, 1, 0, 4, 1, 0, 1, 5}; int32 Materials[] = {0, 0, 0, 0};
    FInspectSimplifier Simplifier(Points.Array.GetData(), Points.Num(), Indices, 12, Materials, Points.GetVertSize() - 3);
    Seams.LockSeams(Simplifier);
    Check(TEXT("deliberate skin seam locked before simplification"), Simplifier.Locked(Positions[2]));
    Check(TEXT("reordered equivalent slots do not lock simplification"), !Simplifier.Locked(Positions[4]));
    Check(TEXT("ordinary geometry positions remain unlocked"), !Simplifier.Locked(Positions[0]));
    Nanite::FVertexArray SignedZero = Original; SignedZero.SetNum(1026);
    SignedZero.GetPosition(1024) = FVector3f(0.0f, 0, 0);
    SignedZero.GetPosition(1025) = FVector3f(0.0f, 0, 0);
    volatile uint32 NegativeZeroBits = 0x80000000u;
    const uint32 NegativeZeroCopy = NegativeZeroBits;
    FMemory::Memcpy(&SignedZero.GetPosition(1025).X, &NegativeZeroCopy, sizeof(float));
    for (uint32 I = 0; I < 2; ++I)
    {
        SignedZero.GetBoneInfluences(1024 + I)[0] = FVector2f(0, I == 0 ? 1 : 0);
        SignedZero.GetBoneInfluences(1024 + I)[1] = FVector2f(1, I == 0 ? 0 : 1);
    }
    const FVector3f ZeroPositions[] = {SignedZero.GetPosition(1024), SignedZero.GetPosition(1025)};
    FSkinningWeld(SignedZero).Restore(SignedZero);
    Check(TEXT("signed zero coordinates retain intentional skin seams"),
        SignedZero.GetBoneInfluences(1024)[0].Y == 1 && SignedZero.GetBoneInfluences(1025)[1].Y == 1);
    Check(TEXT("position key normalization does not alter vertex coordinates"),
        FMemory::Memcmp(&SignedZero.GetPosition(1024), &ZeroPositions[0], sizeof(FVector3f)) == 0 &&
        FMemory::Memcmp(&SignedZero.GetPosition(1025), &ZeroPositions[1], sizeof(FVector3f)) == 0);
    FVertexFormat StaticFormat; Nanite::FVertexArray Static(StaticFormat); Static.SetNum(1); Static.Array.Init(3, Static.Array.Num());
    const auto StaticBefore = Static.Array; FSkinningWeld(Static).Restore(Static);
    Check(TEXT("unskinned vertices remain byte identical"), Static.Array == StaticBefore);
    Report->SetBoolField(TEXT("pass"), Passed); Report->SetArrayField(TEXT("checks"), Checks);
    Report->SetNumberField(TEXT("nearestQueries"), Query.Num());
    FString Json; FJsonSerializer::Serialize(Report, TJsonWriterFactory<>::Create(&Json));
    return FFileHelper::SaveStringToFile(Json, *Output, FFileHelper::EEncodingOptions::ForceUTF8WithoutBOM) && Passed ? 0 : 1;
}
