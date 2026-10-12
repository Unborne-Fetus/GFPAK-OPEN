/** Game-aware format guidance: converted meshes render in-browser; native game assets require a decoder. */
export const GAMES = Object.freeze([
  { id:'auto', name:'Auto-detect format', year:'', engine:'Automatic', native:[], tags:[],
    short:'Inspect source files and choose a game when filenames are ambiguous.',
    hint:'Compatible GLB, GLTF, FBX, OBJ and DAE exports render directly.' },
  { id:'lgpe', name:"Let's Go Pikachu / Eevee", year:'2018', engine:'Game Freak GFBMDL',
    native:['.gfpak','.gfbmdl','.gfbanm','.bntx'],tags:['letsgo','lets_go','lgpe'],
    short:'Legacy Game Freak models',hint:'Native GFBMDL geometry now previews and exports GLB in the browser. For accurate textures, rigs and GFBANM animation, use the desktop converter and decoded assets.' },
  { id:'swsh', name:'Sword / Shield + DLC', year:'2019–2020', engine:'Game Freak GFBMDL',
    native:['.gfpak','.gfbmdl','.gfbanm','.bntx'],tags:['sword','shield','swsh','crown_tundra','isle_of_armor'],
    short:'Includes Isle of Armor and Crown Tundra',hint:'Native GFBMDL meshes can now render in-browser. Full original materials, textures and animations still require additional conversion.' },
  { id:'snap', name:'New Pokémon Snap', year:'2021', engine:'Bandai Namco custom',
    native:['.nusrcmdlb','.nutexb','.nushdb'],tags:['new_pokemon_snap','pokemon_snap','newsnap'],
    short:'Custom model engine',hint:'Extract NUSRCMDLB with a compatible game-specific tool, then load FBX/OBJ/DAE/GLB.' },
  { id:'bdsp', name:'Brilliant Diamond / Shining Pearl', year:'2021', engine:'Unity',
    native:['.assets','.bundle','.unity3d','.prefab','.asset','.ress'],tags:['bdsp','brilliant_diamond','shining_pearl','brilliantdiamond','shiningpearl'],
    short:'Unity models and textures',hint:'Use AssetRipper or AssetStudio to export FBX and textures. The web viewer can load the exported models.' },
  { id:'pla', name:'Legends: Arceus', year:'2022', engine:'Game Freak Trinity',
    native:['.gfpak','.trmdl','.trmsh','.trmbf','.trskl','.tranm','.bntx'],tags:['legends_arceus','arceus','pla','la_poke'],
    short:'Trinity meshes and often Oodle-compressed archives',hint:'Extract a complete TRMDL/TRMSH/TRMBF package to preview actual geometry in the browser. Compatible Oodle GFPAK resources now decode locally through WASM. Some BNTX textures, native animation tracks and game shaders still need further work.' },
  { id:'sv', name:'Scarlet / Violet + DLC', year:'2022–2024', engine:'Game Freak Trinity',
    native:['.gfpak','.trmdl','.trmsh','.trmbf','.trskl','.tranm','.bntx'],tags:['scarlet','violet','sv_poke','sv-poke','teal_mask','indigo_disk','hidden_treasure'],
    short:'Includes both expansions and epilogue',hint:'Import a decoded TRMDL with matching TRMSH/TRMBF for native browser preview and GLB export. Game-specific shader/texture variations and animation tracks still need validation.' },
  { id:'za', name:'Legends: Z-A + Mega Dimension', year:'2025–2026', engine:'Game Freak Trinity (revised)',
    native:['.gfpak','.trmdl','.trmsh','.trmbf','.trskl','.tranm','.bntx'],tags:['legends_za','legends-z-a','mega_dimension','megadimension','za_poke','pza'],
    short:'Newer Trinity model revisions',hint:'The experimental browser Trinity decoder can read compatible decoded TRMDL/TRMSH/TRMBF data. Z-A revisions, materials and Mega Dimension animations need actual-model validation; use GFTool when a format is unsupported.' },
  { id:'other', name:'Other Pokémon Switch games', year:'2018–2026', engine:'Various engines',
    native:['.assets','.bundle','.unity3d','.nusrcmdlb','.gfbmdl','.trmdl','.gfpak'],
    tags:['rescue_team_dx','detective_pikachu','pokemon_unite','pokemon_quest','pokemon_home','cafe_remix'],
    short:'Additional spin-offs', hint:'Use a compatible game-specific extractor to get GLB/GLTF/FBX/OBJ/DAE before importing here.' }
]);
export const NATIVE_EXTENSIONS=new Set(GAMES.flatMap(g=>g.native||[]));
export const CONVERTED_EXTENSIONS=new Set(['.glb','.gltf','.fbx','.obj','.dae','.stl','.ply','.3ds']);
export function fileExtension(name){
  const clean=String(name).split(/[?#]/,1)[0];const n=clean.lastIndexOf('.');
  return n<0?'':clean.slice(n).toLowerCase();
}
export function gameById(id){return GAMES.find(g=>g.id===id)||GAMES[0];}
export function detectGameFromNames(names){
  const joined=[...names].slice(0,10000).join(' ').replace(/[/\\\s-]+/g,'_').toLowerCase();
  const profiles=GAMES.filter(g=>g.id!=='auto'&&g.id!=='other');
  for (const g of profiles) if(g.tags?.some(tag=>joined.includes(tag.replace(/-/g,'_')))) return g;
  return GAMES[0];
}
export function identifyFormat(names){
 const items=[...names];const exts=new Set(items.map(fileExtension));
 const converted=items.filter(n=>CONVERTED_EXTENSIONS.has(fileExtension(n)));
 const native=items.filter(n=>NATIVE_EXTENSIONS.has(fileExtension(n)));
 return {converted,native,hasGfpak:exts.has('.gfpak'),hasTrmdl:exts.has('.trmdl'),
 hasGfbmdl:exts.has('.gfbmdl'),hasUnity:['.unity3d','.assets','.bundle','.asset','.prefab'].some(e=>exts.has(e)),
 hasSnap:exts.has('.nusrcmdlb'),extensions:exts};
}
export function describeSource(gameId,names){
 const f=identifyFormat(names);const game=gameById(gameId);
 if(f.converted.length)return {kind:'renderable',title:String(f.converted.length)+' renderable 3D model(s)',
   message:'Load a model to preview and export GLB. Original game shaders may not survive conversion.'};
 if(f.hasGfpak)return {kind:'native',title:'GFPak model archive detected',
   message:'Use the Archive Inspector to preview stored, LZ4 or Oodle GFPAK model resources. Unknown Trinity names can often be recovered by inspecting genuine mesh references; some codec variants remain unsupported.'};
 if(f.hasGfbmdl)return {kind:'native',title:'Native GFBMDL model available',
   message:'GFBMDL geometry can now be decoded and rendered directly in the browser, including GLB export. Game-specific shaders, BNTX textures, skeleton rigging and animations remain incomplete.'};
 if(f.hasTrmdl||f.extensions.has('.trmsh'))return {kind:'native',title:'Native Trinity model ready for inspection',
   message:game.id!=='auto'?game.hint:'Native TRMDL/TRMSH can now render mesh geometry in-browser when matching TRMBF buffers are supplied. Shaders, BNTX and full animation decoding are still incomplete.'};
 if(f.hasUnity)return {kind:'native',title:'Unity source assets',
   message:'Unity asset bundles cannot be rendered directly in GitHub Pages. Export FBX/OBJ/GLB and textures with a Unity asset tool first.'};
 if(f.hasSnap)return {kind:'native',title:'New Pokémon Snap source model',
   message:'NUSRCMDLB models need a game-specific extractor; import the resulting FBX/OBJ/DAE/GLB.'};
 return {kind:'unknown',title:'No renderable models detected',
   message:'Open a converted GLB, GLTF, FBX, OBJ, DAE, PLY, STL or 3DS model, or the ZIP containing its dependencies.'};
}

/** Separates file browsing from genuine native 3D rendering support. */
export const GAME_CAPABILITIES = Object.freeze({
  auto: {archives:'Generic NSP/XCI/NSZ/XCZ inspection',models:'Unknown engine',textures:'Decoded images and DDS',animations:'Unverified'},
  lgpe: {archives:'Browse supported game archive structures',models:'GFBMDL geometry (partial)',textures:'Decoded images and DDS; BNTX incomplete',animations:'Selected matching GFBANM clips'},
  swsh: {archives:'Browse supported game archive structures',models:'GFBMDL geometry (partial)',textures:'Decoded images and DDS; BNTX incomplete',animations:'Selected matching GFBANM clips'},
  pla: {archives:'Browse supported game archive structures',models:'Trinity TRMDL mesh geometry (partial)',textures:'Decoded images and DDS; BNTX incomplete',animations:'Selected matching TRANM clips'},
  sv: {archives:'Browse supported game archive structures',models:'Trinity TRMDL mesh geometry (partial)',textures:'Decoded images and DDS; BNTX incomplete',animations:'Selected matching TRANM clips'},
  za: {archives:'Browse supported game archive structures',models:'Revised Trinity format (experimental)',textures:'Decoded images and DDS; BNTX incomplete',animations:'TRANM playback experimental'},
  bdsp: {archives:'Browse supported game archive structures',models:'Unity native assets not yet decoded',textures:'Unity bundles not yet decoded',animations:'Unity clips not yet decoded'},
  snap: {archives:'Browse supported game archive structures',models:'NUSRCMDLB native decoding not yet supported',textures:'NUTEXB native decoding not yet supported',animations:'Original motion tracks not yet supported'},
  other: {archives:'Browse supported game archive structures',models:'Game-specific native decoding needed',textures:'Game-specific decoding needed',animations:'Game-specific decoding needed'}
});
export function gameCapabilities(id) {
  return GAME_CAPABILITIES[id] || GAME_CAPABILITIES.other;
}
