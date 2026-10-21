#pragma once

#include "Commandlets/Commandlet.h"
#include "WebTemplateMapCommandlet.generated.h"

UCLASS()
class UWebTemplateMapCommandlet : public UCommandlet
{
    GENERATED_BODY()

public:
    UWebTemplateMapCommandlet();
    virtual int32 Main(const FString& Params) override;
};
