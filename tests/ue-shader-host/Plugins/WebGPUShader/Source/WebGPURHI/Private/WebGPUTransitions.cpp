#include "WebGPUDynamicRHI.h"

namespace
{
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
        if (Texture->GetFormat() == PF_DepthStencil)
        {
            const ERHIAccess Allowed = ERHIAccess::DSVRead | ERHIAccess::DSVWrite |
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
                                                                                       : ERHIAccess::Unknown);
        return !EnumHasAnyFlags(Access, ~Allowed);
    }
    if (Resource->GetType() == RRT_Buffer)
    {
        const auto Usage = static_cast<FRHIBuffer *>(Resource)->GetUsage();
        const ERHIAccess Allowed =
            ERHIAccess::CopySrc | ERHIAccess::CopyDest |
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
} // namespace

FWebGPUResourceState &FWebGPUDynamicRHI::ResourceState(FRHIViewableResource *Resource) const
{
    check(Resource && (Resource->GetType() == RRT_Buffer || Resource->GetType() == RRT_Texture));
    return Resource->GetType() == RRT_Buffer ? static_cast<FWebGPUBuffer *>(Resource)->State
                                             : static_cast<FWebGPUTexture *>(Resource)->State;
}
bool FWebGPUDynamicRHI::ValidateAccess(FRHIViewableResource *Resource, ERHIAccess Access, FString &Error,
                                       bool InternalCopy) const
{
    if (!SupportedAccess(Resource, Access))
    {
        Error = TEXT("Resource capability does not support requested access");
        return false;
    }
    const auto &State = ResourceState(Resource);
    if (Resource->GetType() == RRT_Buffer && static_cast<FWebGPUBuffer *>(Resource)->Locked)
    {
        Error = TEXT("Resource use while a CPU buffer lock is active");
        return false;
    }
    if (Resource->GetType() == RRT_Texture && static_cast<FWebGPUTexture *>(Resource)->LockedMip != MAX_uint32)
    {
        Error = TEXT("Resource use while a CPU texture lock is active");
        return false;
    }
    if (State.Pending)
    {
        Error = TEXT("Resource use between transition Begin and End");
        return false;
    }
    if (Resource->GetType() == RRT_Texture && Attachments.Contains(static_cast<FWebGPUTexture *>(Resource)) &&
        Access != ERHIAccess::RTV && Access != ERHIAccess::DSVRead && Access != ERHIAccess::DSVWrite)
    {
        Error = TEXT("Active render attachment cannot be copied or sampled");
        return false;
    }
    if (InternalCopy && (Pass || (Access != ERHIAccess::CopySrc && Access != ERHIAccess::CopyDest)))
    {
        Error = TEXT("Internal upload/readback requires a copy outside a render pass");
        return false;
    }
    if (!InternalCopy && !EnumHasAllFlags(State.Access, Access))
    {
        Error = FString::Printf(TEXT("Resource access mismatch: current=0x%x requested=0x%x"), uint32(State.Access),
                                uint32(Access));
        return false;
    }
    return true;
}
void FWebGPUDynamicRHI::RequireAccess(FRHIViewableResource *Resource, ERHIAccess Access, bool InternalCopy)
{
    RequireOwner();
    FString Error;
    checkf(ValidateAccess(Resource, Access, Error, InternalCopy), TEXT("%s"), *Error);
    ++AccessChecks;
}
bool FWebGPUDynamicRHI::ValidateTransitionCreate(const FRHITransitionCreateInfo &Info, FString &Error) const
{
    if (Info.SrcPipelines != ERHIPipeline::Graphics || Info.DstPipelines != ERHIPipeline::Graphics)
    {
        Error = TEXT("Only Graphics-to-Graphics transitions are implemented");
        return false;
    }
    if (EnumHasAnyFlags(Info.Flags, ~(ERHITransitionCreateFlags::NoFence | ERHITransitionCreateFlags::NoSplit)) ||
        !Info.AliasingInfos.IsEmpty() || Info.TransitionInfos.IsEmpty())
    {
        Error = TEXT("Transition flags, aliasing or empty transition batch are unsupported");
        return false;
    }
    TSet<FRHIViewableResource *> Seen;
    for (const auto &Entry : Info.TransitionInfos)
    {
        if (Entry.Type != FRHITransitionInfo::EType::Buffer && Entry.Type != FRHITransitionInfo::EType::Texture &&
            Entry.Type != FRHITransitionInfo::EType::UAV)
        {
            Error = TEXT("Transition resource type is unsupported");
            return false;
        }
        auto *Resource = GetViewableResource(Entry);
        if (!Resource || !SupportedAccess(Resource, Entry.AccessAfter) ||
            (Entry.AccessBefore != ERHIAccess::Unknown && !SupportedAccess(Resource, Entry.AccessBefore)))
        {
            Error = TEXT("Transition access or resource capability is unsupported");
            return false;
        }
        if (Entry.Flags != EResourceTransitionFlags::None || Entry.CommitInfo.IsSet() ||
            (Entry.MipIndex != 0 && !Entry.IsAllMips()) || (Entry.ArraySlice != 0 && !Entry.IsAllArraySlices()) ||
            (Entry.PlaneSlice != 0 && !Entry.IsAllPlaneSlices()))
        {
            Error = TEXT("Transition flags, commit or subresource range are unsupported");
            return false;
        }
        if (Seen.Contains(Resource))
        {
            Error = TEXT("Transition batch contains the same resource more than once");
            return false;
        }
        Seen.Add(Resource);
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
    TSet<FRHIViewableResource *> Seen;
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
            const auto &State = ResourceState(Resource);
            if (Resource->GetType() == RRT_Buffer && static_cast<FWebGPUBuffer *>(Resource)->Locked)
            {
                Error = TEXT("Transition while a CPU buffer lock is active");
                return false;
            }
            if (Resource->GetType() == RRT_Texture &&
                static_cast<FWebGPUTexture *>(Resource)->LockedMip != MAX_uint32)
            {
                Error = TEXT("Transition while a CPU texture lock is active");
                return false;
            }
            if (Seen.Contains(Resource) || (Begin ? State.Pending != nullptr : State.Pending != Transition))
            {
                Error = TEXT("Transition resource is already pending or has another owner");
                return false;
            }
            if (Begin && Entry.AccessBefore != ERHIAccess::Unknown && Entry.AccessBefore != State.Access)
            {
                Error = TEXT("Transition AccessBefore does not match the tracked resource state");
                return false;
            }
            Seen.Add(Resource);
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
    Data->Infos.Append(Info.TransitionInfos);
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
            ResourceState(GetViewableResource(Entry)).Pending = Transition;
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
            auto &State = ResourceState(GetViewableResource(Entry));
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
