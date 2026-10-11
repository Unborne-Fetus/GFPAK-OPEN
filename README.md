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

Get the portable executable from [Build Windows Model Converter](https://github.com/Unborne-Fetus/GFPAK-OPEN/actions/workflows/build-windows.yml). On a Windows source checkout, double-click `run.bat`: it installs **build-time tools**, compiles the web interface, bundles its dependencies, creates **`dist/GFPAK-OPEN.exe`**, and launches that executable. It creates **no installer** and does not invoke the source-only `launch.py` as the final desktop app. `run.bat --build-only` builds without launching (used by CI). You need Python 3 and Node.js to build locally, but not to run the resulting EXE.

The desktop application opens **one studio window** with the web 3D viewer, GFPAK Inspector, **Blender Converter**, and **Game File Explorer** tabs. It does not launch a separate converter app. It detects installed Blender automatically; Blender and the optional importer are still required for native formats that cannot be decoded directly.

1. Blender is detected automatically, including supported Microsoft Store installations. Blender itself is **not** automatically downloaded.
2. On first start, the app checks for the open-source [Pokémon Switch Blender importer](https://github.com/ChicoEevee/Pokemon-Switch-Model-Importer-Blender). If missing, it downloads it from the upstream GitHub repository into your local GFPAK-OPEN application data directory, validates the required importer files and reuses it on later runs. This one-time download requires an internet connection; use the Retry control if it fails. You can still choose a manually installed add-on folder in Advanced Settings.
3. Under **Blender Converter**, choose individual native models, an extracted folder, or multiple GFPAKs, then click **Preview with Blender**. There is no mandatory file-save dialog: GLBs are generated into an app-owned temporary session directory and automatically shown in the same 3D viewer.
4. Temporary previews are deleted when another preview begins or when the desktop app exits normally. Click **Save GLB** to explicitly copy the cached model to a permanent location (or export in the 3D Viewer tab). Your original input files are never removed.
5. For supported Trinity GFPAKs, the desktop converter first identifies verified **TRMDL/TRMSH/TRMBF groups from the archive's FNV-1a hashes** without needing a filename dictionary. It then attempts to restore the exact companion filenames by reading strings from the decoded model and verifying their hashes. Unrecognized resources still benefit from an optional gfpak.txt/JSON dictionary.
6. Compression type 3 can be decompressed with the independently maintained open-source [pyooz](https://pypi.org/project/pyooz/) decoder (installed by run.bat or included in Windows builds), or using a compatible existing local Oodle DLL. No proprietary DLL or game files are downloaded or bundled. Unsupported Oodle variants and unresolvable texture/material references can still prevent a complete conversion.

### Built-in Game File Explorer

The Windows desktop studio has an integrated read-only **Game File Explorer** tab inspired by NX File Viewer. Use **Open game folder** to browse already extracted game resources and scan for models (`.trmdl`, `.gfbmdl`, GLB, etc.), animations (`.tranm`, `.gfbanm`), textures (`.bntx`, PNG, DDS, etc.), skeletons and materials. You can navigate subfolders, search and filter, inspect GFPAK resource hashes, and launch a temporary preview of compatible model files from the same tab.

Use **Open GFPAK / ZIP / NSP** to browse individual archive structures. ZIPs have a safe nested-file view. GFPAK resources are labeled from verified hash groups and, when decoding works, from hash-verified embedded filenames. Unknown resources are labeled **unidentified**, not fabricated. An NSP can be inspected only at its **outer PFS0 index**: individual NCA payloads are encrypted, and this tool **does not decrypt NCA, bypass protection or directly traverse an NSP's internal `bin/archive` file tree**. For that level of browsing, open a directory that you have already extracted in a compatible tool. `.xci` is currently listed as a file, not an implemented container decoder. Unsupported textures/animations can be discovered without necessarily being decoded, skinned or rendered.

The recursive scan is bounded to at most 40,000 scanned files per request and the results are capped at 1,200 rows, with truncation clearly indicated.

### NX File Viewer-style fourth tab

**Game File Explorer** has been redesigned into a Windows-style, NX File Viewer-inspired interface based on the user's reference screenshots. It has a collapsible **Content tree** (left), file list (center), and type-sensitive **Properties/preview pane** (right), plus functioning File, View, Tools and Help menus. Click a folder name to navigate; click its triangle to expand/collapse without leaving the tree. Double-click compatible models to preview them. Open image files to see a bounded embedded thumbnail, or inspect a short hex and ASCII sample. Folder and GFPAK nodes are lazily opened so large trees do not need to be fully loaded.

For a game that was already extracted using your own tools, use **Open package**, choose the NSP, then **Link extracted NSP files** to select its existing extracted folder. An **Extracted game files (linked)** node appears under the NSP. Expand it to browse your actual `bin/archive/pokemon`, `chara`, `effect`, animation and texture directories. The linked tree is not represented as decrypted data from the NSP itself; the source NSP is never changed.

This is an independently implemented interface inspired by the [open-source NX File Viewer project](https://github.com/Myster-Tee/NxFileViewer), rather than a copy of its C#/.NET or GPL-3.0 code. Feature parity is incomplete: this application does **not** decrypt NCAs, auto-obtain keys or open protected RomFS directly. XCI/NSZ/XCZ extraction is not yet implemented.

### Advanced NSP package workbench

When an NSP is selected, **Game File Explorer** now opens a full **read-only PFS0 analyzer** in the same desktop application:

- **Whole-package inventory:** exact NSP size, index size, indexed file counts, NCA counts, per-role file sizes, and warnings for duplicate names, overlaps, malformed offsets, reserved fields and trailing/unindexed data.
- **Complete indexed browsing:** server-side filename/type/role search, with paginated results across the entire NSP index rather than a fixed first-page sample (250 rows per page). Distinguishes content and metadata NCAs, tickets, certificates, artwork, plaintext metadata and other resources.
- **Plaintext CNMT information where available:** title ID, version, content type, required system version and content references from existing `.cnmt.xml` files. If metadata exists only inside encrypted NCAs, those fields cannot be recovered.
- **Per-file byte inspector:** absolute offset, file size, content ID, file signature, hex+ASCII preview (maximum 1 KiB per request, with selectable byte offset). Ticket payload bytes are intentionally hidden from the hex viewer.
- **Streaming integrity tools:** SHA-256 for a selected file and an optional cancellable SHA-256 audit of every indexed file, with progress. Comparison of an NCA filename's content-ID prefix with the calculated digest is advisory and **not** a complete authenticity check.
- **Explicit, safe export:** save a selected **raw** NSP entry (byte-identical, no decryption) or save a JSON index manifest. Nothing is extracted automatically, existing destinations are not overwritten, and original NSP files are never modified.

The PFS0 reader handles very large packages without loading entire game payloads into memory. It **does not** decrypt NCAs, bypass copy protection, retrieve console keys or mount protected RomFS data. The full tree visible in NX File Viewer still requires already-decrypted/extracted files supplied locally. NSZ and XCI container decoding are not yet implemented.



**Blender 5.x / FlatBuffers:** The Pokémon Switch Blender importer also requires Python
modules such as `flatbuffers` and `requests`. Blender may prohibit the importer's
own pip installation when Online Access is disabled. GFPAK-OPEN instead prepares
these packages in its own application-data folder on first conversion (source-run
installations), or bundles them inside the downloaded Windows EXE. The Blender worker
receives the package directory before registering the importer. You do **not** need
to enable Blender's Online Access setting. The first source-run install requires
network access to Python package downloads; packaged EXE builds include the packages
and can run offline after the importer itself has been installed.

**Animated demo:** The built-in geometric crystal has a four-second looping float
and ring-orbit animation. Use the inspector's animation controls to pause/play;
the animation is also included when exporting the demo to GLB.
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
