#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <cstdio>

struct FStaticNameMapEntry
{
    const wchar_t* Name;
    const wchar_t* Platform;
    int Enum;
};

int wmain(int argc, wchar_t** argv)
{
    if (argc != 2)
        return 2;
    HMODULE Module = LoadLibraryExW(argv[1], nullptr, LOAD_WITH_ALTERED_SEARCH_PATH);
    if (!Module)
    {
        std::fprintf(stderr, "LoadLibrary failed: %lu\n", GetLastError());
        return 3;
    }
    const auto* Entries = reinterpret_cast<const FStaticNameMapEntry*>(
        GetProcAddress(Module, "?GStaticShaderNames@@3PAUFStaticNameMapEntry@@A"));
    if (!Entries)
        return 4;
    std::printf("{\"entries\":[");
    for (int Index = 0; Entries[Index].Name; ++Index)
    {
        if (Index >= 16)
            return 5;
        std::printf("%s{\"name\":\"%ls\",\"platform\":\"%ls\",\"index\":%d}",
                    Index ? "," : "", Entries[Index].Name, Entries[Index].Platform, Entries[Index].Enum);
    }
    using FGetInt = int (*)();
    using FGetU64 = unsigned long long (*)();
    const auto GetMajor = reinterpret_cast<FGetInt>(GetProcAddress(Module, "?GetEngineVersionMajor@BuildSettings@@YAHXZ"));
    const auto GetMinor = reinterpret_cast<FGetInt>(GetProcAddress(Module, "?GetEngineVersionMinor@BuildSettings@@YAHXZ"));
    const auto GetPatch = reinterpret_cast<FGetInt>(GetProcAddress(Module, "?GetEngineVersionHotfix@BuildSettings@@YAHXZ"));
    const auto GetChangelist = reinterpret_cast<FGetInt>(GetProcAddress(Module, "?GetCurrentChangelist@BuildSettings@@YAHXZ"));
    const auto GetReserve = reinterpret_cast<FGetU64>(GetProcAddress(Module, "?GetPersistentAllocatorReserveSize@BuildSettings@@YA_KXZ"));
    if (!GetMajor || !GetMinor || !GetPatch || !GetChangelist || !GetReserve)
        return 6;
    std::printf("],\"major\":%d,\"minor\":%d,\"patch\":%d,\"changelist\":%d,\"persistentReserve\":%llu}\n",
                GetMajor(), GetMinor(), GetPatch(), GetChangelist(), GetReserve());
    FreeLibrary(Module);
    return 0;
}
