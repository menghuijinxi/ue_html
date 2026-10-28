#pragma once

#include "Commandlets/Commandlet.h"
#include "WebVillaMaterialLabCommandlet.generated.h"

UCLASS()
class UWebVillaMaterialLabCommandlet : public UCommandlet
{
    GENERATED_BODY()

public:
    UWebVillaMaterialLabCommandlet();
    virtual int32 Main(const FString& Params) override;
};
