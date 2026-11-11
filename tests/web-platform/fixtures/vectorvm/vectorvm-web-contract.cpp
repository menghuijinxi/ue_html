#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <vector>
#include "Platforms/VectorVMWebScalar.h"
#ifndef __EMSCRIPTEN__
#include "Platforms/VectorVMPlatformGeneric.h"
#endif

struct Register { uint32_t Values[4]; };
struct HalfCase { uint32_t Bits[4]; uint16_t Expected[4]; };
struct ByteCase { Register Value, Mask, Expected; };
struct ShiftCase { Register Value, Counts, Left, Right; };
static uint64_t Checks = 0;
static void Require(bool OK, const char* Message)
{
	++Checks;
	if (!OK) { fprintf(stderr, "check %llu failed: %s\n", (unsigned long long)Checks, Message); exit(1); }
}
template<typename T> static void Read(FILE* File, T& Value)
{
	Require(fread(&Value, sizeof(Value), 1, File) == 1, "fixture read");
}
static void TestHalf(const HalfCase& C)
{
	uint8_t Input[17], Output[10];
	memcpy(Input + 1, C.Bits, 16); memset(Output, 0xcd, sizeof(Output));
	VectorVMWeb::FloatToHalf4(Output + 1, Input + 1);
	Require(!memcmp(Output + 1, C.Expected, 8), "float to half desktop match");
	Require(Output[0] == 0xcd && Output[9] == 0xcd, "half output bounds");
}
static void TestBytes(const ByteCase& C)
{
	const Register Result = VectorVMWeb::ShuffleBytes(C.Value, C.Mask);
	Require(!memcmp(&Result, &C.Expected, 16), "PSHUFB desktop match");
	// Heap allocations deliberately end after the readable bytes, for ASan.
	auto* Input = static_cast<uint8_t*>(malloc(9)); memcpy(Input + 1, &C.Value, 8);
	Register Loaded = VectorVMWeb::LoadHalf4<Register>(Input + 1);
	Require(!memcmp(&Loaded, &C.Value, 8) && !Loaded.Values[2] && !Loaded.Values[3], "8-byte load and zero extension");
	free(Input);
	Input = static_cast<uint8_t*>(malloc(3)); memcpy(Input + 1, &C.Value, 2);
	Register Splat = VectorVMWeb::SplatHalf<Register>(Input + 1);
	uint16_t Lanes[8], Expected; memcpy(Lanes, &Splat, 16); memcpy(&Expected, Input + 1, 2);
	for (auto Lane : Lanes) Require(Lane == Expected, "16-bit broadcast");
	free(Input);
	uint8_t Output[10]; memset(Output, 0xcd, 10);
	VectorVMWeb::StoreHalf4(C.Value, Output + 1);
	Require(!memcmp(Output + 1, &C.Value, 8) && Output[0] == 0xcd && Output[9] == 0xcd, "8-byte unaligned store");
}
static void TestShift(const ShiftCase& C)
{
	Register Left = VectorVMWeb::Shift<true>(C.Value, C.Counts);
	Register Right = VectorVMWeb::Shift<false>(C.Value, C.Counts);
	Require(!memcmp(&Left, &C.Left, 16) && !memcmp(&Right, &C.Right, 16), "logical variable shifts");
	for (unsigned Lane = 0; Lane < 4; ++Lane)
	{
		Left = VectorVMWeb::ShiftImmediate<true>(C.Value, C.Counts.Values[Lane]);
		Right = VectorVMWeb::ShiftImmediate<false>(C.Value, C.Counts.Values[Lane]);
		Require(Left.Values[Lane] == C.Left.Values[Lane] && Right.Values[Lane] == C.Right.Values[Lane], "logical immediate shifts");
	}
}
#ifndef __EMSCRIPTEN__
static uint32_t HalfToFloatBits(uint32_t Half)
{
	const uint32_t Sign = (Half & 0x8000) << 16;
	uint32_t Exponent = (Half >> 10) & 31, Mantissa = Half & 1023;
	if (Exponent == 31) return Sign | 0x7f800000 | (Mantissa << 13);
	if (!Exponent)
	{
		if (!Mantissa) return Sign;
		int Shift = 0; while (!(Mantissa & 1024)) { Mantissa <<= 1; ++Shift; }
		return Sign | uint32_t(113 - Shift) << 23 | (Mantissa & 1023) << 13;
	}
	return Sign | ((Exponent + 112) << 23) | (Mantissa << 13);
}
static uint32_t RandomState = 0x93dc8341;
static uint32_t Random() { RandomState ^= RandomState << 13; RandomState ^= RandomState >> 17; return RandomState ^= RandomState << 5; }
template<typename T> static void Write(FILE* File, const T& Value) { Require(fwrite(&Value, sizeof(Value), 1, File) == 1, "fixture write"); }
static void Generate(const char* Path)
{
	std::vector<uint32_t> Values;
	for (uint32_t Half = 0; Half < 65536; ++Half) Values.push_back(HalfToFloatBits(Half));
	for (uint32_t Half = 0; Half < 0x7c00; ++Half)
	{
		float A, B; uint32_t BitsA = HalfToFloatBits(Half), BitsB = HalfToFloatBits(Half + 1);
		memcpy(&A, &BitsA, 4); memcpy(&B, &BitsB, 4);
		// Overflow threshold is the midpoint between max finite and 65536.
		if (Half == 0x7bff) B = 65536.f;
		float Mid = (A + B) * .5f; uint32_t Bits; memcpy(&Bits, &Mid, 4);
		for (int Delta = -1; Delta <= 1; ++Delta)
		{
			Values.push_back(Bits + Delta); Values.push_back((Bits + Delta) | 0x80000000);
		}
	}
	for (unsigned I = 0; I < 1048576; ++I) Values.push_back(Random());
	while (Values.size() % 4) Values.push_back(0);
	FILE* File = fopen(Path, "wb"); Require(File != nullptr, "create fixture");
	const uint32_t HalfCount = uint32_t(Values.size() / 4), ByteCount = 4096, ShiftCount = 1024;
	Write(File, HalfCount); Write(File, ByteCount); Write(File, ShiftCount);
	for (uint32_t I = 0; I < HalfCount; ++I)
	{
		HalfCase C; memcpy(C.Bits, Values.data() + I * 4, 16);
		VVM_floatToHalf(C.Expected, reinterpret_cast<const float*>(C.Bits));
		TestHalf(C); Write(File, C);
	}
	for (uint32_t I = 0; I < ByteCount; ++I)
	{
		ByteCase C; uint8_t Mask[16];
		for (auto& Value : C.Value.Values) Value = Random();
		for (unsigned Lane = 0; Lane < 16; ++Lane) Mask[Lane] = uint8_t(I + Lane * 17);
		memcpy(&C.Mask, Mask, 16);
		_mm_storeu_si128(reinterpret_cast<__m128i*>(&C.Expected), _mm_shuffle_epi8(_mm_loadu_si128(reinterpret_cast<const __m128i*>(&C.Value)), _mm_loadu_si128(reinterpret_cast<const __m128i*>(&C.Mask))));
		TestBytes(C); Write(File, C);
	}
	for (uint32_t I = 0; I < ShiftCount; ++I)
	{
		ShiftCase C;
		for (unsigned Lane = 0; Lane < 4; ++Lane)
		{
			C.Value.Values[Lane] = Random();
			// Exercise different counts in the same register, including a mix
			// of in-range and >=32 values. Equal lanes would miss a broadcast.
			C.Counts.Values[Lane] = (I + Lane * 17) % 64;
			if (I >= 960) C.Counts.Values[Lane] = ~uint32_t(I - 960 + Lane * 17);
			__m128i Value = _mm_cvtsi32_si128(C.Value.Values[Lane]);
			__m128i Count = _mm_cvtsi64_si128(C.Counts.Values[Lane]);
			C.Left.Values[Lane] = _mm_cvtsi128_si32(_mm_sll_epi32(Value, Count));
			C.Right.Values[Lane] = _mm_cvtsi128_si32(_mm_srl_epi32(Value, Count));
		}
		TestShift(C); Write(File, C);
	}
	Require(!fclose(File), "close fixture");
}
#endif
int main(int Argc, char** Argv)
{
	const char* Path = Argc > 1 ? Argv[1] : "/vectorvm-reference.bin";
#ifndef __EMSCRIPTEN__
	Generate(Path);
#endif
	FILE* File = fopen(Path, "rb"); Require(File != nullptr, "open fixture");
	uint32_t HalfCount, ByteCount, ShiftCount; Read(File, HalfCount); Read(File, ByteCount); Read(File, ShiftCount);
	for (uint32_t I = 0; I < HalfCount; ++I) { HalfCase C; Read(File, C); TestHalf(C); }
	for (uint32_t I = 0; I < ByteCount; ++I) { ByteCase C; Read(File, C); TestBytes(C); }
	for (uint32_t I = 0; I < ShiftCount; ++I) { ShiftCase C; Read(File, C); TestShift(C); }
	Require(fgetc(File) == EOF, "complete fixture consumption"); fclose(File);
	printf("{\"pass\":true,\"halfValues\":%u,\"byteCases\":%u,\"shiftCases\":%u,\"checks\":%llu}\n", HalfCount * 4, ByteCount, ShiftCount, (unsigned long long)Checks);
	return 0;
}
