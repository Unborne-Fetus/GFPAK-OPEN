"""Blender-side TRMDL import and GLB export. Invoked with blender --background."""
import argparse
import importlib.util
import sys
import traceback
from pathlib import Path


def main():
    import bpy
    arguments = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--addon", required=True)
    parser.add_argument("--animations", action="store_true")
    opts = parser.parse_args(arguments)
    addon = Path(opts.addon).resolve()
    spec = importlib.util.spec_from_file_location(
        "pokemon_switch_importer", addon / "__init__.py",
        submodule_search_locations=[str(addon)])
    if not spec or not spec.loader:
        raise RuntimeError("Could not load Pokémon Switch Blender importer")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    module.register()

    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    imported = bpy.ops.import_scene.trmdl(filepath=str(Path(opts.model).resolve()),
                                           loadlods=False, multiple=False, multiplesubs=False)
    if "FINISHED" not in imported:
        raise RuntimeError("TRMDL import cancelled; check the Blender flatbuffers dependency")
    meshes = [obj for obj in bpy.data.objects if obj.type == "MESH" and len(obj.data.vertices) > 0]
    if not meshes:
        raise RuntimeError("TRMDL importer produced no geometry; refusing empty GLB")

    if opts.animations:
        armatures = [obj for obj in bpy.data.objects if obj.type == "ARMATURE"]
        clips = sorted(Path(opts.model).parent.glob("*.tranm")) + sorted(Path(opts.model).parent.glob("*.gfbanm"))
        if clips and not armatures:
            raise RuntimeError("Animation files exist, but the model importer produced no armature")
        if armatures:
            bpy.ops.object.select_all(action="DESELECT")
            armatures[0].select_set(True)
            bpy.context.view_layer.objects.active = armatures[0]
            for clip in clips:
                result = bpy.ops.import_scene.gfbanm(directory=str(clip.parent),
                                                     files=[{"name": clip.name}], nla_import=True)
                if "FINISHED" not in result:
                    raise RuntimeError(f"Animation importer rejected {clip.name}")
    exported = bpy.ops.export_scene.gltf(filepath=str(Path(opts.output).resolve()),
                                          export_format="GLB", export_animations=opts.animations,
                                          export_materials="EXPORT", export_nla_strips=opts.animations)
    if "FINISHED" not in exported:
        raise RuntimeError("Blender GLB export cancelled")
    print(f"GFPAK_CONVERT_SUCCESS meshes={len(meshes)}")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        sys.exit(2)
