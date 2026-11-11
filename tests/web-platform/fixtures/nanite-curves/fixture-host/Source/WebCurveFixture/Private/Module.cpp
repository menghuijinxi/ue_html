#include "Modules/ModuleManager.h"
#include "ShaderCore.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "Misc/Paths.h"
void StartWebGroomNativeCapture();
class FWebCurveFixtureModule:public FDefaultGameModuleImpl {
 void StartupModule()override{
  FString Root;if(FParse::Value(FCommandLine::Get(),TEXT("CurveShaderRoot="),Root)){
   auto Mappings=AllShaderSourceDirectoryMappings();ResetAllShaderSourceDirectoryMappings();
   for(const auto& Pair:Mappings)AddShaderSourceDirectoryMapping(Pair.Key,Pair.Key==TEXT("/Engine")?Root:Pair.Value);
   FlushShaderFileCache();
  }
  AddShaderSourceDirectoryMapping(TEXT("/WebCurveProbe"),FPaths::ConvertRelativePathToFull(FPaths::ProjectDir()/TEXT("..")));
  StartWebGroomNativeCapture();
 }
};
IMPLEMENT_PRIMARY_GAME_MODULE(FWebCurveFixtureModule,WebCurveFixture,"WebCurveFixture");
