# GFPAK OPEN — 3D Model Converter

Two ways to work with Pokémon model assets: a Windows converter and a GitHub Pages web studio.

## Web studio (GitHub Pages)

Website (once GitHub Pages is enabled and deployed): https://unborne-fetus.github.io/GFPAK-OPEN/

The web version is a local-browser 3D converter built with Three.js. It supports:

- Drag-and-drop FBX, OBJ + MTL, Collada DAE, glTF and GLB models.
- ZIP packages containing multiple models and nearby textures. Select the model you want from a filterable list.
- Orbitable 3D previews with zoom, pan, automatic camera framing, grid/axes, and animation playback when clips are supported.
- Mesh / vertex / triangle / material / skeleton / animation counts.
- Export to real GLB with compatible geometry, materials, textures, and animations.
- Read GFLXPACK / .gfpak archive indexes, resolve hashes with optional filename dictionaries, export JSON and stored/LZ4 resource data. Oodle blocks can be downloaded as compressed bytes only.
- All game/model files are processed locally in your browser, without a server upload.

**Important limitation:** A raw Legends: Arceus .gfpak typically contains Oodle-compressed Trinity model resources. GitHub Pages cannot run a Windows Oodle DLL or Blender, and the web app cannot yet decode these compressed TRMDL meshes into GLB. To convert them, use the Windows converter and its required external decoder/importer, or import an already-extracted FBX, OBJ, DAE or glTF model into the web page.

No site or program in this repository distributes game data, proprietary libraries, keys, or third-party addons.

### Enable GitHub Pages

The build and deploy workflow is in .github/workflows/deploy-pages.yml.

If the first run fails because GitHub Pages has not been initialized, open **Settings → Pages → Build and deployment → Source: GitHub Actions**. Then go to **Actions → Deploy GFPAK Open Web → Run workflow**.

The published URL will be https://unborne-fetus.github.io/GFPAK-OPEN/

### Local web development

Requires Node.js 22 or later:

    npm install
    npm test
    npm run dev

Open the local URL printed by Vite. To generate the deployable static website, run npm run build. Output goes to dist-web/.

## Windows converter

Get the Windows EXE from [Build Windows Model Converter](https://github.com/Unborne-Fetus/GFPAK-OPEN/actions/workflows/build-windows.yml).

The Windows version can hand off real decoded TRMDL resources to Blender and the open-source [Pokémon Switch V3 Blender importer](https://github.com/ChicoEevee/Pokemon-Switch-Model-Importer-Blender) and export GLB. It can parse GFLXPACK. Raw GFPAK conversion requires a matching filename dictionary and a compatible legally obtained Oodle runtime. Nothing proprietary is included.

For local Python use:

    python launch.py

For CLI help:

    python -m gfpak_open.cli --help

Python tests:

    python -m unittest discover -s tests -v

## Status

- [x] Windows GFLXPACK archive parser and TRMDL-to-Blender conversion pipeline.
- [x] GitHub Pages browser project with WebGL preview and GLB exporter for FBX/OBJ/DAE/glTF/GLB.
- [x] Browser GFPAK archive inspection, stored/LZ4 resource decoding, and Oodle packed-resource export.
- [x] ZIP models and texture-file import.
- [ ] Full browser-native Oodle + Trinity/TRMDL decoder directly from raw Legends: Arceus GFPAK.
- [ ] Extensive fidelity tests for textures and animations across all Switch games.
- [ ] Offline-first web caching and bulk web exports.

Only operate on assets you have rights to use.
