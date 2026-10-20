#pragma once

#include "Commandlets/Commandlet.h"
#include "WebShaderProbeCommandlet.generated.h"

UCLASS()
class UWebShaderProbeCommandlet : public UCommandlet
{
    GENERATED_BODY()

public:
    UWebShaderProbeCommandlet();
    virtual int32 Main(const FString& Params) override;
};
