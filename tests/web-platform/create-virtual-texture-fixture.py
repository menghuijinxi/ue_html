import binascii
import json
from pathlib import Path
import struct
import zlib

import unreal

root = Path(__file__).resolve().parent
project = Path(unreal.Paths.get_project_file_path()).resolve()
expected = root / "build" / "projects" / "triplex-vt-fixture" / "TriplexHouseVilla.uproject"
if project != expected.resolve():
    raise RuntimeError("This fixture may only modify the isolated triplex-vt-fixture project")

destination = "/Game/WebVirtualTextureProbe"
map_path = destination + "/VT_Default"
assets = unreal.get_editor_subsystem(unreal.EditorAssetSubsystem)
if assets.does_asset_exist(map_path):
    raise RuntimeError("Fixture already exists; inspect it instead of overwriting it")

# Deterministic multiscale source, shared by the virtual and ordinary textures.
width = 1024
rows = bytearray()
colors = [(230, 55, 45), (45, 195, 90), (45, 100, 230), (245, 205, 40)]
for y in range(width):
    rows.append(0)
    for x in range(width):
        quadrant = (x >= width // 2) + 2 * (y >= width // 2)
        size = [64, 16, 8, 2][quadrant]
        color = colors[quadrant] if ((x // size) + (y // size)) % 2 else (235, 235, 235)
        rows.extend((*color, 255))


def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", binascii.crc32(kind + data))


image = project.parent / "Saved" / "WebVTSource.png"
image.parent.mkdir(parents=True, exist_ok=True)
image.write_bytes(b"\x89PNG\r\n\x1a\n" +
                  chunk(b"IHDR", struct.pack(">2I5B", width, width, 8, 6, 0, 0, 0)) +
                  chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))
tools = unreal.AssetToolsHelpers.get_asset_tools()
materials = []
for virtual in (False, True):
    suffix = "Virtual" if virtual else "Regular"
    task = unreal.AssetImportTask()
    task.set_editor_property("filename", str(image))
    task.set_editor_property("destination_path", destination)
    task.set_editor_property("destination_name", "T_" + suffix)
    task.set_editor_property("automated", True)
    task.set_editor_property("save", False)
    tools.import_asset_tasks([task])
    texture = unreal.load_asset(destination + "/T_" + suffix)
    if texture is None:
        raise RuntimeError("Texture import failed")
    texture.set_editor_property("virtual_texture_streaming", virtual)
    assets.save_loaded_asset(texture)
    material = tools.create_asset("M_" + suffix, destination, unreal.Material, unreal.MaterialFactoryNew())
    material.set_editor_property("two_sided", True)
    sample = unreal.MaterialEditingLibrary.create_material_expression(material, unreal.MaterialExpressionTextureSample)
    sample.set_editor_property("texture", texture)
    sample.set_editor_property("sampler_type", unreal.MaterialSamplerType.SAMPLERTYPE_VIRTUAL_COLOR
                               if virtual else unreal.MaterialSamplerType.SAMPLERTYPE_COLOR)
    unreal.MaterialEditingLibrary.connect_material_property(sample, "RGB", unreal.MaterialProperty.MP_BASE_COLOR)
    unreal.MaterialEditingLibrary.recompile_material(material)
    assets.save_loaded_asset(material)
    materials.append(material)

level = unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)
if not level.new_level_from_template(map_path, "/Engine/Maps/Templates/Template_Default"):
    raise RuntimeError("Cannot copy the default lit template")
actors = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
plane = unreal.load_asset("/Engine/BasicShapes/Plane")
for index, material in enumerate(materials):
    actor = actors.spawn_actor_from_class(unreal.StaticMeshActor, unreal.Vector(0, -115 + index * 230, 200))
    actor.set_actor_label("WebVT_" + ("Virtual" if index else "Regular"))
    actor.set_actor_rotation(unreal.Rotator(pitch=90.0, yaw=0.0, roll=0.0), False)
    actor.set_actor_scale3d(unreal.Vector(2, 2, 2))
    component = actor.get_component_by_class(unreal.StaticMeshComponent)
    component.set_static_mesh(plane)
    component.set_material(0, material)
if not level.save_current_level():
    raise RuntimeError("Fixture map save failed")
report = {"pass": True, "project": str(project), "map": map_path,
          "source": str(image), "virtualTextures": 1, "regularTextures": 1,
          "camera": [-450, 0, 200, 0, 0], "originalProjectModified": False}
(root / "results" / "virtual-texture-fixture.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
unreal.log("WEB_VT_FIXTURE " + json.dumps(report))
