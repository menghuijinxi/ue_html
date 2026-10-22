#include <windows.h>
#include <dxcapi.h>
#include <wrl/client.h>
#include <algorithm>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

using Microsoft::WRL::ComPtr;

int wmain(int argc, wchar_t** argv)
{
    if (argc < 4) {
        std::cerr << "Usage: dxc-batch <dxcompiler.dll> <HLSL directory> <rounds> [file index] [new|reuse] [affinity mask]\n";
        return 2;
    }
    if (argc > 6) {
        const DWORD_PTR mask = static_cast<DWORD_PTR>(std::stoull(argv[6], nullptr, 0));
        if (mask && !SetProcessAffinityMask(GetCurrentProcess(), mask)) return 6;
    }
    HMODULE module = LoadLibraryExW(argv[1], nullptr, LOAD_WITH_ALTERED_SEARCH_PATH);
    auto create = module ? reinterpret_cast<DxcCreateInstanceProc>(
        GetProcAddress(module, "DxcCreateInstance")) : nullptr;
    ComPtr<IDxcCompiler3> compiler;
    if (!create || FAILED(create(CLSID_DxcCompiler, IID_PPV_ARGS(&compiler)))) return 3;
    std::vector<std::filesystem::path> files;
    for (const auto& entry : std::filesystem::directory_iterator(argv[2]))
        if (entry.path().extension() == ".hlsl" &&
            (argc < 5 || _wtoi(argv[4]) < 0 ||
                std::stoi(entry.path().filename().wstring()) == _wtoi(argv[4])))
            files.push_back(entry.path());
    std::sort(files.begin(), files.end(), [](const auto& a, const auto& b) {
        return std::stoi(a.filename().wstring()) < std::stoi(b.filename().wstring());
    });
    if (files.empty()) return 4;
    for (int round = 0; round < _wtoi(argv[3]); ++round) {
        for (const auto& file : files) {
            if (argc > 5 && std::wstring(argv[5]) == L"new") {
                compiler.Reset();
                if (FAILED(create(CLSID_DxcCompiler, IID_PPV_ARGS(&compiler)))) return 3;
            }
            std::ifstream input(file, std::ios::binary);
            const std::string text{std::istreambuf_iterator<char>(input), {}};
            const auto name = file.filename().wstring();
            const auto dash = name.find(L'-');
            const auto profile = name.substr(dash + 1, name.size() - dash - 6);
            const auto entryAt = text.find("dawn_entry_point_");
            if (entryAt == std::string::npos || profile.size() != 6) return 7;
            const auto entryEnd = text.find_first_not_of("abcdefghijklmnopqrstuvwxyz0123456789_", entryAt);
            const std::wstring entry(text.begin() + entryAt, text.begin() + entryEnd);
            const wchar_t* args[] = {
                L"-T", profile.c_str(), L"-E", entry.c_str(),
                L"-HV", L"2021", L"-O3", L"-Gis", L"-Zpr",
                L"-opt-disable", L"structurize-loop-exits-for-unroll"
            };
            std::wcout << L"[dxc-host] " << round << L" " << name
                << L" cpu=" << GetCurrentProcessorNumber() << std::endl;
            DxcBuffer source{text.data(), text.size(), DXC_CP_UTF8};
            ComPtr<IDxcResult> result;
            const HRESULT call = compiler->Compile(&source, args, _countof(args), nullptr,
                IID_PPV_ARGS(&result));
            HRESULT status = E_FAIL;
            if (result) result->GetStatus(&status);
            if (FAILED(call) || FAILED(status)) {
                ComPtr<IDxcBlobUtf8> errors;
                if (result) result->GetOutput(DXC_OUT_ERRORS, IID_PPV_ARGS(&errors), nullptr);
                if (errors && errors->GetStringLength()) std::cerr << errors->GetStringPointer();
                return 5;
            }
        }
    }
    return 0;
}
