#include "GlobalShader.h"
#include "Interfaces/IShaderFormat.h"
#include "Interfaces/IShaderFormatModule.h"
#include "Interfaces/ITargetPlatformManagerModule.h"
#include "Misc/FileHelper.h"
#include "Misc/Parse.h"
#include "ShaderCompiler.h"
#include "ShaderPreprocessTypes.h"
#include "WebGPUShaderCode.h"

int32 RunWebCurveShaders(const FString& Params)
{
 FString Directory;if(!FParse::Value(*Params,TEXT("Output="),Directory))return 1;
 IFileManager::Get().MakeDirectory(*Directory,true);
 const auto* Format=FModuleManager::LoadModuleChecked<IShaderFormatModule>(TEXT("WebGPUShaderFormat")).GetShaderFormat();
 FDataDrivenShaderPlatformInfo::Initialize();
 const auto Platform=FDataDrivenShaderPlatformInfo::GetShaderPlatformFromName(TEXT("SP_WEBGPU_SM5"));
 const auto* Type=FindShaderTypeByName(FHashedName(TEXT("FMemcpyCS")));
 if(!Format||!Type||Platform==SP_NumPlatforms){UE_LOG(LogTemp,Error,TEXT("Curve shader prerequisites: format=%d type=%d platform=%d"),Format!=nullptr,Type!=nullptr,int32(Platform));return 1;}
 for(int32 Stage=0;Stage<4;++Stage){
  const FString Name=Stage==0?TEXT("independent"):Stage==1?TEXT("dependent"):Stage==2?TEXT("decode"):TEXT("primitive");
  FShaderCompileJob Job;Job.Key=FShaderCompileJobKey(Type,Platform,nullptr,0);
  GlobalBeginCompileShader(TEXT("WebCurveProbe"),nullptr,Type,nullptr,0,
   Stage<2?TEXT("/Engine/Private/Nanite/NaniteTranscode.usf"):Stage==2?TEXT("/WebCurveProbe/WebCurveDecode.usf"):TEXT("/WebCurveProbe/WebCurvePrimitive.usf"),
   Stage<2?TEXT("TranscodePageToGPU"):TEXT("MainCS"),FShaderTarget(SF_Compute,Platform),Job.Input,false);
  Job.Input.ShaderFormat=UE::WebGPUShader::SM5Format;
  Job.Input.Environment.SetDefine(TEXT("VF_SUPPORTS_PRIMITIVE_SCENE_DATA"),1);
  Job.Input.Environment.SetDefine(TEXT("GROUP_SIZE"),32);
  Job.Input.Environment.SetDefine(TEXT("NANITE_TRANSCODE_PASS"),Stage);
  Job.Input.Environment.SetDefine(TEXT("NANITE_USE_VIEW_UNIFORM_BUFFER"),0);
  Job.Input.Environment.SetDefine(TEXT("NANITE_CURVE_DATA"),1);
  Job.Input.Environment.CompilerFlags.Add(CFLAG_HLSL2021);
  Job.Input.Environment.CompilerFlags.Add(CFLAG_ForceDXC);
  Job.Input.Environment.CompilerFlags.Add(CFLAG_WaveOperations);
  Format->ModifyShaderCompilerInput(Job.Input);
  if(!Format->PreprocessShader(Job.Input,Job.Input.Environment,Job.PreprocessOutput)){
   for(const auto& Error:Job.PreprocessOutput.GetErrors())UE_LOG(LogTemp,Error,TEXT("%s"),*Error.StrippedErrorMessage);return 1;
  }
  Format->CompilePreprocessedShader(Job.Input,Job.PreprocessOutput,Job.Output);
  for(const auto& Error:Job.Output.Errors)UE_LOG(LogTemp,Display,TEXT("%s"),*Error.StrippedErrorMessage);
  if(!Job.Output.bSucceeded)return 1;
  UE::WebGPUShader::FPayload Payload;FString Error;
  const auto Bytes=Job.Output.ShaderCode.GetReadView().Left(Job.Output.ShaderCode.GetShaderCodeSize());
  if(!UE::WebGPUShader::Decode(Bytes,Payload,Error))return 1;
  if(!FFileHelper::SaveStringToFile(Payload.Wgsl,*(Directory/(Name+TEXT(".wgsl"))))||
   !FFileHelper::SaveStringToFile(Payload.MetadataJson,*(Directory/(Name+TEXT(".json"))))||
   !FFileHelper::SaveArrayToFile(Bytes,*(Directory/(Name+TEXT(".webshader")))))return 1;
  UE_LOG(LogTemp,Display,TEXT("WEB_CURVE_SHADER stage=%s"),*Name);
 }
 return 0;
}
