(function(){
"use strict";
const PUB = window.__PUBLIC__ || null;
function showFatal(msg){
  try{
    let box=document.getElementById("err-box");
    if(!box){ box=document.createElement("div"); box.id="err-box"; box.className="err-box"; box.setAttribute("role","alert"); document.body.appendChild(box); }
    box.innerHTML='<strong>Algo deu errado nesta tela.</strong><span>Mande um print desta mensagem para o Claude:</span><code></code><button type="button">Fechar</button>';
    box.querySelector("code").textContent=String(msg||"erro desconhecido").slice(0,300)+" · "+navigator.userAgent.replace(/^Mozilla\/5\.0 /,"").slice(0,120);
    box.querySelector("button").onclick=()=>box.remove();
  }catch(e){}
}
window.addEventListener("error",e=>{ if(e && e.message) showFatal(e.message+(e.filename?" ("+String(e.filename).split("/").pop()+":"+e.lineno+")":"")); });
window.addEventListener("unhandledrejection",e=>{ const r=e&&e.reason; showFatal("Promessa rejeitada: "+(r&&(r.message||r.code)||r)); });           // set only in the exported public file
const PRIVATE_VIEWS = ["hoje","reservas","custos","checklists","gravacoes"];
const VIEWS = [
  ["inicio","Início"],["hoje","Hoje"],["roteiro","Roteiro"],["mapa","Mapa"],["guia","Guia"],
  ["reservas","Reservas"],["custos","Custos"],["checklists","Checklists"],["gravacoes","Gravações"]
];
const TIPOS = {transporte:"Transporte",atracao:"Atração",comida:"Comida",fora:"Fora da rota",gravacao:"Gravação",aviso:"Atenção",livre:"Livre"};
const CATS = ["Voos","Hospedagem","Transporte local","Alimentação","Ingressos","Documentos e taxas","Seguro e chip","Outros"];
const CHK_GROUPS = ["Documentos","Reservas","Mala de inverno","Kit de filmagem","Chegada na Irlanda"];
const TAKE_STATUS = [["ideia","Ideias"],["gravado","Gravado"],["editado","Editado"],["publicado","Publicado"]];
const RES_TIPOS = {voo:"Voo",hospedagem:"Hospedagem",trem:"Trem / ônibus",ingresso:"Ingresso",outro:"Outro"};

const S = {
  site:{}, priv:{cambio:6.3,teto:null},
  dias:[], itens:[], custos:[], checklists:[], takes:[], reservas:[], lugares:[], guia:[],
  canEdit:false, publicView:false, db:null, assets:null, downloads:null,
  loaded:false, noDb:false, userKnown:false, hojeOff:0, fEstado:"", fAno:"", view:"inicio", guiaSel:null, picking:null, mapZoom:"mundo"
};

/* ---------- helpers ---------- */
const $ = (s,el=document)=>el.querySelector(s);
const esc = v => String(v==null?"":v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const safeUrl = u => /^https?:\/\//i.test(String(u||"").trim()) ? String(u).trim() : "";
const eur = n => (n==null||n==="")?"—":new Intl.NumberFormat("pt-BR",{style:"currency",currency:"EUR"}).format(+n);
const brl = n => (n==null||n==="")?"—":new Intl.NumberFormat("pt-BR",{style:"currency",currency:"BRL"}).format(+n);
const num = v => { if(v===""||v==null) return null; const n=parseFloat(String(v).replace(",",".")); return isFinite(n)?n:null; };
let regionNames=null; try{regionNames=new Intl.DisplayNames(["pt-BR"],{type:"region"});}catch(e){}
const countryName = a2 => { if(!a2) return "Sem país"; try{return regionNames?regionNames.of(a2):a2;}catch(e){return a2;} };
const flag = a2 => (a2&&a2.length===2&&a2!=="XK") ? String.fromCodePoint(...[...a2.toUpperCase()].map(c=>127397+c.charCodeAt(0))) : "";
const fmtDay = iso => { const d=new Date(iso+"T12:00:00"); return {
  n:d.getDate(), wd:d.toLocaleDateString("pt-BR",{weekday:"long"}), mo:d.toLocaleDateString("pt-BR",{month:"long"}),
  short:d.toLocaleDateString("pt-BR",{day:"numeric",month:"short"}) }; };
const isPrivateNow = () => !S.canEdit || S.publicView || !!PUB;
const imgSrc = (id,data) => data || (id ? "/_blob/"+id : "");
function toast(msg){ const t=document.createElement("div"); t.className="toast"; t.setAttribute("role","status"); t.textContent=msg; document.body.appendChild(t); setTimeout(()=>t.remove(),2600); }
const uid = () => Math.random().toString(36).slice(2,10)+Date.now().toString(36).slice(-4);

const todayISO = () => { const d=new Date(); return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); };
const addDays = (iso,n) => { const d=new Date(iso+"T12:00:00"); d.setDate(d.getDate()+n); return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); };
function tripRunning(){ const ds=S.dias.map(d=>d.data).filter(Boolean).sort(); if(!ds.length) return false; const t=todayISO(); return t>=ds[0] && t<=ds[ds.length-1]; }
const SMALL = new Set(["de","da","do","das","dos","e","del","la","las","los","y","di","van","der","den","von","op","aan","het"]);
function tidyName(raw){
  let t=String(raw||"").replace(/\s+/g," ").trim(); if(!t) return t;
  if(t===t.toUpperCase() || t===t.toLowerCase()){
    t=t.toLowerCase().split(" ").map((w,i)=> (i>0 && SMALL.has(w)) ? w : w.split("-").map(p=>p.charAt(0).toUpperCase()+p.slice(1)).join("-")).join(" ");
  }
  return t;
}
function canonCity(name,country){ if(!CITY||!name) return null; const k=nrm(name); let best=null; for(const c of CITY){ if(c.k===k && (!country||c.c===country) && (!best||c.p>best.p)) best=c; } return best; }
function canonState(name,country){ if(!name) return name; const m=(window.CITY_STATES||{})[country]; if(!m) return tidyName(name); const k=nrm(name); for(const v of Object.values(m)){ if(nrm(v)===k) return v; } return tidyName(name); }
const mapsLink = q => "https://www.google.com/maps/search/?api=1&query="+encodeURIComponent(q);

/* ---------- data layer ---------- */
function clean(o){ const r={}; Object.keys(o||{}).forEach(k=>{ if(k!=="id" && o[k]!==undefined) r[k]=o[k]; }); return r; }
async function write(col,id,data){
  data = clean(data);
  if(!S.db) { toast("Salvar não está disponível nesta visualização."); return false; }
  try{ await S.db.collection(col).doc(id||uid()).set(data); return true; }
  catch(e){ toast(e && e.code==="quota_exceeded" ? "Limite de armazenamento atingido." : "Não deu para salvar. Tente de novo."); return false; }
}
async function patch(col,id,data){
  if(!S.db) return false;
  try{ await S.db.collection(col).doc(id).update(data); return true; }
  catch(e){ toast("Não deu para salvar. Tente de novo."); return false; }
}
async function remove(col,id){
  if(!S.db) return false;
  try{ await S.db.collection(col).doc(id).delete(); return true; }
  catch(e){ toast("Não deu para excluir. Tente de novo."); return false; }
}
function subscribe(){
  const cols = ["dias","itens","lugares","guia"];
  if(S.canEdit) cols.push("custos","checklists","takes","reservas");
  let pending = cols.length + 2;
  const done = () => { if(--pending<=0 && !S.loaded){ S.loaded=true; if(!location.hash && S.canEdit && tripRunning()) S.view="hoje"; render(); } };
  cols.forEach(c=>{
    let first=true;
    S.db.collection(c).onSnapshot(snap=>{
      S[c] = snap.docs.map(d=>Object.assign({id:d.id},d.data()));
      if(first){first=false;done();} else render();
    }, ()=>{ if(first){first=false;done();} });
  });
  let f1=true, f2=true;
  S.db.doc("config/site").onSnapshot(s=>{ S.site = s.exists ? Object.assign({},s.data()) : {}; if(f1){f1=false;done();} else render(); }, ()=>{ if(f1){f1=false;done();} });
  if(S.canEdit){
    S.db.doc("privado/config").onSnapshot(s=>{ if(s.exists) S.priv=Object.assign({cambio:6.3},s.data()); if(f2){f2=false;done();} else render(); }, ()=>{ if(f2){f2=false;done();} });
  } else done();
}

/* ---------- boot ---------- */
function getTheme(){ try{ return localStorage.getItem("lat53-theme")||""; }catch(e){ return ""; } }
function applyTheme(t){ const r=document.documentElement; if(t==="dark") r.setAttribute("data-theme","dark"); else r.setAttribute("data-theme","light"); }
function toggleTheme(btn){
  const next = document.documentElement.getAttribute("data-theme")==="dark" ? "light" : "dark";
  try{ localStorage.setItem("lat53-theme",next); }catch(e){}
  const swap=()=>{ applyTheme(next); const m=document.querySelector('meta[name="theme-color"]'); if(m) m.setAttribute("content", next==="dark"?"#0b0e14":"#fbfbfd"); };
  if(document.startViewTransition && !reduceMotion() && btn){
    const r=btn.getBoundingClientRect(); const root=document.documentElement;
    root.style.setProperty("--tx",(r.left+r.width/2)+"px"); root.style.setProperty("--ty",(r.top+r.height/2)+"px");
    try{ document.startViewTransition(swap); return; }catch(e){}
  }
  swap();
}
function installGlass(){
  { const saved=getTheme(); if(saved) applyTheme(saved); else if(!document.documentElement.getAttribute("data-theme")) applyTheme("light"); }
  if(!document.querySelector(".ambient")){ const a=document.createElement("div"); a.className="ambient"; a.setAttribute("aria-hidden","true"); a.innerHTML="<i></i><i></i><i></i><i></i>"; document.body.insertBefore(a, document.body.firstChild); }
  let raf=0, last=null;
  document.addEventListener("pointermove",e=>{
    if(e.pointerType!=="mouse") return;
    last=e; if(raf) return;
    raf=requestAnimationFrame(()=>{ raf=0; const el=last.target.closest && last.target.closest(".tile,.place,.gsec,.group,.col,.hoje-card,.day,.empty-state"); if(!el) return;
      const r=el.getBoundingClientRect(); el.style.setProperty("--mx",((last.clientX-r.left)/r.width*100).toFixed(1)+"%"); el.style.setProperty("--my",((last.clientY-r.top)/r.height*100).toFixed(1)+"%"); });
  },{passive:true});
}
const reduceMotion = () => { try{ return matchMedia("(prefers-reduced-motion: reduce)").matches; }catch(e){ return false; } };
let lastShown=null, pillPos=null;
function choreograph(entering){
  const view=$("#view"); if(!view) return;
  // sliding glass pill under the active tab
  const tabs=$(".tabs"), cur=tabs&&tabs.querySelector('[aria-current="page"]');
  if(tabs && cur){
    const pill=document.createElement("span"); pill.className="tab-pill"; pill.setAttribute("aria-hidden","true"); tabs.insertBefore(pill,tabs.firstChild);
    const to={x:cur.offsetLeft, w:cur.offsetWidth};
    const from=pillPos||to;
    pill.style.transition="none"; pill.style.transform=`translateX(${from.x}px)`; pill.style.width=from.w+"px";
    void pill.offsetWidth; pill.style.transition="";
    requestAnimationFrame(()=>{ pill.style.transform=`translateX(${to.x}px)`; pill.style.width=to.w+"px"; });
    pillPos=to;
    if(entering){ const l=cur.offsetLeft-16, r=cur.offsetLeft+cur.offsetWidth+16; if(l<tabs.scrollLeft||r>tabs.scrollLeft+tabs.clientWidth) tabs.scrollTo({left:Math.max(0,l-tabs.clientWidth/3),behavior:reduceMotion()?"auto":"smooth"}); }
  }
  if(!entering) return;
  view.classList.add("enter");
  view.querySelectorAll(".hero .wrap > *").forEach((el,i)=>el.style.setProperty("--i",i));
  view.querySelectorAll(".head-row,.stats,.tile,.place,.gsec,.group,.col,.day,.hoje-card,.empty-state,.map-shell,.table-wrap,.bars,.legend,.country > .h3,.segbar,.sumrow .tile").forEach((el,i)=>{ el.setAttribute("data-anim",""); el.style.setProperty("--i",Math.min(i,14)); });
  if(!reduceMotion()){
    view.querySelectorAll(".count b,.stats b").forEach(el=>{
      const end=parseInt(el.textContent,10); if(!(end>0) || String(end)!==el.textContent.trim()) return;
      const t0=performance.now(), dur=900+Math.min(end,60)*8;
      const step=t=>{ const k=Math.min(1,(t-t0)/dur), e=1-Math.pow(1-k,3); el.textContent=String(Math.round(end*e)); if(k<1) requestAnimationFrame(step); };
      el.textContent="0"; requestAnimationFrame(step);
    });
  }
  setTimeout(()=>{ const v=$("#view"); if(v) v.classList.remove("enter"); },2200);
}

async function boot(){
  installGlass();
  const h = (location.hash||"").replace("#","");
  if(VIEWS.some(v=>v[0]===h)) S.view=h;
  if(PUB){
    const v0=S.view; Object.assign(S, PUB); S.view=v0; S.canEdit=false; S.loaded=true; S.userKnown=true; render(); return;
  }
  render();
  const use = window.claude && window.claude.use ? window.claude.use.bind(window.claude) : null;
  if(!use){ S.noDb=true; S.loaded=true; S.userKnown=true; render(); return; }
  // never leave the page stuck on "Carregando" if the platform is slow to answer
  setTimeout(()=>{ if(!S.loaded){ S.loaded=true; S.userKnown=true; render(); toast("A conexão está lenta. Os dados aparecem assim que chegarem."); } },12000);
  let db=null,user=null;
  try{ [db,user] = await Promise.all([use("db"),use("user")]); }catch(e){}
  S.db = db;
  if(user){ try{ S.canEdit = await user.canEdit(); }catch(e){} }
  S.userKnown = true;
  if(!db){ S.noDb=true; S.loaded=true; render(); return; }
  if(S.canEdit){
    use("assets").then(a=>{S.assets=a; render();});
    use("downloads").then(d=>{S.downloads=d; render();});
  }
  subscribe();
}
window.addEventListener("hashchange",()=>{ const h=location.hash.replace("#",""); if(VIEWS.some(v=>v[0]===h)){S.view=h; render(); window.scrollTo(0,0);} });

/* ---------- render shell ---------- */
function render(){
  const app = $("#app"); if(!app) return;
  const priv = isPrivateNow();
  if(priv && S.userKnown && S.loaded && PRIVATE_VIEWS.includes(S.view)) S.view="inicio";
  const name = S.site.nome || "Latitude 53";
  document.title = name;
  const tabs = VIEWS.filter(v=>!(priv && PRIVATE_VIEWS.includes(v[0])))
    .map(([k,l])=>`<a href="#${k}" ${S.view===k?'aria-current="page"':""}>${l}</a>`).join("");
  const themeBtn = `<button class="icon-btn theme-btn" id="toggle-theme" type="button" aria-label="Alternar tema claro e escuro" title="Tema claro ou escuro"><svg class="sun" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6"/></svg><svg class="moon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.6A8.2 8.2 0 0 1 9.4 4a8.2 8.2 0 1 0 10.6 10.6z"/></svg></button>`;
  let btns = themeBtn;
  if(S.canEdit && !PUB){
    btns = themeBtn + `<button class="ghost-btn" id="toggle-pub" type="button">${S.publicView?"Sair da visão pública":"Ver como público"}</button>
      <button class="icon-btn" id="open-settings" type="button" aria-label="Ajustes do site">${gearSvg()}</button>`;
  }
  let banner = "";
  if(S.publicView) banner = `<div class="banner info"><div class="wrap">Você está vendo o site como os seguidores veem: sem custos, reservas, checklists e roteiro de gravação.</div></div>`;
  else if(S.noDb && !PUB) banner = `<div class="banner"><div class="wrap">Entre na sua conta Claude para ver e editar os dados do site.</div></div>`;
  const scrollY = window.scrollY;
  app.innerHTML = `
    <nav class="lnav" aria-label="Seções"><div class="wrap">
      <a class="brand" href="#inicio">${esc(name)}</a>
      <div class="tabs">${tabs}</div>
      <div class="navbtns">${btns}</div>
    </div></nav>
    ${banner}
    <main id="view">${S.loaded?safeView():loadingView()}</main>
    ${canWrite()?`<button type="button" class="fab" id="fab-gasto" aria-label="Lançar gasto"><span aria-hidden="true">+</span> Gasto</button>`:""}
    <footer class="site"><div class="wrap"><span>${esc(name)} · Gustavo e Priscila</span><span>Valores são estimativas. Confirme sempre nas fontes oficiais antes de pagar.</span></div></footer>`;
  const shown = S.loaded ? S.view : "loading";
  const entering = shown!==lastShown && shown!=="loading";
  if(entering && lastShown!==null) window.scrollTo(0,0); else window.scrollTo(0,scrollY);
  S.mapAnim = entering && S.view==="mapa" && !reduceMotion();
  lastShown = shown;
  bindShell();
  afterRender();
  try{ choreograph(entering); }catch(e){}
}
function safeView(){
  try{ return renderView(); }
  catch(e){ setTimeout(()=>showFatal((e&&e.message)||e),0); return `<section class="band hero"><div class="wrap"><h1 class="h2">Esta aba não abriu.</h1><p class="lead">Tente outra aba ou recarregue a página.</p></div></section>`; }
}
function loadingView(){ return `<section class="band hero"><div class="wrap"><p class="eyebrow">Carregando</p><h1 class="h1">Abrindo o diário de viagem</h1></div></section>`; }
function renderView(){
  switch(S.view){
    case "hoje": return vHoje();
    case "roteiro": return vRoteiro();
    case "mapa": return vMapa();
    case "guia": return vGuia();
    case "reservas": return vReservas();
    case "custos": return vCustos();
    case "checklists": return vChecklists();
    case "gravacoes": return vTakes();
    default: return vInicio();
  }
}
function gearSvg(){ return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>`; }
function bindShell(){
  const t=$("#toggle-pub"); if(t) t.onclick=()=>{S.publicView=!S.publicView; render();};
  const th=$("#toggle-theme"); if(th) th.onclick=()=>toggleTheme(th);
  const g=$("#open-settings"); if(g) g.onclick=openSettings;
  const fb=$("#fab-gasto"); if(fb) fb.onclick=()=>quickExpense();
}
const canWrite = () => S.canEdit && !S.publicView && !PUB && !!S.db;
const editBtn = (attrs,label="Editar") => canWrite() ? `<button type="button" class="link-btn edit-x small" ${attrs}>${label}</button>` : "";

/* ---------- views ---------- */
function sortedDays(){ return S.dias.slice().sort((a,b)=>(a.data||"").localeCompare(b.data||"")||(a.ordem||0)-(b.ordem||0)); }
function itemsOf(diaId){ return S.itens.filter(i=>i.diaId===diaId).sort((a,b)=>(a.hora||"99").localeCompare(b.hora||"99")||(a.ordem||0)-(b.ordem||0)); }
function visitedStats(){
  const v = S.lugares.filter(l=>l.status!=="planejado");
  const paises = new Set(v.map(l=>l.paisA2).filter(Boolean));
  const estados = new Set(v.filter(l=>l.estado).map(l=>(l.paisA2||"")+"|"+l.estado.trim().toLowerCase()));
  const cidades = new Set(v.filter(l=>l.cidade).map(l=>(l.paisA2||"")+"|"+l.cidade.trim().toLowerCase()));
  return {paises:paises.size, estados:estados.size, cidades:cidades.size};
}

function vInicio(){
  const start = new Date((S.site.partida||"2026-12-22")+"T00:00:00");
  const diff = Math.ceil((start - new Date())/86400000);
  const days = sortedDays();
  const st = visitedStats();
  const cover = S.site.capaId || S.site.capaData
    ? `<div class="cover"><img src="${esc(imgSrc(S.site.capaId,S.site.capaData))}" alt="Foto de capa"></div>`
    : (canWrite()?`<button type="button" class="cover empty" id="add-cover">Adicione uma foto de capa nos ajustes</button>`:"");
  const countries = [...new Set(days.map(d=>d.paisA2).filter(Boolean))];
  const next = days.filter(d=>d.paisA2!=="BR").slice(0,4);
  const chk = S.checklists; const chkDone = chk.filter(c=>c.feito).length;
  const custoPrev = S.custos.reduce((s,c)=>s+(num(c.prevEUR)||0),0);
  return `
  <section class="hero"><div class="wrap">
    <p class="eyebrow">${esc(S.site.eyebrow||"Gustavo e Priscila")}</p>
    <h1 class="h-hero">${esc(S.site.nome||"Latitude 53")}</h1>
    <p class="lead">${esc(S.site.subtitulo||"Da Bahia para a Irlanda, passando por Lisboa e Amsterdam.")}</p>
    <p class="coords"><b>14°51′S</b> Vitória da Conquista &nbsp;→&nbsp; <b>53°21′N</b> Dublin</p>
    <div class="count">
      <div><b>${diff>0?diff:0}</b><span>${diff>0?"dias para o embarque":"a viagem começou"}</span></div>
      <div><b>${countries.length||3}</b><span>países no roteiro</span></div>
      <div><b>${st.paises}</b><span>países já visitados</span></div>
    </div>
  </div>
  <div class="wrap">${cover}</div></section>
  <section class="band alt"><div class="wrap">
    <div class="head-row"><div><p class="eyebrow">Próximas paradas</p><h2 class="h2">Dezembro em três países.</h2></div><a href="#roteiro" class="btn secondary">Ver roteiro completo</a></div>
    <div class="tiles">${next.map(d=>{const f=fmtDay(d.data);return `<div class="tile"><span class="place-chip"><span class="flag">${flag(d.paisA2)}</span>${esc(d.cidade||countryName(d.paisA2))} · ${esc(f.short)}</span><h3 class="h3">${esc(d.titulo||"")}</h3><p class="small muted" style="margin:0">${esc(d.resumo||"")}</p><a class="more" href="#roteiro">Ver o dia ›</a></div>`;}).join("") || `<div class="empty-state"><p class="h3">Roteiro vazio</p><p class="small">Adicione o primeiro dia na aba Roteiro.</p></div>`}</div>
  </div></section>
  <section class="band"><div class="wrap">
    <div class="tiles">
      <div class="tile"><p class="eyebrow" style="margin:0">Mapa</p><h3 class="h2 num">${st.cidades} ${st.cidades===1?"cidade":"cidades"}</h3><p class="small muted" style="margin:0">${st.paises} ${st.paises===1?"país":"países"} e ${st.estados} ${st.estados===1?"estado":"estados"} visitados.</p><a class="more" href="#mapa">Abrir o mapa ›</a></div>
      <div class="tile"><p class="eyebrow" style="margin:0">Guia</p><h3 class="h3">Documentos, transporte e lugares fora da rota</h3><p class="small muted" style="margin:0">Portugal, Países Baixos e Irlanda, com fontes.</p><a class="more" href="#guia">Ler o guia ›</a></div>
      ${!isPrivateNow()?`<div class="tile"><p class="eyebrow" style="margin:0">Preparação</p><h3 class="h2 num">${chkDone}/${chk.length}</h3><p class="small muted" style="margin:0">itens prontos · ${eur(custoPrev)} previstos</p><a class="more" href="#checklists">Ver checklists ›</a></div>`:""}
    </div>
  </div></section>`;
}

function vRoteiro(){
  const days = sortedDays();
  const first = days[0], last = days[days.length-1];
  const range = first&&last ? `${fmtDay(first.data).short} a ${fmtDay(last.data).short}` : "";
  return `<section class="band"><div class="wrap">
    <div class="head-row"><div><p class="eyebrow">Roteiro${range?" · "+esc(range):""}</p><h1 class="h1">Dia a dia.</h1><p class="lead">Horários, deslocamentos e o que vale a pena em cada parada.</p></div>
    ${canWrite()?`<div class="actions"><button class="btn" type="button" data-act="new-day">Adicionar dia</button></div>`:""}</div>
    ${days.length? `<div>${days.map(dayHtml).join("")}</div>` : `<div class="empty-state"><p class="h3">Nenhum dia ainda</p><p class="small">Comece pelo dia do embarque.</p></div>`}
  </div></section>`;
}
function dayHtml(d){
  const f = fmtDay(d.data||"2026-12-22");
  const its = itemsOf(d.id);
  return `<article class="day" id="dia-${esc(d.id)}">
    <div class="date-col"><div class="dnum">${f.n}</div><div class="dmeta">${esc(f.wd)}<br>${esc(f.mo)}</div></div>
    <div class="day-body">
      <span class="place-chip"><span class="flag">${flag(d.paisA2)}</span>${esc(d.cidade||"")}${d.cidade&&d.paisA2?" · ":""}${esc(d.paisA2?countryName(d.paisA2):"")}</span>
      <div class="day-title"><h2 class="h2">${esc(d.titulo||"")}</h2>${editBtn(`data-act="edit-day" data-id="${esc(d.id)}"`)}</div>
      ${d.resumo?`<p class="day-sum">${esc(d.resumo)}</p>`:""}
      <ul class="items">${its.map(i=>`<li class="item">
        <span class="time">${esc(i.hora||"")}</span>
        <div><div><span class="tag ${esc(i.tipo||"")}">${esc(TIPOS[i.tipo]||"Item")}</span><span class="t">${esc(i.titulo||"")}</span></div>
        ${i.nota?`<div class="n">${esc(i.nota)}</div>`:""}
        ${safeUrl(i.link)?`<div class="small"><a href="${esc(safeUrl(i.link))}" target="_blank" rel="noopener">${esc(i.linkLabel||"Site oficial")} ↗</a></div>`:""}</div>
        ${editBtn(`data-act="edit-item" data-id="${esc(i.id)}"`)}
      </li>`).join("")}</ul>
      ${canWrite()?`<p style="margin:14px 0 0"><button type="button" class="link-btn small" data-act="new-item" data-dia="${esc(d.id)}">+ Adicionar item</button></p>`:""}
    </div></article>`;
}

function vHoje(){
  const days = sortedDays(); const t = todayISO();
  if(!days.length) return `<section class="band"><div class="wrap"><div class="empty-state"><p class="h3">Roteiro vazio</p><p class="small">Adicione dias na aba Roteiro.</p></div></div></section>`;
  // reference day: today if it is in the itinerary, otherwise the next one (or the last one after the trip)
  let base = days.findIndex(d=>d.data>=t); if(base<0) base=days.length-1;
  const idx = Math.max(0, Math.min(days.length-1, base + S.hojeOff));
  const d = days[idx]; const f = fmtDay(d.data); const isToday = d.data===t;
  const until = Math.round((new Date(d.data+"T12:00:00") - new Date(t+"T12:00:00"))/86400000);
  const label = isToday ? "Hoje" : until===1 ? "Amanhã" : until>1 ? `Daqui a ${until} dias` : until===-1 ? "Ontem" : `Há ${-until} dias`;
  const its = itemsOf(d.id);
  const nowHM = new Date().toTimeString().slice(0,5);
  const nextId = isToday ? (its.find(i=>i.hora && i.hora>=nowHM)||{}).id : null;
  const res = S.reservas.filter(r=>r.data===d.data).sort((a,b)=>(a.hora||"99").localeCompare(b.hora||"99"));
  const gastos = S.custos.filter(c=>c.data===d.data && num(c.realEUR)!=null);
  const cb = num(S.priv.cambio)||6.3; const totDia = gastos.reduce((s,c)=>s+num(c.realEUR),0);
  const place = [d.cidade, d.paisA2?countryName(d.paisA2):""].filter(Boolean).join(", ");
  return `<section class="band"><div class="wrap hoje">
    <div class="hoje-nav">
      <button type="button" class="btn plain" data-hoje="-1" ${idx===0?"disabled":""} aria-label="Dia anterior">‹</button>
      <div class="hoje-when"><p class="eyebrow">${esc(label)}</p><p class="tiny">${esc(f.wd)}, ${f.n} de ${esc(f.mo)}</p></div>
      <button type="button" class="btn plain" data-hoje="1" ${idx===days.length-1?"disabled":""} aria-label="Próximo dia">›</button>
    </div>
    <span class="place-chip"><span class="flag">${flag(d.paisA2)}</span>${esc(place)}</span>
    <h1 class="h1">${esc(d.titulo||"")}</h1>
    ${d.resumo?`<p class="lead">${esc(d.resumo)}</p>`:""}
    ${S.hojeOff!==0?`<p style="margin:12px 0 0"><button type="button" class="link-btn small" data-hoje="0">Voltar para ${t<days[0].data?"o próximo dia":"hoje"}</button></p>`:""}

    ${res.length?`<h2 class="h3 hoje-h">Reservas</h2><div class="hoje-cards">${res.map(r=>`<div class="hoje-card">
      <div class="tiny">${esc(RES_TIPOS[r.tipo]||"Reserva")}${r.hora?" · "+esc(r.hora):""} · <span class="state-pill ${esc(r.estado||"pendente")}">${r.estado==="pago"?"Pago":r.estado==="reservado"?"Reservado":"Pendente"}</span></div>
      <div class="t">${esc(r.titulo||"")}</div>
      ${r.codigo?`<div class="code-row"><span class="mono code">${esc(r.codigo)}</span><button type="button" class="link-btn small" data-copy="${esc(r.codigo)}">Copiar</button></div>`:""}
      ${r.endereco?`<div class="small muted">${esc(r.endereco)}</div><a class="small" href="${esc(mapsLink(r.endereco))}" target="_blank" rel="noopener">Como chegar ↗</a>`:""}
    </div>`).join("")}</div>`:""}

    <h2 class="h3 hoje-h">Programação</h2>
    ${its.length?`<ul class="items">${its.map(i=>`<li class="item ${i.id===nextId?"is-next":""}">
      <span class="time">${esc(i.hora||"")}</span>
      <div>${i.id===nextId?`<div class="next-flag">Próximo</div>`:""}<div><span class="tag ${esc(i.tipo||"")}">${esc(TIPOS[i.tipo]||"Item")}</span><span class="t">${esc(i.titulo||"")}</span></div>
      ${i.nota?`<div class="n">${esc(i.nota)}</div>`:""}
      <div class="small links">${["atracao","fora","comida","livre"].includes(i.tipo)?`<a href="${esc(mapsLink(i.titulo+" "+(d.cidade||"")))}" target="_blank" rel="noopener">Como chegar ↗</a>`:""}${safeUrl(i.link)?`<a href="${esc(safeUrl(i.link))}" target="_blank" rel="noopener">${esc(i.linkLabel||"Site oficial")} ↗</a>`:""}</div></div>
      <span></span></li>`).join("")}</ul>`:`<p class="muted small">Nada programado para este dia.</p>`}

    <div class="head-row hoje-h" style="margin-bottom:12px"><h2 class="h3">Gastos do dia</h2><button type="button" class="btn" data-act="quick-cost" data-date="${esc(d.data)}">+ Lançar gasto</button></div>
    ${gastos.length?`<div class="tile" style="padding:8px 22px">${gastos.map(c=>`<div class="g-row" data-act="edit-cost" data-id="${esc(c.id)}" role="button" tabindex="0"><span>${esc(c.titulo||c.categoria||"")}<span class="tiny"> · ${esc(c.categoria||"")}</span></span><span class="num">${eur(num(c.realEUR))}</span></div>`).join("")}
      <div class="g-row g-tot"><span>Total do dia</span><span class="num">${eur(totDia)} · ${brl(totDia*cb)}</span></div></div>`
    :`<p class="muted small">Nenhum gasto lançado neste dia.</p>`}
  </div></section>`;
}

function vMapa(){
  const st = visitedStats();
  const groups = {};
  const yearOf = l => { const m=String(l.quando||"").match(/(19|20)\d\d/); return m?m[0]:""; };
  const estados = [...new Set(S.lugares.map(l=>(l.estado||"").trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,"pt"));
  const anos = [...new Set(S.lugares.map(yearOf).filter(Boolean))].sort().reverse();
  if(S.fEstado && !estados.includes(S.fEstado)) S.fEstado="";
  if(S.fAno && !anos.includes(S.fAno)) S.fAno="";
  const shown = S.lugares.filter(l=>(!S.fEstado || (l.estado||"").trim()===S.fEstado) && (!S.fAno || yearOf(l)===S.fAno));
  shown.forEach(l=>{ const k=l.paisA2||"??"; (groups[k]=groups[k]||[]).push(l); });
  const keys = Object.keys(groups).sort((a,b)=>countryName(a).localeCompare(countryName(b),"pt"));
  const filters = (estados.length>1||anos.length>1) ? `<div class="filters">
      ${estados.length>1?`<label class="inline-field" for="f-estado-filtro">Estado <select id="f-estado-filtro"><option value="">Todos</option>${estados.map(e=>`<option ${e===S.fEstado?"selected":""}>${esc(e)}</option>`).join("")}</select></label>`:""}
      ${anos.length>1?`<label class="inline-field" for="f-ano-filtro">Ano <select id="f-ano-filtro"><option value="">Todos</option>${anos.map(a=>`<option ${a===S.fAno?"selected":""}>${a}</option>`).join("")}</select></label>`:""}
      <span class="tiny num">${shown.length} de ${S.lugares.length} lugares</span>
    </div>` : "";
  return `<section class="band alt"><div class="wrap">
    <div class="head-row"><div><p class="eyebrow">Mapa</p><h1 class="h1">Onde já pisamos.</h1><p class="lead">Países, estados e cidades, com fotos e lembranças de cada lugar.</p></div>
    ${canWrite()?`<div class="actions"><button class="btn" type="button" data-act="new-place">Adicionar lugar</button></div>`:""}</div>
    <div class="stats"><div><b>${st.paises}</b><span>${st.paises===1?"país":"países"}</span></div><div><b>${st.estados}</b><span>${st.estados===1?"estado":"estados"}</span></div><div><b>${st.cidades}</b><span>${st.cidades===1?"cidade":"cidades"}</span></div></div>
    <div class="map-shell ${S.picking?"picking":""}" id="map">
      <div class="map-tools"><div class="seg" role="group" aria-label="Zoom do mapa">
        ${[["mundo","Mundo"],["europa","Europa"],["brasil","Brasil"]].map(([k,l])=>`<button type="button" data-zoom="${k}" aria-pressed="${S.mapZoom===k}">${l}</button>`).join("")}
      </div></div>
      ${S.picking?`<div class="pick-hint">Toque no mapa onde fica o lugar <button type="button" data-act="cancel-pick">Cancelar</button></div>`:""}
    </div>
    <div class="legend"><span><i style="background:var(--visited)"></i>Visitado</span><span><i style="background:var(--state-soft)"></i>Estado ainda não visitado (Brasil)</span><span><i style="background:var(--planned)"></i>No roteiro</span><span>Arraste e use a roda do mouse ou pinça para aproximar.</span></div>
    ${filters}
    ${keys.length? keys.map(k=>countryBlock(k,groups[k])).join("") : S.lugares.length ? `<div class="empty-state" style="margin-top:32px"><p class="h3">Nada com esse filtro</p></div>` : `<div class="empty-state" style="margin-top:32px"><p class="h3">Nenhum lugar registrado</p><p class="small">Use "Adicionar lugar" e marque a cidade no mapa ou cole as coordenadas do Google Maps.</p></div>`}
  </div></section>`;
}
function countryBlock(a2,list){
  const byState = {};
  list.forEach(l=>{ const k=(l.estado||"").trim()||"—"; (byState[k]=byState[k]||[]).push(l); });
  const sk = Object.keys(byState).sort((a,b)=>a==="—"?1:b==="—"?-1:a.localeCompare(b,"pt"));
  return `<div class="country"><h2 class="h3"><span class="flag">${flag(a2)}</span>${esc(countryName(a2))}</h2>
    ${sk.map(s=>`<div class="state">${s!=="—"?`<div class="state-name">${esc(s)}</div>`:""}<div class="places">${byState[s].sort((a,b)=>(a.cidade||"").localeCompare(b.cidade||"","pt")).map(placeCard).join("")}</div></div>`).join("")}
  </div>`;
}
function placeCard(l){
  const fotos = (l.fotos||[]).map((id,i)=>imgSrc(id,(l.fotosData||[])[i])).filter(Boolean);
  const links = (l.links||[]).filter(x=>safeUrl(x.url));
  return `<div class="place">
    <div class="top"><div><div class="name">${esc(l.cidade||"Lugar")}</div>${l.quando?`<div class="tiny">${esc(l.quando)}${l.juntos===false?" · só um de nós":""}</div>`:""}</div>
    <span class="status ${l.status==="planejado"?"planejado":"visitado"}">${l.status==="planejado"?"No roteiro":"Visitado"}</span></div>
    ${l.nota?`<div class="note">${esc(l.nota)}</div>`:""}
    ${fotos.length?`<div class="thumbs">${fotos.slice(0,6).map(s=>`<img src="${esc(s)}" alt="Foto em ${esc(l.cidade||"")}" loading="lazy">`).join("")}</div>`:""}
    ${links.length?`<div class="links">${links.map(x=>`<a href="${esc(safeUrl(x.url))}" target="_blank" rel="noopener">${esc(x.label||"Link")} ↗</a>`).join("")}</div>`:""}
    ${editBtn(`data-act="edit-place" data-id="${esc(l.id)}" style="align-self:flex-start;opacity:1"`)}
  </div>`;
}

function vGuia(){
  const list = S.guia.slice().sort((a,b)=>(a.ordem||0)-(b.ordem||0));
  if(!S.guiaSel || !list.some(g=>g.id===S.guiaSel)) S.guiaSel = list[0] && list[0].id;
  const g = list.find(x=>x.id===S.guiaSel);
  return `<section class="band"><div class="wrap">
    <div class="head-row"><div><p class="eyebrow">Guia</p><h1 class="h1">O que saber antes de ir.</h1><p class="lead">Documentos, transporte, pontos principais e lugares fora da rota.</p></div>
    ${canWrite()?`<div class="actions">${g?`<button class="btn secondary" type="button" data-act="edit-guide" data-id="${esc(g.id)}">Editar ${esc(g.titulo||"")}</button>`:""}<button class="btn" type="button" data-act="new-guide">Novo país</button></div>`:""}</div>
    ${list.length?`<div class="segbar" role="group" aria-label="País">${list.map(x=>`<button type="button" data-guide="${esc(x.id)}" aria-pressed="${x.id===S.guiaSel}"><span class="flag">${flag(x.paisA2)}</span> ${esc(x.titulo||countryName(x.paisA2))}</button>`).join("")}</div>`:""}
    ${g?`${g.intro?`<p class="lead" style="margin:0 0 28px">${esc(g.intro)}</p>`:""}<div class="guide-grid">${(g.secoes||[]).map(sec=>`<div class="gsec"><h3 class="h3">${esc(sec.titulo)}</h3><ul>${(sec.itens||[]).map(t=>`<li>${esc(t)}</li>`).join("")}</ul>
      ${(sec.fontes||[]).filter(f=>safeUrl(f.url)).length?`<div class="src">Fontes: ${(sec.fontes||[]).filter(f=>safeUrl(f.url)).map(f=>`<a href="${esc(safeUrl(f.url))}" target="_blank" rel="noopener">${esc(f.label||"fonte")}</a>`).join("")}</div>`:""}</div>`).join("")}</div>`
    :`<div class="empty-state"><p class="h3">Guia vazio</p></div>`}
  </div></section>`;
}

function vReservas(){
  const list = S.reservas.slice().sort((a,b)=>(a.data||"9").localeCompare(b.data||"9"));
  return `<section class="band alt"><div class="wrap">
    <div class="head-row"><div><p class="eyebrow">Privado · Reservas</p><h1 class="h1">Voos, camas e ingressos.</h1><p class="lead">Códigos, endereços e prazos num lugar só. Seguidores não veem esta página.</p></div>
    ${canWrite()?`<div class="actions"><button class="btn" type="button" data-act="new-res">Adicionar reserva</button></div>`:""}</div>
    ${list.length?`<div class="tile" style="padding:8px 28px">${list.map(r=>{const f=r.data?fmtDay(r.data):null;return `<div class="res" data-act="edit-res" data-id="${esc(r.id)}" role="button" tabindex="0">
      <div class="rd"><div class="h3 num">${f?esc(f.short):"Sem data"}</div><div class="tiny">${esc(RES_TIPOS[r.tipo]||"Reserva")}${r.hora?" · "+esc(r.hora):""}</div></div>
      <div><div class="t">${esc(r.titulo||"")}</div>${r.codigo?`<div class="small">Código <span class="mono">${esc(r.codigo)}</span></div>`:""}${r.endereco?`<div class="small muted">${esc(r.endereco)}</div>`:""}${r.nota?`<div class="small muted" style="white-space:pre-line">${esc(r.nota)}</div>`:""}${safeUrl(r.link)?`<div class="small"><a href="${esc(safeUrl(r.link))}" target="_blank" rel="noopener">Abrir link ↗</a></div>`:""}</div>
      <span class="state-pill ${esc(r.estado||"pendente")}">${r.estado==="pago"?"Pago":r.estado==="reservado"?"Reservado":"Pendente"}</span></div>`;}).join("")}</div>`
    :`<div class="empty-state"><p class="h3">Nenhuma reserva ainda</p><p class="small">Cadastre voos, hospedagens e ingressos assim que comprar.</p></div>`}
  </div></section>`;
}

function vCustos(){
  const cb = num(S.priv.cambio)||6.3;
  const rows = S.custos.slice().sort((a,b)=>CATS.indexOf(a.categoria)-CATS.indexOf(b.categoria)||(a.titulo||"").localeCompare(b.titulo||""));
  const prev = rows.reduce((s,c)=>s+(num(c.prevEUR)||0),0);
  const real = rows.reduce((s,c)=>s+(num(c.realEUR)||0),0);
  const semValor = rows.filter(c=>num(c.prevEUR)==null&&num(c.realEUR)==null).length;
  const teto = num(S.priv.teto);
  const byCat = CATS.map(cat=>({cat,v:rows.filter(c=>c.categoria===cat).reduce((s,c)=>s+(num(c.realEUR)??num(c.prevEUR)??0),0)})).filter(x=>x.v>0);
  const maxV = Math.max(1,...byCat.map(x=>x.v));
  return `<section class="band"><div class="wrap">
    <div class="head-row"><div><p class="eyebrow">Privado · Custos</p><h1 class="h1">Quanto vai custar.</h1><p class="lead">Valores para o casal. Previsto vem das fontes; real é o que vocês pagarem.</p></div>
    <div class="actions"><label class="inline-field" for="cambio">€1 = R$ <input id="cambio" type="text" inputmode="decimal" value="${esc(String(cb).replace(".",","))}" ${canWrite()?"":"disabled"}></label>${canWrite()?`<button class="btn" type="button" data-act="new-cost">Adicionar custo</button>`:""}</div></div>
    <div class="sumrow">
      <div class="tile"><span class="tiny">Previsto</span><b>${eur(prev)}</b><span class="sub">${brl(prev*cb)}</span></div>
      <div class="tile"><span class="tiny">Gasto até agora</span><b>${eur(real)}</b><span class="sub">${brl(real*cb)}</span></div>
      <div class="tile"><span class="tiny">${teto?"Sobra do orçamento":"Orçamento"}</span><b>${teto?eur(teto-Math.max(prev,real)):"Sem teto"}</b><span class="sub">${teto?`Teto ${eur(teto)} · ${brl((teto-Math.max(prev,real))*cb)}`:"Defina o teto nos ajustes"}</span></div>
    </div>
    ${semValor?`<p class="small muted" style="margin:-16px 0 28px">${semValor} ${semValor===1?"item ainda sem valor":"itens ainda sem valor"} (passagens e seguro, por exemplo). O total vai subir quando forem preenchidos.</p>`:""}
    ${byCat.length?`<h2 class="h3" style="margin-bottom:16px">Por categoria</h2><div class="bars">${byCat.map(x=>`<div class="bar"><span>${esc(x.cat)}</span><div class="track"><div class="fill" style="width:${(x.v/maxV*100).toFixed(1)}%"></div></div><span class="v">${eur(x.v)}</span></div>`).join("")}</div>`:""}
    ${rows.length?`<div class="table-wrap"><table><thead><tr><th>Item</th><th>Categoria</th><th>País</th><th class="r">Previsto</th><th class="r">Real</th><th class="r">Em reais</th></tr></thead><tbody>
      ${rows.map(c=>{const v=num(c.realEUR)??num(c.prevEUR);return `<tr data-act="edit-cost" data-id="${esc(c.id)}" tabindex="0"><td><strong>${esc(c.titulo||"")}</strong>${c.data?`<div class="tiny">${esc(fmtDay(c.data).short)}</div>`:""}${c.nota?`<div class="tiny" style="white-space:pre-line">${esc(c.nota)}</div>`:""}${safeUrl(c.fonte)?`<div class="tiny"><a href="${esc(safeUrl(c.fonte))}" target="_blank" rel="noopener">fonte ↗</a></div>`:""}</td><td>${esc(c.categoria||"")}</td><td>${c.paisA2?flag(c.paisA2)+" "+esc(countryName(c.paisA2)):"—"}</td><td class="r">${eur(num(c.prevEUR))}</td><td class="r">${eur(num(c.realEUR))}</td><td class="r">${v==null?"—":brl(v*cb)}</td></tr>`;}).join("")}
    </tbody></table></div>`:`<div class="empty-state"><p class="h3">Nenhum custo</p></div>`}
  </div></section>`;
}

function vChecklists(){
  const groups = [...CHK_GROUPS, ...new Set(S.checklists.map(c=>c.grupo).filter(g=>g&&!CHK_GROUPS.includes(g)))];
  return `<section class="band alt"><div class="wrap">
    <div class="head-row"><div><p class="eyebrow">Privado · Checklists</p><h1 class="h1">Nada fica para trás.</h1><p class="lead">Documentos, reservas, mala e equipamento. Marquem juntos, cada um no seu celular.</p></div>
    ${canWrite()?`<div class="actions"><button class="btn" type="button" data-act="new-check">Adicionar item</button></div>`:""}</div>
    <div class="groups">${groups.map(g=>{const its=S.checklists.filter(c=>c.grupo===g).sort((a,b)=>(a.ordem||0)-(b.ordem||0)); if(!its.length) return ""; const done=its.filter(c=>c.feito).length;
      return `<div class="group"><div class="gh"><h2 class="h3">${esc(g)}</h2><span class="tiny num">${done} de ${its.length}</span></div><div class="prog"><i style="width:${(done/its.length*100).toFixed(0)}%"></i></div>
      <ul class="checks">${its.map(c=>`<li class="check ${c.feito?"done":""}"><input type="checkbox" id="chk-${esc(c.id)}" data-check="${esc(c.id)}" ${c.feito?"checked":""} ${canWrite()?"":"disabled"} aria-label="${esc(c.texto)}"><div><label for="chk-${esc(c.id)}" class="ct">${esc(c.texto||"")}</label>${c.nota?`<div class="cn">${esc(c.nota)}</div>`:""}${safeUrl(c.fonte)?`<div class="cn"><a href="${esc(safeUrl(c.fonte))}" target="_blank" rel="noopener">fonte ↗</a></div>`:""}</div>${editBtn(`data-act="edit-check" data-id="${esc(c.id)}"`)}</li>`).join("")}</ul></div>`;}).join("")}</div>
  </div></section>`;
}

function vTakes(){
  return `<section class="band"><div class="wrap">
    <div class="head-row"><div><p class="eyebrow">Privado · Gravações</p><h1 class="h1">O que filmar.</h1><p class="lead">Ideias de Reels e YouTube por lugar, do roteiro até a publicação.</p></div>
    ${canWrite()?`<div class="actions"><button class="btn" type="button" data-act="new-take">Nova ideia</button></div>`:""}</div>
    <div class="kanban">${TAKE_STATUS.map(([k,l])=>{const its=S.takes.filter(t=>(t.status||"ideia")===k).sort((a,b)=>(a.lugar||"").localeCompare(b.lugar||"","pt"));
      return `<div class="col"><h4><span>${l}</span><span class="num">${its.length}</span></h4>${its.map(t=>`<div class="take" data-act="edit-take" data-id="${esc(t.id)}" role="button" tabindex="0"><div class="tl">${esc(t.lugar||"")}${t.formato?` · <span class="fmt">${esc(t.formato)}</span>`:""}</div><div>${esc(t.ideia||"")}</div>${t.nota?`<div class="tiny" style="margin-top:4px;white-space:pre-line">${esc(t.nota)}</div>`:""}</div>`).join("")}</div>`;}).join("")}</div>
  </div></section>`;
}

/* ---------- interactions ---------- */
function afterRender(){
  const v = $("#view"); if(!v) return;
  v.onclick = e=>{
    if(e.target.closest("a[href]")) return;
    const z = e.target.closest("[data-zoom]"); if(z){ S.mapZoom=z.dataset.zoom; zoomTo(S.mapZoom,true); v.querySelectorAll("[data-zoom]").forEach(b=>b.setAttribute("aria-pressed",b===z)); return; }
    const gb = e.target.closest("[data-guide]"); if(gb){ S.guiaSel=gb.dataset.guide; render(); return; }
    const hb = e.target.closest("[data-hoje]"); if(hb){ const n=+hb.dataset.hoje; S.hojeOff = n===0 ? 0 : S.hojeOff+n; render(); return; }
    const cp = e.target.closest("[data-copy]"); if(cp){ const txt=cp.dataset.copy; try{ navigator.clipboard.writeText(txt).then(()=>toast("Código copiado"),()=>toast(txt)); }catch(err){ toast(txt); } return; }
    const a = e.target.closest("[data-act]"); if(!a) return;
    const id=a.dataset.id, act=a.dataset.act;
    if(!canWrite() && act!=="cancel-pick") return;
    ({
      "new-day":()=>dayForm({}), "edit-day":()=>dayForm(S.dias.find(x=>x.id===id)),
      "new-item":()=>itemForm({diaId:a.dataset.dia}), "edit-item":()=>itemForm(S.itens.find(x=>x.id===id)),
      "new-place":()=>placeForm({status:"visitado",juntos:true}), "edit-place":()=>placeForm(S.lugares.find(x=>x.id===id)),
      "cancel-pick":()=>{const d=S.picking; S.picking=null; render(); if(d) placeForm(d);},
      "new-guide":()=>guideForm({}), "edit-guide":()=>guideForm(S.guia.find(x=>x.id===id)),
      "new-res":()=>resForm({estado:"pendente"}), "edit-res":()=>resForm(S.reservas.find(x=>x.id===id)),
      "quick-cost":()=>quickExpense(a.dataset.date),
      "new-cost":()=>costForm({}), "edit-cost":()=>costForm(S.custos.find(x=>x.id===id)),
      "new-check":()=>checkForm({grupo:"Documentos"}), "edit-check":()=>checkForm(S.checklists.find(x=>x.id===id)),
      "new-take":()=>takeForm({status:"ideia"}), "edit-take":()=>takeForm(S.takes.find(x=>x.id===id))
    }[act]||(()=>{}))();
  };
  v.onkeydown = e=>{ if((e.key==="Enter"||e.key===" ") && e.target.matches("[data-act][tabindex]")){ e.preventDefault(); e.target.click(); } };
  v.onchange = e=>{
    const c = e.target.closest("[data-check]");
    if(c && canWrite()){ patch("checklists",c.dataset.check,{feito:c.checked}); }
    if(e.target.id==="f-estado-filtro"){ S.fEstado=e.target.value; render(); return; }
    if(e.target.id==="f-ano-filtro"){ S.fAno=e.target.value; render(); return; }
    if(e.target.id==="cambio" && canWrite()){ const n=num(e.target.value); if(n&&n>0){ write("privado","config",Object.assign({},S.priv,{cambio:n})).then(ok=>ok&&toast("Câmbio atualizado")); } }
  };
  const cov = $("#add-cover"); if(cov) cov.onclick=openSettings;
  if(S.view==="mapa"){ try{ drawMap(); }catch(e){ showFatal("Mapa: "+((e&&e.message)||e)); } }
}

/* ---------- map ---------- */
let mapCtx=null;
let mapLibP=null, mapLibTried=false;
function loadMapLib(){
  if(window.d3 && window.topojson && window.STATES) return Promise.resolve(true);
  if(mapLibP) return mapLibP;
  const add = src => new Promise(r=>{ const sc=document.createElement("script"); sc.src=src; sc.onload=()=>r(true); sc.onerror=()=>r(false); document.head.appendChild(sc); });
  mapLibP = Promise.all([window.d3?true:add("maplib.js"), window.STATES?true:add("states.js")]).then(()=>{ if(!window.d3) mapLibP=null; return !!window.d3; });
  return mapLibP;
}
function drawMap(){
  const el = $("#map"); if(!el) return;
  if(!window.d3 || !window.topojson || (!window.STATES && !mapLibTried)){ mapLibTried = true;
    const note=document.createElement("p"); note.className="small muted map-wait"; note.textContent="Carregando o mapa…"; el.appendChild(note);
    loadMapLib().then(ok=>{ if(S.view!=="mapa") return; const cur=$("#map"); if(!cur) return; const n=cur.querySelector(".map-wait"); if(n) n.remove();
      if(ok && !cur.querySelector("svg")) { try{ drawMap(); }catch(e){ showFatal("Mapa: "+((e&&e.message)||e)); } }
      else if(!ok) cur.insertAdjacentHTML("beforeend",`<p class="small muted map-wait">O mapa não carregou. Verifique a internet e recarregue.</p>`); });
    return;
  }
  if(!window.WORLD){ el.insertAdjacentHTML("beforeend",`<p class="small muted map-wait">O mapa não carregou. Recarregue a página.</p>`); return; }
  const d3=window.d3;
  const W = 960, H = 500;
  const feats = topojson.feature(WORLD, WORLD.objects.countries).features.filter(f=>f.properties.a2!=="AQ");
  const proj = d3.geoNaturalEarth1().fitExtent([[6,6],[W-6,H-6]],{type:"FeatureCollection",features:feats});
  const path = d3.geoPath(proj);
  const visited = new Set(S.lugares.filter(l=>l.status!=="planejado").map(l=>l.paisA2));
  const planned = new Set(S.lugares.filter(l=>l.status==="planejado").map(l=>l.paisA2));
  sortedDays().forEach(d=>d.paisA2&&planned.add(d.paisA2));
  const svg = d3.select(el).append("svg").attr("viewBox",`0 0 ${W} ${H}`).attr("role","img").attr("aria-label","Mapa-múndi com países visitados");
  const g = svg.append("g");
  g.append("g").selectAll("path").data(feats).join("path").attr("d",path)
    .style("fill",f=>visited.has(f.properties.a2)?"var(--visited)":planned.has(f.properties.a2)?"var(--planned)":"var(--land)")
    .style("stroke","var(--land-line)").attr("stroke-width",.5).attr("vector-effect","non-scaling-stroke")
    .append("title").text(f=>countryName(f.properties.a2));
  if(window.STATES && window.STATES.objects && window.STATES.objects.s){
    const vis = new Set(S.lugares.filter(l=>l.status!=="planejado" && l.paisA2==="BR" && l.estado).map(l=>nrm(l.estado)));
    const sts = topojson.feature(STATES, STATES.objects.s).features;
    g.append("g").selectAll("path").data(sts).join("path").attr("d",path)
      .style("fill",f=> (vis.has(nrm(f.properties.n))||vis.has(nrm(f.properties.p))) ? "var(--visited)" : visited.has("BR") ? "var(--state-soft)" : "var(--land)")
      .style("stroke","var(--land-line)").attr("stroke-width",.4).attr("vector-effect","non-scaling-stroke")
      .append("title").text(f=>f.properties.n);
  }
  const pts = S.lugares.filter(l=>isFinite(l.lat)&&isFinite(l.lng)&&l.lat!==null&&l.lng!==null);
  const tip = document.createElement("div"); tip.className="tip"; tip.hidden=true; el.appendChild(tip);
  const mk = g.append("g").selectAll("circle").data(pts).join("circle")
    .attr("cx",l=>proj([l.lng,l.lat])[0]).attr("cy",l=>proj([l.lng,l.lat])[1]).attr("r",4)
    .style("fill",l=>l.status==="planejado"?"#ffffff":"var(--visited-pin)").attr("stroke",l=>l.status==="planejado"?"#0071e3":"#ffffff").attr("stroke-width",1.5).attr("vector-effect","non-scaling-stroke")
    .on("mouseenter",(ev,l)=>{ const r=el.getBoundingClientRect(); tip.textContent=(l.cidade||"")+(l.estado?", "+l.estado:""); tip.style.left=(ev.clientX-r.left)+"px"; tip.style.top=(ev.clientY-r.top)+"px"; tip.hidden=false; })
    .on("mouseleave",()=>{tip.hidden=true;});
  const zoom = d3.zoom().scaleExtent([1,40]).translateExtent([[0,0],[W,H]]).on("zoom",ev=>{ g.attr("transform",ev.transform); mk.attr("r",4/Math.sqrt(ev.transform.k)); });
  svg.call(zoom);
  svg.on("click",ev=>{
    if(!S.picking) return;
    const t = d3.zoomTransform(svg.node());
    const [px,py] = d3.pointer(ev, svg.node());
    const ll = proj.invert(t.invert([px,py])); if(!ll) return;
    const hit = feats.find(f=>d3.geoContains(f,ll));
    const draft = Object.assign({}, S.picking, {lat:+ll[1].toFixed(4), lng:+ll[0].toFixed(4)});
    if(hit && hit.properties.a2) draft.paisA2 = hit.properties.a2;
    const near = nearestCity(draft.lat, draft.lng);
    if(near && (!draft.paisA2 || draft.paisA2===near.c)){
      if(!draft.cidade) draft.cidade = near.n;
      if(!draft.estado) draft.estado = stateName(near.c, near.s);
      draft.paisA2 = near.c; draft._auto = true;
    }
    S.picking=null; render(); placeForm(draft);
  });
  if(S.mapAnim){
    S.mapAnim=false;
    g.selectAll("path").filter(function(){ const f=this.style.fill||""; return f.includes("visited")||f.includes("planned")||f.includes("state-soft"); })
      .style("opacity",0).transition().delay((d,i)=>200+i*12).duration(700).style("opacity",1);
    mk.attr("r",0).transition().delay((d,i)=>500+i*28).duration(650).ease(d3.easeBackOut.overshoot(2.2)).attr("r",4);
  }
  mapCtx = {svg,zoom,proj,W,H};
  zoomTo(S.mapZoom,false);
}
function zoomTo(k,anim){
  if(!mapCtx) return; const {svg,zoom,proj,W,H}=mapCtx;
  const boxes = {mundo:null, europa:[[-25,34],[35,62]], brasil:[[-74,-34],[-34,6]]};
  let t = window.d3.zoomIdentity;
  if(boxes[k]){ const [[x0,y0],[x1,y1]]=boxes[k]; const a=proj([x0,y1]), b=proj([x1,y0]);
    const s = Math.min(40, .92/Math.max((b[0]-a[0])/W,(b[1]-a[1])/H));
    t = window.d3.zoomIdentity.translate(W/2,H/2).scale(s).translate(-(a[0]+b[0])/2,-(a[1]+b[1])/2); }
  (anim && !matchMedia("(prefers-reduced-motion: reduce)").matches ? svg.transition().duration(650) : svg).call(zoom.transform,t);
}

/* ---------- gazetteer (offline) ---------- */
const nrm = t => String(t||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().trim();
let CITY=null, cityP=null;
function loadCities(){
  if(CITY) return Promise.resolve(CITY);
  if(cityP) return cityP;
  cityP = new Promise(res=>{
    const done=()=>{ if(!window.CITY_DATA){ res(null); return; }
      CITY = window.CITY_DATA.split("\n").map(l=>{ const p=l.split("\t"); return {n:p[0],k:nrm(p[0]),c:p[1],s:p[2],lat:+p[3],lng:+p[4],p:+p[5]||0}; });
      res(CITY); };
    if(window.CITY_DATA) return done();
    const sc=document.createElement("script"); sc.src="cities.js"; sc.onload=done; sc.onerror=()=>{cityP=null;res(null);}; document.head.appendChild(sc);
  });
  return cityP;
}
const stateName = (c,s) => (window.CITY_STATES&&window.CITY_STATES[c]&&window.CITY_STATES[c][s]) || s || "";
function searchCities(q,max=8){
  if(!CITY) return []; const k=nrm(q); if(k.length<2) return [];
  const out=[];
  for(const c of CITY){ if(c.k.startsWith(k)) out.push(c); }
  if(out.length<max){ for(const c of CITY){ if(!c.k.startsWith(k) && c.k.includes(" "+k)) out.push(c); if(out.length>200) break; } }
  out.sort((a,b)=>(b.k===k)-(a.k===k) || b.p-a.p || a.n.localeCompare(b.n,"pt"));
  return out.slice(0,max);
}
function nearestCity(lat,lng){
  if(!CITY) return null; let best=null,bd=Infinity; const cl=Math.cos(lat*Math.PI/180);
  for(const c of CITY){ const dx=(c.lng-lng)*cl, dy=c.lat-lat, d=dx*dx+dy*dy; if(d<bd){bd=d;best=c;} }
  return bd < 0.36 ? best : null;   // ~60 km
}

/* ---------- sheet (form) ---------- */
function sheet({title, fields, value, onSave, onDelete, extra, again}){
  const dlg = document.createElement("dialog"); dlg.className="sheet";
  const v = Object.assign({}, value||{});
  const fieldHtml = f=>{
    const id = "f-"+f.key; const val = v[f.key];
    if(f.type==="row") return `<div class="row2">${f.fields.map(fieldHtml).join("")}</div>`;
    if(f.type==="checkbox") return `<div class="field check-f"><input type="checkbox" id="${id}" ${val?"checked":""}><label for="${id}" style="color:var(--ink);font-weight:400;font-size:15px">${esc(f.label)}</label></div>`;
    let input;
    if(f.type==="textarea") input=`<textarea id="${id}" ${f.rows?`rows="${f.rows}"`:""}>${esc(val==null?"":val)}</textarea>`;
    else if(f.type==="select") input=`<select id="${id}">${f.options.map(([ov,ol])=>`<option value="${esc(ov)}" ${String(val??"")===String(ov)?"selected":""}>${esc(ol)}</option>`).join("")}</select>`;
    else input=`<input type="${f.type==="number"?"text":(f.type||"text")}" ${f.type==="number"?'inputmode="decimal"':""} id="${id}" value="${esc(val==null?"":(f.type==="number"?String(val).replace(".",","):val))}" ${f.placeholder?`placeholder="${esc(f.placeholder)}"`:""}>`;
    return `<div class="field"><label for="${id}">${esc(f.label)}</label>${input}${f.help?`<span class="help">${esc(f.help)}</span>`:""}</div>`;
  };
  dlg.innerHTML = `<form method="dialog"><header><h2 class="h3">${esc(title)}</h2><button type="button" class="icon-btn" data-x aria-label="Fechar">✕</button></header>
    <div class="body">${fields.map(fieldHtml).join("")}<div id="sheet-extra"></div></div>
    <footer>${onDelete?`<button type="button" class="btn plain" data-del>Excluir</button>`:""}<span class="sp"></span><button type="button" class="btn plain" data-x>Cancelar</button>${again?`<button type="button" class="btn secondary" data-again>Salvar e adicionar outro</button>`:""}<button type="submit" class="btn">Salvar</button></footer></form>`;
  document.body.appendChild(dlg);
  const close = ()=>{ try{ if(dlg.close) dlg.close(); }catch(e){} dlg.remove(); };
  dlg.querySelectorAll("[data-x]").forEach(b=>b.onclick=close);
  dlg.addEventListener("cancel",e=>{e.preventDefault();close();});
  const read = ()=>{ const out={}; const walk=fs=>fs.forEach(f=>{ if(f.type==="row") return walk(f.fields); const el=dlg.querySelector("#f-"+f.key); if(!el) return;
      out[f.key] = f.type==="checkbox"?el.checked : f.type==="number"?num(el.value) : el.value.trim(); }); walk(fields); return out; };
  const ctx = {dlg, read, close, value:v};
  if(extra) extra(dlg.querySelector("#sheet-extra"), ctx);
  dlg.querySelector("form").onsubmit = async e=>{ e.preventDefault(); const btn=dlg.querySelector("[type=submit]"); btn.disabled=true; const ok = await onSave(read(), ctx); btn.disabled=false; if(ok!==false){ close(); toast("Salvo"); } };
  const ag = dlg.querySelector("[data-again]");
  if(ag) ag.onclick = async ()=>{ ag.disabled=true; const o=read(); const ok = await onSave(o, ctx); ag.disabled=false; if(ok!==false){ close(); toast("Salvo. Próximo lugar:"); again(o); } };
  const del = dlg.querySelector("[data-del]");
  if(del) del.onclick = async ()=>{ if(!del.dataset.confirm){ del.dataset.confirm="1"; del.textContent="Confirmar exclusão"; del.className="btn danger"; return; } await onDelete(); close(); toast("Excluído"); };
  if(typeof dlg.showModal==="function"){ try{ dlg.showModal(); }catch(e){ dlg.setAttribute("open",""); dlg.classList.add("no-modal"); } }
  else { dlg.setAttribute("open",""); dlg.classList.add("no-modal"); }
  return ctx;
}
const countryOptions = (()=>{ let c=null; return ()=>{ if(c) return c; const set=new Set((window.WORLD?WORLD.objects.countries.geometries:[]).map(g=>g.properties.a2).filter(a=>a&&a!=="AQ")); ["SG","MT","LU","AD","MC","VA","SM","LI","BH","HK","MO"].forEach(x=>set.add(x));
  c=[["","Escolha o país"],...[...set].map(a=>[a,countryName(a)]).sort((a,b)=>a[1].localeCompare(b[1],"pt"))]; return c; }; })();

function dayForm(d){ d=d||{};
  sheet({title:d.id?"Editar dia":"Novo dia", value:d, fields:[
    {type:"row",fields:[{key:"data",label:"Data",type:"date"},{key:"paisA2",label:"País",type:"select",options:countryOptions()}]},
    {key:"cidade",label:"Cidade",placeholder:"Lisboa"},
    {key:"titulo",label:"Título do dia",placeholder:"Chegada e Belém"},
    {key:"resumo",label:"Resumo",type:"textarea"}],
    onSave:o=>{ if(!o.data){toast("Escolha a data.");return false;} o.cidade=tidyName(o.cidade); return write("dias",d.id,Object.assign({},d,o)); },
    onDelete:d.id?async()=>{ await remove("dias",d.id); for(const i of itemsOf(d.id)) await remove("itens",i.id); }:null });
}
function itemForm(i){ i=i||{};
  sheet({title:i.id?"Editar item":"Novo item", value:i, fields:[
    {type:"row",fields:[{key:"hora",label:"Horário",type:"time"},{key:"tipo",label:"Tipo",type:"select",options:Object.entries(TIPOS)}]},
    {key:"titulo",label:"O quê"},
    {key:"nota",label:"Detalhes",type:"textarea",help:"Preços, dicas, como chegar. Aparece para os seguidores."},
    {type:"row",fields:[{key:"link",label:"Link",type:"url",placeholder:"https://"},{key:"linkLabel",label:"Texto do link",placeholder:"Site oficial"}]},
    {key:"diaId",label:"Dia",type:"select",options:sortedDays().map(d=>[d.id,fmtDay(d.data).short+" · "+(d.cidade||"")])}],
    onSave:o=>{ if(!o.titulo){toast("Escreva o que é o item.");return false;} return write("itens",i.id,Object.assign({},i,o)); },
    onDelete:i.id?()=>remove("itens",i.id):null });
}
function placeForm(l){ l=l||{};
  sheet({title:l.id?"Editar lugar":"Novo lugar", value:Object.assign({},l,{coords:(l.lat!=null&&l.lng!=null)?`${l.lat}, ${l.lng}`:"",linksTxt:(l.links||[]).map(x=>(x.label||"")+" | "+x.url).join("\n")}), fields:[
    {type:"row",fields:[{key:"cidade",label:"Cidade",placeholder:"Salvador"},{key:"estado",label:"Estado / região",placeholder:"Bahia"}]},
    {type:"row",fields:[{key:"paisA2",label:"País",type:"select",options:countryOptions()},{key:"status",label:"Situação",type:"select",options:[["visitado","Visitado"],["planejado","No roteiro"]]}]},
    {key:"coords",label:"Coordenadas",placeholder:"-12.9777, -38.5016",help:"Cole do Google Maps (clique com o botão direito no lugar) ou escolha no mapa abaixo."},
    {type:"row",fields:[{key:"quando",label:"Quando",placeholder:"Jan 2024"},{key:"juntos",label:"Fomos juntos",type:"checkbox"}]},
    {key:"nota",label:"Lembrança",type:"textarea",help:"Aparece para os seguidores."},
    {key:"linksTxt",label:"Links (um por linha: texto | url)",type:"textarea",rows:3,placeholder:"Reel | https://instagram.com/..."}],
    extra:(box,ctx)=>{
      wirePlaceAuto(ctx.dlg, !!l._auto);
      ctx.fotos = (l.fotos||[]).slice();
      box.innerHTML = `<div class="field"><label>Fotos</label><div class="photo-edit" id="pe"></div>
        ${S.assets?`<input type="file" id="f-up" accept="image/png,image/jpeg,image/webp" multiple><span class="help">Até 6 fotos por lugar. Vídeos: use os links (Reels, YouTube).</span>`:`<span class="help">O envio de fotos fica disponível para quem edita o site.</span>`}</div>
        <button type="button" class="btn secondary" id="pick">Escolher no mapa</button>`;
      const draw=()=>{ box.querySelector("#pe").innerHTML = ctx.fotos.map((id,ix)=>`<figure><img src="/_blob/${esc(id)}" alt=""><button type="button" data-rm="${ix}" aria-label="Remover foto">×</button></figure>`).join(""); };
      draw();
      box.querySelector("#pe").onclick=e=>{ const b=e.target.closest("[data-rm]"); if(b){ ctx.fotos.splice(+b.dataset.rm,1); draw(); } };
      const up = box.querySelector("#f-up");
      if(up) up.onchange = async ()=>{ for(const file of [...up.files]){ if(ctx.fotos.length>=6){toast("Máximo de 6 fotos.");break;}
          try{ const small = await shrink(file,1600); const r = await S.assets.upload(small,{type:"image/jpeg"}); ctx.fotos.push(r.id); draw(); }
          catch(e){ toast(e&&e.code==="too_large"?"Foto grande demais.":"Não deu para enviar a foto."); } } up.value=""; };
      box.querySelector("#pick").onclick=()=>{ loadCities(); const o=ctx.read(); S.picking = Object.assign({},l,parsePlace(o),{fotos:ctx.fotos}); ctx.close(); if(S.view!=="mapa"){ location.hash="mapa"; } else render(); };
    },
    onSave:async(o,ctx)=>{ const p=parsePlace(o); delete l._auto; if(!p.cidade){toast("Escreva o nome da cidade.");return false;}
      await loadCities();
      const c = canonCity(p.cidade, p.paisA2);
      p.cidade = c ? c.n : tidyName(p.cidade);
      p.estado = canonState(p.estado, p.paisA2);
      if(c && (p.lat==null || p.lng==null)){ p.lat=c.lat; p.lng=c.lng; }
      const dup = S.lugares.find(x=>x.id!==l.id && x.paisA2===p.paisA2 && nrm(x.cidade)===nrm(p.cidade) && nrm(x.estado)===nrm(p.estado));
      if(dup && !ctx.dupOk){ ctx.dupOk=true; toast(p.cidade+" já está no mapa. Toque em Salvar de novo para registrar mesmo assim."); return false; }
      p.fotos=ctx.fotos; const base=Object.assign({},l); delete base.id; delete base.linksTxt; delete base.coords; return write("lugares",l.id,Object.assign(base,p)); },
    again: l.id ? null : (o)=>placeForm({status:o.status||"visitado", juntos:o.juntos, paisA2:o.paisA2, quando:o.quando}),
    onDelete:l.id?()=>remove("lugares",l.id):null });
}
function wirePlaceAuto(dlg, autoFilled){
  const city=dlg.querySelector("#f-cidade"), st=dlg.querySelector("#f-estado"), co=dlg.querySelector("#f-paisA2"), crd=dlg.querySelector("#f-coords");
  if(!city) return;
  const wrap=city.parentElement; wrap.classList.add("ac-wrap");
  const list=document.createElement("ul"); list.className="ac"; list.id="ac-list"; list.setAttribute("role","listbox"); list.hidden=true; wrap.appendChild(list);
  city.setAttribute("autocomplete","off"); city.setAttribute("role","combobox"); city.setAttribute("aria-controls","ac-list"); city.setAttribute("aria-expanded","false");
  const hint=document.createElement("span"); hint.className="help"; hint.id="auto-hint";
  hint.textContent = autoFilled ? "Estado e país identificados pelo mapa. Você pode trocar se quiser." : "Digite a cidade e escolha na lista: estado, país e coordenadas são preenchidos sozinhos.";
  wrap.appendChild(hint);
  const dl=document.createElement("datalist"); dl.id="dl-estados"; dlg.appendChild(dl); st.setAttribute("list","dl-estados");
  const fillStates=()=>{ const m=(window.CITY_STATES||{})[co.value]||{}; dl.innerHTML=Object.values(m).sort((a,b)=>a.localeCompare(b,"pt")).map(n=>`<option value="${esc(n)}"></option>`).join(""); };
  let res=[], act=-1, picked=false;
  const close=()=>{ list.hidden=true; city.setAttribute("aria-expanded","false"); act=-1; };
  const apply=(c, opts={})=>{
    if(!c) return;
    if(!opts.keepName) city.value=c.n;
    if(!opts.onlyEmpty || !st.value) st.value=stateName(c.c,c.s);
    if(!opts.onlyEmpty || !co.value) co.value=c.c;
    if(!opts.onlyEmpty || !crd.value) crd.value=c.lat+", "+c.lng;
    fillStates(); picked=true;
    hint.textContent=`Identificado: ${stateName(c.c,c.s)||"região não informada"}, ${countryName(c.c)}. Se não for essa, troque estado e país abaixo.`;
    close();
  };
  const draw=()=>{
    if(!res.length){ close(); return; }
    list.innerHTML=res.map((c,i)=>`<li role="option" id="ac-${i}" data-i="${i}" aria-selected="${i===act}"><span class="flag">${flag(c.c)}</span><span class="ac-n">${esc(c.n)}</span><span class="ac-s">${esc([stateName(c.c,c.s),countryName(c.c)].filter(Boolean).join(", "))}</span></li>`).join("");
    list.hidden=false; city.setAttribute("aria-expanded","true");
    if(act>=0) city.setAttribute("aria-activedescendant","ac-"+act); else city.removeAttribute("aria-activedescendant");
  };
  city.addEventListener("input",async()=>{ picked=false; await loadCities(); res=searchCities(city.value); act=-1; draw(); });
  city.addEventListener("keydown",e=>{
    if(list.hidden) return;
    if(e.key==="ArrowDown"){ e.preventDefault(); act=Math.min(res.length-1,act+1); draw(); }
    else if(e.key==="ArrowUp"){ e.preventDefault(); act=Math.max(0,act-1); draw(); }
    else if(e.key==="Enter" && act>=0){ e.preventDefault(); apply(res[act]); }
    else if(e.key==="Escape"){ e.preventDefault(); e.stopPropagation(); close(); }
  });
  list.addEventListener("mousedown",e=>{ const li=e.target.closest("li[data-i]"); if(li){ e.preventDefault(); apply(res[+li.dataset.i]); } });
  city.addEventListener("blur",()=>{ setTimeout(()=>{
    close();
    if(picked || !city.value.trim()) return;
    const k=nrm(city.value); const exact=(CITY||[]).filter(c=>c.k===k).sort((a,b)=>b.p-a.p);
    if(exact.length && (!st.value || !co.value)) apply(exact[0],{keepName:true,onlyEmpty:true});
  },120); });
  co.addEventListener("change",fillStates);
  loadCities().then(fillStates);
}
function parsePlace(o){
  const p = {cidade:o.cidade, estado:o.estado, paisA2:o.paisA2, status:o.status, quando:o.quando, juntos:o.juntos, nota:o.nota};
  const m = String(o.coords||"").match(/(-?\d+(?:\.\d+)?)\s*[,; ]\s*(-?\d+(?:\.\d+)?)/);
  if(m){ p.lat=+m[1]; p.lng=+m[2]; } else { p.lat=null; p.lng=null; }
  p.links = String(o.linksTxt||"").split("\n").map(s=>s.trim()).filter(Boolean).map(s=>{ const [a,b]=s.includes("|")?s.split("|").map(x=>x.trim()):["Link",s]; return {label:a||"Link",url:b}; }).filter(x=>safeUrl(x.url));
  return p;
}
function shrink(file,max){ return new Promise((res,rej)=>{ const img=new Image(); const u=URL.createObjectURL(file); img.onload=()=>{ const k=Math.min(1,max/Math.max(img.width,img.height)); const c=document.createElement("canvas"); c.width=Math.round(img.width*k); c.height=Math.round(img.height*k); c.getContext("2d").drawImage(img,0,0,c.width,c.height); URL.revokeObjectURL(u); c.toBlob(b=>b?res(b):rej(new Error("x")),"image/jpeg",.85); }; img.onerror=()=>rej(new Error("img")); img.src=u; }); }

function guideForm(g){ g=g||{};
  const txt = (g.secoes||[]).map(s=>"## "+s.titulo+"\n"+(s.itens||[]).map(t=>"- "+t).join("\n")+((s.fontes||[]).length?"\n"+(s.fontes||[]).map(f=>"fonte: "+f.label+" | "+f.url).join("\n"):"")).join("\n\n");
  sheet({title:g.id?"Editar guia":"Novo país no guia", value:Object.assign({},g,{texto:txt}), fields:[
    {type:"row",fields:[{key:"titulo",label:"Nome na aba",placeholder:"Portugal"},{key:"paisA2",label:"País",type:"select",options:countryOptions()}]},
    {key:"ordem",label:"Ordem",type:"number"},
    {key:"intro",label:"Introdução",type:"textarea",rows:2},
    {key:"texto",label:"Seções",type:"textarea",rows:14,help:"'## Título' abre uma seção, '- ' cria um item, 'fonte: nome | https://...' adiciona fonte."}],
    onSave:o=>{ const secoes=[]; let cur=null; String(o.texto||"").split("\n").forEach(line=>{ const t=line.trim(); if(!t) return;
        if(t.startsWith("## ")){ cur={titulo:t.slice(3).trim(),itens:[],fontes:[]}; secoes.push(cur); }
        else if(/^fonte:/i.test(t) && cur){ const [a,b]=t.replace(/^fonte:/i,"").split("|").map(x=>x.trim()); if(safeUrl(b)) cur.fontes.push({label:a,url:b}); }
        else if(cur){ cur.itens.push(t.replace(/^[-•]\s*/,"")); } });
      return write("guia",g.id,{titulo:o.titulo,paisA2:o.paisA2,ordem:o.ordem||0,intro:o.intro,secoes}); },
    onDelete:g.id?()=>remove("guia",g.id):null });
}
function resForm(r){ r=r||{};
  sheet({title:r.id?"Editar reserva":"Nova reserva", value:r, fields:[
    {type:"row",fields:[{key:"tipo",label:"Tipo",type:"select",options:Object.entries(RES_TIPOS)},{key:"estado",label:"Situação",type:"select",options:[["pendente","Pendente"],["reservado","Reservado"],["pago","Pago"]]}]},
    {key:"titulo",label:"Descrição",placeholder:"Voo Lisboa → Amsterdam"},
    {type:"row",fields:[{key:"data",label:"Data",type:"date"},{key:"hora",label:"Horário",type:"time"}]},
    {key:"codigo",label:"Código / localizador"},{key:"endereco",label:"Endereço"},{key:"link",label:"Link",type:"url"},{key:"nota",label:"Observações",type:"textarea"}],
    onSave:o=>{ if(!o.titulo){toast("Descreva a reserva.");return false;} return write("reservas",r.id,o); },
    onDelete:r.id?()=>remove("reservas",r.id):null });
}
function costForm(c){ c=c||{};
  const cb=num(S.priv.cambio)||6.3;
  sheet({title:c.id?"Editar custo":"Novo custo", value:c, fields:[
    {key:"titulo",label:"Item"},
    {type:"row",fields:[{key:"categoria",label:"Categoria",type:"select",options:CATS.map(x=>[x,x])},{key:"paisA2",label:"País",type:"select",options:countryOptions()}]},
    {type:"row",fields:[{key:"prevEUR",label:"Previsto (€, casal)",type:"number"},{key:"realEUR",label:"Pago (€, casal)",type:"number",help:`Câmbio atual: €1 = R$ ${String(cb).replace(".",",")}`}]},
    {key:"data",label:"Dia do gasto (opcional)",type:"date"},
    {key:"nota",label:"Como chegamos nesse valor",type:"textarea"},{key:"fonte",label:"Fonte (link)",type:"url"}],
    onSave:o=>{ if(!o.titulo){toast("Dê um nome ao custo.");return false;} return write("custos",c.id,o); },
    onDelete:c.id?()=>remove("custos",c.id):null });
}
function quickExpense(date){
  const dt = date || todayISO();
  const day = sortedDays().find(d=>d.data===dt);
  const cb = num(S.priv.cambio)||6.3;
  sheet({title:"Lançar gasto", value:{moeda:"EUR", categoria:"Alimentação", data:dt}, fields:[
    {type:"row",fields:[{key:"valor",label:"Valor",type:"number",placeholder:"12,50"},{key:"moeda",label:"Moeda",type:"select",options:[["EUR","€ Euro"],["BRL","R$ Real"]]}]},
    {key:"categoria",label:"Categoria",type:"select",options:CATS.map(x=>[x,x])},
    {key:"titulo",label:"Descrição (opcional)",placeholder:"Almoço em Alfama"},
    {key:"data",label:"Dia",type:"date"}],
    onSave:o=>{
      if(!(o.valor>0)){ toast("Digite o valor."); return false; }
      const e = o.moeda==="BRL" ? Math.round(o.valor/cb*100)/100 : o.valor;
      const dd = sortedDays().find(d=>d.data===o.data) || day;
      return write("custos", null, {titulo:o.titulo||o.categoria, categoria:o.categoria, paisA2:(dd&&dd.paisA2)||"", prevEUR:null, realEUR:e, data:o.data,
        nota:o.moeda==="BRL" ? `Pago R$ ${String(o.valor).replace(".",",")} (câmbio €1 = R$ ${String(cb).replace(".",",")})` : "", rapido:true});
    }});
  setTimeout(()=>{ const v=document.querySelector("#f-valor"); if(v) v.focus(); },60);
}
function checkForm(c){ c=c||{};
  const gs=[...new Set([...CHK_GROUPS,...S.checklists.map(x=>x.grupo).filter(Boolean)])];
  sheet({title:c.id?"Editar item":"Novo item", value:c, fields:[
    {key:"texto",label:"Item"},{key:"grupo",label:"Lista",type:"select",options:gs.map(x=>[x,x])},
    {key:"nota",label:"Observação",type:"textarea",rows:3},{key:"fonte",label:"Fonte (link)",type:"url"},{key:"feito",label:"Pronto",type:"checkbox"}],
    onSave:o=>{ if(!o.texto){toast("Escreva o item.");return false;} return write("checklists",c.id,Object.assign({ordem:c.ordem||Date.now()},o)); },
    onDelete:c.id?()=>remove("checklists",c.id):null });
}
function takeForm(t){ t=t||{};
  sheet({title:t.id?"Editar ideia":"Nova ideia de gravação", value:t, fields:[
    {key:"ideia",label:"Ideia",type:"textarea",rows:3},
    {type:"row",fields:[{key:"lugar",label:"Lugar",placeholder:"Lisboa"},{key:"formato",label:"Formato",type:"select",options:[["Reels","Reels"],["YouTube","YouTube"],["Shorts","Shorts"],["Stories","Stories"],["Foto","Foto / carrossel"]]}]},
    {key:"status",label:"Situação",type:"select",options:TAKE_STATUS},
    {key:"nota",label:"Notas de produção",type:"textarea",rows:3}],
    onSave:o=>{ if(!o.ideia){toast("Descreva a ideia.");return false;} return write("takes",t.id,o); },
    onDelete:t.id?()=>remove("takes",t.id):null });
}
function openSettings(){
  sheet({title:"Ajustes do site", value:Object.assign({},S.site,{cambio:S.priv.cambio,teto:S.priv.teto}), fields:[
    {key:"nome",label:"Nome do site",placeholder:"Latitude 53"},
    {key:"eyebrow",label:"Linha acima do nome",placeholder:"Gustavo e Priscila"},
    {key:"subtitulo",label:"Frase de apresentação",type:"textarea",rows:2},
    {key:"partida",label:"Data do embarque",type:"date"},
    {type:"row",fields:[{key:"cambio",label:"Câmbio (R$ por €)",type:"number"},{key:"teto",label:"Teto do orçamento (€)",type:"number"}]}],
    extra:(box,ctx)=>{
      ctx.capaId = S.site.capaId||null;
      box.innerHTML = `<div class="field"><label>Foto de capa</label><div class="photo-edit" id="cv"></div>${S.assets?`<input type="file" id="f-cover" accept="image/png,image/jpeg,image/webp">`:`<span class="help">Envio indisponível nesta visualização.</span>`}</div>
        <div class="field"><label>Versão pública para seguidores</label><span class="help">Gera um arquivo HTML com mapa, roteiro e guia, sem custos, reservas, checklists ou gravações. Hospede onde quiser ou peça ao Claude para publicar como página pública.</span><button type="button" class="btn secondary" id="exp" ${S.downloads?"":"disabled"}>Baixar versão pública</button></div>`;
      const draw=()=>{ box.querySelector("#cv").innerHTML = ctx.capaId?`<figure><img src="/_blob/${esc(ctx.capaId)}" alt=""><button type="button" id="rmcv" aria-label="Remover capa">×</button></figure>`:""; const r=box.querySelector("#rmcv"); if(r) r.onclick=()=>{ctx.capaId=null;draw();}; };
      draw();
      const f=box.querySelector("#f-cover"); if(f) f.onchange=async()=>{ const file=f.files[0]; if(!file) return; try{ const small=await shrink(file,2400); const r=await S.assets.upload(small,{type:"image/jpeg"}); ctx.capaId=r.id; draw(); }catch(e){ toast("Não deu para enviar a foto."); } };
      box.querySelector("#exp").onclick=exportPublic;
    },
    onSave:async(o,ctx)=>{
      const site = {nome:o.nome||"Latitude 53", eyebrow:o.eyebrow, subtitulo:o.subtitulo, partida:o.partida||"2026-12-22", capaId:ctx.capaId};
      const ok1 = await write("config","site",site);
      const ok2 = await write("privado","config",Object.assign({},S.priv,{cambio:o.cambio||6.3,teto:o.teto}));
      return ok1&&ok2;
    }});
}

/* ---------- public export ---------- */
async function toDataUrl(id,max){ return new Promise(res=>{ const img=new Image(); img.onload=()=>{ const k=Math.min(1,max/Math.max(img.width,img.height)); const c=document.createElement("canvas"); c.width=Math.round(img.width*k); c.height=Math.round(img.height*k); c.getContext("2d").drawImage(img,0,0,c.width,c.height); try{res(c.toDataURL("image/jpeg",.8));}catch(e){res(null);} }; img.onerror=()=>res(null); img.src="/_blob/"+id; }); }
async function exportPublic(){
  if(!S.downloads){ toast("Download indisponível nesta visualização."); return; }
  toast("Montando a versão pública…");
  try{
    const [css,js,world,maplib,states] = await Promise.all(["app.css","app.js","world.js","maplib.js","states.js"].map(f=>fetch(f).then(r=>{ if(!r.ok) throw new Error(f); return r.text(); })));
    const lugares = [];
    for(const l of S.lugares){ const c=Object.assign({},l); c.fotosData=[]; for(const id of (l.fotos||[])) c.fotosData.push(await toDataUrl(id,1200)); lugares.push(c); }
    const site = Object.assign({},S.site); if(site.capaId){ site.capaData = await toDataUrl(site.capaId,2000); }
    const data = {site, dias:S.dias, itens:S.itens, lugares, guia:S.guia};
    const safe = s => s.replace(/<\/script/gi,"<\\/script").replace(/<!--/g,"<\\!--");
    const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${esc(site.nome||"Latitude 53")}</title><style>body{margin:0}img{max-width:100%}[hidden]{display:none!important}\n${css}</style></head><body><div id="app"></div>
<script>${safe(maplib)}</script><script>${safe(states)}</script>
<script>${safe(world)}</script><script>window.__PUBLIC__=${safe(JSON.stringify(data))};</script><script>${safe(js)}</script></body></html>`;
    const slug = (site.nome||"latitude-53").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
    const r = await S.downloads.save({filename:slug+"-publico.html", data:html});
    if(r && r.status==="saved") toast("Arquivo salvo");
  }catch(e){ if(e && e.code==="cancelled") return; toast("Não deu para gerar o arquivo."); }
}

if(document.readyState==="loading") document.addEventListener("DOMContentLoaded",boot); else boot();
})();
