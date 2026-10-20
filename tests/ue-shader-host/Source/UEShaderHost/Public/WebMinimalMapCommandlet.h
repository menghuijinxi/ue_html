#pragma once

#include "Commandlets/Commandlet.h"
#include "WebMinimalMapCommandlet.generated.h"

UCLASS()
class UWebMinimalMapCommandlet : public UCommandlet
{
    GENERATED_BODY()

public:
    UWebMinimalMapCommandlet();
    virtual int32 Main(const FString& Params) override;
};
