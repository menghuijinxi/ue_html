#include "Modules/ModuleManager.h"

void StartWebNativeComparison();

class FUEShaderHostModule : public FDefaultGameModuleImpl
{
    virtual void StartupModule() override
    {
        StartWebNativeComparison();
    }
};

IMPLEMENT_PRIMARY_GAME_MODULE(FUEShaderHostModule, UEShaderHost, "UEShaderHost");
