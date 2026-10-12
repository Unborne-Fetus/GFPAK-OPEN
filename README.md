# GFPAK OPEN — Pokémon Switch 3D Model Converter

**Windows converter:** [Download builds](https://github.com/Unborne-Fetus/GFPAK-OPEN/actions/workflows/build-windows.yml)

**Web 3D studio:** https://unborne-fetus.github.io/GFPAK-OPEN/

GFPAK OPEN recognizes model packages from Pokémon Switch games from **Let's Go Pikachu/Eevee through Legends: Z-A and Mega Dimension**, using different decoding paths. The browser now has **experimental native GFBMDL and Trinity/TRMDL geometry decoders**. They render decoded vertices/indices directly, without running Blender; full game fidelity is not yet verified.

## Game compatibility

| Game | Original native format | Browser rendering | Native conversion route |
| --- | --- | --- | --- |
| Let's Go Pikachu / Eevee | GFBMDL, GFPAK, GFBANM | Native GFBMDL mesh preview/export; also converted assets | Built-in FlatBuffers decoder; original shaders and some GFBANM variants remain unsupported; experimental skeletal clips added |
| Sword / Shield + Isle of Armor + Crown Tundra | GFBMDL, GFPAK | Native GFBMDL mesh preview/export; also converted assets | Built-in FlatBuffers decoder; original shaders and GFBANM are not yet decoded |
| New Pokémon Snap | NUSRCMDLB / NUTEXB | Converted 3D assets | Game-specific extraction required |
| Brilliant Diamond / Shining Pearl | Unity assets and asset bundles | Converted 3D assets | AssetStudio / AssetRipper to FBX/OBJ/GLB |
| Legends: Arceus | GFPAK / TRMDL | Native TRMDL + TRMSH + TRMBF geometry; converted 3D assets | Browser-native experimental Trinity decoder; Oodle GFPAKs still blocked |
| Scarlet / Violet + Teal Mask + Indigo Disk | Trinity / TRMDL | Native TRMDL + TRMSH + TRMBF geometry; converted 3D assets | Browser-native experimental Trinity decoder; textures/animations still partial |
| Legends: Z-A + Mega Dimension | Revised Trinity / TRMDL | Compatible native TRMDL geometry; converted 3D assets | Experimental Trinity decoder; model revisions still need real-data testing |
| Other Switch Pokémon spin-offs | Varies (Unity, custom engines) | Converted 3D assets | Separate extraction may be necessary |

**Important:** Browser-side geometry decoding now handles compatible **GFBMDL** and **TRMDL/TRMSH/TRMBF** resources. Trinity skeleton data (TRSKL) can supply bones/skin weights, and decoded PNG/JPEG material maps can provide approximate PBR shading. Compatible skeletal TRANM and GFBANM tracks now have experimental browser animation playback and GLB export. Some BNTX texture variants, original shaders, unsupported animation variations and **Oodle-compressed** resources still require further decoding, and revised Z-A files have not yet been validated. Only stored or LZ4-compressed GFPAK resources with a matching filename-hash dictionary can be previewed directly; a static GitHub Pages app cannot use a Windows Oodle DLL or Blender.

## GitHub Pages — web 3D studio

The sidebar includes a game selector with automatic filename-based suggestions. It supports:

- GLB, GLTF, FBX, OBJ + MTL, DAE, STL, PLY, 3DS, **GFBMDL, TRMDL and TRMSH** model rendering, using actual geometry decoders.
- ZIP and folder imports with associated local textures and experimental native skeletal animation clips.
- **Standalone texture inspector:** Open individual BNTX/DDS/PNG/JPEG/WebP files or select them inside a ZIP/folder. A Nintendo BNTX container lists every internal named surface; choose a surface, view its original dimensions/format, and save a decoded PNG preview. RGBA8/BGRA8, R8/RG8/RGB565 and BC1–BC5 use CPU decoding; BC7/ASTC previews require WebGL GPU extensions. The original data never leaves your device.
- **Texture inspection inside GFPAKs:** Select any resource and click **PROBE SELECTED TEXTURE** to detect supported BNTX/DDS/PNG/JPEG/WebP signatures without a filename-hash dictionary. A matching dictionary lets you filter known textures and choose the correct names. Only the requested stored/LZ4 entry is extracted; Oodle entries still require a separate compatible decoder.
- Compatible **GFBMDL material references can now load BNTX textures**, including named surfaces from a single local BNTX container; ambiguous matches are skipped rather than assigning incorrect Pokémon markings.
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

The desktop application opens one studio window with the 3D viewer, GFPAK Inspector, **Model Converter**, and **Game File Explorer**. Previews, compatible animations, texture decoding and GLB export run through the bundled native viewer. Blender and its importer are no longer installed, detected, downloaded or launched.

1. Open your game file and select your compatible keys in Game File Explorer.
2. Select a model and click **Preview in 3D**, or select native files/folders in **Model Converter**.
3. Use **Export GLB** in the viewer to save decoded geometry, skeleton, compatible animation clips and textures. **Export Pokémon** saves the associated original assets together in a ZIP.

The portable EXE includes its runtime dependencies. Building it from GitHub with `run.bat` still requires Python and Node.js. Full fidelity for every game/version is not yet supported: unsupported formats report decoder errors rather than requiring another app.
The Model Converter fully scans selected folders and GFPAKs, lists every resolved model, and matches companions across subfolders. Each model can be previewed separately. **Export all GLBs in one ZIP** converts sequentially with compatible textures, skeletons and animations; `export-report.json` records any failures without discarding successful exports. Original Pokémon ZIP export follows the exact source selected in either the converter or explorer, including unresolved archive members where available.

Optional model settings retain filename dictionary selection, an additional texture folder, and the animation inclusion switch. These do not require Blender or its importer.

Compression type 3 can be decompressed with the independently maintained open-source [pyooz](https://pypi.org/project/pyooz/) decoder (installed by run.bat or included in Windows builds), or using a compatible existing local Oodle DLL. No proprietary DLL or game files are downloaded or bundled. Unsupported Oodle variants and unresolvable texture/material references can still prevent a complete conversion.

### Expanded Pokémon Switch archive compatibility (October 2026)

**Added to GFPAK-OPEN's portable desktop build:**

- **XCI game-card files:** Native `HEAD`/HFS0 partition parsing, with browseable `secure`, `normal`, and other present partitions. Their NCA entries can use the existing built-in NCA3 reader. No external XCI tool is needed for supported file structures.
- **Large RomFS IVFC fix:** The built-in reader now recognizes the Switch's standard **seven integrity levels** (six on-disk level descriptors plus the master-hash level), and reads the correct last descriptor instead of rejecting the section with `invalid IVFC layer count`. RomFS data offsets use 64-bit arithmetic, with strict logical bounds. Synthetic integration tests cover seven-level NCA sections, mapped compressed RomFS, and directory metadata at offsets above 4 GiB; this does not imply that all encrypted patch formats are supported.
- **NSZ/XCZ packages:** Read standard NSP-like/ XCI-like outer indexes. Expand an `.ncz` resource to decode supported zstandard stream or NCZBLOCK compression into a temporary NCA in the app's session cache. Encrypted NCZ section payloads are reconstructed from NCZ metadata; the usual authorized keys are still needed for subsequent NCA browsing. This is not a guaranteed decoder for all compressed game releases.
- **Update and DLC NCA inspection:** Per-section detection of BKTR updates, sparse mappings, and compressed storage. Unaffected standard ExeFS sections can be browsed even when a patched RomFS exists. **Compatible read-only BucketTree mapping is now available:** plaintext sparse NCA ranges can zero-fill holes; unpatched compressed NCA sections can decode stored, zero and LZ4 blocks. Repeated small RomFS reads reuse a bounded LZ4 decompression cache for faster browsing. For plaintext BKTR update NCAs, select the update NCA in the Game File Explorer and use **Link base NCA for update** to choose its matching, already-owned original standalone `.nca`; original and patch ranges can then be merged on demand without modifying either source. Encrypted AES-CTR-Ex BKTR overlays, encrypted sparse IV generation, combined sparse/compressed storage and unsupported codecs still require validation. Do not mistake the detection/status report for complete patch reading.
- **Pokémon asset recognition:** Classify discovered Game Freak TRMDL/GFBMDL meshes, materials, `.trskl` skeletons, `.tranm`/`.gfbanm` animations and texture files. Group related `pm####` filename families without assuming internal numbering equals National Pokédex numbering. Unknown hashed entries remain unidentified until verified.
- **Decoded material textures:** Web/native model viewer uses actual compatible PNG/JPEG/WebP and **DDS BCn** textures. GFBMDL geometry previews inside GFPAKs now include BNTX/DDS companion resources rather than silently omitting them. BNTX RGBA8/BGRA8, R8, RG8, RGB565 and BC1–BC5 textures are decoded directly; BC7/ASTC BNTX blocks use GPU-native formats when available. Multi-texture BNTX containers require a matching internal texture name, preventing incorrect Pokémon skins. TRTEX, unsupported BNTX variants and game-specific shaders remain incomplete.
- **Native animation matching:** Automatically rank existing Pokémon animation companions by filename family and location even in large game directories. Actual decoded skeletal tracks only play when they match the loaded rig; unsupported formats still require work.
- **Per-game capability display:** The Game File Explorer identifies recognized Let's Go, Sword/Shield, Legends: Arceus, Scarlet/Violet, Legends: Z-A, BDSP Unity and New Pokémon Snap families, and clearly separates *archive browsing* from fully decoding original 3D models, textures and animations. Recognition is not a guarantee of complete playback.

The expanded functionality has automated synthetic fixture coverage and CI builds; compatibility with every revision of every real Pokémon Switch game has **not** been established. Use local copies of game content you are authorized to inspect. GFPAK-OPEN does not acquire game files or decryption keys.

### Fast 3D preview and three-class asset catalog

- **Faster Preview in 3D:** The desktop File Explorer first requests a small, read-only preview manifest for supported native GFBMDL/TRMDL/TRMSH meshes and common GLB/glTF/OBJ/FBX/DAE models. For native Pokémon models, **geometry is drawn first**, followed by compatible textures and animation clips in the background; the first visible model no longer waits for them. Standard GLB and untextured OBJ previews skip eager loading of unrelated texture files. For compatible assets inside a physical GFPAK **or a GFPAK nested in a readable NCA/RomFS section**, the app streams individual required resources without extracting the entire packed archive. Unsupported native variants report a built-in decoder error; there is no external conversion fallback. Exact performance improvements depend on the real game files, storage and supported formats, and have not been benchmarked.
- **Always full discovery, not partial scans:** Opening an extracted folder, GFPAK, NSP or XCI now automatically traverses **all readable source files, NCA/NCZ sections, and recognized GFPAK members**, including archives nested inside RomFS. No default 4,000/40,000-file, 12/64-NCA, or 1,200-result cutoff remains. The background scanner reports entries visited and which section is being read; the catalog is kept in the desktop process and filtered/paginated into the UI, 250 rows at a time. **Locate assets** reruns a full scan for the current source. Locked/encrypted NCAs, unknown hashes and unsupported resource formats remain explicitly **unresolved**, not falsely shown as verified zero. A full scan of a large game may take time and cannot decrypt inaccessible sections or infer every hashed filename.
- **Automatic model companions:** After the full inventory completes, GFPAK-OPEN associates known models with their likely mesh buffers, skeletons, textures and native animations. Verified same-stem filenames and matching internal `pm####` asset-family IDs take priority; files in a folder with only one model and same-game cross-archive Pokémon matches are labeled **probable**. Generic `body.bntx` or `idle.tranm` files shared among multiple models are not blindly assigned. Model rows show companion counts, and the right-side related-assets panel has clickable texture and animation entries. **Preview in 3D on a compatible GFBMDL/TRMDL model now imports its linked textures and native animation clips automatically, including cross-folder and cross-GFPAK companions:** geometry appears first, supported surface maps are applied to the original mesh materials, skeleton-compatible clips appear in the animation menu and can be played, and GLB export waits for the companion import to finish. Exact material references are respected; otherwise a single clearly associated diffuse texture or uniquely named material matches can be applied. Unsupported BNTX/animation variations or ambiguous matches are reported, never invented or silently substituted.
- **Actionable results:** Selecting a model offers the fast 3D preview. Recognized BNTX, DDS, PNG, JPEG and WebP textures from folders, ZIPs, GFPAKs and readable NCA sections now have **View texture**, which opens the built-in surface inspector and supports PNG export without converting the model. Animation entries show native names, file details and related Pokémon asset families; actual clip playback still requires a compatible loaded model and decoder. Animation clips can play when the matching model's native animation tracks are supported; individual raw animations are not claimed to be full standalone 3D scenes.

### Built-in Game File Explorer

The Windows desktop studio has an integrated read-only **Game File Explorer** tab inspired by NX File Viewer. Use **Open game folder** to browse already extracted game resources and scan for models (`.trmdl`, `.gfbmdl`, GLB, etc.), animations (`.tranm`, `.gfbanm`), textures (`.bntx`, PNG, DDS, etc.), skeletons and materials. You can navigate subfolders, search and filter, inspect GFPAK resource hashes, and launch a temporary preview of compatible model files from the same tab.

Use **Open GFPAK / ZIP / NSP** to browse individual archive structures. ZIPs have a safe nested-file view. GFPAK resources are labeled from verified hash groups and, when decoding works, from hash-verified embedded filenames. Unknown resources are labeled **unidentified**, not fabricated. An NSP opens at its **outer PFS0 index**. GFPAK-OPEN now also includes a **native NCA3/ExeFS/RomFS reader** for supported sections. It reads plaintext sections immediately, and can read compatible encrypted sections only with keys already authorized and supplied by the user; no reader app is needed. Unsupported patched, sparse, compressed and newer encryption formats are explicitly reported instead of fabricating files. Native XCI/HFS0 partition browsing is supported for standard game-card structures. Unsupported textures/animations can be discovered without necessarily being decoded, skinned or rendered.

The recursive scan is bounded to at most 40,000 scanned files per request and the results are capped at 1,200 rows, with truncation clearly indicated.

### Large GFPAK archive handling and packed export

GFPAK indexes are now **lazy on Windows and the web**. The desktop reader maps the index briefly and releases the file immediately; it does not copy a multi-gigabyte GFPAK into RAM. The web studio uses local File/Blob range reads rather than `file.arrayBuffer()` on the whole archive. Opening and searching a GFPAK therefore requires only its metadata. Resource content is fetched on demand.

The built-in explorer shows resource offsets, compressed sizes, hashes and bounded hexadecimal previews. **Save selected file** streams stored entries; **Save packed bytes** streams the original compressed block without requiring a decoder, including for entries larger than 512 MiB. Existing output files are never silently replaced. The browser exports stored and packed resources as Blob slices. LZ4 decoding remains capped at 512 MiB of output; browser Oodle and unsupported game-specific compression are not claimed to work. A large resource can be indexed and inspected even if it cannot yet be decoded to a usable model.

Windows and Node regression tests use synthetic GFPAK fixtures, including a >512 MiB sparse file and an instrumented browser Blob that disallows reading the whole archive. These tests do not validate every Pokémon game or proprietary compression variant.

### File browser reliability audit

GFPAK-OPEN now keeps separate NCA readers and tree nodes for each XCI
partition **even when different partitions contain NCA files with the same
entry index or filename**. Optional linked extractions appear *alongside*
real, readable NCA sections rather than replacing them. Switching game files
removes cached NCZ reconstructions and model preview files owned by the
current session (Windows can defer removal of files held by another process).

In addition to the earlier large-RomFS fix, **ordinary folders, ZIP archive
folders, GFPAK resource lists and XCI game-card partitions** now expose
continuation pages rather than silently cutting off at 2,000 files. The same
"Load next 250 entries" interaction works in both NX-style panes. Filtered
views retain this option even if no match occurs on the current page.

Supported small PNG/JPEG/WebP assets now have in-panel previews whether they
come from a directory, ZIP, or uncompressed/decrypted NCA section. A locked
NCA node exposes its specific parsing error in its Properties panel. The
reader can also handle an NCA whose **header was decrypted** while its
filesystem section remains encrypted; it respects section-level encryption.
Large NCZ reconstruction checks free temporary disk space before writing,
instead of filling the disk unexpectedly.

These reliability fixes are validated using synthetic NSP, XCI, NCZ, RomFS,
ZIP, plaintext-header/AES-CTR and large-directory fixtures. They are not a
claim of universal compatibility with every Nintendo Switch release.
Game-specific encrypted BKTR overlays, encrypted sparse mappings, combined
storage layers, hardware fallbacks for BC7/ASTC BNTX and some animation pipelines still need
additional decoders and real-world test cases.

### Large NCA sections and paginated filesystem browsing

The built-in RomFS reader no longer rejects large sections because metadata tables exceed **16 MiB**, and no longer errors when a single folder contains **3,000+** entries. It uses an LRU cache of 64 KiB metadata pages (32 pages per directory/file index) and opens **250 files per request** instead of copying huge filesystem tables into RAM. A **Load next 250 files** control appears in the left content tree and center file list when the folder has more entries. Repeated clicks browse the full directory without silently dropping later files. Only the metadata pages being accessed are decoded; model/texture payloads remain on disk until selected. File reads and explicit single-file export remain bounded/streamed and do not use the whole section size as an allocation request.

The huge-section regression uses a synthetic **9 GiB** NCA section with 24 MiB and 48 MiB filesystem tables and 3,304 sibling files. This demonstrates the eliminated size/entry limits, but cannot guarantee support for every encrypted or patched NCA variant without real-game validation. **BKTR patch overlays, sparse block remapping, and NCA compressed-storage layers remain separately unsupported** and will show their specific error messages rather than a false size-limit error.

### Native NSP NCA tree — no external application

The Windows portable EXE includes its own NCA3 reader. Open an NSP and expand a Program NCA to inspect **real NCA sections**. Expand supported ExeFS (PartitionFS) or RomFS sections to browse actual nested folders such as `bin/archive/pokemon` without using NX File Viewer, hactool, Blender, or another extractor. Directory tables are read lazily from the original NSP rather than copying an entire multi-gigabyte NCA to temporary storage. You can inspect metadata and hex previews, save individual files explicitly, or select a supported native model for a preview. Single-file previews are cleaned up on exit. The NCA reader itself needs no other executable.

For **encrypted NCAs**, the app can only open the contents when you already have the appropriate authorized keys and choose that local keys file within the application. Those keys are not included, downloaded, searched for or displayed; the key-file contents are never sent to the web interface. Plaintext NCAs need no keys. The native parser currently supports standard NCA3 sections, AES-XTS headers, AES-CTR or plaintext contents, PartitionFS/ExeFS and RomFS. Rights-managed content may need separately available title content keys. Encrypted game-update patch layers, sparse or compressed sections, and older NCA revisions are not yet implemented. It is therefore not guaranteed that every retail NSP can be browsed down to all internal files.

For already-extracted game data, **Link files to selected NCA** remains an optional way to attach that existing folder beneath its relevant NCA; no third-party application is required to browse that folder. GFPAK-OPEN does not claim to verify that the linked extraction matches the selected NSP.

The three-pane layout constrains wide file names and hex previews so the properties inspector does not clip off-screen.

### NX File Viewer-style fourth tab

**Game File Explorer** has been redesigned into a Windows-style, NX File Viewer-inspired interface based on the user's reference screenshots. It has a collapsible **Content tree** (left), file list (center), and type-sensitive **Properties/preview pane** (right), plus functioning File, View, Tools and Help menus. Click a folder name to navigate; click its triangle to expand/collapse without leaving the tree. Double-click compatible models to preview them. Open image files to see a bounded embedded thumbnail, or inspect a short hex and ASCII sample. Use **Save selected file** to copy an individual item from an already-extracted folder, GFPAK, ZIP or the outer NSP index to a chosen path (existing destinations are never overwritten, and protected NCA payloads remain encrypted). Folder and GFPAK nodes are lazily opened so large trees do not need to be fully loaded.

For a game that was already extracted using your own tools, use **Open package**, choose the NSP, then **Link extracted NSP files** to select its existing extracted folder. An **Extracted game files (linked)** node appears under the NSP. Expand it to browse your actual `bin/archive/pokemon`, `chara`, `effect`, animation and texture directories. The linked tree is not represented as decrypted data from the NSP itself; the source NSP is never changed.

This is an independently implemented interface inspired by the [open-source NX File Viewer project](https://github.com/Myster-Tee/NxFileViewer), rather than a copy of its C#/.NET or GPL-3.0 code. Feature parity is incomplete: the app never obtains keys automatically, but its built-in reader can inspect compatible encrypted NCA3 sections using keys supplied locally by the user. XCI/HFS0 and common NSZ/NCZ variants are supported; not all XCI/NSZ/XCZ revisions or patch storage layers are implemented.

### Advanced NSP package workbench

When an NSP is selected, **Game File Explorer** now opens a full **read-only PFS0 analyzer** in the same desktop application:

- **Whole-package inventory:** exact NSP size, index size, indexed file counts, NCA counts, per-role file sizes, and warnings for duplicate names, overlaps, malformed offsets, reserved fields and trailing/unindexed data.
- **Complete indexed browsing:** server-side filename/type/role search, with paginated results across the entire NSP index rather than a fixed first-page sample (250 rows per page). Distinguishes content and metadata NCAs, tickets, certificates, artwork, plaintext metadata and other resources.
- **Plaintext CNMT information where available:** title ID, version, content type, required system version and content references from existing `.cnmt.xml` files. If metadata exists only inside encrypted NCAs, those fields cannot be recovered.
- **Per-file byte inspector:** absolute offset, file size, content ID, file signature, hex+ASCII preview (maximum 1 KiB per request, with selectable byte offset). Ticket payload bytes are intentionally hidden from the hex viewer.
- **Streaming integrity tools:** SHA-256 for a selected file and an optional cancellable SHA-256 audit of every indexed file, with progress. Comparison of an NCA filename's content-ID prefix with the calculated digest is advisory and **not** a complete authenticity check.
- **Explicit, safe export:** save a selected **raw** NSP entry (byte-identical, no decryption) or save a JSON index manifest. Nothing is extracted automatically, existing destinations are not overwritten, and original NSP files are never modified.

The PFS0/HFS0 readers handle large packages without loading their payloads into memory. The built-in native NCA reader can browse supported NCA3 sections directly with user-supplied keys where necessary. Common NCZ/zstandard decompression is session-cached on demand. Neither keys nor games are downloaded, and full patch overlay, sparse, compressed NCA storage and all game-specific graphics formats remain incomplete.



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
- [x] Built-in Windows GFBMDL and TRMDL preview and GLB export entry points.
- [x] ZIP, folder and GFPAK archive inspection.
- [ ] Validate native GFBMDL decoder against real Let's Go and Sword/Shield samples; currently tested with synthetic FlatBuffers-based geometry and browser GLB exports.
- [ ] Validate each other native game family with representative real mesh, texture and animation samples.
- [ ] Decode raw Unity and NUSRCMDLB models directly.
- [ ] Browser-native Oodle decompression (decoder license/performance review), CPU fallbacks for GPU-only BC7/ASTC BNTX textures, and validation of actual Trinity revisions.
- [ ] Validate native model skeletal skinning, native animation interpolation and all shader/material variations against actual game files.

Only process models and game assets you own or are authorized to use.


## Browser-first game explorer (no Windows app required)

**Same File Viewer layout as desktop:** the browser **OPEN GAME FILES** tab now uses the desktop app's three-pane interface: expandable **Content tree** on the left, the current folder's files in the center, and a **Selected Resource** inspector on the right. The File, View, Tools, and Help menus are functional without a Python/Windows bridge. Double-click a folder (or choose a branch in the tree) to navigate; double-click supported models to preview them. Global search and model/animation/texture class filters display results across the entire readable game. File lists and expanded tree leaves are paged in groups of 250 rather than allocating a huge table for every discovered asset. The existing local `prod.keys` reader and exported-asset actions are unchanged.



Open the hosted site or run `npm run dev`, then choose **OPEN GAME FILES**. Drag an NSP/NSZ/XCI/XCZ to the main drop area, or use **Open NSP / XCI / GFPAK**. You can also use **Open extracted folder** to scan all available model, animation and texture files in a directory.

The web reader streams **index metadata** from local files (rather than loading gigabyte-sized games into RAM) and currently supports:

- NSP/NSZ **outer PFS0** file indexes and XCI **HFS0 game-card partition** indexes
- NCA3 encrypted headers (AES-XTS), AES-CTR filesystem sections, and plaintext NCA sections, with **PartitionFS and RomFS** file browsing when compatible user-supplied keys are loaded
- Full extracted-folder indexing, model/texture/animation filters, filename search, save selected original, and export full index JSON
- Browser GFPAK inspection of package resources, plus native 3D preview and GLB / Pokémon ZIP export for compatible decoded models and companions
- A shared preview pipeline: select a readable GFBMDL/TRMDL/GLB model and press **Preview selected in 3D**; the 3D viewer can export GLB or a Pokémon ZIP when appropriate.

### Decrypting game contents in the browser

1. Open **OPEN GAME FILES** in the web studio.
2. Press **Load local prod.keys** and select your own locally available compatible key file. Nothing is uploaded and the key-file text is not stored in browser storage.
3. Choose your NSP or XCI. The browser decrypts compatible NCA3 headers (AES-XTS) and filesystem sections (AES-CTR or AES-XTS) using WebCrypto. If the game was already open, selecting a key file automatically rescans it.
4. Filter the discovered files to models/textures/animations, then preview or export any readable Pokémon resource. Press **Forget keys** to clear loaded key values and references to the decrypted asset catalog.

**Important limits:** `prod.keys` does **not** necessarily contain title content keys for rights-managed NCAs; a separately available compatible title key may be required. Some newer titles also use key revisions that must match the provided keys. The web reader does not yet decode **NCZ payload compression**, **sparse/compressed/patch NCA storage**, complex DLC/update overlays, or every original Pokémon model/shader/animation format. An encrypted or unsupported section stays visibly locked/unavailable; it is **not** counted as having zero assets. Downloaded decrypted files are explicit user-selected exports only, not automatic whole-game extraction. The app does not distribute or look up keys. Use only game data and keys you are authorized to access.

## Exporting Pokémon to Pokédex 3D Max

1. Open your own extracted game data and select the correct **Game Source** (important for game-internal Pokémon IDs).
2. Preview the Pokémon and allow all matched textures and animations to finish loading.
3. Click **Export Pokémon**. The ZIP contains original model/texture/skeleton/animation resources, a `gfpak-pokemon-export.json` interoperability manifest, and—if conversion succeeds—`pokedex3d/regular.glb`.
4. In the Pokédex 3D Max project, drag the ZIP onto `import-gfpak-pokemon.bat` (or double-click that file and pick the ZIP). No Blender is used by this new GLB import path.

The Pokédex's strict baseline requires complete embedded textures **and a recognizable idle animation**. If native materials or animations are still unsupported for that Pokémon, GFPAK exports the original files and clearly marks the ZIP `original-assets-only` rather than inventing a working GLB. This format does not imply every game source is already conversion-compatible. Existing Pokédex models are not overwritten by default.
