#include <cstdint>
#include <fstream>
#include <iostream>
#include <string_view>
#include <vector>

#include "src/tint/lang/core/ir/module.h"
#include "src/tint/lang/spirv/reader/reader.h"
#include "src/tint/lang/wgsl/writer/writer.h"

// The pinned CLI does not expose this library option. Workgroup barrier
// uniformity is still validated for both Nanite and VSM active-lane votes.
int main(int argc, char** argv)
{
    const bool vsmAdaptive = argc == 4 && (std::string_view(argv[3]) == "--vsm-adaptive" ||
        std::string_view(argv[3]) == "--vsm-adaptive-probe");
    if (argc != 3 && !vsmAdaptive) return 2;
    std::ifstream input(argv[1], std::ios::binary | std::ios::ate);
    if (!input) return 3;
    const auto size = input.tellg();
    if (size < 20 || size % 4 != 0) return 3;
    std::vector<uint32_t> words(static_cast<size_t>(size) / 4);
    input.seekg(0);
    if (!input.read(reinterpret_cast<char*>(words.data()), size)) return 3;
    auto ir = tint::spirv::reader::ReadIR(words);
    if (ir != tint::Success)
    {
        std::cerr << ir.Failure().reason << '\n';
        return 4;
    }
    tint::wgsl::writer::Options options;
    options.allowed_features = tint::wgsl::AllowedFeatures::Everything();
    options.allow_non_uniform_subgroup_operations = true;
    options.allow_non_uniform_derivatives = vsmAdaptive;
    auto result = tint::wgsl::writer::WgslFromIR(ir.Get(), options);
    if (result != tint::Success)
    {
        std::cerr << result.Failure().reason << '\n';
        return 5;
    }
    std::ofstream output(argv[2], std::ios::binary);
    output << result->wgsl;
    return output ? 0 : 6;
}
