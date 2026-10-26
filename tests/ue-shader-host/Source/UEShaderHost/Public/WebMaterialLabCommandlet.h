#pragma once

#include "Commandlets/Commandlet.h"
#include "WebMaterialLabCommandlet.generated.h"

UCLASS()
class UWebMaterialLabCommandlet : public UCommandlet
{
    GENERATED_BODY()

public:
    UWebMaterialLabCommandlet();
    virtual int32 Main(const FString& Params) override;
};
