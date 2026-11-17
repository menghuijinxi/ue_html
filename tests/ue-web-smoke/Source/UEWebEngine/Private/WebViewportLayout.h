#pragma once

#include "Blueprint/WidgetLayoutLibrary.h"
#include "Blueprint/WidgetTree.h"
#include "Widgets/SWindow.h"
#include "Widgets/SViewport.h"
#include "GenericPlatform/GenericWindow.h"
#include "UnrealClient.h"
#include "Components/BoxComponent.h"
#include "Components/Slider.h"
#include "Framework/Application/SlateApplication.h"

// Explicit diagnostic RPC; never traverse widget trees during normal frames.
extern "C" EMSCRIPTEN_KEEPALIVE int WebViewportLayoutTest(int Mode)
{
    FTaskTagScope Scope(ETaskTag::EGameThread);
    UGameViewportClient* Viewport = GEngine ? GEngine->GameViewport : nullptr;
    if (!Viewport || !Viewport->Viewport)
        return 0;
    const auto Window = Viewport->GetWindow();
    const auto ViewportWidget = Viewport->GetGameViewportWidget();
    if (!Window || !ViewportWidget || !Window->GetNativeWindow())
        return 0;
    const auto Native = Window->GetNativeWindow();
    const auto Position = Window->GetPositionInScreen();
    const auto Size = Window->GetSizeInScreen();
    const auto Client = Window->GetClientRectInScreen();
    const auto Geometry = ViewportWidget->GetCachedGeometry();
    const auto LocalSize = Geometry.GetLocalSize();
    const auto Origin = Geometry.LocalToAbsolute(FVector2D::ZeroVector);
    const auto Pixels = Viewport->Viewport->GetSizeXY();
    int32 X = 0, Y = 0, Width = 0, Height = 0;
    Native->GetRestoredDimensions(X, Y, Width, Height);
    std::printf("P3_UI_LAYOUT {\"window\":[%g,%g,%g,%g],\"client\":[%g,%g,%g,%g],"
        "\"native\":[%d,%d,%d,%d],\"viewport\":[%d,%d],\"geometry\":[%g,%g,%g,%g,%g],"
        "\"windowDPI\":%g,\"umgDPI\":%g,\"mode\":%d}\n",
        double(Position.X), double(Position.Y), double(Size.X), double(Size.Y),
        double(Client.Left), double(Client.Top), double(Client.Right), double(Client.Bottom),
        X, Y, Width, Height, Pixels.X, Pixels.Y,
        double(LocalSize.X), double(LocalSize.Y), double(Geometry.Scale), double(Origin.X), double(Origin.Y),
        double(Window->GetDPIScaleFactor()), double(UWidgetLayoutLibrary::GetViewportScale(Viewport)), Mode);
    if (auto* Controller = Viewport->GetWorld()->GetFirstPlayerController())
    {
        APawn* Pawn = Controller->GetPawn();
        auto& Slate = FSlateApplication::Get();
        const auto Cursor = Slate.GetCursorPos();
        const auto Hit = Slate.LocateWindowUnderMouse(Cursor, Slate.GetInteractiveTopLevelWindows(), false);
        FString HitPath;
        for (int32 Index = 0; Index < Hit.Widgets.Num(); ++Index)
            HitPath += Hit.Widgets[Index].Widget->GetTypeAsString() + TEXT("/");
        std::printf("P3_UI_INPUT {\"cursor\":[%g,%g],\"show\":%d,\"pawn\":\"%s\","
            "\"hit\":\"%s\",\"focus\":%d,\"capture\":%d}\n",
            double(Cursor.X), double(Cursor.Y), Controller->bShowMouseCursor,
            Pawn ? TCHAR_TO_UTF8(*Pawn->GetClass()->GetName()) : "", TCHAR_TO_UTF8(*HitPath),
            Viewport->Viewport->HasFocus(), Viewport->Viewport->HasMouseCapture());
    }
    if (Mode == 1)
    {
        for (TObjectIterator<AActor> It; It; ++It)
        {
            if (It->GetWorld() != Viewport->GetWorld() ||
                It->GetClass()->GetName() != TEXT("BP_CupboardDoor_C"))
                continue;
            TInlineComponentArray<UBoxComponent*> Boxes(It.operator*());
            for (auto* Box : Boxes)
            {
                const auto Center = Box->Bounds.Origin;
                const auto Extent = Box->Bounds.BoxExtent;
                std::printf("P3_UI_INTERACTION {\"actor\":\"%s\",\"class\":\"%s\",\"box\":\"%s\",\"center\":[%g,%g,%g],"
                    "\"extent\":[%g,%g,%g]}\n", TCHAR_TO_UTF8(*It->GetName()),
                    TCHAR_TO_UTF8(*It->GetClass()->GetName()), TCHAR_TO_UTF8(*Box->GetName()),
                    double(Center.X), double(Center.Y), double(Center.Z),
                    double(Extent.X), double(Extent.Y), double(Extent.Z));
            }
        }
    }
    for (TObjectIterator<UUserWidget> It; It; ++It)
    {
        if (!It->IsInViewport() || It->GetWorld() != Viewport->GetWorld() || !It->WidgetTree)
            continue;
        TArray<UWidget*> Widgets;
        It->WidgetTree->GetAllWidgets(Widgets);
        for (UWidget* Widget : Widgets)
        {
            if (!Widget || !Widget->IsVisible())
                continue;
            const auto& Cached = Widget->GetPaintSpaceGeometry();
            const auto Rect = Cached.GetRenderBoundingRect();
            if (Rect.Right <= Rect.Left || Rect.Bottom <= Rect.Top)
                continue;
            std::printf("P3_UI_WIDGET {\"name\":\"%s\",\"class\":\"%s\",\"owner\":\"%s\","
                "\"opacity\":%g,\"rect\":[%g,%g,%g,%g]}\n",
                TCHAR_TO_UTF8(*Widget->GetName()), TCHAR_TO_UTF8(*Widget->GetClass()->GetName()),
                TCHAR_TO_UTF8(*It->GetClass()->GetName()), double(Widget->GetRenderOpacity()),
                double(Rect.Left), double(Rect.Top), double(Rect.Right), double(Rect.Bottom));
        }
    }
    for (TObjectIterator<USlider> It; It; ++It)
    {
        if (!It->GetCachedWidget().IsValid())
            continue;
        const auto& Cached = It->GetPaintSpaceGeometry();
        const auto Rect = Cached.GetRenderBoundingRect();
        std::printf("P3_UI_SLIDER {\"name\":\"%s\",\"value\":%g,\"range\":[%g,%g],"
            "\"visible\":%d,\"locked\":%d,\"rect\":[%g,%g,%g,%g]}\n",
            TCHAR_TO_UTF8(*It->GetName()), double(It->GetValue()), double(It->GetMinValue()), double(It->GetMaxValue()),
            It->IsVisible(), It->IsLocked(),
            double(Rect.Left), double(Rect.Top), double(Rect.Right), double(Rect.Bottom));
    }
    return 1;
}
