#pragma once

#include "Commandlets/Commandlet.h"
#include "WebDefaultSamplesCommandlet.generated.h"

UCLASS()
class UWebDefaultSamplesCommandlet : public UCommandlet
{
    GENERATED_BODY()

public:
    UWebDefaultSamplesCommandlet();
    virtual int32 Main(const FString& Params) override;
};
