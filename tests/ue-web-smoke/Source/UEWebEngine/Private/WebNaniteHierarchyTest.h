#pragma once
#include "Rendering/NaniteWebHierarchy.h"
#include <limits>

// Real manager buffers are used for ordinary cases; explicitly named synthetic
// cases exercise multi-level scheduling and bounded failure paths separately.
struct FWebNaniteHierarchyChecks
{
    struct FCase
    {
        FString Name;
        uint32 Capacity, Page;
        FVector4f Planes[6];
        uint32 LODMode;
        FMatrix44f LocalToView;
        FVector4f LODParameters;
        TUniquePtr<FRHIGPUBufferReadback> Keys, State;
    };
    TArray<FCase> Cases;
    int32 Rejections = 0;

    void Add(FRDGBuilder& Graph, Nanite::FWebHierarchyCullInput Input, const TCHAR* Name)
    {
        Nanite::FWebHierarchyCullResult Output;
        check(Nanite::AddWebResidentHierarchyCullPasses(Graph, Input, Output));
        auto& Case = Cases.AddDefaulted_GetRef();
        Case.Name = Name; Case.Capacity = Input.MaxVisibleClusters; Case.Page = Input.FirstRootPage;
        Case.LODMode = Input.LODMode; Case.LocalToView = Input.LocalToView; Case.LODParameters = Input.LODParameters;
        for (int32 I = 0; I < 6; ++I) Case.Planes[I] = Input.Planes[I];
        Case.Keys = MakeUnique<FRHIGPUBufferReadback>(TEXT("WebNaniteCullKeys"));
        Case.State = MakeUnique<FRHIGPUBufferReadback>(TEXT("WebNaniteCullState"));
        AddEnqueueCopyPass(Graph, Case.Keys.Get(), Output.ClusterKeys, Case.Capacity * 4);
        AddEnqueueCopyPass(Graph, Case.State.Get(), Output.State, 16);
    }

    void Schedule(FRDGBuilder& Graph, Nanite::FStreamingManager& Manager, const Nanite::FResources& Resource, bool Synthetic)
    {
        Nanite::FWebHierarchyCullInput Input;
        Input.ClusterPageData = Manager.GetClusterPageDataSRV(Graph);
        Input.Hierarchy = Manager.GetHierarchySRV(Graph);
        Input.HierarchyOffset = Resource.HierarchyOffset;
        Input.NumHierarchyNodes = Resource.NumHierarchyNodes;
        Input.RootNode = Resource.HierarchyRootOffsets[0];
        Input.FirstRootPage = Resource.RootPageIndex;
        Input.NumRootPages = Resource.NumRootPages;
        Input.MaxLevels = Manager.GetMaxHierarchyLevels();
        Input.MaxVisibleClusters = Resource.NumClusters;
        for (int32 I = 0; I < 6; ++I) { Input.Planes[I] = FVector4f(0, 0, 0, 100); Input.Planes[I][I / 2] = I % 2 ? -1 : 1; }
        for (uint32 Bad = 0; Bad < 19; ++Bad)
        {
            auto Invalid = Input;
            if (Bad == 0) Invalid.MaxVisibleClusters = 0;
            if (Bad == 1) Invalid.RootNode = Input.NumHierarchyNodes;
            if (Bad == 2) Invalid.HierarchyOffset = MAX_uint32;
            if (Bad == 3) Invalid.FirstRootPage = MAX_uint32;
            if (Bad == 4) Invalid.MaxLevels = 65;
            if (Bad == 5) Invalid.Planes[0].W = std::numeric_limits<float>::infinity();
            if (Bad == 6) Invalid.ClusterPageData = nullptr;
            if (Bad == 7) Invalid.ClusterPageData = Graph.CreateSRV(FRDGBufferSRVDesc(Input.ClusterPageData->Desc.Buffer, 256, 16));
            if (Bad == 8) Invalid.ClusterPageData = Graph.CreateSRV(FRDGBufferSRVDesc(Input.ClusterPageData->Desc.Buffer, uint32(0), 16));
            if (Bad == 9) Invalid.Hierarchy = Graph.CreateSRV(FRDGBufferSRVDesc(Input.Hierarchy->Desc.Buffer, 16, 4));
            if (Bad == 10) Invalid.Hierarchy = Graph.CreateSRV(FRDGBufferSRVDesc(Input.Hierarchy->Desc.Buffer, uint32(0), 4));
            if (Bad >= 11) Invalid.LODMode = 1;
            if (Bad == 11) Invalid.LODMode = 3;
            if (Bad == 12) Invalid.LODParameters.X = 0;
            if (Bad == 13) Invalid.LODParameters.Y = 0;
            if (Bad == 14) Invalid.LODParameters.Z = 0.5f;
            if (Bad == 15) Invalid.LODParameters.W = 0;
            if (Bad == 16) Invalid.LODParameters.X = std::numeric_limits<float>::infinity();
            if (Bad == 17) Invalid.LocalToView.M[0][0] = std::numeric_limits<float>::quiet_NaN();
            if (Bad == 18) Invalid.LocalToView.M[0][3] = 1;
            Nanite::FWebHierarchyCullResult Rejected;
            check(!Nanite::AddWebResidentHierarchyCullPasses(Graph, Invalid, Rejected));
            check(!Rejected.ClusterKeys && !Rejected.State); ++Rejections;
        }
        Add(Graph, Input, TEXT("all"));
        Input.Planes[0] = FVector4f(1, 0, 0, -101); Add(Graph, Input, TEXT("outside"));
        Input.Planes[0] = FVector4f(1, 0, 0, -25); Add(Graph, Input, TEXT("partial"));
        Input.Planes[0] = FVector4f(1, 0, 0, -50); Add(Graph, Input, TEXT("touching"));
        Input.Planes[0] = FVector4f(1, 0, 0, 100);
        Input.Planes[5] = FVector4f(0, 0, -1, -101); Add(Graph, Input, TEXT("sixth-plane"));
        Input.Planes[5] = FVector4f(0, 0, -1, 100);
        Input.Planes[0] = FVector4f(0.6f, 0.8f, 0, -25); Add(Graph, Input, TEXT("rotated"));
        Input.Planes[0] = FVector4f(1, 0, 0, 100);
        Input.MaxVisibleClusters = 1; Add(Graph, Input, TEXT("capacity"));
        if (!Synthetic) return;
        Input.MaxVisibleClusters = Resource.NumClusters;
        Input.LODMode = 2;
        for (const float Scale : { 4.0f, 2.0f, 1.0f, 0.5f, 0.25f })
        {
            Input.LODParameters = FVector4f(Scale, 1, 1, 1);
            Add(Graph, Input, *FString::Printf(TEXT("lod-ortho-%.2f"), Scale));
        }
        Input.LODMode = 1;
        for (const float Distance : { 40.0f, 100.0f, 250.0f, 500.0f, 1000.0f, 2000.0f, 4000.0f })
        {
            Input.LocalToView = FMatrix44f::Identity;
            Input.LocalToView.M[3][2] = Distance;
            Input.LODParameters = FVector4f(512, 1, 1, 10);
            Add(Graph, Input, *FString::Printf(TEXT("lod-perspective-%.0f"), Distance));
        }
        // Off-axis, mirrored scale and camera-inside bounds must stay finite.
        Input.LocalToView = FMatrix44f::Identity;
        Input.LocalToView.M[0][0] = -0.5f; Input.LocalToView.M[1][1] = 2.0f;
        Input.LocalToView.M[3][0] = 250.0f; Input.LocalToView.M[3][2] = 400.0f;
        Input.LODParameters = FVector4f(512, 0.5f, 2.0f, 10);
        Add(Graph, Input, TEXT("lod-mirrored-off-axis"));
        Input.LocalToView = FMatrix44f::Identity;
        Input.LODParameters = FVector4f(512, 1, 1, 10);
        Add(Graph, Input, TEXT("lod-camera-inside"));
        Input.LODMode = 0;
        check(Resource.HierarchyNodes.Num() == 1);
        TArray<Nanite::FPackedHierarchyNode> Nodes;
        Nodes.AddZeroed(); Nodes.Add(Resource.HierarchyNodes[0]);
        auto& Parent = Nodes[0];
        const uint32 NoAssembly = (1u << NANITE_HIERARCHY_ASSEMBLY_TRANSFORM_INDEX_BITS) - 1;
        for (uint32 I = 0; I < NANITE_MAX_BVH_NODE_FANOUT; ++I)
        {
            Parent.Misc2[I].ResourcePageRangeKey = NANITE_PAGE_RANGE_KEY_EMPTY_RANGE;
            Parent.Misc2[I].GroupPartSize_AssemblyPartIndex = NoAssembly;
        }
        Parent.Misc0[0].BoxBoundsCenter = FVector3f(0);
        Parent.Misc1[0].BoxBoundsExtent = FVector3f(100);
        Parent.Misc1[0].ChildStartReference = 1;
        Parent.Misc2[0].ResourcePageRangeKey = MAX_uint32;
        Input.HierarchyOffset = 0; Input.NumHierarchyNodes = 2; Input.RootNode = 0; Input.MaxLevels = 2;
        auto Upload = [&]() {
            auto* Buffer = Graph.CreateBuffer(FRDGBufferDesc::CreateByteAddressDesc(Nodes.Num() * sizeof(Nanite::FPackedHierarchyNode)), TEXT("WebNaniteSyntheticHierarchy"));
            Graph.QueueBufferUpload(Buffer, MakeArrayView(Nodes));
            Input.Hierarchy = Graph.CreateSRV(Buffer);
        };
        Upload(); Add(Graph, Input, TEXT("synthetic-two-levels"));
        Input.MaxLevels = 1; Add(Graph, Input, TEXT("synthetic-depth-limit")); Input.MaxLevels = 2;
        Parent.Misc1[0].ChildStartReference = 2; Upload(); Add(Graph, Input, TEXT("synthetic-invalid-node"));
        Parent.Misc1[0].ChildStartReference = 0; Upload(); Add(Graph, Input, TEXT("synthetic-cycle"));
        Parent.Misc1[0].ChildStartReference = 1;
        Parent.Misc2[0].NumBones_BoneIndicesOffset = 1u << NANITE_HIERARCHY_BONE_INDICES_OFFSET_BITS;
        Upload(); Add(Graph, Input, TEXT("synthetic-skinned"));
        Parent.Misc2[0].NumBones_BoneIndicesOffset = 0;
        for (uint32 I = 1; I < NANITE_MAX_BVH_NODE_FANOUT; ++I)
        {
            Parent.Misc0[I] = Parent.Misc0[0]; Parent.Misc1[I] = Parent.Misc1[0]; Parent.Misc2[I] = Parent.Misc2[0];
        }
        Input.MaxVisibleClusters = 64; Upload(); Add(Graph, Input, TEXT("synthetic-queue-overflow"));
    }

    bool IsReady() const
    {
        for (const auto& Case : Cases) if (!Case.Keys->IsReady() || !Case.State->IsReady()) return false;
        return true;
    }

    void Collect(FJsonObject& Report)
    {
        TArray<TSharedPtr<FJsonValue>> Results;
        for (auto& Case : Cases)
        {
            const auto* State = static_cast<const uint32*>(Case.State->Lock(16));
            const auto* Keys = static_cast<const uint32*>(Case.Keys->Lock(Case.Capacity * 4));
            check(State && Keys);
            auto Item = MakeShared<FJsonObject>();
            Item->SetStringField(TEXT("name"), Case.Name); Item->SetNumberField(TEXT("page"), Case.Page);
            Item->SetNumberField(TEXT("capacity"), Case.Capacity);
            Item->SetNumberField(TEXT("lodMode"), Case.LODMode);
            TArray<TSharedPtr<FJsonValue>> LODMatrix, LODParameters;
            for (int32 Row = 0; Row < 4; ++Row) for (int32 Col = 0; Col < 4; ++Col)
                LODMatrix.Add(MakeShared<FJsonValueNumber>(Case.LocalToView.M[Row][Col]));
            for (int32 Axis = 0; Axis < 4; ++Axis) LODParameters.Add(MakeShared<FJsonValueNumber>(Case.LODParameters[Axis]));
            Item->SetArrayField(TEXT("localToView"), LODMatrix);
            Item->SetArrayField(TEXT("lodParameters"), LODParameters);
            TArray<TSharedPtr<FJsonValue>> Values, Counts, Planes;
            for (uint32 I = 0; I < Case.Capacity; ++I) Values.Add(MakeShared<FJsonValueNumber>(Keys[I]));
            for (uint32 I = 0; I < 4; ++I) Counts.Add(MakeShared<FJsonValueNumber>(State[I]));
            for (const auto& Plane : Case.Planes) for (int32 I = 0; I < 4; ++I) Planes.Add(MakeShared<FJsonValueNumber>(Plane[I]));
            Item->SetArrayField(TEXT("keys"), Values); Item->SetArrayField(TEXT("state"), Counts); Item->SetArrayField(TEXT("planes"), Planes);
            Results.Add(MakeShared<FJsonValueObject>(Item));
            Case.Keys->Unlock(); Case.State->Unlock();
        }
        Report.SetArrayField(TEXT("culling"), Results); Report.SetNumberField(TEXT("cullInputRejections"), Rejections);
        Cases.Empty();
    }
};
