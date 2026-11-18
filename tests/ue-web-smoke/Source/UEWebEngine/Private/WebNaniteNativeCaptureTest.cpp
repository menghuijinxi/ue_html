#include "CoreMinimal.h"
#include "SceneView.h"
#include "SceneViewExtension.h"
#include "UnrealClient.h"
#include "RenderingThread.h"
#include "RenderGraphBuilder.h"
#include "RenderGraphUtils.h"
#include "RHIGPUReadback.h"
#include "Misc/Base64.h"
#include "Serialization/JsonSerializer.h"
#include <emscripten.h>

// Read the actual final view output together with its AO sample phase. Browser
// screenshots race ongoing presentation and cannot identify that phase.
namespace
{
class FWebNaniteCaptureExtension : public FSceneViewExtensionBase
{
public:
    FWebNaniteCaptureExtension(const FAutoRegister& Register) : FSceneViewExtensionBase(Register) {}
    int32 RequestedPhase = -1;
    uint32 Serial = 0;
    FIntPoint Size;
    EPixelFormat Format = PF_Unknown;
    TUniquePtr<FRHIGPUTextureReadback> Readback;
    TSharedPtr<FJsonObject> Report;

    virtual void PostRenderViewFamily_RenderThread(FRDGBuilder& Graph, FSceneViewFamily& Family) override
    {
        if (RequestedPhase < 0 || Family.Views.Num() != 1 || !Family.RenderTarget) return;
        const auto& View = *Family.Views[0];
        if (View.bIsSceneCapture || int32(View.GetDistanceFieldTemporalSampleIndex()) != RequestedPhase) return;
        const auto Texture = Family.RenderTarget->GetRenderTargetTexture();
        if (!Texture) return;
        Format = Texture->GetFormat();
        check(Format == PF_B8G8R8A8 || Format == PF_R8G8B8A8);
        Size = Texture->GetSizeXY();
        Report = MakeShared<FJsonObject>();
        Report->SetNumberField(TEXT("serial"), Serial);
        Report->SetNumberField(TEXT("phase"), RequestedPhase);
        Report->SetNumberField(TEXT("frame"), Family.FrameNumber);
        Report->SetNumberField(TEXT("width"), Size.X);
        Report->SetNumberField(TEXT("height"), Size.Y);
        Report->SetNumberField(TEXT("format"), int32(Format));
        Report->SetNumberField(TEXT("antiAliasingMethod"), int32(View.AntiAliasingMethod));
        Report->SetNumberField(TEXT("materialMipBias"), View.MaterialTextureMipBias);
        Report->SetNumberField(TEXT("worldTime"), Family.Time.GetWorldTimeSeconds());
        Report->SetNumberField(TEXT("jitterX"), View.ViewMatrices.GetProjectionMatrix().M[2][0]);
        Report->SetNumberField(TEXT("jitterY"), View.ViewMatrices.GetProjectionMatrix().M[2][1]);
        auto Target = Graph.FindExternalTexture(Texture);
        if (!Target) Target = Graph.RegisterExternalTexture(CreateRenderTarget(Texture, TEXT("WebNativeCaptureOutput")));
        Readback = MakeUnique<FRHIGPUTextureReadback>(TEXT("WebNativeCaptureReadback"));
        AddEnqueueCopyPass(Graph, Readback.Get(), Target);
        RequestedPhase = -1;
    }

    void Poll()
    {
        if (!Readback || !Readback->IsReady()) return;
        int32 Pitch = 0, Height = 0;
        const auto* Bytes = static_cast<const uint8*>(Readback->Lock(Pitch, &Height));
        check(Bytes && Pitch >= Size.X && Height >= Size.Y);
        TArray<uint8> RGBA; RGBA.SetNumUninitialized(Size.X * Size.Y * 4);
        for (int32 Y = 0; Y < Size.Y; ++Y) for (int32 X = 0; X < Size.X; ++X)
        {
            const uint8* Source = Bytes + (Y * Pitch + X) * 4;
            uint8* Pixel = RGBA.GetData() + (Y * Size.X + X) * 4;
            Pixel[0] = Source[Format == PF_B8G8R8A8 ? 2 : 0];
            Pixel[1] = Source[1]; Pixel[2] = Source[Format == PF_B8G8R8A8 ? 0 : 2]; Pixel[3] = 255;
        }
        Readback->Unlock(); Readback.Reset();
        Report->SetStringField(TEXT("rgba"), FBase64::Encode(RGBA));
        FString JSON; FJsonSerializer::Serialize(Report.ToSharedRef(), TJsonWriterFactory<>::Create(&JSON));
        FTCHARToUTF8 UTF8(*JSON);
        MAIN_THREAD_EM_ASM({globalThis.__webNaniteNativeCapture = JSON.parse(UTF8ToString($0));}, UTF8.Get());
        Report.Reset();
    }
};
TSharedPtr<FWebNaniteCaptureExtension, ESPMode::ThreadSafe> Extension;
}

extern "C" EMSCRIPTEN_KEEPALIVE int WebNaniteNativeCaptureTest(int Phase)
{
    FTaskTagScope Scope(ETaskTag::EGameThread);
    if (Phase < -2 || Phase > 3) return 0;
    if (!Extension && Phase >= 0) Extension = FSceneViewExtensions::NewExtension<FWebNaniteCaptureExtension>();
    if (!Extension) return 0;
    if (Phase == -2)
    {
        FlushRenderingCommands();
        if (Extension->RequestedPhase >= 0 || Extension->Readback || Extension->Report) return 0;
        Extension.Reset(); return 1;
    }
    ENQUEUE_RENDER_COMMAND(WebNativeCaptureRequest)([KeepAlive = Extension, Phase](FRHICommandListImmediate&) {
        if (Phase < 0) KeepAlive->Poll();
        else
        {
            check(KeepAlive->RequestedPhase < 0 && !KeepAlive->Readback && !KeepAlive->Report);
            ++KeepAlive->Serial; KeepAlive->RequestedPhase = Phase;
        }
    });
    return 1;
}
