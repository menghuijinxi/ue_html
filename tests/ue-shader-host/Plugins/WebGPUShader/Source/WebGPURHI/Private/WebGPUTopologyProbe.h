#pragma once
#include "WebGPUProbeUtils.h"

// Read back real RHI draws, including the bundle path after its warmup frames.
inline TSharedRef<FJsonObject> RunWebGPUTopologyProbe(FWebGPUDynamicRHI& RHI)
{
    using namespace WebGPUProbe;
    const auto Init = [&](FWebGPUShaderData& Data, FRHIShader* Owner, EShaderFrequency Frequency, const char* Code) {
        Data.Owner = Owner; Data.Frequency = Frequency; Data.Entry = TEXT("main");
        Data.Metadata = MakeShared<FJsonObject>();
        Data.Metadata->SetNumberField(TEXT("frequency"), Frequency);
        Data.Metadata->SetArrayField(TEXT("spirvBindings"), {});
        auto Entry = MakeShared<FJsonObject>(); Entry->SetStringField(TEXT("name"), Data.Entry);
        Entry->SetArrayField(TEXT("bindings"), {}); Entry->SetArrayField(TEXT("output_variables"), {});
        auto Reflection = MakeShared<FJsonObject>();
        Reflection->SetArrayField(TEXT("entry_points"), {MakeShared<FJsonValueObject>(Entry)});
        Data.Metadata->SetObjectField(TEXT("reflection"), Reflection);
        Data.RuntimeMetadata.OutputMask = Frequency == SF_Pixel ? 1 : 0;
        auto WGSL = WGPU_SHADER_SOURCE_WGSL_INIT; WGSL.code = {Code, WGPU_STRLEN};
        auto Desc = WGPU_SHADER_MODULE_DESCRIPTOR_INIT; Desc.nextInChain = &WGSL.chain;
        Data.Module = wgpuDeviceCreateShaderModule(RHI.Device, &Desc);
    };
    TRefCountPtr<FWebGPUVertexShader> VS = new FWebGPUVertexShader;
    TRefCountPtr<FWebGPUPixelShader> PS = new FWebGPUPixelShader;
    Init(VS->Data, VS, SF_Vertex,
        "@vertex fn main(@location(0) p:vec2f)->@builtin(position) vec4f {return vec4f(p,0,1);}");
    VS->Data.VertexInputMask = 1;
    Init(PS->Data, PS, SF_Pixel, "@fragment fn main()->@location(0) vec4f{return vec4f(1,0,0,1);}");
    VS->InitResourceTable(); PS->InitResourceTable();
    FGraphicsPipelineStateInitializer Initializer;
    Initializer.BoundShaderState.VertexShaderRHI = VS;
    Initializer.BoundShaderState.PixelShaderRHI = PS;
    Initializer.BlendState = RHI.RHICreateBlendState(FBlendStateInitializerRHI(FBlendStateInitializerRHI::FRenderTarget()));
    Initializer.RasterizerState = RHI.RHICreateRasterizerState(FRasterizerStateInitializerRHI(FM_Solid, CM_None, false));
    Initializer.DepthStencilState = RHI.RHICreateDepthStencilState(FDepthStencilStateInitializerRHI(false, CF_Always));
    Initializer.RenderTargetsEnabled = 1; Initializer.RenderTargetFormats[0] = PF_R8G8B8A8; Initializer.NumSamples = 1;
    TArray<TSharedPtr<FJsonValue>> Cases;
    bool Pass = true;
    const uint32 BundlesBefore = RHI.DrawBundlesCreated, BundleHitsBefore = RHI.DrawBundleHits;
    for (bool Bundles : {false, true})
    for (auto Type : {PT_LineList, PT_PointList}) for (uint32 IndexBytes : {0u, 2u, 4u})
    for (uint8 Stream : {uint8(0), uint8(16)})
    {
        TGuardValue<bool> BundleGuard(RHI.UseRenderBundles, Bundles);
        FVertexDeclarationElementList Elements;
        Elements.Add(FVertexElement(Stream, 0, VET_Float2, 0, 8));
        Initializer.BoundShaderState.VertexDeclarationRHI = RHI.RHICreateVertexDeclaration(Elements);
        Initializer.PrimitiveType = Type; Initializer.bPSOPrecache = true;
        auto Pipeline = RHI.RHICreateGraphicsPipelineState(Initializer);
        check(Pipeline); Initializer.bPSOPrecache = false;
        const uint16 Indices16[] = {0,1,2,3}; const uint32 Indices32[] = {0,1,2,3};
        const float Shift = Stream ? -0.25f : 0.f;
        const float Positions[][2] = {{0,0},{-0.9375f,0.4375f+Shift},{0.9375f,0.4375f+Shift},
            {-0.9375f,-0.4375f+Shift},{0.9375f,-0.4375f+Shift}};
        FTextureRHIRef Texture; FBufferRHIRef Index, Vertices;
        RHI.RHIGetCommandContext(ERHIPipeline::Graphics);
        {
            FCommandList Cmd(&RHI); Texture = Target(RHI, Cmd, 16, 16);
            Vertices = Buffer(RHI, Cmd, FRHIBufferCreateDesc::CreateVertex(TEXT("TopologyVertices"), sizeof(Positions)),
                Positions, sizeof(Positions));
            if (IndexBytes) Index = Buffer(RHI, Cmd, FRHIBufferCreateDesc::CreateIndex(TEXT("TopologyIndex"), 4 * IndexBytes, IndexBytes),
                IndexBytes == 2 ? static_cast<const void*>(Indices16) : static_cast<const void*>(Indices32), 4 * IndexBytes);
        }
        RHI.SubmitCurrent();
        for (uint32 Frame = 0; Frame < 5; ++Frame)
        {
            RHI.RHIGetCommandContext(ERHIPipeline::Graphics);
            {
                FCommandList Cmd(&RHI);
                Cmd.BeginRenderPass(FRHIRenderPassInfo(Texture, ERenderTargetActions::Clear_Store), TEXT("TopologyProbe"));
                BindPipeline(RHI, Cmd, Initializer, Pipeline); Cmd.SetViewport(0,0,0,16,16,1);
                Cmd.SetStreamSource(Stream, Vertices, sizeof(Positions[0]));
                const uint32 Primitives = Type == PT_LineList ? 2 : 4;
                if (IndexBytes) Cmd.DrawIndexedPrimitive(Index,0,0,4,0,Primitives,1);
                else Cmd.DrawPrimitive(0,Primitives,1);
                Cmd.EndRenderPass();
            }
            RHI.SubmitCurrent(); ++RHI.EndFrames;
        }
        TArray<FColor> Colors; RHI.RHIReadSurfaceData(Texture,FIntRect(0,0,16,16),Colors,RawReadback());
        uint32 Covered=0; bool OK=Colors.Num()==256;
        for (int32 Pixel = 0; Pixel < Colors.Num(); ++Pixel)
        {
            const FColor& Color = Colors[Pixel];
            Covered += Color.R==255; OK &= Color.G==0 && Color.B==0 && (Color.R==0 || Color.R==255);
            if (Color.R == 255)
            {
                const int32 Y = Pixel / 16, X = Pixel % 16, Delta = Stream ? 2 : 0;
                OK &= Y == 4 + Delta || Y == 11 + Delta;
                if (Type == PT_PointList) OK &= X == 0 || X == 15;
            }
        }
        OK &= Type==PT_LineList ? Covered>=28 && Covered<=32 : Covered==4;
        auto Case=MakeShared<FJsonObject>(); Case->SetNumberField(TEXT("topology"),Type);
        Case->SetNumberField(TEXT("indexBytes"),IndexBytes); Case->SetNumberField(TEXT("covered"),Covered);
        Case->SetNumberField(TEXT("stream"),Stream); Case->SetBoolField(TEXT("bundles"),Bundles);
        Case->SetBoolField(TEXT("pass"),OK); Cases.Add(MakeShared<FJsonValueObject>(Case)); Pass &= OK;
    }
    auto Report=MakeShared<FJsonObject>();
    Report->SetNumberField(TEXT("bundlesCreated"),RHI.DrawBundlesCreated - BundlesBefore);
    Report->SetNumberField(TEXT("bundleHits"),RHI.DrawBundleHits - BundleHitsBefore);
    Pass &= RHI.DrawBundlesCreated > BundlesBefore && RHI.DrawBundleHits > BundleHitsBefore;
    // Decode real packed vertex bytes, including signed integer inputs and
    // normalized extrema. Color expectations come from the encoded values.
    struct FFormatCase { EVertexElementType Type; const char* Input; const char* Color; uint32 Stride; uint16 Data[4]; FColor Expected; };
    const FFormatCase Formats[] = {
        {VET_Short2,"vec2i","vec4f(vec2f(v)/32768*.5+.5,0,1)",4,{0xc000,0x4000,0,0},FColor(64,191,0,255)},
        {VET_Short4,"vec4i","vec4f(v)/32768*.5+.5",8,{0x8000,0,0x4000,0x7fff},FColor(0,128,191,255)},
        {VET_Short2N,"vec2f","vec4f(v*.5+.5,0,1)",4,{0x8000,0x7fff,0,0},FColor(0,255,0,255)},
        {VET_UShort4,"vec4u","vec4f(v)/65535",8,{0,0x8000,0x4000,0xffff},FColor(0,128,64,255)},
        {VET_UShort2N,"vec2f","vec4f(v,0,1)",4,{0,0xffff,0,0},FColor(0,255,0,255)},
        {VET_UShort4N,"vec4f","v",8,{0,0x8000,0x4000,0xffff},FColor(0,128,64,255)},
        // Packed 10:10:10:2, R=1023 G=0 B=512 A=3.
        {VET_URGB10A2N,"vec4f","v",4,{0x03ff,0xe000,0,0},FColor(255,0,128,255)}
    };
    TArray<TSharedPtr<FJsonValue>> FormatResults;
    TRefCountPtr<FWebGPUPixelShader> FormatPS = new FWebGPUPixelShader;
    Init(FormatPS->Data, FormatPS, SF_Pixel,"@fragment fn main(@location(0) c:vec4f)->@location(0) vec4f{return c;}");
    FormatPS->InitResourceTable();
    for (const auto& Format : Formats)
    {
        TRefCountPtr<FWebGPUVertexShader> FormatVS = new FWebGPUVertexShader;
        const FString Code = FString::Printf(TEXT("struct Out{@builtin(position) p:vec4f,@location(0) c:vec4f} "
            "@vertex fn main(@location(0) v:%s)->Out {var o:Out;o.p=vec4f(0,0,0,1);o.c=%s;return o;}"),
            UTF8_TO_TCHAR(Format.Input),UTF8_TO_TCHAR(Format.Color));
        const FTCHARToUTF8 Encoded(*Code); Init(FormatVS->Data,FormatVS,SF_Vertex,Encoded.Get());
        FormatVS->Data.VertexInputMask=1; FormatVS->InitResourceTable();
        Initializer.BoundShaderState.VertexShaderRHI=FormatVS; Initializer.BoundShaderState.PixelShaderRHI=FormatPS;
        FVertexDeclarationElementList Elements; Elements.Add(FVertexElement(16,0,Format.Type,0,Format.Stride));
        Initializer.BoundShaderState.VertexDeclarationRHI=RHI.RHICreateVertexDeclaration(Elements);
        Initializer.PrimitiveType=PT_PointList; Initializer.bPSOPrecache=true;
        auto Pipeline=RHI.RHICreateGraphicsPipelineState(Initializer); check(Pipeline); Initializer.bPSOPrecache=false;
        FTextureRHIRef Texture; FBufferRHIRef Vertices;
        RHI.RHIGetCommandContext(ERHIPipeline::Graphics);
        {
            FCommandList Cmd(&RHI); Texture=Target(RHI,Cmd,16,16);
            Vertices=Buffer(RHI,Cmd,FRHIBufferCreateDesc::CreateVertex(TEXT("PackedVertices"),Format.Stride),Format.Data,Format.Stride);
            Cmd.BeginRenderPass(FRHIRenderPassInfo(Texture,ERenderTargetActions::Clear_Store),TEXT("PackedVertexProbe"));
            BindPipeline(RHI,Cmd,Initializer,Pipeline); Cmd.SetViewport(0,0,0,16,16,1); Cmd.SetStreamSource(16,Vertices,0);
            Cmd.DrawPrimitive(0,1,1); Cmd.EndRenderPass();
        }
        RHI.SubmitCurrent();
        TArray<FColor> Colors; RHI.RHIReadSurfaceData(Texture,FIntRect(0,0,16,16),Colors,RawReadback());
        uint32 Covered=0; bool OK=Colors.Num()==256;
        for (const auto& Color:Colors) if(Color.A)
        {
            ++Covered;
            OK &= FMath::Abs(int32(Color.R)-Format.Expected.R)<=1 && FMath::Abs(int32(Color.G)-Format.Expected.G)<=1 &&
                FMath::Abs(int32(Color.B)-Format.Expected.B)<=1 && FMath::Abs(int32(Color.A)-Format.Expected.A)<=1;
        }
        OK &= Covered==1; Pass &= OK;
        auto Case=MakeShared<FJsonObject>(); Case->SetNumberField(TEXT("type"),Format.Type); Case->SetBoolField(TEXT("pass"),OK);
        FormatResults.Add(MakeShared<FJsonValueObject>(Case));
    }
    Report->SetArrayField(TEXT("vertexFormats"),FormatResults);
    Report->SetBoolField(TEXT("pass"),Pass);
    Report->SetArrayField(TEXT("cases"),Cases); return Report;
}
