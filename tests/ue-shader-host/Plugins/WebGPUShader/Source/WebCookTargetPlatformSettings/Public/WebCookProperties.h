#pragma once

#include "GenericPlatform/GenericPlatformProperties.h"

struct FWebCookProperties : FGenericPlatformProperties
{
    static const char* PlatformName() { return "Web"; }
    static const char* IniPlatformName() { return "Web"; }
    static bool HasEditorOnlyData() { return false; }
    static bool RequiresCookedData() { return true; }
    static bool IsServerOnly() { return false; }
    static bool IsClientOnly() { return false; }
    static bool SupportsBuildTarget(EBuildTargetType) { return false; }
};
