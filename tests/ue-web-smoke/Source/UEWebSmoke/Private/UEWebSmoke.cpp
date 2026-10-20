#include "CoreMinimal.h"
#include "HAL/PlatformFile.h"
#include "HAL/PlatformMemory.h"
#include "HAL/PlatformProcess.h"
#include "Math/Transform.h"
#include <cstdio>

TCHAR GInternalProjectName[64] = TEXT("UEWebSmoke");

template<typename T>
bool CheckRegisterTransform()
{
    using Vector = UE::Math::TVector<T>;
    using Quat = UE::Math::TQuat<T>;
    using Transform = UE::Math::TTransform<T>;
    const T HalfSqrt = T(0.7071067811865475244);
    const T Tolerance = T(0.0001);
    const Transform Scaled(Quat(T(0), T(0), HalfSqrt, HalfSqrt),
        Vector(T(10), T(20), T(30)), Vector(T(2), T(3), T(4)));
    const Vector Point(T(1), T(2), T(3));
    const Vector Expected(T(4), T(22), T(42));
    const Transform Registers(
        MakeVectorRegister(T(0), T(0), HalfSqrt, HalfSqrt),
        MakeVectorRegister(T(10), T(20), T(30), T(0)),
        MakeVectorRegister(T(2), T(3), T(4), T(0)));
    const Transform Translation(Quat(T(0), T(0), T(0), T(1)),
        Vector(T(7), T(-5), T(2)), Vector(T(1), T(1), T(1)));
    const Transform Uniform(Quat(T(0), T(0), HalfSqrt, HalfSqrt),
        Vector(T(10), T(20), T(30)), Vector(T(2), T(2), T(2)));
    return Scaled.TransformPosition(Point).Equals(Expected, Tolerance) &&
        Registers.TransformPosition(Point).Equals(Expected, Tolerance) &&
        Scaled.InverseTransformPosition(Expected).Equals(Point, Tolerance) &&
        Uniform.Inverse().TransformPosition(Uniform.TransformPosition(Point)).Equals(Point, Tolerance) &&
        (Scaled * Translation).TransformPosition(Point).Equals(
            Translation.TransformPosition(Expected), Tolerance);
}

bool CheckArithmeticShift()
{
    const auto Input = MakeVectorRegisterInt(-3, -2147483647 - 1, 7, 2147483647);
    const auto Identity = VectorShiftRightImmArithmetic(Input, 0);
    const auto Half = VectorShiftRightImmArithmetic(Input, 1);
    const auto Sign = VectorShiftRightImmArithmetic(Input, 31);
    const auto Saturated = VectorShiftRightImmArithmetic(Input, 32);
    const auto Large = VectorShiftRightImmArithmetic(Input, 255);
    int32 Restored[4];
    VectorIntStore(Half, Restored);
    return Identity.V[0] == -3 && Identity.V[1] == (-2147483647 - 1) &&
        Identity.V[2] == 7 && Identity.V[3] == 2147483647 &&
        Restored[0] == -2 && Restored[1] == -1073741824 &&
        Restored[2] == 3 && Restored[3] == 1073741823 &&
        Sign.V[0] == -1 && Sign.V[1] == -1 && Sign.V[2] == 0 && Sign.V[3] == 0 &&
        FMemory::Memcmp(&Sign, &Saturated, sizeof(Sign)) == 0 &&
        FMemory::Memcmp(&Sign, &Large, sizeof(Sign)) == 0;
}

int main()
{
    bool Pass = true;
    int Groups = 0;
    auto Check = [&](bool Result, const char* Name)
    {
        ++Groups;
        if (!Result)
        {
            std::printf("P3_CORE_PROGRAM_FAILED %s\n", Name);
            Pass = false;
        }
    };

    uint64 ArraySum = 0;
    {
        TArray<uint32> Values;
        for (uint32 Index = 0; Index < 4096; ++Index)
        {
            Values.Add(Index * 3 + 7);
            ArraySum += Values.Last();
        }
        Values.Reserve(8192);
        Values.RemoveAt(0, 128, EAllowShrinking::No);
        Values.Shrink();
        const bool ArrayPass = Values.Num() == 3968 && Values[0] == 391 &&
            Values.Last() == 12292 && ArraySum == 25188352;
        Values.Empty();
        Check(ArrayPass && Values.Num() == 0 && Values.GetAllocatedSize() == 0, "array");
    }

    {
        uint8* Bytes = static_cast<uint8*>(FMemory::Malloc(257, 64));
        FMemory::Memset(Bytes, 0x5a, 257);
        Bytes = static_cast<uint8*>(FMemory::Realloc(Bytes, 8193, 64));
        bool AllocationPass = reinterpret_cast<UPTRINT>(Bytes) % 64 == 0;
        for (int Index = 0; Index < 257; ++Index) AllocationPass &= Bytes[Index] == 0x5a;
        FMemory::Free(Bytes);
        Check(AllocationPass, "aligned-realloc");
    }

    {
        const auto& Constants = FPlatformMemory::GetConstants();
        void* Pages = FPlatformMemory::BinnedAllocFromOS(65537);
        const bool PagePass = Pages && Constants.PageSize == 65536 &&
            reinterpret_cast<UPTRINT>(Pages) % Constants.PageSize == 0;
        if (Pages)
        {
            static_cast<uint8*>(Pages)[65536] = 0x7e;
            FPlatformMemory::BinnedFreeToOS(Pages, 65537);
        }
        Check(PagePass, "page-allocation");
    }

    {
        IPlatformFile& Files = IPlatformFile::GetPlatformPhysical();
        const TCHAR* Directory = TEXT("/ue-web-smoke");
        const TCHAR* Filename = TEXT("/ue-web-smoke/\u573a\u666f.bin");
        const TCHAR* MovedFilename = TEXT("/ue-web-smoke/moved.bin");
        const uint8 Payload[] = {0, 1, 127, 128, 254, 255};
        bool FilePass = Files.Initialize(nullptr, TEXT("")) && Files.CreateDirectory(Directory);
        {
            TUniquePtr<IFileHandle> Writer(Files.OpenWrite(Filename));
            FilePass &= Writer && Writer->Write(Payload, sizeof(Payload)) && Writer->Flush();
        }
        FilePass &= Files.FileExists(Filename) && Files.FileSize(Filename) == sizeof(Payload);
        {
            TUniquePtr<IFileHandle> Reader(Files.OpenRead(Filename));
            uint8 Restored[sizeof(Payload)]{};
            FilePass &= Reader && Reader->Read(Restored, sizeof(Restored)) &&
                FMemory::Memcmp(Payload, Restored, sizeof(Payload)) == 0;
        }
        FilePass &= Files.MoveFile(MovedFilename, Filename) && !Files.FileExists(Filename) &&
            Files.FileExists(MovedFilename) && Files.DeleteFile(MovedFilename) &&
            Files.DeleteDirectory(Directory);
        Check(FilePass, "memfs-file");
    }

    Check(FCString::Strcmp(FPlatformProcess::BaseDir(), TEXT("/")) == 0 &&
        !FPlatformProcess::SupportsMultithreading(), "platform-mode");
    static_assert(ENABLE_VECTORIZED_TRANSFORM && !PLATFORM_ENABLE_VECTORINTRINSICS);
    Check(CheckArithmeticShift() && CheckRegisterTransform<float>() && CheckRegisterTransform<double>() &&
        FTransform3d(FQuat4d(0, 0, 0, 1), FVector3d(8589934602.0, 20, 30),
            FVector3d(1, 1, 1)).TransformPosition(FVector3d(1, 2, 3)).Equals(
                FVector3d(8589934603.0, 22, 33), 0.000001), "register-transform-fpu");
    std::printf("P3_WEB_CORE_PROGRAM_RESULT {\"pointerBytes\":%zu,\"arraySum\":%llu,\"groups\":%d,\"pass\":%s}\n",
        sizeof(void*), static_cast<unsigned long long>(ArraySum), Groups, Pass ? "true" : "false");
    return Pass ? 0 : 1;
}
