cmake_minimum_required(VERSION 3.24)
project(tint_nanite LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_MSVC_RUNTIME_LIBRARY MultiThreadedDLL)
if(NOT DAWN_ROOT)
  message(FATAL_ERROR "DAWN_ROOT must point to dawn-v20261009.190412")
endif()
add_executable(tint_nanite main.cpp)
# This shared header is omitted from the binary distribution's Tint headers.
set(NANITE_SUPPORT_HEADER "${CMAKE_CURRENT_BINARY_DIR}/support/src/utils/compiler.h")
set(NANITE_SUPPORT_SHA256 ce2b896c8f708730da5bd8831cac6ffbd6b339315a8a11f578fc615177e3e318)
if(EXISTS "${NANITE_SUPPORT_HEADER}")
  file(SHA256 "${NANITE_SUPPORT_HEADER}" NANITE_EXISTING_SHA256)
endif()
if(NOT NANITE_EXISTING_SHA256 STREQUAL NANITE_SUPPORT_SHA256)
  file(DOWNLOAD
  "https://raw.githubusercontent.com/google/dawn/v20261009.190412/src/utils/compiler.h"
    "${NANITE_SUPPORT_HEADER}"
    EXPECTED_HASH SHA256=${NANITE_SUPPORT_SHA256}
    TLS_VERIFY ON)
endif()
target_include_directories(tint_nanite PRIVATE "${DAWN_ROOT}/include/src/tint"
  "${CMAKE_CURRENT_BINARY_DIR}/support")
target_compile_definitions(tint_nanite PRIVATE DAWN_HAVE_UTILS_BUILD_CONFIG)
file(GLOB TINT_LIBRARIES "${DAWN_ROOT}/lib/tint*.lib")
target_link_libraries(tint_nanite PRIVATE ${TINT_LIBRARIES}
  "${DAWN_ROOT}/lib/webgpu_dawn.lib" user32 onecore_apiset dxguid)
target_compile_options(tint_nanite PRIVATE /W4 /EHsc /utf-8 /Zc:preprocessor)
