#include "WebGPUDynamicRHI.h"

namespace
{
bool IsBufferUploadTransition(const FRHITransitionInfo& Entry)
{
    return Entry.Type == FRHITransitionInfo::EType::Buffer && Entry.Buffer &&
        Entry.Flags == EResourceTransitionFlags::IgnoreAfterState &&
        ((Entry.AccessBefore == ERHIAccess::Unknown && Entry.AccessAfter == ERHIAccess::CopyDest) ||
         (Entry.AccessBefore == ERHIAccess::CopyDest && Entry.AccessAfter == ERHIAccess::Unknown));
}

bool SupportedAccess(FRHIViewableResource *Resource, ERHIAccess Access)
{
    if (!Resource || Access == ERHIAccess::Unknown || IsInvalidAccess(Access))
        return false;
    if (EnumHasAnyFlags(Access, ERHIAccess::RTV | ERHIAccess::CopyDest) && Access != ERHIAccess::RTV &&
        Access != ERHIAccess::CopyDest)
        return false;
    if (Resource->GetType() == RRT_Texture)
    {
        const auto *Texture = static_cast<FRHITexture *>(Resource);
        if (!static_cast<const FWebGPUTexture *>(Texture)->SurfaceFrameActive)
            return false;
        if (Texture->GetFormat() == PF_DepthStencil || Texture->GetFormat() == PF_ShadowDepth)
        {
            const ERHIAccess Allowed = ERHIAccess::DSVRead | ERHIAccess::DSVWrite |
                (Texture->GetFormat() == PF_ShadowDepth ? ERHIAccess::CopySrc | ERHIAccess::CopyDest
                                                       : ERHIAccess::Unknown) |
                (EnumHasAnyFlags(Texture->GetFlags(), ETextureCreateFlags::ShaderResource) ? ERHIAccess::SRVMask
                                                                                        : ERHIAccess::Unknown);
            return !EnumHasAnyFlags(Access, ~Allowed) &&
                EnumHasAnyFlags(Texture->GetFlags(), ETextureCreateFlags::DepthStencilTargetable);
        }
        const ERHIAccess Allowed =
            ERHIAccess::CopySrc | ERHIAccess::CopyDest |
            (EnumHasAnyFlags(Texture->GetFlags(), ETextureCreateFlags::Presentable) ? ERHIAccess::Present
                                                                                    : ERHIAccess::Unknown) |
            (EnumHasAnyFlags(Texture->GetFlags(), ETextureCreateFlags::RenderTargetable) ? ERHIAccess::RTV
                                                                                         : ERHIAccess::Unknown) |
            (EnumHasAnyFlags(Texture->GetFlags(), ETextureCreateFlags::ShaderResource) ? ERHIAccess::SRVMask
                                                                                       : ERHIAccess::Unknown) |
            (EnumHasAnyFlags(Texture->GetFlags(), ETextureCreateFlags::UAV) ? ERHIAccess::UAVMask
                                                                          : ERHIAccess::Unknown);
        return !EnumHasAnyFlags(Access, ~Allowed);
    }
    if (Resource->GetType() == RRT_Buffer)
    {
        const auto Usage = static_cast<FRHIBuffer *>(Resource)->GetUsage();
        const ERHIAccess Allowed =
            ERHIAccess::CopySrc | ERHIAccess::CopyDest |
            (EnumHasAnyFlags(Usage, BUF_DrawIndirect) ? ERHIAccess::IndirectArgs : ERHIAccess::Unknown) |
            (EnumHasAnyFlags(Usage, BUF_VertexBuffer | BUF_IndexBuffer) ? ERHIAccess::VertexOrIndexBuffer
                                                                        : ERHIAccess::Unknown) |
            (EnumHasAnyFlags(Usage, BUF_ShaderResource | BUF_StructuredBuffer | BUF_VertexBuffer)
                 ? ERHIAccess::SRVMask
                 : ERHIAccess::Unknown) |
            (EnumHasAnyFlags(Usage, BUF_UnorderedAccess) ? ERHIAccess::UAVMask : ERHIAccess::Unknown);
        return !EnumHasAnyFlags(Access, ~Allowed);
    }
    return false;
}

bool SupportedTransitionAccess(FRHIViewableResource* Resource, ERHIAccess Access)
{
    // RDG parks geometry buffers in its default SRVMask epilogue state even
    // without an SRV. Actual shader bindings still require ValidateBufferSRV.
    if (Resource && Resource->GetType() == RRT_Buffer && Access == ERHIAccess::SRVMask &&
        EnumHasAnyFlags(static_cast<FRHIBuffer*>(Resource)->GetUsage(), BUF_VertexBuffer | BUF_IndexBuffer))
        return true;
    return SupportedAccess(Resource, Access);
}
} // namespace

FWebGPUResourceState &FWebGPUDynamicRHI::ResourceState(FRHIViewableResource *Resource, uint32 Plane,
                                                      uint32 Mip, uint32 Slice) const
{
    check(Resource && (Resource->GetType() == RRT_Buffer || Resource->GetType() == RRT_Texture));
    if (Plane == 1)
    {
        check(Resource->GetType() == RRT_Texture &&
              static_cast<FRHITexture *>(Resource)->GetFormat() == PF_DepthStencil);
        return static_cast<FWebGPUTexture *>(Resource)->StencilState;
    }
    check(Plane == 0);
    if (Resource->GetType() == RRT_Texture && (Mip || Slice))
    {
        auto* Texture = static_cast<FWebGPUTexture*>(Resource);
        check(Mip < Texture->GetNumMips() && Slice < Texture->LayerCount());
        return Texture->SubresourceStates[Slice * Texture->GetNumMips() + Mip - 1];
    }
    return Resource->GetType() == RRT_Buffer ? static_cast<FWebGPUBuffer *>(Resource)->State
                                             : static_cast<FWebGPUTexture *>(Resource)->State;
}
bool FWebGPUDynamicRHI::ValidateAccess(FRHIViewableResource *Resource, ERHIAccess Access, FString &Error,
                                       bool InternalCopy, uint32 Plane, uint32 Mip, uint32 Slice) const
{
    if (!SupportedAccess(Resource, Access))
    {
        Error = TEXT("Resource capability does not support requested access");
        if (Resource && Resource->GetType() == RRT_Texture)
        {
            const auto* Texture = static_cast<const FWebGPUTexture*>(Resource);
            Error += FString::Printf(TEXT(": texture=%s format=%u flags=0x%llx access=0x%x surfaceActive=%d"),
                *Texture->GetName().ToString(), uint32(Texture->GetFormat()), uint64(Texture->GetFlags()),
                uint32(Access), int(Texture->SurfaceFrameActive));
        }
        return false;
    }
    if (Resource->GetType() == RRT_Buffer && static_cast<FWebGPUBuffer *>(Resource)->Locked)
    {
        Error = TEXT("Resource use while a CPU buffer lock is active");
        return false;
    }
    if (Resource->GetType() == RRT_Texture &&
        ((Mip == MAX_uint32 || Slice == MAX_uint32)
            ? !static_cast<FWebGPUTexture *>(Resource)->MipLocks.IsEmpty()
            : static_cast<FWebGPUTexture *>(Resource)->MipLocks.Contains(
                Mip * static_cast<FWebGPUTexture *>(Resource)->LayerCount() + Slice)))
    {
        Error = TEXT("Resource use while a CPU texture lock is active");
        return false;
    }
    if (InternalCopy && (Pass || (Access != ERHIAccess::CopySrc && Access != ERHIAccess::CopyDest)))
    {
        Error = TEXT("Internal upload/readback requires a copy outside a render pass");
        return false;
    }
    const auto* Texture = Resource->GetType() == RRT_Texture ? static_cast<FWebGPUTexture*>(Resource) : nullptr;
    const uint32 FirstMip = Mip == MAX_uint32 ? 0 : Mip;
    const uint32 LastMip = Mip == MAX_uint32 ? (Texture ? Texture->GetNumMips() : 1) : Mip + 1;
    const uint32 FirstSlice = Slice == MAX_uint32 ? 0 : Slice;
    const uint32 LastSlice = Slice == MAX_uint32 ? (Texture ? Texture->LayerCount() : 1) : Slice + 1;
    for (uint32 CurrentSlice = FirstSlice; CurrentSlice < LastSlice; ++CurrentSlice)
    for (uint32 CurrentMip = FirstMip; CurrentMip < LastMip; ++CurrentMip)
    {
        const bool ReadOnlyDepthSample = Texture &&
            (Texture->GetFormat() == PF_DepthStencil || Texture->GetFormat() == PF_ShadowDepth) &&
            Plane == 0 && PassDepthReadOnly && !EnumHasAnyFlags(Access, ~ERHIAccess::SRVMask);
        if (Texture && !ReadOnlyDepthSample &&
            IsRenderAttachment(static_cast<FWebGPUTexture*>(Resource), CurrentMip, CurrentSlice) &&
            Access != ERHIAccess::RTV && Access != ERHIAccess::DSVRead && Access != ERHIAccess::DSVWrite)
        {
            Error = FString::Printf(TEXT("Active attachment %s mip=%u slice=%u cannot be copied or sampled"),
                *Resource->GetName().ToString(), CurrentMip, CurrentSlice);
            return false;
        }
        const auto& State = ResourceState(Resource, Plane, CurrentMip, CurrentSlice);
        if (State.Pending)
        {
            Error = TEXT("Resource use between transition Begin and End");
            return false;
        }
        if (!InternalCopy && !EnumHasAllFlags(State.Access, Access))
        {
            Error = FString::Printf(TEXT("Resource %s mip=%u slice=%u access mismatch: current=0x%x requested=0x%x"),
                *Resource->GetName().ToString(), CurrentMip, CurrentSlice, uint32(State.Access), uint32(Access));
            return false;
        }
    }
    return true;
}
void FWebGPUDynamicRHI::RequireAccess(FRHIViewableResource *Resource, ERHIAccess Access, bool InternalCopy,
                                     uint32 Plane, uint32 Mip, uint32 Slice)
{
    RequireOwner();
    FString Error;
    checkf(ValidateAccess(Resource, Access, Error, InternalCopy, Plane, Mip, Slice), TEXT("%s"), *Error);
    ++AccessChecks;
}
bool FWebGPUDynamicRHI::ValidateTransitionCreate(const FRHITransitionCreateInfo &Info, FString &Error) const
{
    if (Info.SrcPipelines != ERHIPipeline::Graphics || Info.DstPipelines != ERHIPipeline::Graphics)
    {
        Error = TEXT("Only Graphics-to-Graphics transitions are implemented");
        return false;
    }
    if (EnumHasAnyFlags(Info.Flags, ~(ERHITransitionCreateFlags::NoFence | ERHITransitionCreateFlags::NoSplit |
                                    ERHITransitionCreateFlags::AllowDecayPipelines |
                                    ERHITransitionCreateFlags::AllowDuringRenderPass)) ||
        !Info.AliasingInfos.IsEmpty())
    {
        Error = FString::Printf(TEXT("Unsupported transition: flags=0x%x aliasing=%d resources=%d"),
            uint32(Info.Flags), Info.AliasingInfos.Num(), Info.TransitionInfos.Num());
        return false;
    }
    TSet<const FWebGPUResourceState *> Seen;
    // Empty same-queue barriers still participate in Begin/End lifetime tracking.
    // WebGPU submission order supplies their ordering without a resource barrier.
    for (const auto &Entry : Info.TransitionInfos)
    {
        if (Entry.Type != FRHITransitionInfo::EType::Buffer && Entry.Type != FRHITransitionInfo::EType::Texture &&
            Entry.Type != FRHITransitionInfo::EType::UAV)
        {
            Error = TEXT("Transition resource type is unsupported");
            return false;
        }
        auto *Resource = GetViewableResource(Entry);
        const bool Upload = IsBufferUploadTransition(Entry);
        if (EnumHasAnyFlags(Info.Flags, ERHITransitionCreateFlags::AllowDuringRenderPass) && !Upload)
        {
            Error = TEXT("AllowDuringRenderPass is limited to RDG buffer upload transitions outside an active pass");
            return false;
        }
        if (!Resource || (!Upload && !SupportedTransitionAccess(Resource, Entry.AccessAfter)) ||
            (Entry.AccessBefore != ERHIAccess::Unknown && !SupportedTransitionAccess(Resource, Entry.AccessBefore)))
        {
            Error = FString::Printf(TEXT("Unsupported transition resource=%s before=0x%x after=0x%x"),
                Resource ? *Resource->GetName().ToString() : TEXT("null"),
                uint32(Entry.AccessBefore), uint32(Entry.AccessAfter));
            return false;
        }
        const bool DepthStencil = Resource->GetType() == RRT_Texture &&
            static_cast<FRHITexture *>(Resource)->GetFormat() == PF_DepthStencil;
        const auto* Texture = Resource->GetType() == RRT_Texture ? static_cast<FWebGPUTexture*>(Resource) : nullptr;
        const uint32 Mips = Texture ? Texture->GetNumMips() : 1;
        const uint32 Slices = Texture ? Texture->LayerCount() : 1;
        if ((!Upload && Entry.Flags != EResourceTransitionFlags::None) || Entry.CommitInfo.IsSet() ||
            (!Entry.IsAllMips() && Entry.MipIndex >= Mips) ||
            (!Entry.IsAllArraySlices() && Entry.ArraySlice >= Slices) ||
            (Entry.PlaneSlice != 0 && !Entry.IsAllPlaneSlices() && !(DepthStencil && Entry.PlaneSlice == 1)))
        {
            Error = FString::Printf(TEXT("Unsupported transition range: flags=0x%x commit=%d mip=%u array=%u plane=%u"),
                uint32(Entry.Flags), Entry.CommitInfo.IsSet(), Entry.MipIndex, Entry.ArraySlice, Entry.PlaneSlice);
            return false;
        }
        const uint32 FirstPlane = Entry.PlaneSlice == 1 ? 1 : 0;
        const uint32 LastPlane = DepthStencil && Entry.IsAllPlaneSlices() ? 1 : FirstPlane;
        const uint32 FirstMip = Entry.IsAllMips() ? 0 : Entry.MipIndex;
        const uint32 LastMip = Entry.IsAllMips() ? Mips : FirstMip + 1;
        const uint32 FirstSlice = Entry.IsAllArraySlices() ? 0 : Entry.ArraySlice;
        const uint32 LastSlice = Entry.IsAllArraySlices() ? Slices : FirstSlice + 1;
        for (uint32 Slice = FirstSlice; Slice < LastSlice; ++Slice)
        for (uint32 Mip = FirstMip; Mip < LastMip; ++Mip)
        for (uint32 Plane = FirstPlane; Plane <= LastPlane; ++Plane)
        {
            const auto *State = &ResourceState(Resource, Plane, Mip, Slice);
            if (Seen.Contains(State))
            {
                Error = TEXT("Transition batch contains the same resource plane more than once");
                return false;
            }
            Seen.Add(State);
        }
    }
    return true;
}
bool FWebGPUDynamicRHI::ValidateTransitionBatch(TArrayView<const FRHITransition *> Batch, bool Begin,
                                                FString &Error) const
{
    if (!ContextOpen || !Encoder || Pass || Batch.IsEmpty())
    {
        Error = TEXT("Transition requires an open context outside a render pass");
        return false;
    }
    TSet<const FWebGPUResourceState *> Seen;
    for (const auto *Transition : Batch)
    {
        const auto *Found = Transitions.Find(Transition);
        if (!Found || !Found->IsValid() ||
            (*Found)->Stage != (Begin ? FWebGPUTransitionData::EStage::Created : FWebGPUTransitionData::EStage::Begun))
        {
            Error = TEXT("Transition is missing or Begin/End lifecycle order is invalid");
            return false;
        }
        for (const auto &Entry : (*Found)->Infos)
        {
            auto *Resource = GetViewableResource(Entry);
            const auto &State = ResourceState(Resource, Entry.PlaneSlice, Entry.MipIndex, Entry.ArraySlice);
            if (Resource->GetType() == RRT_Buffer && static_cast<FWebGPUBuffer *>(Resource)->Locked)
            {
                Error = TEXT("Transition while a CPU buffer lock is active");
                return false;
            }
            if (Resource->GetType() == RRT_Texture &&
                !static_cast<FWebGPUTexture *>(Resource)->MipLocks.IsEmpty())
            {
                Error = TEXT("Transition while a CPU texture lock is active");
                return false;
            }
            if (Seen.Contains(&State) || (Begin ? State.Pending != nullptr : State.Pending != Transition))
            {
                Error = TEXT("Transition resource is already pending or has another owner");
                return false;
            }
            if (Begin && Entry.AccessBefore != ERHIAccess::Unknown && Entry.AccessBefore != State.Access)
            {
                Error = TEXT("Transition AccessBefore does not match the tracked resource state");
                return false;
            }
            Seen.Add(&State);
        }
    }
    return true;
}
bool FWebGPUDynamicRHI::ValidateTransitionRelease(const FRHITransition *Transition, FString &Error) const
{
    const auto *Found = Transitions.Find(Transition);
    if (!Found || !Found->IsValid() || (*Found)->Stage != FWebGPUTransitionData::EStage::Ended)
    {
        Error = TEXT("Transition release requires a completed End");
        return false;
    }
    return true;
}
void FWebGPUDynamicRHI::RHICreateTransition(FRHITransition *Transition, const FRHITransitionCreateInfo &Info)
{
    RequireOwner();
    FString Error;
    checkf(Transition && !Transitions.Contains(Transition) && ValidateTransitionCreate(Info, Error), TEXT("%s"),
           *Error);
    auto Data = MakeShared<FWebGPUTransitionData>();
    for (const auto& Source : Info.TransitionInfos)
    {
        // WebGPU orders staging copies automatically. These temporary upload barriers
        // explicitly preserve the logical access state and can bracket CPU buffer locks.
        if (IsBufferUploadTransition(Source))
        {
            Data->References.Add(Source.Resource);
            continue;
        }
        const auto *Resource = GetViewableResource(Source);
        const bool BothPlanes = Resource->GetType() == RRT_Texture &&
            static_cast<const FRHITexture *>(Resource)->GetFormat() == PF_DepthStencil && Source.IsAllPlaneSlices();
        const auto* Texture = Resource->GetType() == RRT_Texture ? static_cast<const FWebGPUTexture*>(Resource) : nullptr;
        const uint32 FirstMip = Source.IsAllMips() ? 0 : Source.MipIndex;
        const uint32 LastMip = Source.IsAllMips() ? (Texture ? Texture->GetNumMips() : 1) : FirstMip + 1;
        const uint32 FirstSlice = Source.IsAllArraySlices() ? 0 : Source.ArraySlice;
        const uint32 LastSlice = Source.IsAllArraySlices() ?
            (Texture ? Texture->LayerCount() : 1) : FirstSlice + 1;
        for (uint32 Slice = FirstSlice; Slice < LastSlice; ++Slice)
        for (uint32 Mip = FirstMip; Mip < LastMip; ++Mip)
        {
            auto Entry = Source;
            Entry.MipIndex = Mip;
            Entry.ArraySlice = Slice;
            Entry.PlaneSlice = Source.PlaneSlice == 1 ? 1 : 0;
            Data->Infos.Add(Entry);
            if (BothPlanes)
            {
                Entry.PlaneSlice = 1;
                Data->Infos.Add(Entry);
            }
        }
    }
    for (const auto &Entry : Data->Infos)
        Data->References.Add(Entry.Resource);
    Transitions.Add(Transition, MoveTemp(Data));
    if (GlobalProbeMode)
    {
        check(GDynamicRHI == this);
        new (Transition->GetPrivateData<FWebGPUTransitionPrivateData>())
            FWebGPUTransitionPrivateData{Transitions.FindChecked(Transition)};
    }
    ++TransitionsCreated;
}
void FWebGPUDynamicRHI::RHIBeginTransitions(TArrayView<const FRHITransition *> Batch)
{
    RequireOwner();
    if (GlobalProbeMode && !ContextOpen)
        RHIGetCommandContext(ERHIPipeline::Graphics);
    FString Error;
    checkf(ValidateTransitionBatch(Batch, true, Error), TEXT("%s"), *Error);
    for (const auto *Transition : Batch)
    {
        auto &Data = *Transitions.FindChecked(Transition);
        for (const auto &Entry : Data.Infos)
            ResourceState(GetViewableResource(Entry), Entry.PlaneSlice, Entry.MipIndex, Entry.ArraySlice).Pending = Transition;
        Data.Stage = FWebGPUTransitionData::EStage::Begun;
        ++TransitionsBegun;
    }
}
void FWebGPUDynamicRHI::RHIEndTransitions(TArrayView<const FRHITransition *> Batch)
{
    RequireOwner();
    if (GlobalProbeMode && !ContextOpen)
        RHIGetCommandContext(ERHIPipeline::Graphics);
    FString Error;
    checkf(ValidateTransitionBatch(Batch, false, Error), TEXT("%s"), *Error);
    for (const auto *Transition : Batch)
    {
        auto &Data = *Transitions.FindChecked(Transition);
        for (const auto &Entry : Data.Infos)
        {
            auto &State = ResourceState(GetViewableResource(Entry), Entry.PlaneSlice, Entry.MipIndex, Entry.ArraySlice);
            State.Access = Entry.AccessAfter;
            State.Pending = nullptr;
        }
        Data.Stage = FWebGPUTransitionData::EStage::Ended;
        ++TransitionsEnded;
    }
}
void FWebGPUDynamicRHI::RHIReleaseTransition(FRHITransition *Transition)
{
    RequireOwner();
    FString Error;
    checkf(ValidateTransitionRelease(Transition, Error), TEXT("%s"), *Error);
    if (GlobalProbeMode)
    {
        check(GDynamicRHI == this);
        auto *Storage = Transition->GetPrivateData<FWebGPUTransitionPrivateData>();
        check(Storage->Data == Transitions.FindChecked(Transition));
        Storage->~FWebGPUTransitionPrivateData();
    }
    Transitions.Remove(Transition);
    ++TransitionsReleased;
}
bool FWebGPUDynamicRHI::ValidateSubmissionOrder(TConstArrayView<IRHIPlatformCommandList *> Lists, FString &Error) const
{
    uint32 Expected = Submitted + 1;
    for (auto *List : Lists)
    {
        if (!List || static_cast<FWebGPUCommandList *>(List)->Serial != Expected++)
        {
            Error = TEXT("Single-context tracked states require submission in recording order");
            return false;
        }
    }
    return true;
}
bool FWebGPUDynamicRHI::ValidatePipelineDepth(const FGraphicsPipelineStateInitializer &Initializer,
                                              FString &Error) const
{
    FDepthStencilStateInitializerRHI Depth;
    if (!Initializer.DepthStencilState || !Initializer.DepthStencilState->GetInitializer(Depth))
    {
        Error = TEXT("Depth state initializer is unavailable");
        return false;
    }
    if (PassDepthReadOnly && Depth.bEnableDepthWrite)
    {
        Error = TEXT("Depth-writing pipeline cannot use a read-only depth attachment");
        return false;
    }
    return true;
}
