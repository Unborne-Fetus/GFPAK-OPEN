# GFPAK Open — 3D Model Converter

A local Windows tool to convert compatible Pokemon Switch Trinity model assets from GFPAK / TRMDL into genuine GLB models for Pokedex 3D Max.

## Features

- Read and index GFLXPACK archives and inspect compressed resource hashes.
- Restore original model resource names from a compatible GFPAK text filename dictionary or explicit JSON hash mapping.
- Decompress stored, LZ4 or Oodle resources. Oodle requires a compatible runtime DLL legitimately provided by the user.
- Import TRMDL geometry and its associated resources with Blender and the independently maintained Pokemon Switch Blender addon, then export as a real GLB.
- Reject missing/empty/invalid GLB results rather than labeling them as complete.
- Convert many archives at once, import compatible animations on request, supply already-decoded PNG textures, and save converter settings.
- Work with an already extracted and named TRMDL folder without any Oodle decoder or hash dictionary.

## Windows build

Open the Actions tab of this repository, select Build Windows Model Converter, download the GFPAK-OPEN-Windows artifact from a successful run, and launch GFPAK-OPEN.exe.

The Windows app does not include Blender, a Pokemon model importer, game assets, filename dictionaries, console keys, or proprietary runtime DLLs.

## One-time setup for raw GFPAK to GLB

1. Install Blender from https://www.blender.org/download/ and select blender.exe.
2. Obtain the Pokemon Switch V3 Blender importer from https://github.com/ChicoEevee/Pokemon-Switch-Model-Importer-Blender and follow its setup instructions (including Blender Python's flatbuffers dependency). In the converter, select the addon folder containing __init__.py.
3. For raw GFPAK archives, select a matching GFPAK filename dictionary in gfpak.txt format or JSON format, so the converter can identify TRMDL, TRMSH, TRMBF, TRMTR, TRSKL etc. For already extracted TRMDL folders, no dictionary is necessary.
4. If your archive uses Oodle compression (compression type 3 for the supplied Legends: Arceus sample), select a compatible legitimately obtained Oodle DLL, which is not bundled.
5. Optionally select a folder containing already decoded PNG textures, and tick supported animation import.
6. Open the GFPAK, click Convert to GLB, choose the output location. Review the conversion log.

## CLI examples

Direct GFPAK:

    python -m gfpak_open.cli "C:\Pokemon\pm0025_00_00.gfpak" --convert-glb pikachu.glb --blender "C:\Program Files\Blender Foundation\Blender 4.5\blender.exe" --addon "C:\Tools\Pokemon-Switch-Model-Importer-Blender" --hashes "C:\Tools\gfpak.txt" --oodle "C:\Tools\oo2core_8_win64.dll"

Already extracted and decoded model folder:

    python -m gfpak_open.cli "C:\Pokemon\PikachuExtracted" --convert-glb pikachu.glb --blender "C:\path\to\blender.exe" --addon "C:\path\to\Pokemon-Switch-Model-Importer-Blender"

Optional arguments: --textures, --animations, --model, --keep-extracted.

Archive diagnostics: --list, --report, --extract, --packed.

A plain text hash list may contain a folder line ending in slash followed by one filename per line, as in Switch Toolbox GFPAK hash lists.

An explicit JSON dictionary maps hexadecimal resource hashes to safe relative filenames. A sample (NOT a real Pikachu hash):

    {"0123456789abcdef": "bin/pokemon/pm0025/pm0025_00_00/mdl/pm0025_00_00.trmdl"}

## Status and limitations

The supplied Pikachu archive from Legends: Arceus has been verified as a readable GFLXPACK index with 180 internal resources in four folders, all compression type 3. Parser and GLB orchestration tests have passed using an emulated Blender process.

However, complete Pikachu-to-GLB conversion with correct textures has NOT been verified: the actual matching filename dictionary, compatible Oodle decoder and configured external Blender importer have not yet been used together in this test environment.

The app is a real conversion frontend; it will report missing conversion requirements instead of creating a fake successful model. Independent BNTX-to-PNG decoding, GFBMDL support, built-in 3D preview, and model fidelity verification are future work.

Run automated tests with: python -m unittest discover -s tests -v

GFPAK Open does not distribute Nintendo game data, console keys, proprietary runtime DLLs or third-party Blender add-ons.
