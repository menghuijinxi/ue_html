#include "WebGPUDynamicRHI.h"

namespace
{
bool CanDiscardBuffer(FRHIBuffer* Buffer, uint32 Offset, EResourceLockMode Mode)
{
    return Buffer && Mode == RLM_WriteOnly && Offset == 0 &&
        EnumHasAnyFlags(Buffer->GetUsage(), EBufferUsageFlags::Volatile) &&
        !EnumHasAnyFlags(Buffer->GetUsage(), EBufferUsageFlags::UnorderedAccess);
}
}

bool FWebGPUDynamicRHI::ValidateBufferLock(FRHIBuffer *Buffer, uint32 Offset, uint32 Size, EResourceLockMode Mode,
                                           FString &Error) const
{
    if (!Buffer || Buffer->GetType() != RRT_Buffer)
    {
        Error = TEXT("Buffer lock requires a buffer");
        return false;
    }
    if (Mode != RLM_WriteOnly && Mode != RLM_ReadOnly)
    {
        Error = TEXT("Only WriteOnly and synchronous native ReadOnly locks are implemented");
        return false;
    }
    if (!Size || Size > MAX_int32 || Offset % 4 || Size % 4 || uint64(Offset) + Size > Buffer->GetSize())
    {
        Error = FString::Printf(TEXT("Buffer lock requires a nonempty four-byte-aligned in-bounds range: name=%s offset=%u size=%u capacity=%u mode=%u"),
            *Buffer->GetName().ToString(), Offset, Size, Buffer->GetSize(), uint32(Mode));
        return false;
    }
    if (BufferLocks.Contains(Buffer) || static_cast<FWebGPUBuffer *>(Buffer)->Locked)
    {
        Error = TEXT("Buffer already has an active lock");
        return false;
    }
    if (Pass && CanDiscardBuffer(Buffer, Offset, Mode))
        return ValidateAccess(Buffer, static_cast<FWebGPUBuffer*>(Buffer)->State.Access, Error);
    return ValidateAccess(Buffer, Mode == RLM_ReadOnly ? ERHIAccess::CopySrc : ERHIAccess::CopyDest, Error, true);
}

bool FWebGPUDynamicRHI::ValidateBufferUnlock(FRHIBuffer *Buffer, FString &Error) const
{
    const auto *Lock = BufferLocks.Find(Buffer);
    if (!Lock || !Lock->Buffer->Locked)
    {
        Error = TEXT("Buffer unlock requires a matching active lock");
        return false;
    }
    if ((Pass && !CanDiscardBuffer(Buffer, Lock->Offset, Lock->Mode)) || Lock->Buffer->State.Pending)
    {
        Error = TEXT("Buffer unlock is forbidden inside a render pass or split transition");
        return false;
    }
    return true;
}

void *FWebGPUDynamicRHI::LockBuffer_BottomOfPipe(FRHICommandListBase & WebArg0, FRHIBuffer *Buffer, uint32 Offset, uint32 Size, EResourceLockMode Mode)
{
    WEBGPU_COMMAND_ON_OWNER(LockBuffer_BottomOfPipe(WebArg0, Buffer, Offset, Size, Mode));
    RequireOwner();
    if (StartupProbeMode && EndFrames == 0 && Buffer)
        UE_LOG(LogRHI, Display, TEXT("P2_STARTUP BufferLock requested name=%s offset=%u size=%u mode=%u"),
               *Buffer->GetName().ToString(), Offset, Size, uint32(Mode));
    FString Error;
    checkf(ValidateBufferLock(Buffer, Offset, Size, Mode, Error),
        TEXT("WebGPU BufferLock unsupported: name=%s offset=%u size=%u mode=%u: %s"),
        Buffer ? *Buffer->GetName().ToString() : TEXT("<null>"), Offset, Size, uint32(Mode), *Error);
    FWebGPUBufferLock Lock;
    Lock.Buffer = static_cast<FWebGPUBuffer *>(Buffer);
    Lock.Offset = Offset;
    Lock.Mode = Mode;
    if (Mode == RLM_ReadOnly)
    {
        // ReadBuffer submits earlier encoded work; no CPU shadow can represent intervening GPU writes.
        auto Bytes = ReadBuffer(Buffer, uint64(Offset) + Size);
        check(Bytes.Num() == uint64(Offset) + Size);
        Lock.Bytes.Append(Bytes.GetData() + Offset, Size);
        ++BufferReadLocks;
    }
    else
        Lock.Bytes.SetNumUninitialized(Size);
    Lock.Buffer->Locked = true;
    ++BindingStateSerial;
    auto &Stored = BufferLocks.Add(Buffer, MoveTemp(Lock));
    ++BufferLocksCreated;
    return Stored.Bytes.GetData();
}

void FWebGPUDynamicRHI::UnlockBuffer_BottomOfPipe(FRHICommandListBase & WebArg0, FRHIBuffer *Buffer)
{
    WEBGPU_COMMAND_ON_OWNER(UnlockBuffer_BottomOfPipe(WebArg0, Buffer));
    RequireOwner();
    FString Error;
    checkf(ValidateBufferUnlock(Buffer, Error), TEXT("WebGPU BufferUnlock unsupported: %s"), *Error);
    auto Lock = MoveTemp(BufferLocks.FindChecked(Buffer));
    BufferLocks.Remove(Buffer);
    Lock.Buffer->Locked = false;
    ++BindingStateSerial;
    if (!ContextOpen)
        RHIGetCommandContext(ERHIPipeline::Graphics);
    if (Lock.Mode == RLM_WriteOnly)
    {
        if (Pass)
        {
            // Volatile writes discard old contents. Previously encoded draws retain the old handle.
            FlushDrawBundles();
            ResetEncoderBindings();
            auto Previous = Lock.Buffer->Handle;
            Lock.Buffer->Handle = CreateBuffer(Lock.Buffer->GetSize(), wgpuBufferGetUsage(Previous));
            wgpuQueueWriteBuffer(Queue, Lock.Buffer->Handle, 0, Lock.Bytes.GetData(), Lock.Bytes.Num());
            wgpuBufferRelease(Previous);
        }
        else
        {
            // Each upload keeps a unique source slice until every frame encoder is submitted.
            uint64 UploadOffset = 0;
            auto Staging = UploadStagingBytes(Lock.Bytes.GetData(), Lock.Bytes.Num(), UploadOffset);
            EndComputePass();
            wgpuCommandEncoderCopyBufferToBuffer(Encoder, Staging, UploadOffset, Lock.Buffer->Handle, Lock.Offset, Lock.Bytes.Num());
            wgpuBufferRelease(Staging);
        }
        ++BufferUploads;
        BufferUploadBytes += Lock.Bytes.Num();
    }
    ++BufferLocksReleased;
    if (StartupProbeMode && EndFrames == 0)
        UE_LOG(LogRHI, Display, TEXT("P2_STARTUP BufferLock released name=%s offset=%u size=%d mode=%u"),
               *Buffer->GetName().ToString(), Lock.Offset, Lock.Bytes.Num(), uint32(Lock.Mode));
}
