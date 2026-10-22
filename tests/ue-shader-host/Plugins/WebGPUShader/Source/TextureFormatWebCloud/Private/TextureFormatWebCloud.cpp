#include "ImageCore.h"
#include "Interfaces/ITextureFormat.h"
#include "Interfaces/ITextureFormatModule.h"
#include "Modules/ModuleManager.h"
#include "TextureCompressorModule.h"

class FTextureFormatWebCloud final : public ITextureFormat
{
public:
    virtual bool AllowParallelBuild() const override { return true; }
    virtual bool CanAcceptNonF32Source(FName) const override { return true; }
    virtual FName GetEncoderName(FName) const override { return TEXT("WebCloudRG16F"); }
    virtual uint16 GetVersion(FName, const FTextureBuildSettings*) const override { return 1; }
    virtual void GetSupportedFormats(TArray<FName>& Formats) const override
    {
        Formats.Add(TEXT("WebCloudRG16F"));
    }
    virtual EPixelFormat GetEncodedPixelFormat(const FTextureBuildSettings&, bool) const override
    {
        return PF_G16R16F;
    }
    virtual bool CompressImage(const FImage& Source, const FTextureBuildSettings&,
        const FIntVector3&, int32, int32, int32, FStringView, bool,
        FCompressedImage2D& Output) const override
    {
        FImage Linear;
        Source.CopyTo(Linear, ERawImageFormat::RGBA16F, EGammaSpace::Linear);
        Output.PixelFormat = PF_G16R16F;
        Output.SizeX = Linear.SizeX;
        Output.SizeY = Linear.SizeY;
        Output.NumSlicesWithDepth = Linear.NumSlices;
        Output.RawData.SetNumUninitialized(Linear.GetNumPixels() * 4);
        for (int64 Index = 0; Index < Linear.GetNumPixels(); ++Index)
            FMemory::Memcpy(Output.RawData.GetData() + Index * 4, Linear.RawData.GetData() + Index * 8, 4);
        return true;
    }
};

class FTextureFormatWebCloudModule final : public ITextureFormatModule
{
public:
    virtual bool CanCallGetTextureFormats() override { return false; }
    virtual ITextureFormat* GetTextureFormat() override { return &Format; }
private:
    FTextureFormatWebCloud Format;
};

IMPLEMENT_MODULE(FTextureFormatWebCloudModule, TextureFormatWebCloud);
