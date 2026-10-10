# GFPAK Open

A Windows-friendly, read-only **GFLXPACK / `.gfpak` archive inspector** for extracted Pokémon game assets. This is the first stage of a planned model viewer and converter for Pokédex 3D Max.

## What works in v0.1

- Open `.gfpak` archives and inspect internal folder, file, and hash indexes.
- Browse resources in the desktop GUI or list them with the CLI.
- Save a JSON archive report without decompressing anything.
- Export raw compressed blocks, or extract stored and LZ4 resources.
- Decompress Oodle resources using a **user-supplied, legitimately obtained compatible Oodle DLL**. No DLL or game files are bundled.
- Build the Windows `.exe` automatically with GitHub Actions.

**Not implemented:** model or skeleton decoding, textures, animations, 3D previews, and GLB export.

## Getting started

**Windows EXE:** Open the repository **Actions → Build Windows App**, download the `GFPAK-OPEN-Windows` artifact, unzip, and run `GFPAK-OPEN.exe`.

**Python:** Install Python 3.10+ and double-click `run.bat`, or run:

```powershell
python launch.py
python -m gfpak_open.cli "C:\Users\You\Downloads\pm0025_00_00.gfpak" --list
python -m gfpak_open.cli "C:\Users\You\Downloads\pm0025_00_00.gfpak" --report pikachu.json
python -m gfpak_open.cli "C:\Users\You\Downloads\pm0025_00_00.gfpak" --extract out --packed
python -m gfpak_open.cli "C:\Users\You\Downloads\pm0025_00_00.gfpak" --extract out --oodle "C:\path\to\your\oo2core_9_win64.dll"
```

The `--packed` option saves still-compressed data, **not converted model files**. Original internal names are hashes; extracted resources receive deterministic hashed filenames.

## Tested example

The Pikachu `pm0025_00_00.gfpak` sample from Legends: Arceus (not distributed here) has signature `GFLXPACK`, version `0x1000`, 180 resources, 4 folders, and compression type 3 for every resource. The index can be read without Oodle.

## Roadmap

- [x] GFPAK archive inspection and hash index
- [x] Optional Oodle resource decoding with externally supplied DLL
- [x] CLI, GUI, tests, automated Windows build
- [ ] Identify TRMDL, TRMSH, TRSKL, BNTX and animation contents
- [ ] Decode meshes, textures, skeletons, animations
- [ ] 3D preview and reliable GLB export
- [ ] Batch import into Pokédex 3D Max

Run tests with `python -m unittest discover -s tests -v`.

This project contains no game assets, console keys, or proprietary runtime libraries. Work only with files you have the rights to use.
