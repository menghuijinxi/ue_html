import json
from pathlib import Path

import unreal

registry = unreal.AssetRegistryHelpers.get_asset_registry()
registry.search_all_assets(True)
assets = registry.get_assets_by_path("/Game", recursive=True)
textures = []
unknown_tags = 0
for asset in assets:
    if str(asset.asset_class_path.asset_name) != "Texture2D":
        continue
    tag = asset.get_tag_value("VirtualTextureStreaming")
    value = str(tag).lower() in ("true", "1")
    if tag is None:
        unknown_tags += 1
        texture = asset.get_asset()
        if texture is None:
            raise RuntimeError("Cannot inspect texture: " + str(asset.package_name))
        value = bool(texture.get_editor_property("virtual_texture_streaming"))
        texture = None
    textures.append({
        "asset": str(asset.package_name),
        "virtualTextureStreaming": value,
        "registryTag": str(tag) if tag is not None else None,
    })
    if len(textures) % 32 == 0:
        unreal.SystemLibrary.collect_garbage()
        unreal.log("WEB_VT_ASSETS inspected=" + str(len(textures)))
report = {
    "project": unreal.Paths.get_project_file_path(),
    "textureCount": len(textures),
    "virtualTextureCount": sum(item["virtualTextureStreaming"] for item in textures),
    "missingTagsVerifiedByLoading": unknown_tags,
    "assets": textures,
    "assetsModified": False,
}
output = Path(__file__).parent / "results" / "virtual-texture-assets.json"
output.write_text(json.dumps(report, indent=2), encoding="utf-8")
unreal.log("WEB_VT_ASSETS " + json.dumps({
    "textures": report["textureCount"],
    "virtualTextures": report["virtualTextureCount"],
    "output": str(output),
}))
