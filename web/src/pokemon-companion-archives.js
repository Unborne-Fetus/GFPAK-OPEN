/** Pick local archive companions for a Pokémon model.
 * Matching only a full pm####_form_variant token missed PLA animation packs
 * named by species or form. We never cross species and we prefer the exact
 * model/form; no network, file uploads, or full-game decompression.
 */
export function pokemonArchiveIdentity(name) {
  const normalized=String(name||'').replaceAll('\\','/').toLowerCase();
  const match=normalized.match(/(?:^|[^a-z0-9])pm(\d{4})(?:_(\d{2}))?(?:_(\d{2}))?(?=$|[^a-z0-9])/);
  if(!match)return null;
  return {species:'pm'+match[1],form:match[2]||null,variant:match[3]||null};
}
export function selectPokemonCompanionArchives(entries,model,{maxArchives=24,maxBytes=160*1024*1024}={}){
  const id=pokemonArchiveIdentity(model.name);
  if(!id)return [];
  const parent=String(model.name).replaceAll('\\','/').split('/').slice(0,-1).join('/');
  let score=0;
  const candidates=entries.filter(row=>{
    if(row===model||!/\.gfpak$/i.test(row.name)||!(row.size>0)||
      row.size>64*1024*1024)return false;
    const other=pokemonArchiveIdentity(row.name);
    return other?.species===id.species;
  }).map(row=>{
    const other=pokemonArchiveIdentity(row.name);
    let rating=50;
    if(other.form===id.form)rating+=70;
    else if(other.form!==null&&id.form!==null)rating-=80;
    if(other.variant===id.variant)rating+=20;
    else if(other.variant!==null&&id.variant!==null)rating-=10;
    if(String(row.name).includes(parent+'/'))rating+=10;
    if(/(?:anim|motion|battle|idle|tex|skin|mat|base)/i.test(row.name))rating+=8;
    return {row,rating};
  }).sort((a,b)=>b.rating-a.rating||a.row.name.localeCompare(b.row.name));
  const chosen=[];
  for(const {row} of candidates){
    if(chosen.length>=maxArchives)break;
    if(score+row.size>maxBytes)continue;
    chosen.push(row);score+=row.size;
  }
  return chosen;
}
