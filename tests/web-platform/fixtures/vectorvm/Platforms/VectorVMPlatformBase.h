#pragma once
// Minimal type adapter for testing the unmodified desktop VectorVM platform
// header. No operation under test is reimplemented here.
#include <immintrin.h>
#include <stdint.h>
using VectorRegister4i = __m128i;
using uint32 = uint32_t;
using int32 = int32_t;
#define VM_FORCEINLINE inline
#define MS_ALIGN(N) __declspec(align(N))
#define GCC_ALIGN(N)
#define PLATFORM_CPU_X86_FAMILY 1
struct FVVM_VUI4 { union { VectorRegister4i v; uint32 u4[4]; int32 i4[4]; }; };
