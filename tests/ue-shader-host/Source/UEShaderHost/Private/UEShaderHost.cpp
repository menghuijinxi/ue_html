#include "Modules/ModuleManager.h"

void StartWebNativeComparison();
void StartWebDistanceFieldComparison();

class FUEShaderHostModule : public FDefaultGameModuleImpl
{
    virtual void StartupModule() override
    {
        StartWebNativeComparison();
        StartWebDistanceFieldComparison();
    }
};

IMPLEMENT_PRIMARY_GAME_MODULE(FUEShaderHostModule, UEShaderHost, "UEShaderHost");
