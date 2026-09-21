const $ = (s) => document.querySelector(s);
const state = { person:null, assets:[], reviewed:new Set(), activeFace:null, activeCard:null, people:[] };

async function api(url, options={}) {
  const r = await fetch(url, { ...options, headers:{'content-type':'application/json', ...(options.headers||{})} });
  if (!r.ok) { let msg=`HTTP ${r.status}`; try{ const d=await r.json(); msg=d.message||msg; }catch{} throw new Error(msg); }
  const ct=r.headers.get('content-type')||'';
  return ct.includes('application/json') ? r.json() : r;
}
function toast(msg){ const el=$('#toast'); el.textContent=msg; el.classList.remove('hidden'); clearTimeout(toast.t); toast.t=setTimeout(()=>el.classList.add('hidden'),2600); }
function esc(s=''){return s.replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
function fmtDate(d){return new Intl.DateTimeFormat('de-AT',{day:'2-digit',month:'2-digit',year:'numeric'}).format(new Date(d));}
function ageAt(birth, taken){
  if(!birth) return 'Alter unbekannt';
  const b=new Date(`${birth}T00:00:00`), t=new Date(taken); if(t<b) return 'vor Geburt?';
  let y=t.getFullYear()-b.getFullYear(), m=t.getMonth()-b.getMonth(), day=t.getDate()-b.getDate();
  if(day<0) m--; if(m<0){y--;m+=12;}
  if(y<2) return y===0 ? `${Math.max(0,m)} Monate` : `${y} Jahr ${m} Monate`;
  return `${y} Jahre`;
}
function thumbPerson(id){return `/review-api/people/${id}/thumbnail`;}
function thumbAsset(id){return `/review-api/assets/${id}/thumbnail?size=preview`;}

async function init(){
  try{ const s=await api('/review-api/status'); $('#status').textContent=`Verbunden · ${s.keyName}`; $('#status').className='status ok'; }
  catch(e){ $('#status').textContent='Immich nicht erreichbar'; $('#status').className='status bad'; $('#people').innerHTML=`<div class="error">${esc(e.message)}</div>`; return; }
  await loadPeople();
}
async function loadPeople(){
  $('#people').innerHTML='<div class="loading">Personen werden geladen…</div>';
  try{
    const all=[]; let page=1;
    while(page<100){ const d=await api(`/review-api/people?page=${page}&size=250`); all.push(...d.people); if(!d.hasNextPage) break; page++; }
    state.people=all.sort((a,b)=>(a.name||'').localeCompare(b.name||'', 'de'));
    renderPeople(state.people);
  }catch(e){ $('#people').innerHTML=`<div class="error">${esc(e.message)}</div>`; }
}
function renderPeople(people){
  $('#people').innerHTML=people.map(p=>`<button class="person-card" data-person="${p.id}"><img class="person-avatar" loading="lazy" src="${thumbPerson(p.id)}" alt=""><div class="person-name">${esc(p.name||'Unbenannt')}</div><div class="muted">${p.birthDate?`geb. ${fmtDate(p.birthDate)}`:'kein Geburtsdatum'}</div></button>`).join('') || '<div class="muted">Keine Personen.</div>';
  document.querySelectorAll('[data-person]').forEach(b=>b.onclick=()=>selectPerson(b.dataset.person));
}
$('#personSearch').addEventListener('input',e=>{ const q=e.target.value.trim().toLowerCase(); renderPeople(!q?state.people:state.people.filter(p=>(p.name||'').toLowerCase().includes(q))); });

async function selectPerson(id){
  $('#chooser').classList.add('hidden'); $('#review').classList.remove('hidden'); $('#timeline').innerHTML='<div class="panel loading">Fotos und Gesichter werden geladen…</div>';
  try{
    state.person=await api(`/review-api/people/${id}`); state.reviewed.clear();
    $('#selectedPersonName').textContent=state.person.name||'Unbenannt'; $('#selectedPersonThumb').src=thumbPerson(id);
    $('#selectedPersonMeta').textContent=state.person.birthDate?`Geburtsdatum ${fmtDate(state.person.birthDate)}`:'Kein Geburtsdatum – Alter kann nicht berechnet werden';
    const d=await api(`/review-api/people/${id}/assets`); state.assets=d.items;
    $('#selectedPersonMeta').textContent += ` · ${d.count} Fotos`;
    await renderTimeline();
  }catch(e){ $('#timeline').innerHTML=`<div class="panel error">${esc(e.message)}</div>`; }
}

async function renderTimeline(){
  const tl=$('#timeline'); tl.innerHTML=''; $('#empty').classList.toggle('hidden',state.assets.length!==0);
  for(const asset of state.assets){
    const card=document.createElement('article'); card.className='review-card'; card.dataset.asset=asset.id;
    const taken=asset.fileCreatedAt||asset.localDateTime||asset.createdAt;
    card.innerHTML=`<div class="full-wrap"><img class="full-photo" loading="lazy" src="${thumbAsset(asset.id)}" alt="${esc(asset.originalFileName||'Foto')}"><div class="face-box hidden"></div></div><aside class="side"><canvas class="crop" width="500" height="500"></canvas><div><div class="date">${fmtDate(taken)}</div><div class="age">${ageAt(state.person.birthDate,taken)}</div><div class="muted">${esc(asset.originalFileName||'')}</div></div><div class="actions"><button class="btn warn reassign">Falsche Zuordnung ändern</button><span class="badge ok-badge hidden">Korrigiert</span></div></aside>`;
    tl.appendChild(card);
    setupCard(card, asset);
  }
}

async function setupCard(card, asset){
  try{
    const faces=await api(`/review-api/assets/${asset.id}/faces`);
    const face=faces.find(f=>f.person?.id===state.person.id);
    if(!face){ card.querySelector('.actions').insertAdjacentHTML('afterbegin','<div class="muted">Kein passendes Face-Objekt gefunden.</div>'); card.querySelector('.reassign').disabled=true; return; }
    card._face=face;
    const img=card.querySelector('.full-photo');
    img.addEventListener('load',()=>{ drawCrop(card,img,face); positionBox(card,img,face); });
    if(img.complete) { drawCrop(card,img,face); positionBox(card,img,face); }
    card.querySelector('.reassign').onclick=()=>openReassign(card,face,asset);
  }catch(e){card.querySelector('.actions').insertAdjacentHTML('afterbegin',`<div class="error">Face: ${esc(e.message)}</div>`);}
}
function cropRect(face){
  const fw=face.boundingBoxX2-face.boundingBoxX1, fh=face.boundingBoxY2-face.boundingBoxY1, side=Math.max(fw,fh)*1.75;
  const cx=(face.boundingBoxX1+face.boundingBoxX2)/2, cy=(face.boundingBoxY1+face.boundingBoxY2)/2;
  let x=Math.max(0,cx-side/2), y=Math.max(0,cy-side/2), w=Math.min(side,face.imageWidth-x), h=Math.min(side,face.imageHeight-y);
  return {x,y,w,h};
}
function drawCrop(card,img,face){
  const c=card.querySelector('.crop'), ctx=c.getContext('2d'), r=cropRect(face), sx=img.naturalWidth/face.imageWidth, sy=img.naturalHeight/face.imageHeight;
  ctx.clearRect(0,0,c.width,c.height); ctx.fillStyle='#e5e7eb';ctx.fillRect(0,0,c.width,c.height);
  ctx.drawImage(img,r.x*sx,r.y*sy,r.w*sx,r.h*sy,0,0,c.width,c.height);
}
function positionBox(card,img,face){
  const wrap=card.querySelector('.full-wrap'), box=card.querySelector('.face-box');
  const scale=Math.min(wrap.clientWidth/img.naturalWidth, wrap.clientHeight/img.naturalHeight), rw=img.naturalWidth*scale, rh=img.naturalHeight*scale;
  const ox=(wrap.clientWidth-rw)/2, oy=(wrap.clientHeight-rh)/2, sx=rw/face.imageWidth, sy=rh/face.imageHeight;
  box.style.left=`${ox+face.boundingBoxX1*sx}px`;box.style.top=`${oy+face.boundingBoxY1*sy}px`;box.style.width=`${(face.boundingBoxX2-face.boundingBoxX1)*sx}px`;box.style.height=`${(face.boundingBoxY2-face.boundingBoxY1)*sy}px`;box.classList.remove('hidden');
}
window.addEventListener('resize',()=>document.querySelectorAll('.review-card').forEach(c=>{if(c._face){const i=c.querySelector('.full-photo');if(i.complete)positionBox(c,i,c._face)}}));

function openReassign(card,face,asset){ state.activeFace=face; state.activeCard=card; $('#reassignInfo').textContent=`${fmtDate(asset.fileCreatedAt||asset.localDateTime||asset.createdAt)} · ${asset.originalFileName||''}`; $('#targetSearch').value=''; renderTargets(state.people.filter(p=>p.id!==state.person.id).slice(0,40)); $('#reassignDialog').showModal(); }
function renderTargets(people){ $('#targetPeople').innerHTML=people.map(p=>`<button type="button" class="target-item" data-target="${p.id}"><img src="${thumbPerson(p.id)}" alt=""><div><strong>${esc(p.name||'Unbenannt')}</strong><div class="muted">${p.birthDate?fmtDate(p.birthDate):''}</div></div></button>`).join(''); document.querySelectorAll('[data-target]').forEach(b=>b.onclick=()=>reassign(b.dataset.target)); }
$('#targetSearch').addEventListener('input',async e=>{ const q=e.target.value.trim(); if(!q)return renderTargets(state.people.filter(p=>p.id!==state.person.id).slice(0,40)); try{renderTargets((await api(`/review-api/people/search?q=${encodeURIComponent(q)}`)).filter(p=>p.id!==state.person.id));}catch(e){toast(e.message);} });
async function reassign(personId){ try{ await api(`/review-api/faces/${state.activeFace.id}/reassign`,{method:'PUT',body:JSON.stringify({personId})}); markReviewed(); $('#reassignDialog').close(); toast('Gesicht wurde neu zugeordnet'); }catch(e){toast(e.message);} }
function markReviewed(){ if(!state.activeCard)return; state.reviewed.add(state.activeCard.dataset.asset); state.activeCard.classList.add('reviewed'); state.activeCard.querySelector('.ok-badge').classList.remove('hidden'); if($('#hideReviewed').checked)state.activeCard.classList.add('hidden'); }
$('#createPersonBtn').onclick=async()=>{ const name=$('#newPersonName').value.trim(); if(!name)return toast('Bitte Namen eingeben'); try{const p=await api('/review-api/people',{method:'POST',body:JSON.stringify({name,birthDate:$('#newPersonBirthDate').value||null})}); state.people.push(p); await reassign(p.id); $('#newPersonName').value=''; $('#newPersonBirthDate').value='';}catch(e){toast(e.message);} };
$('#closeDialog').onclick=()=>$('#reassignDialog').close();
$('#backBtn').onclick=()=>{ $('#review').classList.add('hidden');$('#chooser').classList.remove('hidden');state.person=null; };
$('#hideReviewed').onchange=e=>state.reviewed.forEach(id=>document.querySelector(`[data-asset="${id}"]`)?.classList.toggle('hidden',e.target.checked));

init();
