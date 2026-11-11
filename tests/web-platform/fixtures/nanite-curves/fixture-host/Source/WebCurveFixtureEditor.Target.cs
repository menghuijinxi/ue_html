using UnrealBuildTool;
public class WebCurveFixtureEditorTarget : TargetRules {
 public WebCurveFixtureEditorTarget(TargetInfo Target):base(Target){
  Type=TargetType.Editor;DefaultBuildSettings=BuildSettingsVersion.V7;
  IncludeOrderVersion=EngineIncludeOrderVersion.Unreal5_8;ExtraModuleNames.Add("WebCurveFixture");
 }
}
