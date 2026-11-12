#include "CoreMinimal.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/Engine.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "Camera/CameraActor.h"
#include "Camera/CameraComponent.h"
#include "GameFramework/PlayerController.h"
#include "Rendering/NaniteWebGBuffer.h"
#include "Rendering/NaniteWebDepth.h"
#include "Rendering/NaniteStreamingManager.h"
#include "RenderingThread.h"
#include "SceneView.h"
#include "HAL/IConsoleManager.h"
#include "RHIGPUReadback.h"
#include "RenderGraphBuilder.h"
#include "RenderGraphUtils.h"
#include "WebNaniteCullReadback.h"
#include "Serialization/JsonSerializer.h"
#include <emscripten.h>

UStaticMesh* CreateWebNaniteDepthFixture();
UStaticMesh* CreateWebNaniteOrdinaryFixture();
UStaticMesh* CreateWebNaniteMultiMaterialFixture();
namespace
{
UStaticMesh* NaniteMesh;
UStaticMesh* OrdinaryMesh;
UStaticMeshComponent* Components[2];
UStaticMeshComponent* Ordinary;
TWeakObjectPtr<ACameraActor> Camera;
TWeakObjectPtr<AActor> SavedTarget;
TWeakObjectPtr<APlayerController> Controller;
FPrimitiveComponentId IDs[2];
FDelegateHandle CullObserver, GBufferObserver, TilesObserver;
int SavedDepth = 0, SavedGBuffer = 0, Step = 0, Settled = 0;
float SavedPixelsPerEdge = 1.0f;
int SavedHZB = 1;
bool Requested = false, Capturing = false;
FRDGTextureRef CaptureDepth = nullptr;
TSharedPtr<FJsonObject> Report;
struct FCopy { FString Field; uint32 Bytes; TUniquePtr<FRHIGPUBufferReadback> Readback; TSharedPtr<FJsonObject> Json; };
TArray<FCopy> Copies;
const uint32 Stride = 8;
FTextureRHIRef BaseTextures[2], InvalidTexture, ArrayTexture;
const uint32 MaterialSlots[] = {0, 7, 31, 63};
int AppliedStep[2] = {};

void CreateTextures(FRHICommandListImmediate& Cmd)
{
    for (int Index = 0; Index < 2; ++Index)
    {
        const int Size = Index ? 64 : 128, Mips = Index ? 7 : 8;
        auto Desc = FRHITextureCreateDesc::Create2D(TEXT("WebNanite.BaseColorFixture"), Size, Size, Index ? PF_R8G8B8A8 : PF_B8G8R8A8)
            .SetNumMips(Mips).SetFlags(TexCreate_ShaderResource | (Index ? TexCreate_None : TexCreate_SRGB));
        BaseTextures[Index] = Cmd.CreateTexture(Desc);
        for (int Mip = 0; Mip < Mips; ++Mip)
        {
            const int N = FMath::Max(1, Size >> Mip), Block = FMath::Max(1, N / 8);
            TArray<uint8> Bytes; Bytes.SetNumUninitialized(N * N * 4);
            for (int Y = 0; Y < N; ++Y) for (int X = 0; X < N; ++X)
            {
                const uint8 R = ((X / Block + Y / Block) & 1) ? 224 : 48;
                const uint8 G = 48 + 160 * Y / FMath::Max(1, N - 1), B = 32 + 24 * Mip + 16 * Index;
                const int O = (Y * N + X) * 4;
                Bytes[O] = Index ? R : B; Bytes[O + 1] = G; Bytes[O + 2] = Index ? B : R; Bytes[O + 3] = 255;
            }
            Cmd.UpdateTexture2D(BaseTextures[Index], Mip, FUpdateTextureRegion2D(0, 0, 0, 0, N, N), N * 4, Bytes.GetData());
        }
    }
    InvalidTexture = Cmd.CreateTexture(FRHITextureCreateDesc::Create2D(TEXT("WebNanite.InvalidIntegerTexture"), 4, 4, PF_R32_UINT).SetFlags(TexCreate_ShaderResource));
    ArrayTexture = Cmd.CreateTexture(FRHITextureCreateDesc::Create2DArray(TEXT("WebNanite.InvalidArrayTexture"), 4, 4, 2, PF_R8G8B8A8).SetFlags(TexCreate_ShaderResource));
}

int TextureIndex(int Index)
{ return Step < 7 || (Step == 10 && Index == 1) ? -1 : Step == 10 ? 1 : Index; }

TArray<TSharedPtr<FJsonValue>> MatrixJSON(const FMatrix& Matrix)
{
    TArray<TSharedPtr<FJsonValue>> Values;
    for (int32 R = 0; R < 4; ++R) for (int32 C = 0; C < 4; ++C) Values.Add(MakeShared<FJsonValueNumber>(Matrix.M[R][C]));
    return Values;
}
TArray<TSharedPtr<FJsonValue>> VectorJSON(const FVector3f& V)
{ return {MakeShared<FJsonValueNumber>(V.X), MakeShared<FJsonValueNumber>(V.Y), MakeShared<FJsonValueNumber>(V.Z)}; }
Nanite::FWebConstantMaterial Material(int Index)
{
    Nanite::FWebConstantMaterial M;
    M.BaseColor = Index ? FVector3f(0.08f, 0.25f, 0.7f) : Step == 1 ? FVector3f(0.7f, 0.12f, 0.04f) : FVector3f(0.1f, 0.65f, 0.2f);
    M.Emissive = Index ? FVector3f(0.005f, 0.015f, 0.03f) : FVector3f(0.03f, 0.01f, 0.005f);
    M.Metallic = Index ? 0.7f : 0.2f; M.Specular = Index ? 0.25f : 0.6f; M.Roughness = Index ? 0.8f : 0.35f;
    if (Step == 6 && !Index) { M.BaseColor = FVector3f(0.4f, 0.08f, 0.65f); M.Emissive = FVector3f(0.12f, 0.03f, 0.2f); M.Roughness = 0.65f; }
    const int Texture = TextureIndex(Index);
    if (Texture >= 0) { M.BaseColorTexture = BaseTextures[Texture]; M.BaseColor = FVector3f(0.8f, 0.7f, 0.9f); }
    if (Step == 8) M.BaseColorUVScaleBias = Index ? FVector4f(0.05f, 0.05f, 0.13f, 0.27f) : FVector4f(-2.25f, 1.75f, -0.3f, 0.2f);
    if (Step == 9) M.BaseColorUVScaleBias = FVector4f(32, -32, 0.25f, -0.4f);
    return M;
}
int MultiTexture(int Index, uint32 Slot)
{ return Step >= 21 ? (Step >= 22 && Step <= 24 && !Index && Slot == 0 ? 1 : 0) : Slot == 31 ? 0 : Slot == 63 ? 1 : -1; }
Nanite::FWebConstantMaterial MultiMaterial(int Index, uint32 Slot)
{
    Nanite::FWebConstantMaterial M;
    if (Step >= 21)
    {
        M.BaseColor = FVector3f(0.8f, 0.7f, 0.9f); M.Emissive = FVector3f(0.01f, 0.02f, 0.03f);
        M.Metallic = 0.2f; M.Specular = 0.6f; M.Roughness = 0.4f;
        M.BaseColorTexture = BaseTextures[MultiTexture(Index, Slot)];
        if (Step >= 23 && Step <= 24 && !Index && Slot == 7) M.BaseColorUVScaleBias = FVector4f(-2, 3, 0.2f, -0.3f);
        if (Step == 24 && !Index && Slot == 31) M.Roughness = 0.85f;
        // +0 and -0 are the same binding value and should share a bin.
        if (Index) M.BaseColorUVScaleBias.W = -0.0f;
        return M;
    }
    if (Step == 20) Index = 0;
    M.BaseColor = Slot == 0 ? FVector3f(0.7f, 0.1f, 0.05f) : Slot == 7 ? FVector3f(0.05f, 0.7f, 0.1f) :
        Slot == 31 ? FVector3f(0.15f, 0.3f, 0.8f) : FVector3f(0.8f, 0.7f, 0.2f);
    if (Index) M.BaseColor *= 0.65f;
    M.Metallic = Slot / 100.0f; M.Specular = Index ? 0.3f : 0.6f; M.Roughness = 0.2f + Slot / 100.0f;
    M.Emissive = M.BaseColor * 0.015f;
    if (MultiTexture(Index, Slot) >= 0) M.BaseColorTexture = BaseTextures[MultiTexture(Index, Slot)];
    if (Step >= 14 && !Index && Slot == 7) { M.BaseColor = FVector3f(0.1f, 0.7f, 0.8f); M.Roughness = 0.95f; }
    return M;
}
TArray<uint32> ExpectedSlots(int Index)
{
    if (Step <= 12) return {Step == 5 && Index == 0 ? 1u : 0u};
    if (Step == 19 || Step == 26 || (Step == 18 && Index == 1)) return {};
    if (!Index && Step == 18) return {63};
    if (!Index && Step == 17) return {7};
    TArray<uint32> Slots;
    for (const uint32 Slot : MaterialSlots)
        if ((Step >= 20 && !(Step == 25 && Index == 1 && Slot == 63)) || Step < 15 || (Step < 20 && Slot != (Index ? 63u : 31u))) Slots.Add(Slot);
    return Slots;
}
bool CurrentBinding(int Index) { return Step != 4 && !(Step == 17 && Index == 0); }
void BindMaterials(FRDGBuilder&, const Nanite::FWebSceneCullView& View)
{
    if (Step < 1 || Step > 26) return;
    for (const auto& Entry : View.Entries)
    {
        const int Index = Entry.ComponentId == IDs[0] ? 0 : Entry.ComponentId == IDs[1] ? 1 : -1;
        if (Index < 0) continue;
        if (Step >= 13)
        {
            if (AppliedStep[Index] == Step) continue;
            AppliedStep[Index] = Step;
            if (Step >= 20)
            {
                Nanite::RemoveWebConstantMaterial(Entry.ComponentId);
                for (const uint32 Slot : ExpectedSlots(Index))
                    check(Nanite::SetWebConstantMaterial(Entry.ComponentId, Entry.RuntimeResourceID, Slot, MultiMaterial(Index, Slot)));
                continue;
            }
            if (Step == 13) for (const uint32 Slot : MaterialSlots)
                check(Nanite::SetWebConstantMaterial(Entry.ComponentId, Entry.RuntimeResourceID, Slot, MultiMaterial(Index, Slot)));
            if (Step == 14 && Index == 0)
                check(Nanite::SetWebConstantMaterial(Entry.ComponentId, Entry.RuntimeResourceID, 7, MultiMaterial(Index, 7)));
            if (Step == 15)
                check(Nanite::RemoveWebConstantMaterialSlot(Entry.ComponentId, Entry.RuntimeResourceID, Index ? 63 : 31));
            if (Step == 16)
            {
                auto Invalid = MultiMaterial(Index, 0); Invalid.Roughness = -1;
                check(!Nanite::SetWebConstantMaterial(Entry.ComponentId, Entry.RuntimeResourceID, 0, Invalid));
                check(!Nanite::SetWebConstantMaterial(Entry.ComponentId, Entry.RuntimeResourceID, 64, MultiMaterial(Index, 0)));
                check(!Nanite::RemoveWebConstantMaterialSlot(Entry.ComponentId, Entry.RuntimeResourceID + 1, 0));
                check(!Nanite::RemoveWebConstantMaterialSlot(Entry.ComponentId, Entry.RuntimeResourceID, Index ? 63 : 31));
                check(!Nanite::RemoveWebConstantMaterialSlot(Entry.ComponentId, Entry.RuntimeResourceID, 64));
            }
            if (Step == 17 && Index == 0)
                check(Nanite::SetWebConstantMaterial(Entry.ComponentId, Entry.RuntimeResourceID + 1, 7, MultiMaterial(Index, 7)));
            if (Step == 18 && Index == 0)
                check(Nanite::SetWebConstantMaterial(Entry.ComponentId, Entry.RuntimeResourceID, 63, MultiMaterial(Index, 63)));
            if (Step == 19) Nanite::RemoveWebConstantMaterial(Entry.ComponentId);
            continue;
        }
        // Step 4 deliberately holds a stale resource binding; step 5 uses a
        // valid but absent material slot on the first object.
        Nanite::RemoveWebConstantMaterial(Entry.ComponentId);
        check(Nanite::SetWebConstantMaterial(Entry.ComponentId, Entry.RuntimeResourceID + (Step == 4 ? 1 : 0),
            Step == 5 && Index == 0 ? 1 : 0, Material(Index)));
    }
}
void CopyBuffer(FRDGBuilder& Graph, FRDGBufferRef Buffer, const TCHAR* Field, TSharedPtr<FJsonObject> Json)
{
    check(Buffer); auto& Copy = Copies.AddDefaulted_GetRef();
    Copy.Field = Field; Copy.Bytes = Buffer->Desc.GetSize(); Copy.Json = Json;
    Copy.Readback = MakeUnique<FRHIGPUBufferReadback>(Field);
    AddEnqueueCopyPass(Graph, Copy.Readback.Get(), Buffer, Copy.Bytes);
}
void ObserveTiles(FRDGBuilder& Graph, const Nanite::FWebSceneRasterView& Saved, const Nanite::FWebMaterialTiles& Tiles)
{
    if (!Capturing || !Report) return;
    auto Json = MakeShared<FJsonObject>();
    TArray<TSharedPtr<FJsonValue>> Members;
    for (const auto& Member : Tiles.Members)
    {
        auto Value = MakeShared<FJsonObject>(); Value->SetNumberField(TEXT("entry"), Member.EntryIndex);
        Value->SetNumberField(TEXT("slot"), Member.MaterialSlot); Members.Add(MakeShared<FJsonValueObject>(Value));
    }
    Json->SetArrayField(TEXT("members"), Members);
    Json->SetNumberField(TEXT("gridWidth"), Tiles.Grid.X); Json->SetNumberField(TEXT("gridHeight"), Tiles.Grid.Y);
    CopyBuffer(Graph, Tiles.Tiles, TEXT("tiles"), Json); CopyBuffer(Graph, Tiles.Arguments, TEXT("arguments"), Json);
    if (Step == 12)
    {
        auto OffsetSaved = Saved; OffsetSaved.Raster.Rect.Min += FIntPoint(7, 5); OffsetSaved.Raster.Rect.Max -= FIntPoint(3, 2);
        const auto Offset = Nanite::AddWebMaterialBinPass(Graph, OffsetSaved, CaptureDepth, Tiles.Members);
        const auto R = OffsetSaved.Raster.Rect;
        Json->SetArrayField(TEXT("offsetRect"), {MakeShared<FJsonValueNumber>(R.Min.X), MakeShared<FJsonValueNumber>(R.Min.Y), MakeShared<FJsonValueNumber>(R.Max.X), MakeShared<FJsonValueNumber>(R.Max.Y)});
        CopyBuffer(Graph, Offset.Tiles, TEXT("offsetTiles"), Json); CopyBuffer(Graph, Offset.Arguments, TEXT("offsetArguments"), Json);
    }
    auto Values = Report->GetArrayField(TEXT("materialTiles")); Values.Add(MakeShared<FJsonValueObject>(Json));
    Report->SetArrayField(TEXT("materialTiles"), Values);
}
void Observe(FRDGBuilder& Graph, const Nanite::FWebSceneRasterView& Saved, const Nanite::FWebGBufferTargets& Targets, bool After)
{
    if (Step < 1 || Step > 26) return;
    if (!After)
    {
        if (!Requested || ++Settled < 4) return;
        Requested = false; Capturing = true; Report = MakeShared<FJsonObject>();
        CaptureDepth = Targets.Depth;
        const auto Rect = Saved.Raster.Rect;
        Report->SetNumberField(TEXT("step"), Step);
        Report->SetNumberField(TEXT("frame"), Saved.Cull->View->Family->FrameNumber);
        Report->SetNumberField(TEXT("registered"), Saved.Cull->Registered); Report->SetNumberField(TEXT("rejected"), Saved.Cull->Rejected);
        Report->SetNumberField(TEXT("materialStride"), Stride);
        Report->SetNumberField(TEXT("materialWidth"), FMath::DivideAndRoundUp(uint32(Rect.Width()), Stride));
        Report->SetNumberField(TEXT("materialHeight"), FMath::DivideAndRoundUp(uint32(Rect.Height()), Stride));
        Report->SetArrayField(TEXT("rect"), {MakeShared<FJsonValueNumber>(Rect.Min.X), MakeShared<FJsonValueNumber>(Rect.Min.Y), MakeShared<FJsonValueNumber>(Rect.Max.X), MakeShared<FJsonValueNumber>(Rect.Max.Y)});
        Report->SetArrayField(TEXT("worldToClip"), MatrixJSON(Saved.Cull->View->ViewMatrices.GetWorldToClip()));
        Report->SetStringField(TEXT("colorFormat"), GPixelFormats[Targets.Color->Desc.Format].Name);
        Report->SetBoolField(TEXT("srgbBaseColor"), EnumHasAnyFlags(Targets.C->Desc.Flags, TexCreate_SRGB));
        Report->SetArrayField(TEXT("materialTiles"), {});
        if (Step == 16) Report->SetNumberField(TEXT("slotInputRejections"), 10);
        CopyBuffer(Graph, Nanite::AddWebDepthSnapshotPass(Graph, Saved.ResolvedVisibility, Targets.Depth, Rect, 1), TEXT("tilePixels"), Report);
        CopyBuffer(Graph, Saved.Raster.VisibleClusters, TEXT("visibleRecords"), Report);
        CopyBuffer(Graph, Nanite::AddWebMaterialInputResolvePasses(Graph, *Saved.Cull, Saved.Raster, Stride), TEXT("materialInputs"), Report);
        TArray<TSharedPtr<FJsonValue>> Entries;
        for (int32 I = 0; I < Saved.Cull->Entries.Num(); ++I)
        {
            const auto& Entry = Saved.Cull->Entries[I]; const int Index = Entry.ComponentId == IDs[0] ? 0 : 1;
            auto Json = MakeShared<FJsonObject>(); const auto M = Material(Index);
            Json->SetNumberField(TEXT("component"), Index); Json->SetNumberField(TEXT("instanceId"), Entry.InstanceSceneDataOffset);
            Json->SetNumberField(TEXT("clusterBase"), Saved.Raster.ClusterBases[I]);
            Json->SetArrayField(TEXT("localToWorld"), MatrixJSON(Entry.LocalToWorld));
            Json->SetBoolField(TEXT("bindingCurrent"), CurrentBinding(Index));
            Json->SetNumberField(TEXT("materialSlot"), Step == 5 && Index == 0 ? 1 : 0);
            Json->SetArrayField(TEXT("baseColor"), VectorJSON(M.BaseColor)); Json->SetArrayField(TEXT("emissive"), VectorJSON(M.Emissive));
            Json->SetNumberField(TEXT("metallic"), M.Metallic); Json->SetNumberField(TEXT("specular"), M.Specular); Json->SetNumberField(TEXT("roughness"), M.Roughness);
            Json->SetNumberField(TEXT("textureIndex"), TextureIndex(Index));
            TArray<TSharedPtr<FJsonValue>> UV; for (int J = 0; J < 4; ++J) UV.Add(MakeShared<FJsonValueNumber>(M.BaseColorUVScaleBias[J]));
            Json->SetArrayField(TEXT("uvScaleBias"), UV);
            if (Step >= 13)
            {
                TArray<TSharedPtr<FJsonValue>> Materials;
                for (const uint32 Slot : ExpectedSlots(Index))
                {
                    const auto SM = MultiMaterial(Index, Slot); auto B = MakeShared<FJsonObject>();
                    B->SetNumberField(TEXT("slot"), Slot);
                    B->SetArrayField(TEXT("baseColor"), VectorJSON(SM.BaseColor)); B->SetArrayField(TEXT("emissive"), VectorJSON(SM.Emissive));
                    B->SetNumberField(TEXT("metallic"), SM.Metallic); B->SetNumberField(TEXT("specular"), SM.Specular); B->SetNumberField(TEXT("roughness"), SM.Roughness);
                    B->SetNumberField(TEXT("textureIndex"), MultiTexture(Index, Slot));
                    TArray<TSharedPtr<FJsonValue>> SlotUV;
                    for (int J = 0; J < 4; ++J) SlotUV.Add(MakeShared<FJsonValueNumber>(SM.BaseColorUVScaleBias[J]));
                    B->SetArrayField(TEXT("uvScaleBias"), SlotUV);
                    Materials.Add(MakeShared<FJsonValueObject>(B));
                }
                Json->SetArrayField(TEXT("materials"), Materials);
            }
            CopyBuffer(Graph, WebNaniteCullReadbackRange(Graph, Entry.Result.ClusterKeys, Entry.Result.ClusterOffset, Entry.Input.MaxVisibleClusters), TEXT("keys"), Json);
            CopyBuffer(Graph, WebNaniteCullReadbackRange(Graph, Entry.Result.State, Entry.Result.StateOffset, 4), TEXT("state"), Json);
            Entries.Add(MakeShared<FJsonValueObject>(Json));
        }
        Report->SetArrayField(TEXT("entries"), Entries);
        if (Step == 1)
        {
            const auto& Entry = Saved.Cull->Entries[0]; auto M = Material(0);
            check(!Nanite::SetWebConstantMaterial({}, Entry.RuntimeResourceID, 0, M));
            check(!Nanite::SetWebConstantMaterial(Entry.ComponentId, MAX_uint32, 0, M));
            check(!Nanite::SetWebConstantMaterial(Entry.ComponentId, Entry.RuntimeResourceID, 64, M));
            M.Roughness = -1; check(!Nanite::SetWebConstantMaterial(Entry.ComponentId, Entry.RuntimeResourceID, 0, M));
            M = Material(0); M.BaseColor.X = 2; check(!Nanite::SetWebConstantMaterial(Entry.ComponentId, Entry.RuntimeResourceID, 0, M));
            check(!Nanite::AddWebGBufferSnapshotPass(Graph, Saved, Targets, 0));
            auto Invalid = Targets; Invalid.A = nullptr;
            check(!Nanite::AddWebGBufferSnapshotPass(Graph, Saved, Invalid, Stride));
            Invalid = Targets; Invalid.C = Targets.B;
            check(!Nanite::AddWebGBufferSnapshotPass(Graph, Saved, Invalid, Stride));
            check(!Nanite::AddWebResidentGBufferPasses(Graph, *Saved.Cull->View, Invalid));
            auto InvalidSaved = Saved; InvalidSaved.Cull = nullptr;
            check(!Nanite::AddWebGBufferSnapshotPass(Graph, InvalidSaved, Targets, Stride));
            InvalidSaved = Saved; InvalidSaved.Raster.SourceView = nullptr;
            check(!Nanite::AddWebGBufferSnapshotPass(Graph, InvalidSaved, Targets, Stride));
            M = Material(0); uint32 InvalidBits = 0x7fc00000; FMemory::Memcpy(&M.BaseColorUVScaleBias.X, &InvalidBits, 4);
            check(!Nanite::SetWebConstantMaterial(Entry.ComponentId, Entry.RuntimeResourceID, 0, M));
            InvalidBits = 0x7f800000; FMemory::Memcpy(&M.BaseColorUVScaleBias.X, &InvalidBits, 4);
            check(!Nanite::SetWebConstantMaterial(Entry.ComponentId, Entry.RuntimeResourceID, 0, M));
            M = Material(0); M.BaseColorUVScaleBias.X = 65537;
            check(!Nanite::SetWebConstantMaterial(Entry.ComponentId, Entry.RuntimeResourceID, 0, M));
            M = Material(0); M.BaseColorTexture = InvalidTexture;
            check(!Nanite::SetWebConstantMaterial(Entry.ComponentId, Entry.RuntimeResourceID, 0, M));
            M.BaseColorTexture = ArrayTexture;
            check(!Nanite::SetWebConstantMaterial(Entry.ComponentId, Entry.RuntimeResourceID, 0, M));
            Report->SetNumberField(TEXT("inputRejections"), 16);
            check(!Nanite::AddWebMaterialTilePass(Graph, Saved, Targets.Depth, -1, 0).Arguments);
            check(!Nanite::AddWebMaterialTilePass(Graph, Saved, Targets.Depth, Saved.Cull->Entries.Num(), 0).Arguments);
            check(!Nanite::AddWebMaterialTilePass(Graph, Saved, Targets.Depth, 0, 64).Arguments);
            check(!Nanite::AddWebMaterialTilePass(Graph, Saved, nullptr, 0, 0).Arguments);
            check(!Nanite::AddWebMaterialTilePass(Graph, Saved, Targets.C, 0, 0).Arguments);
            auto InvalidTiles = Saved; InvalidTiles.Cull = nullptr;
            check(!Nanite::AddWebMaterialTilePass(Graph, InvalidTiles, Targets.Depth, 0, 0).Arguments);
            InvalidTiles = Saved; InvalidTiles.Raster.SourceView = nullptr;
            check(!Nanite::AddWebMaterialTilePass(Graph, InvalidTiles, Targets.Depth, 0, 0).Arguments);
            InvalidTiles = Saved; InvalidTiles.Raster.Rect.Min.X = -1;
            check(!Nanite::AddWebMaterialTilePass(Graph, InvalidTiles, Targets.Depth, 0, 0).Arguments);
            Report->SetNumberField(TEXT("tileInputRejections"), 8);
            TArray<Nanite::FWebMaterialBinMember> Members;
            check(!Nanite::AddWebMaterialBinPass(Graph, Saved, Targets.Depth, Members).Arguments);
            Members = {{0, 0}, {0, 0}};
            check(!Nanite::AddWebMaterialBinPass(Graph, Saved, Targets.Depth, Members).Arguments);
            Members = {{0, 0}, {-1, 7}};
            check(!Nanite::AddWebMaterialBinPass(Graph, Saved, Targets.Depth, Members).Arguments);
            Members = {{0, 0}, {0, 64}};
            check(!Nanite::AddWebMaterialBinPass(Graph, Saved, Targets.Depth, Members).Arguments);
            Members.SetNum(65);
            check(!Nanite::AddWebMaterialBinPass(Graph, Saved, Targets.Depth, Members).Arguments);
            Report->SetNumberField(TEXT("binInputRejections"), 5);
        }
    }
    if (!Capturing) return;
    CopyBuffer(Graph, Nanite::AddWebGBufferSnapshotPass(Graph, Saved, Targets, Stride), After ? TEXT("after") : TEXT("before"), Report);
    if (After) { Capturing = false; CaptureDepth = nullptr; }
}
void Poll()
{
    if (!Report || Capturing) return;
    for (const auto& Copy : Copies) if (!Copy.Readback->IsReady()) return;
    for (auto& Copy : Copies)
    {
        const auto* Data = static_cast<const uint32*>(Copy.Readback->Lock(Copy.Bytes)); check(Data);
        TArray<TSharedPtr<FJsonValue>> Values;
        if (Copy.Field == TEXT("tilePixels"))
        {
            // Lossless sparse encoding of the full-resolution ID/depth snapshot:
            // omit only ID=0 pixels, retain all Nanite pixels including occluded ones.
            Copy.Json->SetNumberField(TEXT("tilePixelCount"), Copy.Bytes / 16);
            for (uint32 I = 0; I < Copy.Bytes / 16; ++I) if (Data[I * 4])
            {
                Values.Add(MakeShared<FJsonValueNumber>(I));
                for (uint32 J = 0; J < 3; ++J) Values.Add(MakeShared<FJsonValueNumber>(Data[I * 4 + J]));
            }
        }
        else for (uint32 I = 0; I < Copy.Bytes / 4; ++I) Values.Add(MakeShared<FJsonValueNumber>(Data[I]));
        Copy.Readback->Unlock(); Copy.Json->SetArrayField(Copy.Field, Values);
    }
    Report->SetBoolField(TEXT("pending"), false);
    FString Json; FJsonSerializer::Serialize(Report.ToSharedRef(), TJsonWriterFactory<>::Create(&Json)); FTCHARToUTF8 Utf8(*Json);
    MAIN_THREAD_EM_ASM({globalThis.__webNaniteGBufferTest = JSON.parse(UTF8ToString($0));}, Utf8.Get());
    Copies.Empty(); Report.Reset();
}
}
extern "C" EMSCRIPTEN_KEEPALIVE int WebNaniteGBufferTest(int RequestedStep)
{
    FTaskTagScope Scope(ETaskTag::EGameThread); static int LastStep = 0;
    if (RequestedStep < 0 || RequestedStep > 27 || !GEngine || !Nanite::GStreamingManager.IsWebResidentMode()) return 0;
    if (!RequestedStep) { ENQUEUE_RENDER_COMMAND(PollWebGBuffer)([](FRHICommandListImmediate&) { Poll(); }); return 1; }
    if (RequestedStep != LastStep + 1) return 0;
    if (RequestedStep == 1)
    {
        UWorld* World = nullptr; for (const auto& Context : GEngine->GetWorldContexts()) if (Context.WorldType == EWorldType::Game) World = Context.World();
        if (!World || !World->GetFirstPlayerController()) return 0;
        Controller = World->GetFirstPlayerController(); SavedTarget = Controller->GetViewTarget();
        Camera = World->SpawnActor<ACameraActor>(); if (!Camera.IsValid()) return 0;
        Camera->SetActorLocationAndRotation(FVector(100000, 0, 100000), FRotator::ZeroRotator);
        Camera->GetCameraComponent()->SetFieldOfView(90); Camera->GetCameraComponent()->SetConstraintAspectRatio(false);
        Controller->SetViewTarget(Camera.Get());
        NaniteMesh = CreateWebNaniteDepthFixture(); OrdinaryMesh = CreateWebNaniteOrdinaryFixture(); if (!NaniteMesh || !OrdinaryMesh) return 0;
        for (int I = 0; I < 2; ++I)
        {
            auto*& C = Components[I]; C = NewObject<UStaticMeshComponent>(); C->AddToRoot(); C->SetCollisionEnabled(ECollisionEnabled::NoCollision);
            C->SetMobility(EComponentMobility::Movable); C->SetStaticMesh(NaniteMesh); C->SetWorldLocation(FVector(100500, I ? 130 : 0, 100000));
            C->RegisterComponentWithWorld(World); IDs[I] = C->GetPrimitiveSceneId();
        }
        Ordinary = NewObject<UStaticMeshComponent>(); Ordinary->AddToRoot(); Ordinary->SetCollisionEnabled(ECollisionEnabled::NoCollision);
        Ordinary->SetMobility(EComponentMobility::Movable); Ordinary->SetStaticMesh(OrdinaryMesh);
        Ordinary->SetWorldLocation(FVector(100350, 0, 100000)); Ordinary->SetWorldScale3D(FVector(0.65)); Ordinary->RegisterComponentWithWorld(World);
        auto* Depth = IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.WebResidentSceneDepth"));
        auto* GBuffer = IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.WebResidentGBuffer")); check(Depth && GBuffer);
        SavedDepth = Depth->GetInt(); SavedGBuffer = GBuffer->GetInt(); Depth->Set(1, ECVF_SetByCode); GBuffer->Set(1, ECVF_SetByCode);
        // This attribute/coverage regression compares the original source mesh.
        // Keep a subpixel LOD budget; separate tests exercise coarse selection.
        auto* Pixels = IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.MaxPixelsPerEdge")); check(Pixels);
        SavedPixelsPerEdge = Pixels->GetFloat(); Pixels->Set(0.01f, ECVF_SetByCode);
        auto* HZB = IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.WebHZB"));
        SavedHZB = HZB->GetInt(); HZB->Set(0, ECVF_SetByCode); // Material oracle retains all candidate geometry.
        ENQUEUE_RENDER_COMMAND(ObserveWebGBuffer)([](FRHICommandListImmediate& Cmd) {
            CreateTextures(Cmd);
            CullObserver = Nanite::GetWebSceneCullDelegate().AddStatic(&BindMaterials); GBufferObserver = Nanite::GetWebGBufferDelegate().AddStatic(&Observe);
            TilesObserver = Nanite::GetWebMaterialTilesDelegate().AddStatic(&ObserveTiles);
        });
    }
    if (RequestedStep == 2) { Ordinary->SetWorldLocation(FVector(100700, 0, 100000)); Ordinary->SetWorldScale3D(FVector(1)); }
    if (RequestedStep == 3)
    {
        Ordinary->SetWorldLocation(FVector(100350, 35, 100000));
        Components[0]->SetWorldTransform(FTransform(FRotator(20, 30, 10), FVector(100500, 0, 100000), FVector(-1, 1.5, 0.6)));
    }
    if (RequestedStep == 4) Components[0]->SetHiddenInGame(true);
    if (RequestedStep == 5) { Components[0]->SetHiddenInGame(false); Ordinary->SetHiddenInGame(true); }
    if (RequestedStep == 6) Components[1]->SetHiddenInGame(true);
    if (RequestedStep == 7) Components[1]->SetHiddenInGame(false);
    if (RequestedStep == 11)
    {
        Ordinary->SetHiddenInGame(false); Ordinary->SetWorldLocation(FVector(100350, 0, 100000)); Ordinary->SetWorldScale3D(FVector(3));
    }
    if (RequestedStep == 12)
    {
        Ordinary->SetHiddenInGame(true);
        Camera->GetCameraComponent()->SetAspectRatio(1.3f); Camera->GetCameraComponent()->SetConstraintAspectRatio(true);
        Components[1]->SetWorldLocation(FVector(100500, 490, 100000));
    }
    if (RequestedStep == 13)
    {
        for (auto* C : Components) C->SetStaticMesh(nullptr);
        NaniteMesh->ReleaseResources(); NaniteMesh->RemoveFromRoot(); FlushRenderingCommands();
        NaniteMesh = CreateWebNaniteMultiMaterialFixture(); if (!NaniteMesh) return 0;
        Camera->GetCameraComponent()->SetConstraintAspectRatio(false);
        for (int I = 0; I < 2; ++I)
        {
            Components[I]->SetStaticMesh(NaniteMesh);
            Components[I]->SetWorldTransform(FTransform(FRotator::ZeroRotator, FVector(100500, I ? 130 : 0, 100000), FVector(1)));
        }
    }
    if (RequestedStep == 18)
    {
        auto* World = Components[1]->GetWorld();
        Components[1]->UnregisterComponent(); Components[1]->RegisterComponentWithWorld(World);
        IDs[1] = Components[1]->GetPrimitiveSceneId();
    }
    if (RequestedStep == 21)
    {
        Components[0]->SetWorldTransform(FTransform(FRotator(10, 12, 5), FVector(100500, 0, 100000), FVector(-1, 1.1, 0.8)));
        // Keep partial overlap, with enough exposed rear-slot pixels for the
        // stride-8 readback across temporal projection jitter.
        Components[1]->SetWorldTransform(FTransform(FRotator(-8, -15, 4), FVector(100540, 90, 100015), FVector(0.9, 1.15, 1.05)));
    }
    if (RequestedStep == 27)
    {
        IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.WebResidentSceneDepth"))->Set(SavedDepth, ECVF_SetByCode);
        IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.WebResidentGBuffer"))->Set(SavedGBuffer, ECVF_SetByCode);
        IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.MaxPixelsPerEdge"))->Set(SavedPixelsPerEdge, ECVF_SetByCode);
        IConsoleManager::Get().FindConsoleVariable(TEXT("r.Nanite.WebHZB"))->Set(SavedHZB, ECVF_SetByCode);
        for (auto* C : {Components[0], Components[1], Ordinary}) { C->UnregisterComponent(); C->RemoveFromRoot(); C->DestroyComponent(); }
        for (auto* Mesh : {NaniteMesh, OrdinaryMesh}) { Mesh->ReleaseResources(); Mesh->RemoveFromRoot(); }
        if (SavedTarget.IsValid()) Controller->SetViewTarget(SavedTarget.Get()); Camera->Destroy(); Camera.Reset();
        ENQUEUE_RENDER_COMMAND(RemoveWebGBufferObserver)([](FRHICommandListImmediate&) {
            check(!Requested && !Report && Copies.IsEmpty()); Step = 27;
            Nanite::GetWebSceneCullDelegate().Remove(CullObserver); Nanite::GetWebGBufferDelegate().Remove(GBufferObserver);
            Nanite::GetWebMaterialTilesDelegate().Remove(TilesObserver);
            for (auto ID : IDs) Nanite::RemoveWebConstantMaterial(ID);
            for (auto& Texture : BaseTextures) Texture.SafeRelease(); InvalidTexture.SafeRelease(); ArrayTexture.SafeRelease();
        });
        LastStep = RequestedStep; return 1;
    }
    LastStep = RequestedStep;
    ENQUEUE_RENDER_COMMAND(RequestWebGBuffer)([RequestedStep](FRHICommandListImmediate&) {
        check(!Requested && !Report && Copies.IsEmpty()); Step = RequestedStep; Requested = true; Settled = 0;
        MAIN_THREAD_ASYNC_EM_ASM({globalThis.__webNaniteGBufferTest = ({pending:true,step:$0});}, RequestedStep);
    });
    return 1;
}
