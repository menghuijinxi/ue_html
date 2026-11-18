#pragma once
#include "Commandlets/Commandlet.h"
#include "WebCurveFixtureCommandlet.generated.h"
UCLASS()
class UWebCurveFixtureCommandlet : public UCommandlet {
 GENERATED_BODY()
 public: virtual int32 Main(const FString& Params) override;
};
