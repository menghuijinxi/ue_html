param(
    [string]$Engine = 'H:/UE_5.8',
    [Parameter(Mandatory)][string]$Output,
    [Parameter(Mandatory)][string]$ExistingEntries
)
$ErrorActionPreference = 'Stop'
$taskAssembly = [Reflection.Assembly]::LoadFrom("$Engine/Engine/Binaries/DotNET/UnrealBuildTool/UnrealBuildTool.dll")
$taskFlags = [Reflection.BindingFlags]'Public,NonPublic,Instance,Static'
function New-TaskObject([Type]$Type) {
    return [Runtime.Serialization.FormatterServices]::GetUninitializedObject($Type)
}
$taskRulesType = $taskAssembly.GetType('UnrealBuildTool.TargetRules')
# The harness invokes the production generator without initializing unrelated SDK/toolchain state.
$taskDynamicAssembly = [Reflection.Emit.AssemblyBuilder]::DefineDynamicAssembly(
    [Reflection.AssemblyName]::new('WebShaderMapHarness'), [Reflection.Emit.AssemblyBuilderAccess]::Run)
$taskTypeBuilder = $taskDynamicAssembly.DefineDynamicModule('Harness').DefineType(
    'WebShaderMapTargetRules', [Reflection.TypeAttributes]::Public, $taskRulesType)
$taskTargetInfoType = $taskAssembly.GetType('UnrealBuildTool.TargetInfo')
$taskConstructor = $taskTypeBuilder.DefineConstructor(
    [Reflection.MethodAttributes]::Public, [Reflection.CallingConventions]::Standard, [Type[]]@($taskTargetInfoType))
$taskIL = $taskConstructor.GetILGenerator()
$taskIL.Emit([Reflection.Emit.OpCodes]::Ldarg_0)
$taskIL.Emit([Reflection.Emit.OpCodes]::Ldarg_1)
$taskIL.Emit([Reflection.Emit.OpCodes]::Call, $taskRulesType.GetConstructors($taskFlags)[0])
$taskIL.Emit([Reflection.Emit.OpCodes]::Ret)
$taskRules = New-TaskObject $taskTypeBuilder.CreateType()
$taskRulesType.GetField('<bNeedsExtraShaderFormatsOverride>k__BackingField',$taskFlags).SetValue($taskRules,$true)
$taskPlatformType = $taskAssembly.GetType('UnrealBuildTool.UnrealTargetPlatform')
$taskWeb = $taskPlatformType.GetMethod('FindOrAddByName',$taskFlags).Invoke($null,[object[]]@('WebGPU'))
$taskRulesType.GetField('<Platform>k__BackingField',$taskFlags).SetValue(
    $taskRules,$taskPlatformType.GetProperty('Win64',$taskFlags).GetValue($null))
$taskReadOnlyType = $taskAssembly.GetType('UnrealBuildTool.ReadOnlyTargetRules')
$taskReadOnly = New-TaskObject $taskReadOnlyType
$taskReadOnlyType.GetField('Inner',$taskFlags).SetValue($taskReadOnly,$taskRules)
$taskPlatform = New-TaskObject $taskAssembly.GetType('UnrealBuildTool.WindowsPlatform')
$taskPlatform.GetType().GetField('Platform',$taskFlags).SetValue($taskPlatform,$taskWeb)
$taskModuleType = $taskAssembly.GetType('UnrealBuildTool.ModuleRules')
$taskModule = New-TaskObject $taskModuleType
$taskModuleType.GetProperty('Name',$taskFlags).SetValue($taskModule,'BuildSettings')
$taskFiles = [Collections.Generic.Dictionary[string,Collections.Generic.IEnumerable[string]]]::new()
$taskOld = Get-Content -LiteralPath $ExistingEntries -Raw | ConvertFrom-Json
$taskLines = [Collections.Generic.List[string]]::new()
$taskLines.Add('#include "RHIStaticShaderPlatformNames.gen.h"')
$taskLines.Add('BUILDSETTINGS_API FStaticNameMapEntry GStaticShaderNames[] =')
$taskLines.Add('{')
foreach ($taskEntry in $taskOld.entries) {
    if ($taskEntry.name -notmatch '^[A-Za-z0-9_]+$' -or $taskEntry.platform -notmatch '^[A-Za-z0-9_]+$') {
        throw 'Unexpected static platform name'
    }
    if ($taskEntry.index -in @(46,47)) { throw 'Reserved Web shader slots are already occupied' }
    $taskLines.Add(('    {{ TEXT("{0}"), TEXT("{1}"), {2} }},' -f $taskEntry.name,$taskEntry.platform,$taskEntry.index))
}
$taskLines.Add('    { nullptr, nullptr, 0 },')
$taskLines.Add('};')
$taskFiles.Add('RHIStaticShaderPlatformNames.gen.cpp',$taskLines)
$taskModuleType.GetField('<FilesToGenerate>k__BackingField',$taskFlags).SetValue($taskModule,$taskFiles)
$taskShaderType = $taskAssembly.GetType('UnrealBuildTool.UEBuildPlatform+StaticShader')
$taskShaderArray = [Array]::CreateInstance($taskShaderType,2)
for ($taskIndex=0; $taskIndex -lt 2; ++$taskIndex) {
    $taskShader = [Activator]::CreateInstance($taskShaderType)
    $taskShaderType.GetProperty('Name').SetValue($taskShader,(@('WEBGPU_ES31','WEBGPU_SM5')[$taskIndex]))
    $taskShaderType.GetProperty('Index').SetValue($taskShader,46+$taskIndex)
    $taskShaderArray.SetValue($taskShader,$taskIndex)
}
$taskGenerator = $taskPlatform.GetType().GetMethod('AddPlatformStaticShaders',$taskFlags)
$null = $taskGenerator.Invoke($taskPlatform,[object[]]@($taskReadOnly,$taskModule,$taskShaderArray))
$taskModuleType.GetProperty('Name',$taskFlags).SetValue($taskModule,'RHI')
$null = $taskGenerator.Invoke($taskPlatform,[object[]]@($taskReadOnly,$taskModule,$taskShaderArray))
$null = New-Item -ItemType Directory -Path $Output -Force
foreach ($taskFile in $taskFiles.GetEnumerator()) {
    [IO.File]::WriteAllLines((Join-Path $Output $taskFile.Key), [string[]]$taskFile.Value)
}
[IO.File]::WriteAllText((Join-Path $Output 'generator.json'), (@{
    assembly=$taskAssembly.Location
    productionMethod='UEBuildPlatform.AddPlatformStaticShaders'
    generatedFiles=[string[]]$taskFiles.Keys
    webSlots=@(46,47)
    limitation='Reflection harness invokes the installed UBT generator; full Web UBT factory/toolchain is not registered.'
} | ConvertTo-Json -Depth 5))
