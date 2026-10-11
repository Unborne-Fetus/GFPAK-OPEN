"""Blender-side TRMDL and GFBMDL import; export actual 3D geometry to GLB."""
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
    parser.add_argument("--deps", help="App-managed Python dependency directory")
    parser.add_argument("--animations", action="store_true")
    opts = parser.parse_args(arguments)
    if opts.deps:
        dependencies = Path(opts.deps).resolve()
        if not (dependencies / "flatbuffers" / "__init__.py").is_file():
            raise RuntimeError(
                "Missing FlatBuffers files in GFPAK-OPEN's managed Blender dependencies."
            )
        # Must precede loading the importer, which checks for flatbuffers and
        # otherwise tries to install packages from inside Blender's disabled network.
        sys.path.insert(0, str(dependencies))
    try:
        import flatbuffers  # noqa: F401
    except ImportError as exc:
        raise RuntimeError(
            "FlatBuffers is unavailable to Blender's Python. Update GFPAK-OPEN "
            "so it supplies a managed --deps directory automatically."
        ) from exc
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
    source = Path(opts.model).resolve()
    if source.suffix.lower() == ".trmdl":
        imported = bpy.ops.import_scene.trmdl(filepath=str(source),
                                               loadlods=False, multiple=False, multiplesubs=False)
        if "FINISHED" not in imported:
            raise RuntimeError(
                "TRMDL importer cancelled after Python dependency initialization. "
                "See preceding importer messages for missing model companions or "
                "unsupported resources."
            )
    elif source.suffix.lower() == ".gfbmdl":
        # The legacy Blender operator reads its 'files' collection, not 'filepath',
        # which is empty in background mode. Call the import function directly.
        # This importer supports Let's Go / Sword-Shield geometry but does not
        # reconstruct their original proprietary materials/textures.
        from pokemon_switch_importer.gfbmdl_import import LoadModel
        LoadModel(bytearray(source.read_bytes()), source.name)
    else:
        raise RuntimeError("Unsupported native mesh extension: " + source.suffix)
    print("GFPAK_NATIVE_IMPORT", source.suffix.lower())

    meshes = [obj for obj in bpy.data.objects if obj.type == "MESH" and len(obj.data.vertices) > 0]
    if not meshes:
        raise RuntimeError("Native model importer produced no geometry; refusing empty GLB")

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
