#include <windows.h>
#include <dxcapi.h>
#include <wrl/client.h>
#include <atomic>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

using Microsoft::WRL::ComPtr;
using Clock = std::chrono::steady_clock;
struct Input { int index; std::string name, text, expected; std::wstring profile, entry; };
struct Measurement { double ms = 0, cpuMs = 0; HRESULT status = E_FAIL; std::string hash; ComPtr<IDxcBlob> dxil; };
static double ThreadMs() {
    FILETIME c, e, k, u;
    GetThreadTimes(GetCurrentThread(), &c, &e, &k, &u);
    ULARGE_INTEGER kernel{}, user{};
    kernel.LowPart = k.dwLowDateTime; kernel.HighPart = k.dwHighDateTime;
    user.LowPart = u.dwLowDateTime; user.HighPart = u.dwHighDateTime;
    return (kernel.QuadPart + user.QuadPart) / 10000.0;
}
static std::wstring Widen(const std::string& s) { return {s.begin(), s.end()}; }
int wmain(int argc, wchar_t** argv) {
    if (argc != 8 && argc != 9) {
        std::cerr << "benchmark-same-dxc DLL input-dir HV rounds concurrency output-json output-dxil-dir [O0|O1|O2|O3|Od]\n";
        return 2;
    }
    HMODULE module = LoadLibraryExW(argv[1], nullptr, LOAD_WITH_ALTERED_SEARCH_PATH);
    auto create = module ? reinterpret_cast<DxcCreateInstanceProc>(GetProcAddress(module, "DxcCreateInstance")) : nullptr;
    ComPtr<IDxcCompiler3> compiler;
    if (!create || FAILED(create(CLSID_DxcCompiler, IID_PPV_ARGS(&compiler)))) return 3;
    const std::filesystem::path directory(argv[2]);
    std::ifstream manifest(directory / "inputs.tsv");
    std::vector<Input> inputs;
    std::string line;
    while (std::getline(manifest, line)) {
        std::istringstream row(line); std::string index, name, profile, entry, expected;
        std::getline(row, index, '\t'); std::getline(row, name, '\t'); std::getline(row, profile, '\t');
        std::getline(row, entry, '\t'); std::getline(row, expected, '\t');
        std::ifstream source(directory / name, std::ios::binary);
        inputs.push_back({std::stoi(index), name, {std::istreambuf_iterator<char>(source), {}}, expected, Widen(profile), Widen(entry)});
    }
    const std::wstring optimization = argc == 9 ? argv[8] : L"O3";
    if (optimization != L"O0" && optimization != L"O1" && optimization != L"O2" && optimization != L"O3" && optimization != L"Od") return 4;
    const std::wstring optimizationArg = L"/" + optimization;
    const int rounds = _wtoi(argv[4]), concurrency = _wtoi(argv[5]);
    if (inputs.empty() || rounds < 1 || concurrency < 1 || concurrency > 8) return 4;
    std::filesystem::create_directories(argv[7]);
    std::ofstream output(argv[6]);
    output << std::fixed << std::setprecision(6) << "{\"hv\":" << _wtoi(argv[3]) << ",\"optimization\":\"O" << char(optimization[1]) << "\",\"concurrency\":" << concurrency << ",\"rounds\":[";
    bool allSuccess = true;
    for (int round = 0; round < rounds; ++round) {
        std::vector<Measurement> results(inputs.size()); std::atomic<size_t> next{0};
        std::vector<std::thread> workers;
        const auto start = Clock::now();
        for (int lane = 0; lane < concurrency; ++lane) workers.emplace_back([&] {
            for (;;) {
                const auto i = next.fetch_add(1); if (i >= inputs.size()) break;
                const auto& in = inputs[i]; auto& m = results[i];
                // Match Dawn's ShaderUtils.cpp. The hash check detects a mismatched language mode or flags.
                const wchar_t* args[] = {L"-T", in.profile.c_str(), L"-E", in.entry.c_str(),
                    L"-opt-disable", L"structurize-loop-exits-for-unroll", L"/Gis", optimizationArg.c_str(), L"/Zpr", L"-HV", argv[3]};
                DxcBuffer source{in.text.data(), in.text.size(), DXC_CP_UTF8};
                ComPtr<IDxcResult> result;
                const double cpuStart = ThreadMs(); const auto begin = Clock::now();
                HRESULT call = compiler->Compile(&source, args, _countof(args), nullptr, IID_PPV_ARGS(&result));
                if (result) result->GetStatus(&m.status);
                if (SUCCEEDED(call) && SUCCEEDED(m.status)) call = result->GetResult(&m.dxil);
                m.ms = std::chrono::duration<double, std::milli>(Clock::now() - begin).count();
                m.cpuMs = ThreadMs() - cpuStart;
                if (FAILED(call) || !m.dxil) { m.status = E_FAIL; continue; }
                ComPtr<IDxcBlob> hash;
                if (SUCCEEDED(result->GetOutput(DXC_OUT_SHADER_HASH, IID_PPV_ARGS(&hash), nullptr))) {
                    auto value = static_cast<const DxcShaderHash*>(hash->GetBufferPointer()); std::ostringstream hex;
                    for (auto byte : value->HashDigest) hex << std::hex << std::setw(2) << std::setfill('0') << int(byte);
                    m.hash = hex.str();
                }
            }
        });
        for (auto& worker : workers) worker.join();
        const double wallMs = std::chrono::duration<double, std::milli>(Clock::now() - start).count();
        if (round) output << ',';
        output << "{\"wallMs\":" << wallMs << ",\"shaders\":[";
        for (size_t i = 0; i < results.size(); ++i) {
            const auto& m = results[i]; const auto& in = inputs[i];
            if (i) output << ',';
            output << "{\"index\":" << in.index << ",\"ms\":" << m.ms << ",\"cpuMs\":" << m.cpuMs
                << ",\"success\":" << (SUCCEEDED(m.status) ? "true" : "false") << ",\"dxilHash\":\"" << m.hash
                << "\",\"matchesBrowser\":" << (m.hash == in.expected ? "true" : "false") << '}';
            allSuccess &= SUCCEEDED(m.status);
            if (round == 0 && m.dxil) {
                std::ofstream binary(std::filesystem::path(argv[7]) / (std::to_string(in.index) + ".dxil"), std::ios::binary);
                binary.write(static_cast<const char*>(m.dxil->GetBufferPointer()), m.dxil->GetBufferSize());
            }
        }
        output << "]}";
    }
    output << "],\"success\":" << (allSuccess ? "true" : "false") << "}\n";
    return allSuccess ? 0 : 5;
}
