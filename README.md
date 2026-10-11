# GFPAK OPEN — Pokémon Switch 3D Model Converter

**Windows converter:** [Download builds](https://github.com/Unborne-Fetus/GFPAK-OPEN/actions/workflows/build-windows.yml)

**Web 3D studio:** https://unborne-fetus.github.io/GFPAK-OPEN/

GFPAK OPEN recognizes model packages from Pokémon Switch games from **Let's Go Pikachu/Eevee through Legends: Z-A and Mega Dimension**, using different decoding paths. The browser now has **experimental native GFBMDL and Trinity/TRMDL geometry decoders**. They render decoded vertices/indices directly, without running Blender; full game fidelity is not yet verified.

## Game compatibility

| Game | Original native format | Browser rendering | Native conversion route |
| --- | --- | --- | --- |
| Let's Go Pikachu / Eevee | GFBMDL, GFPAK, GFBANM | Native GFBMDL mesh preview/export; also converted assets | Browser FlatBuffers decoder or desktop importer; original shaders and some GFBANM variants remain unsupported; experimental skeletal clips added |
| Sword / Shield + Isle of Armor + Crown Tundra | GFBMDL, GFPAK | Native GFBMDL mesh preview/export; also converted assets | Browser FlatBuffers decoder or desktop importer; original shaders and GFBANM are not yet decoded |
| New Pokémon Snap | NUSRCMDLB / NUTEXB | Converted 3D assets | Game-specific extraction required |
| Brilliant Diamond / Shining Pearl | Unity assets and asset bundles | Converted 3D assets | AssetStudio / AssetRipper to FBX/OBJ/GLB |
| Legends: Arceus | GFPAK / TRMDL | Native TRMDL + TRMSH + TRMBF geometry; converted 3D assets | Browser-native experimental Trinity decoder; Oodle GFPAKs still blocked |
| Scarlet / Violet + Teal Mask + Indigo Disk | Trinity / TRMDL | Native TRMDL + TRMSH + TRMBF geometry; converted 3D assets | Browser-native experimental Trinity decoder; textures/animations still partial |
| Legends: Z-A + Mega Dimension | Revised Trinity / TRMDL | Compatible native TRMDL geometry; converted 3D assets | Experimental Trinity decoder; model revisions still need real-data testing |
| Other Switch Pokémon spin-offs | Varies (Unity, custom engines) | Converted 3D assets | Separate extraction may be necessary |

**Important:** Browser-side geometry decoding now handles compatible **GFBMDL** and **TRMDL/TRMSH/TRMBF** resources. Trinity skeleton data (TRSKL) can supply bones/skin weights, and decoded PNG/JPEG material maps can provide approximate PBR shading. Compatible skeletal TRANM and GFBANM tracks now have experimental browser animation playback and GLB export. Raw game-correct BNTX textures, original shaders, unsupported animation variations and **Oodle-compressed** resources still require further decoding, and revised Z-A files have not yet been validated. Only stored or LZ4-compressed GFPAK resources with a matching filename-hash dictionary can be previewed directly; a static GitHub Pages app cannot use a Windows Oodle DLL or Blender.

## GitHub Pages — web 3D studio

The sidebar includes a game selector with automatic filename-based suggestions. It supports:

- GLB, GLTF, FBX, OBJ + MTL, DAE, STL, PLY, 3DS, **GFBMDL, TRMDL and TRMSH** model rendering, using actual geometry decoders.
- ZIP and folder imports with associated local textures and experimental native skeletal animation clips.
- Orbit controls, zoom/pan, automatic camera framing, model statistics, and compatible animation playback.
- Export to actual GLB with meshes; empty output is rejected.
- GFPAK inspection, including archives inside ZIPs; filename-hash lists; metadata JSON exports; stored/LZ4 resource extraction and Oodle packed-resource export. When a hash dictionary identifies a stored/LZ4 **GFBMDL or TRMDL with its companion files**, click **PREVIEW 3D MESH** to decode it and export real geometry as GLB.
- Specific feedback for unsupported native resources, with browser GFBMDL/Trinity geometry decoding and warnings when shaders, textures, rigging or animations cannot be reconstructed.

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

## Windows desktop studio — viewer and converter together

Get the executable from [Build Windows Model Converter](https://github.com/Unborne-Fetus/GFPAK-OPEN/actions/workflows/build-windows.yml), or run `run.bat` from the source checkout.

The desktop application now opens **one studio window** with the same 3D viewer and archive tools as the web version, plus a dedicated **Blender Converter** tab in the same window. It does not launch a separate converter app.

1. Blender is detected automatically, including supported Microsoft Store installations. Blender itself is **not** automatically downloaded.
2. On first start, the app checks for the open-source [Pokémon Switch Blender importer](https://github.com/ChicoEevee/Pokemon-Switch-Model-Importer-Blender). If missing, it downloads it from the upstream GitHub repository into your local GFPAK-OPEN application data directory, validates the required importer files and reuses it on later runs. This one-time download requires an internet connection; use the Retry control if it fails. You can still choose a manually installed add-on folder in Advanced Settings.
3. Under **Blender Converter**, choose individual native model files or a decoded model folder, or select multiple GFPAKs for batch conversion. Choose the destination through the native save dialog and click Convert.
4. The successful GLB output appears as a **Preview** action directly in the same 3D viewer; a single completed export opens automatically.
5. For supported Trinity GFPAKs, the desktop converter first identifies verified **TRMDL/TRMSH/TRMBF groups from the archive's FNV-1a hashes** without needing a filename dictionary. It then attempts to restore the exact companion filenames by reading strings from the decoded model and verifying their hashes. Unrecognized resources still benefit from an optional gfpak.txt/JSON dictionary.
6. Compression type 3 can be decompressed with the independently maintained open-source [pyooz](https://pypi.org/project/pyooz/) decoder (installed by run.bat or included in Windows builds), or using a compatible existing local Oodle DLL. No proprietary DLL or game files are downloaded or bundled. Unsupported Oodle variants and unresolvable texture/material references can still prevent a complete conversion.

**Third-party notice:** pyooz 0.0.8 is distributed under [GPL-3.0-or-later](https://www.gnu.org/licenses/gpl-3.0.html); its upstream source is [zao/pyooz](https://github.com/zao/pyooz). The Pokémon Switch importer is independently maintained by ChicoEevee. The decoder and importer are not produced by GFPAK-OPEN.

Model fidelity still depends on the upstream importer and the supplied assets; missing shaders, textures, codecs and animation variants are not automatically restored.

The legacy GFBMDL addon path does not automatically restore original shaders/textures. Models from newer Legends: Z-A revisions may need a current [GFTool/Trinity Model Viewer](https://github.com/pkZukan/gftool) glTF export.

CLI help:

    python -m gfpak_open.cli --help

Python unit tests:

    python -m unittest discover -s tests -v

## Current roadmap

- [x] Game-aware import options for major releases and DLC across the requested range.
- [x] Experimental browser-native FlatBuffers GFBMDL mesh decoding and GLB export, including stored/LZ4 GFPAK resources with identified filenames.
- [x] Experimental Trinity TRMDL/TRMSH/TRMBF vertex and mesh decoders with companion-file resolution, optional TRSKL skinning, TRMTR material references and decoded standard-image textures. Tested with original synthetic fixtures, NOT validated across real game samples.
- [x] Experimental native TRANM / GFBANM skeletal keyframe decoding (fixed, dense, keyed 8/16-bit channels), bone animation playback and animated GLB export in browser, validated with synthetic fixtures only.
- [x] Browser rendering of converted geometry and valid GLB export.
- [x] Windows GFBMDL and TRMDL Blender import entry points.
- [x] ZIP, folder and GFPAK archive inspection.
- [ ] Validate native GFBMDL decoder against real Let's Go and Sword/Shield samples; currently tested with synthetic FlatBuffers-based geometry and browser GLB exports.
- [ ] Validate each other native game family with representative real mesh, texture and animation samples.
- [ ] Decode raw Unity and NUSRCMDLB models directly.
- [ ] Browser-native Oodle decompression (decoder license/performance review), BNTX texture transcoding, and validation of actual Trinity revisions.
- [ ] Validate native model skeletal skinning, native animation interpolation and all shader/material variations against actual game files.

Only process models and game assets you own or are authorized to use.
