# GFPAK OPEN — Pokémon Switch 3D Model Converter

**Windows converter:** [Download builds](https://github.com/Unborne-Fetus/GFPAK-OPEN/actions/workflows/build-windows.yml)

**Web 3D studio:** https://unborne-fetus.github.io/GFPAK-OPEN/

GFPAK OPEN recognizes model packages from Pokémon Switch games from **Let's Go Pikachu/Eevee through Legends: Z-A and Mega Dimension**, using different decoding paths. The web app now has an **experimental browser-native GFBMDL geometry decoder** for Let's Go and Sword/Shield models.

## Game compatibility

| Game | Original native format | Browser rendering | Native conversion route |
| --- | --- | --- | --- |
| Let's Go Pikachu / Eevee | GFBMDL, GFPAK, GFBANM | Native GFBMDL mesh preview/export; also converted assets | Browser FlatBuffers decoder or desktop importer; original shaders and GFBANM are not yet decoded |
| Sword / Shield + Isle of Armor + Crown Tundra | GFBMDL, GFPAK | Native GFBMDL mesh preview/export; also converted assets | Browser FlatBuffers decoder or desktop importer; original shaders and GFBANM are not yet decoded |
| New Pokémon Snap | NUSRCMDLB / NUTEXB | Converted 3D assets | Game-specific extraction required |
| Brilliant Diamond / Shining Pearl | Unity assets and asset bundles | Converted 3D assets | AssetStudio / AssetRipper to FBX/OBJ/GLB |
| Legends: Arceus | GFPAK / TRMDL | Converted 3D assets | Windows Trinity importer / GFTool |
| Scarlet / Violet + Teal Mask + Indigo Disk | Trinity / TRMDL | Converted 3D assets | Windows Trinity importer / GFTool |
| Legends: Z-A + Mega Dimension | Revised Trinity / TRMDL | Converted 3D assets | Current GFTool / Trinity Model Viewer; support is evolving |
| Other Switch Pokémon spin-offs | Varies (Unity, custom engines) | Converted 3D assets | Separate extraction may be necessary |

**Important:** The browser can now decode **GFBMDL geometry directly** without Blender for compatible files. It can also extract GFBMDL from **stored or LZ4-compressed GFPAK** blocks when a matching filename-hash dictionary identifies the resource. Full game-correct materials, skeleton skinning, animations, BNTX and compressed Oodle resources are not yet supported. The browser does **not** directly render proprietary raw TRMDL/Unity/Snap models. GitHub Pages cannot execute Blender or Windows Oodle DLLs.

## GitHub Pages — web 3D studio

The sidebar includes a game selector with automatic filename-based suggestions. It supports:

- GLB, GLTF, FBX, OBJ + MTL, DAE, STL, PLY, 3DS **and GFBMDL** model rendering, using actual geometry decoders.
- ZIP and folder imports with associated local textures.
- Orbit controls, zoom/pan, automatic camera framing, model statistics, and compatible animation playback.
- Export to actual GLB with meshes; empty output is rejected.
- GFPAK inspection, including archives inside ZIPs; file-hash lists; metadata JSON exports; stored/LZ4 resource extraction and Oodle packed-resource export. When a hash dictionary identifies a stored/LZ4 **GFBMDL**, click **PREVIEW 3D MESH** to decode it and export its geometry as GLB.
- Specific feedback for unsupported original resources, with native GFBMDL decoding and warnings when the source lacks usable textures, skinning or animations.

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
- [x] Experimental browser-native FlatBuffers GFBMDL mesh decoding and GLB export, including stored/LZ4 GFPAK resources with identified filenames.
- [x] Browser rendering of converted geometry and valid GLB export.
- [x] Windows GFBMDL and TRMDL Blender import entry points.
- [x] ZIP, folder and GFPAK archive inspection.
- [ ] Validate native GFBMDL decoder against real Let's Go and Sword/Shield samples; currently tested with synthetic FlatBuffers-based geometry and browser GLB exports.
- [ ] Validate each other native game family with representative real mesh, texture and animation samples.
- [ ] Decode raw Unity and NUSRCMDLB models directly.
- [ ] WebAssembly/browser-native Oodle + Trinity model decoder.
- [ ] Fidelity fixes for complex shaders, texture variants, rigging, and animation.

Only process models and game assets you own or are authorized to use.
