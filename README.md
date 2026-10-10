# GFPAK OPEN — Pokémon Switch 3D Model Converter

**Windows converter:** [Download builds](https://github.com/Unborne-Fetus/GFPAK-OPEN/actions/workflows/build-windows.yml)

**Web 3D studio:** https://unborne-fetus.github.io/GFPAK-OPEN/

GFPAK OPEN recognizes model packages from Pokémon Switch games from **Let's Go Pikachu/Eevee through Legends: Z-A and Mega Dimension**, using different conversion routes according to each game's 3D engine.

## Game compatibility

| Game | Original native format | Browser rendering | Native conversion route |
| --- | --- | --- | --- |
| Let's Go Pikachu / Eevee | GFBMDL, GFPAK, GFBANM | Converted 3D assets | Windows GFBMDL importer (materials not fully supported) |
| Sword / Shield + Isle of Armor + Crown Tundra | GFBMDL, GFPAK | Converted 3D assets | Windows GFBMDL importer (materials not fully supported) |
| New Pokémon Snap | NUSRCMDLB / NUTEXB | Converted 3D assets | Game-specific extraction required |
| Brilliant Diamond / Shining Pearl | Unity assets and asset bundles | Converted 3D assets | AssetStudio / AssetRipper to FBX/OBJ/GLB |
| Legends: Arceus | GFPAK / TRMDL | Converted 3D assets | Windows Trinity importer / GFTool |
| Scarlet / Violet + Teal Mask + Indigo Disk | Trinity / TRMDL | Converted 3D assets | Windows Trinity importer / GFTool |
| Legends: Z-A + Mega Dimension | Revised Trinity / TRMDL | Converted 3D assets | Current GFTool / Trinity Model Viewer; support is evolving |
| Other Switch Pokémon spin-offs | Varies (Unity, custom engines) | Converted 3D assets | Separate extraction may be necessary |

**Important:** Browser rendering is verified for decoded/converted 3D model formats, not every game's proprietary raw model container. GitHub Pages cannot load Windows decoder DLLs or run Blender. Raw encrypted and compressed archives, GFBMDL and TRMDL cannot yet be rendered directly by this static web app.

## GitHub Pages — web 3D studio

The sidebar includes a game selector with automatic filename-based suggestions. It supports:

- GLB, GLTF, FBX, OBJ + MTL, DAE, STL, PLY and 3DS model rendering, using actual geometry decoders.
- ZIP and folder imports with associated local textures.
- Orbit controls, zoom/pan, automatic camera framing, model statistics, and compatible animation playback.
- Export to actual GLB with meshes; empty output is rejected.
- GFPAK inspection, including archives inside ZIPs; file-hash lists; metadata JSON exports; stored/LZ4 resource extraction and Oodle packed-resource export.
- Specific feedback for native TRMDL, GFBMDL, Unity and New Pokémon Snap assets that require a conversion step.

No files are sent to our server. Original game models and other assets are not distributed.

### Deployment

The workflow .github/workflows/deploy-pages.yml builds and deploys the web app. Set **Settings → Pages → Build and deployment → Source: GitHub Actions** before running it.

Local development requires Node.js 22+:

    npm install
    npm test
    npx playwright install chromium
    npx playwright test
    npm run dev

The production build uses npm run build and outputs dist-web/.

## Windows converter

Get the executable from [Build Windows Model Converter](https://github.com/Unborne-Fetus/GFPAK-OPEN/actions/workflows/build-windows.yml).

1. Select a .gfbmdl file for Let's Go / Sword / Shield, a .trmdl file for Trinity games, a decoded model folder, or a .gfpak.
2. Choose your installed Blender executable and the [Pokémon Switch V3 Blender addon](https://github.com/ChicoEevee/Pokemon-Switch-Model-Importer-Blender).
3. For raw GFPAK, supply a matching filename hash dictionary and, when required, a compatible legitimately obtained Oodle DLL. Neither is bundled.
4. Optionally provide decoded PNG textures or animation resources.
5. Convert to GLB and load the result on the GitHub Pages viewer.

The legacy GFBMDL addon path does not automatically restore original shaders/textures. Models from newer Legends: Z-A revisions may need a current [GFTool/Trinity Model Viewer](https://github.com/pkZukan/gftool) glTF export.

CLI help:

    python -m gfpak_open.cli --help

Python unit tests:

    python -m unittest discover -s tests -v

## Current roadmap

- [x] Game-aware import options for major releases and DLC across the requested range.
- [x] Browser rendering of converted geometry and valid GLB export.
- [x] Windows GFBMDL and TRMDL Blender import entry points.
- [x] ZIP, folder and GFPAK archive inspection.
- [ ] Validate each native game family with representative real mesh, texture and animation samples.
- [ ] Decode raw Unity and NUSRCMDLB models directly.
- [ ] WebAssembly/browser-native Oodle + Trinity model decoder.
- [ ] Fidelity fixes for complex shaders, texture variants, rigging, and animation.

Only process models and game assets you own or are authorized to use.
