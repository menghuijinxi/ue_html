#include <cstdint>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>
#include <ShaderConductor/ShaderConductor.hpp>

// Use the same optimizer as the UE Cook plugin, on saved real Cook intermediates.
int main(int argc, char** argv) {
    if (argc < 4) return 2;
    std::ifstream input(argv[1], std::ios::binary);
    if (!input) return 3;
    std::vector<char> bytes{std::istreambuf_iterator<char>(input), {}};
    ShaderConductor::Compiler::ResultDesc source{};
    source.target.Reset(bytes.data(), static_cast<uint32_t>(bytes.size()));
    auto result = ShaderConductor::Compiler::Optimize(source, argv + 3, argc - 3);
    if (result.hasError) {
        std::cerr.write(static_cast<const char*>(result.errorWarningMsg.Data()), result.errorWarningMsg.Size());
        return 4;
    }
    std::ofstream output(argv[2], std::ios::binary);
    output.write(static_cast<const char*>(result.target.Data()), result.target.Size());
    return output ? 0 : 5;
}
