/**
 * Privacy-preserving viewer diagnosis. Describes only the locally selected
 * asset manifest and the *actual* rendered meshes/textures; never reads or
 * exports source game bytes or browser credentials.
 */
export function previewDiagnostics(project,loaded,{textureVariant='regular',activity=[]}={}) {
  const items=(project?.items||[]).slice(0,12000);
  const resources=items.map(item=>({
    path:item.path,
    size:item.size??null,
    sourceArchive:item.sourceArchive||null,
    resourceIndex:item.sourceResourceIndex??null,
    pathHash:item.pathHash||null,
    fileHash:item.fileHash||null,
    format:item.detectedType||item.path?.split('.').at(-1)||null,
    canonicalNameVerified:item.nameVerified===true,
    descriptorAliases:(item.nativeAliases||[]).slice(0,30),
    descriptorMatches:(item.resourceMatches||[]).slice(0,30),
    linkedKind:item.linkedKind||null,
    textureVariant:item.textureVariant||null,
    textureSurfaces:(item.textureNames||[]).slice(0,100)
  }));
  const warnings=[];
  const guessed=resources.filter(row=>row.descriptorMatches.some(
    claim=>claim.evidence==='UNVERIFIED-RESOURCE-ORDER'));
  if(guessed.length)warnings.push(guessed.length+
    ' resource(s) connected by UNVERIFIED resource order. Their mesh or buffer may be incorrect.');
  const uniqueMaterials=new Map();
  const meshes=[];
  loaded?.root?.traverse?.(node=>{
    if(!node.isMesh)return;
    const position=node.geometry?.getAttribute?.('position');
    const uv=node.geometry?.getAttribute?.('uv');
    const skinIndex=node.geometry?.getAttribute?.('skinIndex');
    const triangles=node.geometry?.index?.count
      ? Math.floor(node.geometry.index.count/3)
      : Math.floor((position?.count||0)/3);
    meshes.push({
      name:node.name,
      vertices:position?.count||0,
      triangles,
      uv0:uv?.count||0,
      boneJointAttributes:skinIndex?.count||0,
      skinned:!!node.isSkinnedMesh
    });
    for(const material of Array.isArray(node.material)?node.material:[node.material]){
      if(!material)continue;
      const key=material.uuid||material.name||'unknown';
      if(uniqueMaterials.has(key))continue;
      const texture=(tex)=>tex ? {
        name:tex.name||'unnamed',
        width:tex.image?.width??tex.source?.data?.width??null,
        height:tex.image?.height??tex.source?.data?.height??null,
        minFilter:tex.minFilter??null,
        magFilter:tex.magFilter??null,
        format:tex.format??null
      } : null;
      uniqueMaterials.set(key,{
        name:material.name,
        type:material.type,
        alphaTest:material.alphaTest,
        transparent:material.transparent,
        baseColor:material.color?.getHexString?.()||null,
        albedo:texture(material.map),
        normal:texture(material.normalMap),
        alpha:texture(material.alphaMap),
        displacement:texture(material.nativeDisplacementMap),
        mask:texture(material.layerMaskMap)
      });
    }
  });
  const materials=[...uniqueMaterials.values()];
  if(materials.some(row=>!row.albedo))
    warnings.push(materials.filter(row=>!row.albedo).length+
      ' rendered material(s) have no decoded albedo (color) texture.');
  if(meshes.some(row=>row.vertices>0 && row.uv0===0))
    warnings.push('Some rendered mesh parts have no UV0 coordinates.');
  if(loaded?.sourceFormat==='TRMDL' && !loaded?.sourceStats?.bones)
    warnings.push('No skeleton is attached to the rendered model.');
  if(loaded && !loaded.animations?.length)
    warnings.push('No playable animations are currently attached.');
  if(!resources.some(row=>row.textureSurfaces.length))
    warnings.push('No BNTX internal texture names were recovered; cannot validate regular versus shiny.');
  if((project?.scanSummary?.classification?.UNIDENTIFIED||0)>0)
    warnings.push(project.scanSummary.classification.UNIDENTIFIED+
      ' GFPAK resources could not be classified and might include missing textures, rigs or animation data.');
  return {
    schemaVersion:1,
    selectedModel:loaded?.selected||null,
    sourceGame:project?.label||null,
    selectedTextureVariant:textureVariant,
    sourceFormat:loaded?.sourceFormat||null,
    sourceStats:loaded?.sourceStats||null,
    companionLoading:!!loaded?.postLoad && !loaded?.companionsReady,
    scanSummary:project?.scanSummary||null,
    resources,
    rendered:{meshes,materials,animationNames:(loaded?.animations||[]).map(c=>c.name)},
    warnings,
    activity:activity.map(String).slice(-100)
  };
}
