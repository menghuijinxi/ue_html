#include "CoreMinimal.h"
#include "HAL/PlatformApplicationMisc.h"
#include "GenericPlatform/ICursor.h"
#include "Web/WebApplication.h"
#include <emscripten.h>
#include <cstdio>

TCHAR GInternalProjectName[64] = TEXT("UEWebApplication");

namespace
{
TUniquePtr<FWebApplication> Application;
int Frames = 0;
bool Stopped = false;

class FProbeMessageHandler : public FGenericApplicationMessageHandler
{
public:
    bool OnKeyDown(int32 Key, uint32 Character, bool Repeat) override
    {
        std::printf("P3_APP_EVENT {\"type\":\"keyDown\",\"key\":%d,\"char\":%u,\"repeat\":%s,\"shift\":%s}\n",
            Key, Character, Repeat ? "true" : "false", Application->GetModifierKeys().IsShiftDown() ? "true" : "false");
        return true;
    }
    bool OnKeyUp(int32 Key, uint32, bool) override
    {
        std::printf("P3_APP_EVENT {\"type\":\"keyUp\",\"key\":%d}\n", Key);
        return true;
    }
    bool OnKeyChar(TCHAR Character, bool) override
    {
        std::printf("P3_APP_EVENT {\"type\":\"char\",\"value\":%u}\n", static_cast<uint32>(Character));
        return true;
    }
    bool OnMouseMove() override
    {
        const auto Position = Application->Cursor->GetPosition();
        std::printf("P3_APP_EVENT {\"type\":\"move\",\"x\":%.0f,\"y\":%.0f}\n", Position.X, Position.Y);
        return true;
    }
    bool OnMouseDown(const TSharedPtr<FGenericWindow>&, EMouseButtons::Type Button, FVector2D Position) override
    {
        std::printf("P3_APP_EVENT {\"type\":\"mouseDown\",\"button\":%d,\"x\":%.0f,\"y\":%.0f}\n",
            static_cast<int>(Button), Position.X, Position.Y);
        return true;
    }
    bool OnMouseUp(EMouseButtons::Type Button, FVector2D Position) override
    {
        std::printf("P3_APP_EVENT {\"type\":\"mouseUp\",\"button\":%d,\"x\":%.0f,\"y\":%.0f}\n",
            static_cast<int>(Button), Position.X, Position.Y);
        return true;
    }
    bool OnMouseUp(EMouseButtons::Type Button) override
    {
        std::printf("P3_APP_EVENT {\"type\":\"mouseUp\",\"button\":%d}\n", static_cast<int>(Button));
        return true;
    }
    bool OnMouseWheel(float Delta, FVector2D) override
    {
        std::printf("P3_APP_EVENT {\"type\":\"wheel\",\"delta\":%.2f}\n", Delta);
        return true;
    }
    bool OnSizeChanged(const TSharedRef<FGenericWindow>&, int32 Width, int32 Height, bool) override
    {
        // This probe has no RHI; its canvas consumer applies the reported device-pixel size.
        emscripten_set_canvas_element_size(FWebApplication::CanvasSelector, Width, Height);
        std::printf("P3_APP_EVENT {\"type\":\"resize\",\"width\":%d,\"height\":%d}\n", Width, Height);
        return true;
    }
    bool OnApplicationActivationChanged(bool Active) override
    {
        std::printf("P3_APP_EVENT {\"type\":\"focus\",\"active\":%s}\n", Active ? "true" : "false");
        return true;
    }
};
}

extern "C" EMSCRIPTEN_KEEPALIVE int WebApplicationStop()
{
    if (!Stopped)
    {
        Application->DestroyApplication();
        Application.Reset();
        Stopped = true;
        std::printf("P3_APP_STOPPED {\"frames\":%d}\n", Frames);
    }
    return Frames;
}

int main()
{
    Application.Reset(static_cast<FWebApplication*>(FPlatformApplicationMisc::CreateApplication()));
    Application->SetMessageHandler(MakeShared<FProbeMessageHandler>());
    const auto Window = Application->MakeWindow();
    check(!Window->GetOSWindowHandle());
    int32 DisplayX = -1, DisplayY = -1, DisplayWidth = -1, DisplayHeight = -1;
    check(!Window->GetFullScreenInfo(DisplayX, DisplayY, DisplayWidth, DisplayHeight) &&
          DisplayX == 0 && DisplayY == 0 && DisplayWidth == 0 && DisplayHeight == 0);
    Application->InitializeWindow(Window, MakeShared<FGenericWindowDefinition>(), nullptr, true);
    void* WindowIdentity = Window->GetOSWindowHandle();
    check(WindowIdentity && Window->GetWindowMode() == EWindowMode::Windowed);
    Application->StartMainLoop([Window, WindowIdentity](float Delta)
    {
        check(Window->GetOSWindowHandle() == WindowIdentity);
        FPlatformApplicationMisc::PumpMessages(true);
        Application->Tick(Delta);
        int32 X, Y, Width, Height;
        check(Window->GetFullScreenInfo(X, Y, Width, Height));
        FDisplayMetrics Metrics;
        FDisplayMetrics::RebuildDisplayMetrics(Metrics);
        check(X == 0 && Y == 0 && Width == Metrics.PrimaryDisplayWidth && Height == Metrics.PrimaryDisplayHeight);
        EM_ASM({
            globalThis.__webApplicationDisplayInfo = ({x: $0, y: $1, width: $2, height: $3, scale: $4});
        }, X, Y, Width, Height, Window->GetDPIScaleFactor());
        ++Frames;
        EM_ASM({ globalThis.__webApplicationFrames = $0; }, Frames);
    });
    std::printf("P3_APP_READY {\"pointerBytes\":%zu,\"mainLoop\":\"requestAnimationFrame\","
        "\"windowIdentity\":true,\"windowed\":true}\n", sizeof(void*));
    return 0;
}
