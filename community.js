/* Latitude 53 — comunidade (Firebase Auth + Firestore).
   Fica desligada enquanto window.FIREBASE_CONFIG não estiver preenchido em firebase-config.js. */
(function(){
"use strict";
const L = window.LAT53;
const CFG = window.FIREBASE_CONFIG;
if(!L || !CFG || !CFG.apiKey) return;

const SDK = "vendor/";   // Firebase 10.14.1 servido pelo próprio site (fica em cache no celular)
const CACHE_KEY = "lat53-user";
function cachedUser(){ try{ return JSON.parse(localStorage.getItem(CACHE_KEY)||"null"); }catch(e){ return null; } }
function cacheUser(u){ try{ if(u) localStorage.setItem(CACHE_KEY, JSON.stringify(u)); else localStorage.removeItem(CACHE_KEY); }catch(e){} }
const C = {
  ready:false, user:null, verified:false, me:null, admins:new Set(),
  comments:[], byTarget:{}, profiles:{}, following:new Set(), saved:{},
  open:new Set(), perfilUid:null, filtro:"todos", members:null, unsub:[], authKnown:false,
  posts:[], fotos:{}, fotoLoading:new Set(), tipoF:"tudo",
  myTrips:[], pubTrips:[], invites:[], sentInv:[], tripId:null, tripDias:null, tripUnsub:null, tripDoc:null
};
{ const cu=cachedUser(); if(cu && cu.uid) C.profiles[cu.uid]={id:cu.uid, nome:cu.nome||"", foto:cu.foto||"", avatar:cu.avatar||""}; }
let fb=null, auth=null, db=null;
const esc=L.esc, toast=L.toast;
const TS = () => firebase.firestore.FieldValue.serverTimestamp();
function timed(p, ms){ return Promise.race([p, new Promise((_,rej)=>setTimeout(()=>rej({code:"timeout"}), ms||12000))]); }
function dbError(e, what){
  const code = e && e.code;
  const msg = code==="permission-denied" ? `Sem permissão para ${what}. Confira se as regras do Firestore foram publicadas.`
    : code==="timeout" || code==="unavailable" ? `Não consegui falar com o banco de dados para ${what}. Confira a internet; se continuar, o banco Firestore pode não ter sido criado.`
    : code==="not-saved" ? `O servidor não confirmou o salvamento. Use "Verificar conexão" no seu perfil e me mande o resultado.`
    : code==="not-found" ? `Banco de dados não encontrado ao ${what}. Confira se o Firestore foi criado como "(default)".`
    : `Não deu para ${what}${code?" ("+code+")":""}.`;
  toast(msg); C.lastError = msg + (code?" ["+code+"]":"");
  return false;
}

/* ---------- views are registered right away so links like #comunidade work ---------- */
L.addView("inicio","Início",vHome);
L.addView("viagens","Viagens",vViagens,{after:"inicio"});
L.addView("comunidade","Comunidade",vComunidade,{after:"viagens"});
L.addView("viagem","Nossa viagem",()=>L.homeView(),{after:"comunidade"});
L.addView("trip","Viagem",vTrip,{hidden:true});
L.addView("perfil","Perfil",vPerfil,{hidden:true});
L.addView("privacidade","Privacidade",vPrivacidade,{hidden:true});
L.addNav(navChip);
L.onAfterRender(decorate);

/* ---------- botão flutuante "Publicar", em todas as páginas ---------- */
(function installFab(){
  if(document.getElementById("fab-post")) return;
  const b=document.createElement("button"); b.type="button"; b.id="fab-post"; b.className="fab-post"; b.setAttribute("aria-label","Nova publicação");
  b.innerHTML='<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span class="fp-l">Publicar</span>';
  b.onclick=()=>{ if(!C.ready){ toast(C.failed?"A comunidade não carregou. Verifique a internet.":"Só um instante, conectando…"); return; } postSheet("post"); };
  document.body.appendChild(b); document.body.classList.add("has-fab");
  // encolhe para só o "+" ao rolar para baixo e volta ao rolar para cima
  let lastY=window.scrollY, tick=false;
  window.addEventListener("scroll",()=>{ if(tick) return; tick=true; requestAnimationFrame(()=>{ const y=window.scrollY; if(Math.abs(y-lastY)>6){ b.classList.toggle("mini", y>lastY && y>140); lastY=y; } tick=false; }); },{passive:true});
})();

/* ---------- load the Firebase SDK, then start ---------- */
function load(src){ return new Promise((res,rej)=>{ const s=document.createElement("script"); s.src=SDK+src; s.onload=res; s.onerror=()=>rej(new Error("Não carregou "+src)); document.head.appendChild(s); }); }
load("firebase-app-compat.js").then(()=>Promise.all([load("firebase-auth-compat.js"),load("firebase-firestore-compat.js")])).then(start).catch(()=>{ C.failed=true; if(window.__splashDone) window.__splashDone("auth"); L.render(); });

function start(){
  fb = firebase.initializeApp(CFG);
  auth = firebase.auth(); auth.languageCode = "pt";
  auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(()=>{ C.noStorage=true; });
  db = firebase.firestore();
  // conexão por "long polling": mais estável em redes móveis e no Safari do iPhone
  try{ db.settings({experimentalForceLongPolling:true, merge:true}); }catch(e){}
  C.ready = true;
  db.collection("admins").get().then(q=>{ C.admins=new Set(q.docs.map(d=>d.id)); pushLive(); refresh(); }).catch(()=>{});
  // check-ins (sem orderBy: dispensa índice composto); os dos autores desenham a rota ao vivo
  db.collection("posts").where("tipo","==","checkin").limit(150).onSnapshot(q=>{ liveDocs=q.docs.map(d=>Object.assign({id:d.id},d.data())); pushLive(); },()=>{});
  db.collection("comments").orderBy("em","desc").limit(300).onSnapshot(q=>{
    C.comments = q.docs.map(d=>Object.assign({id:d.id},d.data()));
    C.byTarget = {}; C.comments.forEach(c=>{ (C.byTarget[c.alvo]=C.byTarget[c.alvo]||[]).push(c); });
    want(C.comments.map(c=>c.uid)); refresh();
  },()=>{});
  db.collection("posts").orderBy("em","desc").limit(100).onSnapshot(q=>{
    C.posts = q.docs.map(d=>Object.assign({id:d.id},d.data()));
    want(C.posts.map(x=>x.uid)); refresh();
  },()=>{});
  db.collection("viagens").where("publica","==",true).limit(100).onSnapshot(q=>{ C.pubTrips=q.docs.map(d=>Object.assign({id:d.id},d.data())); want([].concat(...C.pubTrips.map(t=>t.membros||[]))); refresh(); },()=>{});
  auth.getRedirectResult().catch(e=>authError(e));
  auth.onAuthStateChanged(async u=>{
    const had=cachedUser(); const first=!C.authKnown; C.authKnown=true;
    if(window.__splashDone) window.__splashDone("auth");
    if(!u && first && had && had.uid) toast("Sua sessão terminou neste aparelho. Entre de novo.");
    cacheUser(u ? {uid:u.uid, nome:(C.profiles[u.uid]&&C.profiles[u.uid].nome)||u.displayName||"", foto:googlePhoto(u)} : null);
    C.unsub.forEach(f=>f()); C.unsub=[]; C.user=u; C.me=null; C.following=new Set(); C.saved={}; C.myTrips=[]; C.invites=[]; C.sentInv=[];
    if(u){
      C.verified = !!u.emailVerified;
      const ref=db.collection("profiles").doc(u.uid);
      try{
        const snap=await timed(ref.get({source:"server"}));
        if(!snap.exists){ await timed(ref.set(cleanProfile({nome:u.displayName||(u.email||"").split("@")[0], foto:googlePhoto(u), insta:"", cidade:"", bio:"", paises:[], criadoEm:TS()}))); }
      }catch(e){ dbError(e,"criar seu perfil"); }
      C.unsub.push(ref.onSnapshot(s=>{ C.me=s.exists?Object.assign({id:u.uid},s.data()):null; if(C.me){ C.profiles[u.uid]=C.me; cacheUser({uid:u.uid, nome:C.me.nome||"", foto:C.me.foto||"", avatar:C.me.avatar||""}); if(C.members){ const i=C.members.findIndex(m=>m.id===u.uid); if(i>=0) C.members[i]=C.me; else C.members.unshift(C.me); } } L.render(); },()=>{}));
      C.unsub.push(db.collection("follows").where("from","==",u.uid).onSnapshot(q=>{ C.following=new Set(q.docs.map(d=>d.data().to)); refresh(); },()=>{}));
      C.unsub.push(db.collection("viagens").where("membros","array-contains",u.uid).onSnapshot(q=>{ C.myTrips=q.docs.map(d=>Object.assign({id:d.id},d.data())); want([].concat(...C.myTrips.map(t=>t.membros||[]))); refresh(); },e=>{ dbError(e,"carregar suas viagens"); }));
      C.unsub.push(db.collection("convites").where("para","==",u.uid).onSnapshot(q=>{ C.invites=q.docs.map(d=>Object.assign({id:d.id},d.data())); want(C.invites.map(v=>v.de)); L.render(); },()=>{}));
      C.unsub.push(db.collection("convites").where("de","==",u.uid).onSnapshot(q=>{ C.sentInv=q.docs.map(d=>Object.assign({id:d.id},d.data())); want(C.sentInv.map(v=>v.para)); refresh(); },()=>{}));
      C.unsub.push(db.collection("users").doc(u.uid).collection("salvos").onSnapshot(q=>{ C.saved={}; q.docs.forEach(d=>C.saved[d.id]=d.data()); refresh(); },()=>{}));
    }
    L.render();
  });
}

/* ---------- helpers ---------- */
function googlePhoto(u){ const p=(u.providerData||[]).find(x=>x.providerId==="google.com"); const url=(p&&p.photoURL)||u.photoURL||""; return /^https:\/\/[a-z0-9.-]*googleusercontent\.com\//i.test(url)?url:""; }
/* resize a picked photo to a compact JPEG data URL (square crop for avatars) */
async function shrinkImage(file, maxSide, quality, square, maxChars){
  const url=URL.createObjectURL(file);
  try{
    const img=await new Promise((res,rej)=>{ const i=new Image(); i.onload=()=>res(i); i.onerror=()=>rej(new Error("img")); i.src=url; });
    let sw=img.naturalWidth, sh=img.naturalHeight, sx=0, sy=0;
    if(square){ const m=Math.min(sw,sh); sx=(sw-m)/2; sy=(sh-m)/2; sw=sh=m; }
    let k=Math.min(1, maxSide/Math.max(sw,sh)), q=quality, out="";
    for(let tries=0; tries<6; tries++){
      const c=document.createElement("canvas"); c.width=Math.max(1,Math.round(sw*k)); c.height=Math.max(1,Math.round(sh*k));
      const g=c.getContext("2d"); g.fillStyle="#fff"; g.fillRect(0,0,c.width,c.height); g.drawImage(img,sx,sy,sw,sh,0,0,c.width,c.height);
      out=c.toDataURL("image/jpeg",q);
      if(out.length<=maxChars) return out;
      q=Math.max(.45,q-.1); k*=.85;
    }
    if(out.length>maxChars) throw new Error("grande");
    return out;
  } finally { URL.revokeObjectURL(url); }
}
function cleanProfile(p){
  const o={};
  o.nome=String(p.nome||"").trim().slice(0,60)||"Viajante";
  o.insta=String(p.insta||"").replace(/^@/,"").replace(/[^A-Za-z0-9._]/g,"").slice(0,30);
  o.cidade=String(p.cidade||"").trim().slice(0,60);
  o.bio=String(p.bio||"").trim().slice(0,280);
  o.paises=(p.paises||[]).filter(a=>/^[A-Z]{2}$/.test(a)).slice(0,200);
  o.foto=p.foto&&/^https:\/\/[a-z0-9.-]*googleusercontent\.com\//i.test(p.foto)?p.foto:"";
  if(typeof p.avatar==="string" && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(p.avatar) && p.avatar.length<=140000) o.avatar=p.avatar;
  const cs=(Array.isArray(p.cidades)?p.cidades:[]).filter(c=>c && typeof c.n==="string" && /^[A-Z]{2}$/.test(c.c||"") && isFinite(c.la) && isFinite(c.lo))
    .slice(0,300).map(c=>({n:c.n.slice(0,60), c:c.c, s:String(c.s||"").slice(0,60), la:Math.round(c.la*1000)/1000, lo:Math.round(c.lo*1000)/1000}));
  if(cs.length) o.cidades=cs;          // only sent when used, so older rules keep working
  const pr=String(p.proximo||"").trim().slice(0,80); if(pr) o.proximo=pr;
  if(p.criadoEm) o.criadoEm=p.criadoEm;
  return o;
}
const wanted=new Set(); let wantT=0;
const asked=new Set();
function want(uids){ uids.forEach(u=>{ if(u && !C.profiles[u] && !asked.has(u)){ wanted.add(u); asked.add(u); } }); if(wanted.size && !wantT) wantT=setTimeout(fetchProfiles,30); }
async function fetchProfiles(){
  wantT=0; const ids=[...wanted]; wanted.clear();
  for(let i=0;i<ids.length;i+=10){
    try{ const q=await db.collection("profiles").where(firebase.firestore.FieldPath.documentId(),"in",ids.slice(i,i+10)).get(); q.docs.forEach(d=>C.profiles[d.id]=Object.assign({id:d.id},d.data())); }catch(e){}
  }
  refresh();
}
function nameOf(uid,fallback){ const p=C.profiles[uid]; return (p&&p.nome)||fallback||"Viajante"; }
function avatar(uid,size){
  const p=C.profiles[uid]||{}; const n=(p.nome||"?").trim();
  const ini=n.split(/\s+/).map(w=>w[0]).join("").slice(0,2).toUpperCase();
  const hue=[...uid].reduce((a,c)=>a+c.charCodeAt(0),0)%360;
  const pic = (p.avatar && /^data:image\/jpeg;base64,/.test(p.avatar)) ? p.avatar : p.foto;
  if(pic) return `<span class="av" style="--s:${size||36}px"><img src="${esc(pic)}" alt="" referrerpolicy="no-referrer" decoding="async"></span>`;
  return `<span class="av" style="--s:${size||36}px;--h:${hue}">${esc(ini)}</span>`;
}
const badge = uid => C.admins.has(uid) ? `<span class="badge-autor">Autor</span>` : "";
function when(ts){ const d=ts&&ts.toDate?ts.toDate():null; if(!d) return "agora"; const s=(Date.now()-d)/1000;
  if(s<60) return "agora"; if(s<3600) return Math.floor(s/60)+" min"; if(s<86400) return Math.floor(s/3600)+" h"; if(s<604800) return Math.floor(s/86400)+" d";
  return d.toLocaleDateString("pt-BR",{day:"numeric",month:"short"}); }
const CVIEWS=["inicio","viagens","trip","comunidade","perfil","privacidade"];
function refresh(){ decorate(false); if(["inicio","viagens","trip","comunidade","perfil"].includes(L.S.view)) L.render(); }
function needLogin(msg){ toast(msg||"Entre na sua conta para isso."); authSheet("entrar"); }
function authError(e){
  const m={ "auth/email-already-in-use":"Esse e-mail já tem conta. Use Entrar.", "auth/invalid-email":"E-mail inválido.",
    "auth/weak-password":"A senha precisa de pelo menos 6 caracteres.", "auth/invalid-credential":"E-mail ou senha incorretos.",
    "auth/wrong-password":"E-mail ou senha incorretos.", "auth/user-not-found":"Não encontramos conta com esse e-mail.",
    "auth/too-many-requests":"Muitas tentativas. Espere alguns minutos.", "auth/popup-closed-by-user":"",
    "auth/cancelled-popup-request":"", "auth/network-request-failed":"Sem conexão. Tente de novo.",
    "auth/requires-recent-login":"Por segurança, saia e entre de novo antes de excluir a conta.",
    "auth/unauthorized-domain":"Este endereço ainda não está autorizado no Firebase." };
  const t = (e && m[e.code]!==undefined) ? m[e.code] : "Não deu certo: "+((e&&e.message)||e);
  if(t) toast(t);
}
const icon = {
  chat:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M4 5.5h16v10H9l-5 4z"/></svg>',
  star:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z"/></svg>',
  starOn:'<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z"/></svg>',
  google:'<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>'
};

/* ---------- nav chip ---------- */
function navChip(){
  if(C.user) return `<button type="button" class="icon-btn c-me" id="c-me" aria-label="Meu perfil${C.invites.length?", convite pendente":""}">${avatar(C.user.uid,28)}${C.invites.length?`<span class="nav-dot" aria-hidden="true">${C.invites.length}</span>`:""}</button>`;
  if(!C.authKnown){
    const cu=cachedUser();
    if(cu && cu.uid) return `<span class="icon-btn c-me is-wait" aria-label="Conectando sua conta">${avatar(cu.uid,28)}</span>`;
    return `<span class="pill-btn is-wait" aria-label="Conectando">…</span>`;
  }
  return `<button type="button" class="pill-btn" id="c-entrar">Entrar</button>`;
}

/* ---------- decorations on days and places ---------- */
function decorate(){
  const ent=document.getElementById("c-entrar"); if(ent && !ent.dataset.b){ ent.dataset.b=1; ent.onclick=()=>authSheet("entrar"); }
  const me=document.getElementById("c-me"); if(me && !me.dataset.b){ me.dataset.b=1; me.onclick=()=>{ C.perfilUid=C.user.uid; L.go("perfil"); }; }
  if(!C.ready) return;
  loadPostPhotos();
  document.querySelectorAll("[data-day],[data-place],[data-post]").forEach(card=>{
    const isPost = !!card.dataset.post;
    const alvo = card.dataset.day ? "dia:"+card.dataset.day : isPost ? "post:"+card.dataset.post : "lugar:"+card.dataset.place;
    const titulo = card.dataset.title||"";
    const host = card.dataset.day ? (card.querySelector(".day-body")||card) : card;
    let bar = host.querySelector(":scope > .social");
    const list = C.byTarget[alvo]||[];
    const saved = !!C.saved[alvo.replace(":","_")];
    const html = `<div class="social-row">
        <button type="button" class="soc-btn" data-c-open aria-expanded="${C.open.has(alvo)}">${icon.chat}<span>${list.length?list.length+" "+(list.length===1?"comentário":"comentários"):"Comentar"}</span></button>
        <button type="button" class="soc-btn ${saved?"on":""}" data-c-save aria-pressed="${saved}">${saved?icon.starOn:icon.star}<span>${isPost ? (saved?"Na lista de desejos":"Quero ir") : (saved?"Salvo":"Salvar")}</span></button>
      </div>
      ${C.open.has(alvo)?thread(alvo,list):""}`;
    if(!bar){ bar=document.createElement("div"); bar.className="social"; host.appendChild(bar); }
    const active = document.activeElement && bar.contains(document.activeElement) && document.activeElement.tagName==="TEXTAREA";
    if(active){ // keep the draft while typing: only refresh the list
      const ul=bar.querySelector(".c-list"); if(ul) ul.outerHTML=commentsList(list); return; }
    if(bar.dataset.h!==html){ bar.innerHTML=html; bar.dataset.h=html; }
    bar.onclick = e=>{
      if(e.target.closest("[data-c-open]")){ C.open.has(alvo)?C.open.delete(alvo):C.open.add(alvo); bar.dataset.h=""; decorate(); if(C.open.has(alvo)){ const ta=bar.querySelector("textarea"); if(ta && matchMedia("(hover:hover)").matches) ta.focus(); } return; }
      if(e.target.closest("[data-c-save]")) return toggleSave(alvo,titulo);
      if(e.target.closest("[data-c-login]")) return authSheet("entrar");
      if(e.target.closest("[data-c-verify]")) return resendVerify();
      const del=e.target.closest("[data-c-del]"); if(del) return delComment(del.dataset.cDel, del);
      const pf=e.target.closest("[data-c-profile]"); if(pf){ C.perfilUid=pf.dataset.cProfile; L.go("perfil"); return; }
    };
    const form=bar.querySelector("form");
    if(form) form.onsubmit=e=>{ e.preventDefault(); sendComment(alvo,titulo,form); };
  });
}
function commentsList(list){
  const items=list.slice().reverse();
  return `<ul class="c-list">${items.length?items.map(c=>`<li class="c-item">
      <button type="button" class="c-av" data-c-profile="${esc(c.uid)}" aria-label="Perfil de ${esc(nameOf(c.uid,c.nome))}">${avatar(c.uid,30)}</button>
      <div class="c-body"><div class="c-meta"><button type="button" class="link-btn c-name" data-c-profile="${esc(c.uid)}">${esc(nameOf(c.uid,c.nome))}</button>${badge(c.uid)}<span class="tiny">${esc(when(c.em))}</span>
      ${C.user && (C.user.uid===c.uid || C.admins.has(C.user.uid)) ? `<button type="button" class="link-btn tiny c-del" data-c-del="${esc(c.id)}">Apagar</button>`:""}</div>
      <div class="c-text">${esc(c.texto)}</div></div></li>`).join(""):`<li class="tiny c-empty">Seja o primeiro a comentar.</li>`}</ul>`;
}
function thread(alvo,list){
  let box;
  if(!C.user) box=`<p class="small c-hint">Para comentar, <button type="button" class="link-btn" data-c-login>entre ou crie sua conta</button>.</p>`;
  else if(!C.verified) box=`<p class="small c-hint">Confirme seu e-mail para comentar. <button type="button" class="link-btn" data-c-verify>Reenviar confirmação</button></p>`;
  else box=`<form class="c-form"><label class="sr" for="c-in-${esc(alvo)}">Seu comentário</label><textarea id="c-in-${esc(alvo)}" maxlength="1000" rows="2" placeholder="Escreva um comentário…" required></textarea><button class="btn" type="submit">Enviar</button></form>`;
  return `<div class="c-thread">${commentsList(list)}${box}</div>`;
}
async function sendComment(alvo,titulo,form){
  const ta=form.querySelector("textarea"); const texto=ta.value.trim(); if(!texto) return;
  const btn=form.querySelector("button"); btn.disabled=true;
  try{
    await timed(db.collection("comments").add({alvo, alvoTitulo:String(titulo).slice(0,120), uid:C.user.uid, nome:(C.me&&C.me.nome)||"", texto:texto.slice(0,1000), em:TS()}));
    ta.value=""; ta.blur();
  }catch(e){ if(e&&e.code==="permission-denied"&&!C.verified) toast("Confirme seu e-mail para comentar."); else dbError(e,"enviar o comentário"); }
  btn.disabled=false;
}
async function delComment(id,btn){
  if(!btn.dataset.confirm){ btn.dataset.confirm=1; btn.textContent="Confirmar"; setTimeout(()=>{ if(btn.isConnected){ btn.textContent="Apagar"; delete btn.dataset.confirm; } },3000); return; }
  try{ await db.collection("comments").doc(id).delete(); toast("Comentário apagado"); }catch(e){ toast("Não deu para apagar."); }
}
async function toggleSave(alvo,titulo){
  if(!C.user) return needLogin("Entre para salvar seus favoritos.");
  const id=alvo.replace(":","_"); const ref=db.collection("users").doc(C.user.uid).collection("salvos").doc(id);
  try{ if(C.saved[id]){ await timed(ref.delete()); toast(alvo.startsWith("post:")?"Tirado da lista de desejos":"Removido dos salvos"); } else { await timed(ref.set({alvo, titulo:String(titulo).slice(0,120), em:TS()})); toast(alvo.startsWith("post:")?"Adicionado à sua lista de desejos":"Salvo"); } }catch(e){ dbError(e,"salvar"); }
}
async function resendVerify(){ try{ await C.user.sendEmailVerification(); toast("Enviamos um novo link para "+C.user.email); }catch(e){ authError(e); } }

/* ---------- auth sheet ---------- */
function authSheet(mode){
  if(!C.ready){ toast("A comunidade ainda está carregando."); return; }
  const dlg=document.createElement("dialog"); dlg.className="sheet";
  const draw=()=>{
    const cad = mode==="criar";
    dlg.innerHTML=`<form method="dialog" novalidate><header><h2 class="h3">${cad?"Criar conta":mode==="senha"?"Recuperar senha":"Entrar"}</h2><button type="button" class="icon-btn" data-x aria-label="Fechar">✕</button></header>
      <div class="body">
        ${mode!=="senha"?`<div class="segbar" role="group" aria-label="Entrar ou criar conta" style="margin-bottom:4px"><button type="button" data-m="entrar" aria-pressed="${!cad}">Entrar</button><button type="button" data-m="criar" aria-pressed="${cad}">Criar conta</button></div>
        <button type="button" class="btn plain g-btn" data-google>${icon.google} Continuar com Google</button>
        <div class="or"><span>ou com e-mail</span></div>`:`<p class="small muted">Digite seu e-mail e enviaremos um link para criar uma senha nova.</p>`}
        ${cad?`<div class="field"><label for="a-nome">Seu nome</label><input type="text" id="a-nome" autocomplete="name" maxlength="60" required></div>`:""}
        <div class="field"><label for="a-email">E-mail</label><input type="text" inputmode="email" id="a-email" autocomplete="email" autocapitalize="off" spellcheck="false" required></div>
        ${mode!=="senha"?`<div class="field"><label for="a-senha">Senha</label><input type="password" id="a-senha" autocomplete="${cad?"new-password":"current-password"}" minlength="6" required>${cad?`<span class="help">Pelo menos 6 caracteres.</span>`:`<button type="button" class="link-btn small" data-m="senha" style="align-self:flex-start">Esqueci a senha</button>`}</div>`:""}
        ${C.noStorage?`<p class="tiny p-err">Este navegador não está guardando dados do site (modo privado ou bloqueio de dados). Você vai precisar entrar toda vez.</p>`:""}
        ${cad?`<p class="tiny">Ao criar a conta, seu nome e o que você publicar ficam visíveis para outros membros. Seu e-mail não aparece para ninguém. <button type="button" class="link-btn tiny" data-priv>Como usamos seus dados</button></p>`:""}
      </div>
      <footer>${mode==="senha"?`<button type="button" class="btn plain" data-m="entrar">Voltar</button>`:""}<span class="sp"></span><button type="submit" class="btn">${cad?"Criar conta":mode==="senha"?"Enviar link":"Entrar"}</button></footer></form>`;
    dlg.querySelectorAll("[data-x]").forEach(b=>b.onclick=close);
    dlg.querySelectorAll("[data-m]").forEach(b=>b.onclick=()=>{ mode=b.dataset.m; draw(); });
    const g=dlg.querySelector("[data-google]"); if(g) g.onclick=google;
    const pv=dlg.querySelector("[data-priv]"); if(pv) pv.onclick=()=>{ close(); L.go("privacidade"); };
    dlg.querySelector("form").onsubmit=submit;
    setTimeout(()=>{ const f=dlg.querySelector(cad?"#a-nome":"#a-email"); if(f && matchMedia("(hover:hover)").matches) f.focus(); },50);
  };
  const close=()=>{ try{ dlg.close(); }catch(e){} dlg.remove(); };
  async function google(){
    const prov=new firebase.auth.GoogleAuthProvider(); prov.setCustomParameters({prompt:"select_account"});
    try{ await auth.signInWithPopup(prov); close(); toast("Bem-vindo!"); }
    catch(e){ if(e && (e.code==="auth/popup-blocked"||e.code==="auth/operation-not-supported-in-this-environment")){ try{ await auth.signInWithRedirect(prov); }catch(x){ authError(x); } } else authError(e); }
  }
  async function submit(e){
    e.preventDefault();
    const email=(dlg.querySelector("#a-email").value||"").trim(); const senhaEl=dlg.querySelector("#a-senha"); const senha=senhaEl?senhaEl.value:"";
    const btn=dlg.querySelector("[type=submit]"); btn.disabled=true;
    try{
      if(mode==="senha"){ await auth.sendPasswordResetEmail(email); toast("Se houver conta com esse e-mail, o link chega em instantes."); close(); }
      else if(mode==="criar"){
        const nome=(dlg.querySelector("#a-nome").value||"").trim(); if(!nome){ toast("Escreva seu nome."); btn.disabled=false; return; }
        const cred=await auth.createUserWithEmailAndPassword(email,senha);
        await cred.user.updateProfile({displayName:nome});
        try{ await timed(db.collection("profiles").doc(cred.user.uid).set(cleanProfile({nome, insta:"", cidade:"", bio:"", paises:[], criadoEm:TS()}))); }catch(x){ dbError(x,"criar seu perfil"); }
        try{ await cred.user.sendEmailVerification(); }catch(x){}
        close(); toast("Conta criada! Confirme seu e-mail pelo link que enviamos para comentar.");
        C.perfilUid=cred.user.uid; L.go("perfil");
      } else { await auth.signInWithEmailAndPassword(email,senha); close(); toast("Bem-vindo de volta!"); }
    }catch(err){ authError(err); }
    btn.disabled=false;
  }
  draw(); document.body.appendChild(dlg);
  if(typeof dlg.showModal==="function"){ try{ dlg.showModal(); }catch(e){ dlg.setAttribute("open",""); dlg.classList.add("no-modal"); } } else { dlg.setAttribute("open",""); dlg.classList.add("no-modal"); }
  dlg.addEventListener("cancel",e=>{ e.preventDefault(); close(); });
}

/* ---------- Início para todos: comunidade primeiro, a viagem do casal como destaque ---------- */
const cidadesOf = p => Array.isArray(p&&p.cidades) ? p.cidades.filter(c=>c && typeof c.n==="string") : [];
function communityTotals(){
  const ms=C.members||[]; const paises=new Set(), cidades=new Set();
  ms.forEach(m=>{ (m.paises||[]).forEach(a=>paises.add(a)); cidadesOf(m).forEach(c=>cidades.add(c.c+"|"+L.nrm(c.n))); });
  return {membros:ms.length, paises:paises.size, cidades:cidades.size, posts:C.posts.length};
}
function tripCard(){
  const S=L.S; if(!(S.dias||[]).length) return "";
  const start=new Date((S.site.partida||"2026-12-22")+"T00:00:00"); const diff=Math.ceil((start-new Date())/86400000);
  const stops=L.routeStops(); const live=(S.live||[]).slice(-1)[0];
  const t=new Date(); const iso=t.getFullYear()+"-"+String(t.getMonth()+1).padStart(2,"0")+"-"+String(t.getDate()).padStart(2,"0");
  const first=stops[0], last=stops[stops.length-1];
  const running = first && last && iso>=first.data && iso<=last.ate;
  let now=null; if(running){ now = live ? live.cidade : (stops.filter(s=>s.data<=iso).slice(-1)[0]||{}).cidade; }
  const capa=S.site.capaData||(S.site.capaId?"/_blob/"+S.site.capaId:"");
  const route=stops.filter(s=>s.paisA2).map(s=>`<span class="flag" title="${esc(s.cidade)}">${L.flag(s.paisA2)}</span>`).join('<span class="tc-arrow" aria-hidden="true">→</span>');
  return `<a class="trip-card" href="#viagem">
    ${capa?`<span class="tc-img"><img src="${esc(capa)}" alt="" loading="lazy"></span>`:""}
    <span class="tc-body">
      <span class="eyebrow">${running?'<span class="live-dot" aria-hidden="true"></span>Ao vivo · ':""}Viagem em destaque</span>
      <span class="h2 tc-t">${esc(S.site.eyebrow||"Gustavo e Priscila")}</span>
      <span class="lead tc-sub">${esc(S.site.subtitulo||"Da Bahia para a Irlanda, passando por Lisboa e Amsterdam.")}</span>
      <span class="tc-route">${route}</span>
      <span class="tc-meta">${now?`Agora em <b>${esc(now)}</b>`:diff>0?`<b class="num">${diff}</b> dias para o embarque`:"Viagem concluída"} · <span class="tc-go">Acompanhar ›</span></span>
    </span></a>`;
}
function vHome(){
  loadMembers();
  const me=C.user; const t=communityTotals();
  const mp = me ? (C.me||C.profiles[me.uid]||{}) : null;
  const latest=C.posts.slice(0,4);
  const indo=(C.members||[]).filter(m=>m.proximo).slice(0,12);
  const novos=(C.members||[]).slice(0,14);
  setTimeout(bindCommunity,0);
  const n=v=>C.members===null?"–":v;
  return `<section class="hero home-hero"><div class="wrap">
    <p class="eyebrow">Latitude 53 · comunidade de viajantes</p>
    <h1 class="h-hero">O mapa de quem viaja.</h1>
    <p class="lead">Marque os países e as cidades que você já conheceu, conte para onde vai e troque dicas com gente que está na estrada.</p>
    <div class="actions home-cta">${me
      ? `<button class="btn" type="button" data-new-post="post">Publicar</button><button class="btn secondary" type="button" data-go-me>Meu mapa</button>`
      : `<button class="btn" type="button" data-login>Criar minha conta</button><a class="btn secondary" href="#comunidade">Explorar a comunidade</a>`}</div>
    <div class="count">
      <div><b class="num">${n(t.membros)}</b><span>${t.membros===1?"viajante":"viajantes"}</span></div>
      <div><b class="num">${n(t.paises)}</b><span>países visitados</span></div>
      <div><b class="num">${n(t.cidades)}</b><span>cidades no mapa</span></div>
    </div>
  </div></section>

  ${me&&C.invites.length?`<section class="band"><div class="wrap">${invitesHtml()}</div></section>`:""}
  ${me?`<section class="band"><div class="wrap">
    <div class="head-row"><div><p class="eyebrow">Seu mapa</p><h2 class="h2">${(mp.paises||[]).length?`${(mp.paises||[]).length} ${(mp.paises||[]).length===1?"país":"países"}${cidadesOf(mp).length?` e ${cidadesOf(mp).length} ${cidadesOf(mp).length===1?"cidade":"cidades"}`:""}.`:"Onde você já esteve?"}</h2>
      <p class="small muted" style="margin:6px 0 0">${(mp.paises||[]).length?"É o mapa que aparece quando alguém visita o seu perfil.":"Marque países e cidades e o seu mapa aparece no seu perfil para a comunidade."}</p></div>
      <div class="actions"><button class="btn secondary" type="button" data-edit-me>${(mp.paises||[]).length?"Editar meu mapa":"Montar meu mapa"}</button></div></div>
    ${(mp.paises||[]).length||cidadesOf(mp).length?`<div class="pmap" id="pmap" data-uid="${esc(me.uid)}" role="img" aria-label="Seu mapa de viagens"></div>`:""}
  </div></section>`:""}

  <section class="band alt"><div class="wrap">
    <div class="head-row"><div><p class="eyebrow">Agora na comunidade</p><h2 class="h2">Dicas, fotos e check-ins.</h2></div><a class="btn secondary" href="#comunidade">Ver tudo</a></div>
    ${latest.length?`<div class="posts">${latest.map(postCard).join("")}</div>`:`<div class="empty-state"><p class="h3">${C.ready?"Seja a primeira publicação":"Carregando…"}</p><p class="small">Uma dica de lugar, uma foto ou onde você está agora.</p></div>`}
  </div></section>

  <section class="band"><div class="wrap">
    <div class="head-row"><div><p class="eyebrow">Viagens</p><h2 class="h2">Viaje junto.</h2><p class="small muted" style="margin:6px 0 0">Crie uma viagem, convide quem vai com você e montem o roteiro juntos, cada um do seu celular.</p></div>
      <div class="actions"><button class="btn" type="button" data-new-trip>Nova viagem</button></div></div>
    ${(()=>{ const ts=(me?C.myTrips:[]).concat(C.pubTrips.filter(t=>!isMember(t))).slice(0,3); return ts.length?`<div class="trips">${ts.map(tripCardHtml).join("")}</div>`:""; })()}
  </div></section>

  ${indo.length?`<section class="band"><div class="wrap">
    <p class="eyebrow">Próximos destinos</p><h2 class="h2" style="margin-bottom:18px">Para onde a comunidade vai.</h2>
    <div class="dest-list">${indo.map(m=>`<button type="button" class="dest" data-profile="${esc(m.id)}">${avatar(m.id,40)}<span class="c-body"><span class="m-name">${esc(m.nome||"Viajante")} ${badge(m.id)}</span><span class="dest-to">✈︎ ${esc(m.proximo)}</span></span></button>`).join("")}</div>
  </div></section>`:""}

  <section class="band"><div class="wrap">${communityMapHtml()||`<div class="empty-state"><p class="h3">O mapa da comunidade</p><p class="small">Quando os membros marcarem os países, eles aparecem aqui.</p></div>`}</div></section>

  <section class="band alt"><div class="wrap">${tripCard()}</div></section>

  ${novos.length?`<section class="band"><div class="wrap">
    <div class="head-row"><div><p class="eyebrow">Membros</p><h2 class="h2">Quem chegou agora.</h2></div><a class="btn secondary" href="#comunidade">Ver todos</a></div>
    <div class="faces">${novos.map(m=>`<button type="button" class="face" data-profile="${esc(m.id)}">${avatar(m.id,64)}<span class="tiny">${esc((m.nome||"Viajante").split(" ")[0])}</span></button>`).join("")}</div>
  </div></section>`:""}`;
}

/* ---------- mapa pessoal (perfil e Início) ---------- */
function profileMapHtml(uid,p){
  const cs=cidadesOf(p); const ps=(p&&p.paises)||[];
  if(!ps.length && !cs.length) return "";
  const mode=C.pmapMode||"perto";
  return `<div class="pmap-wrap">
    <div class="head-row" style="margin:0 0 12px"><h2 class="h3">Mapa de viagens</h2>
      <div class="segbar" role="group" aria-label="Zoom do mapa" style="margin:0"><button type="button" data-pmap="perto" aria-pressed="${mode==="perto"}">Meus lugares</button><button type="button" data-pmap="mundo" aria-pressed="${mode==="mundo"}">Mundo</button></div></div>
    <div class="pmap" id="pmap" data-uid="${esc(uid)}" role="img" aria-label="Países e cidades visitados"></div>
    <p class="tiny muted pmap-leg"><span><i class="lg-c"></i>País visitado</span>${cs.length?`<span><i class="lg-p"></i>Cidade</span>`:""}</p>
  </div>`;
}
function drawProfileMap(animate){
  const el=document.getElementById("pmap"); if(!el || el.querySelector("svg")) return;
  if(!window.d3 || !window.WORLD){ if(!el.dataset.wait){ el.dataset.wait=1; L.loadMapLib().then(ok=>{ if(ok) drawProfileMap(animate); }); } return; }
  const p=C.profiles[el.dataset.uid]||(C.me&&C.me.id===el.dataset.uid?C.me:null)||{};
  const d3=window.d3, ps=new Set(p.paises||[]), cs=cidadesOf(p).filter(c=>isFinite(c.la)&&isFinite(c.lo));
  const W=960,H=520;
  const feats=topojson.feature(WORLD, WORLD.objects.countries).features.filter(f=>f.properties.a2!=="AQ");
  const proj=d3.geoNaturalEarth1();
  const mode=C.pmapMode||"perto";
  const mine=feats.filter(f=>ps.has(f.properties.a2));
  if(mode==="mundo" || (!cs.length && !mine.length)) proj.fitExtent([[4,4],[W-4,H-4]],{type:"FeatureCollection",features:feats});
  else {
    // fit to the cities when there are any (countries like Brazil or Russia are too big to frame a trip)
    let pts = cs.length ? cs.map(c=>[c.lo,c.la]) : null;
    let box = pts ? [[Math.min(...pts.map(q=>q[0])),Math.min(...pts.map(q=>q[1]))],[Math.max(...pts.map(q=>q[0])),Math.max(...pts.map(q=>q[1]))]] : d3.geoBounds({type:"FeatureCollection",features:mine});
    let [[x0,y0],[x1,y1]]=box; if(x1<x0) { x0=-180; x1=180; }
    const cx=(x0+x1)/2, cy=(y0+y1)/2, w=Math.max(x1-x0,14)*1.25, h=Math.max(y1-y0,8)*1.25;
    proj.fitExtent([[24,24],[W-24,H-24]],{type:"MultiPoint",coordinates:[[cx-w/2,cy-h/2],[cx+w/2,cy+h/2]]});
  }
  const path=d3.geoPath(proj);
  const svg=d3.select(el).append("svg").attr("viewBox",`0 0 ${W} ${H}`).attr("preserveAspectRatio","xMidYMid slice");
  svg.append("g").selectAll("path").data(feats).join("path").attr("d",path).attr("class",f=>ps.has(f.properties.a2)?"rm-land pm-on":"rm-land")
    .append("title").text(f=>L.countryName(f.properties.a2));
  const k = mode==="mundo" ? 4 : 6;
  const dots=svg.append("g").selectAll("circle").data(cs).join("circle")
    .attr("cx",c=>proj([c.lo,c.la])[0]).attr("cy",c=>proj([c.lo,c.la])[1]).attr("r",animate&&!L.reduceMotion()?0:k).attr("class","pm-pin");
  dots.append("title").text(c=>c.n+(c.s?", "+c.s:""));
  if(animate && !L.reduceMotion()){
    svg.selectAll(".pm-on").style("opacity",0).transition().delay((d,i)=>100+i*30).duration(600).style("opacity",1);
    dots.transition().delay((d,i)=>350+Math.min(i,40)*25).duration(500).ease(d3.easeBackOut.overshoot(2.2)).attr("r",k);
  }
}

/* ---------- viagens compartilhadas (colaboração) ---------- */
const FV = () => firebase.firestore.FieldValue;
function tripById(id){ return C.myTrips.find(t=>t.id===id) || C.pubTrips.find(t=>t.id===id) || (C.tripDoc&&C.tripDoc.id===id?C.tripDoc:null); }
const isMember = t => !!(C.user && t && (t.membros||[]).includes(C.user.uid));
function fmtRange(a,b){ if(!a) return ""; const x=L.fmtDay(a).short; if(!b||b===a) return x; return `${x} a ${L.fmtDay(b).short}`; }
function stackAv(uids){ return `<span class="av-stack">${uids.slice(0,5).map(u=>avatar(u,30)).join("")}${uids.length>5?`<span class="av" style="--s:30px">+${uids.length-5}</span>`:""}</span>`; }
function tripCardHtml(t){
  want(t.membros||[]);
  const flags=(t.paradas||[]).map(p=>L.flag(p.c)).filter((f,i,a)=>f&&a.indexOf(f)===i).slice(0,8).join(" ");
  const names=(t.membros||[]).map(u=>nameOf(u).split(" ")[0]);
  return `<button type="button" class="tripc" data-trip="${esc(t.id)}">
    <span class="tripc-top"><span class="tag ${t.publica?"pub":"priv"}">${t.publica?"Pública":"Só participantes"}</span>${t.inicio?`<span class="tiny">${esc(fmtRange(t.inicio,t.fim))}</span>`:""}</span>
    <span class="h3 tripc-t">${esc(t.titulo||"Viagem")}</span>
    ${flags?`<span class="tripc-flags">${flags}</span>`:""}
    <span class="tripc-who">${stackAv(t.membros||[])}<span class="tiny">${esc(names.length>2?names.slice(0,2).join(", ")+` e mais ${names.length-2}`:names.join(" e "))}</span></span>
  </button>`;
}
function invitesHtml(){
  if(!C.invites.length) return "";
  return `<div class="invites">${C.invites.map(v=>`<div class="invite">${avatar(v.de,40)}
    <div class="c-body"><strong>${esc(nameOf(v.de,v.deNome))}</strong> convidou você para viajar junto em <strong>${esc(v.viagemTitulo||"uma viagem")}</strong>.</div>
    <div class="actions"><button type="button" class="btn" data-inv-ok="${esc(v.id)}">Aceitar</button><button type="button" class="btn plain" data-inv-no="${esc(v.id)}">Recusar</button></div></div>`).join("")}</div>`;
}
function vViagens(){
  if(!C.ready) return `<section class="band"><div class="wrap"><p class="eyebrow">Viagens</p><h1 class="h1">Carregando…</h1></div></section>`;
  const mine=C.myTrips.slice().sort((a,b)=>(a.inicio||"9").localeCompare(b.inicio||"9"));
  const others=C.pubTrips.filter(t=>!isMember(t)).sort((a,b)=>(b.inicio||"").localeCompare(a.inicio||""));
  setTimeout(bindCommunity,0);
  return `<section class="band"><div class="wrap">
    <div class="head-row"><div><p class="eyebrow">Viagens</p><h1 class="h1">Viaje junto.</h1><p class="lead">Monte o roteiro com quem vai com você: casal, amigos ou família. Cada um edita do próprio celular.</p></div>
      <div class="actions"><button class="btn" type="button" data-new-trip>Nova viagem</button></div></div>
    ${invitesHtml()}
    <h2 class="h3" style="margin:8px 0 14px">Minhas viagens</h2>
    ${!C.user?`<div class="empty-state"><p class="h3">Entre para criar suas viagens</p><p class="small">Crie a viagem, convide quem vai junto e montem o roteiro dia a dia.</p><p style="margin-top:12px"><button class="btn" type="button" data-login>Criar conta ou entrar</button></p></div>`
      : mine.length?`<div class="trips">${mine.map(tripCardHtml).join("")}</div>`
      : `<div class="empty-state"><p class="h3">Nenhuma viagem ainda</p><p class="small">Comece com o destino e as datas. Depois convide quem vai junto.</p><p style="margin-top:12px"><button class="btn" type="button" data-new-trip>Criar a primeira viagem</button></p></div>`}
    <h2 class="h3" style="margin:48px 0 14px">Viagens da comunidade</h2>
    ${others.length?`<div class="trips">${others.map(tripCardHtml).join("")}</div>`:`<p class="small muted">Quando alguém deixar uma viagem pública, ela aparece aqui para servir de inspiração.</p>`}
  </div></section>`;
}
function openTrip(id){
  C.tripId=id; C.tripDias=null; if(C.tripUnsub){ C.tripUnsub(); C.tripUnsub=null; }
  C.tripDoc=null;
  if(!tripById(id)){ db.collection("viagens").doc(id).get().then(d=>{ if(d.exists){ C.tripDoc=Object.assign({id:d.id},d.data()); } else C.tripDoc={id,missing:true}; refreshTrip(); }).catch(()=>{ C.tripDoc={id,missing:true}; refreshTrip(); }); }
  C.tripUnsub=db.collection("viagens").doc(id).collection("dias").onSnapshot(q=>{ C.tripDias=q.docs.map(d=>Object.assign({id:d.id},d.data())); refreshTrip(); },()=>{ C.tripDias=[]; refreshTrip(); });
  C.tripAnim=true; L.go("trip");
}
function refreshTrip(){ if(L.S.view==="trip") L.render(); }
function planLines(txt){
  return String(txt||"").split(/\n+/).map(l=>l.trim()).filter(Boolean).map(l=>{ const m=l.match(/^(\d{1,2}[:h]\d{2})\s*[-–·]?\s*(.*)$/); return `<li>${m?`<b class="num">${esc(m[1].replace("h",":"))}</b> ${esc(m[2])}`:esc(l)}</li>`; }).join("");
}
function vTrip(){
  if(!C.ready) return `<section class="band"><div class="wrap"><h1 class="h1">Carregando…</h1></div></section>`;
  const t=tripById(C.tripId);
  setTimeout(bindCommunity,0);
  if(!t || t.missing) return `<section class="band"><div class="wrap"><div class="empty-state"><p class="h3">${t&&t.missing?"Viagem não encontrada":"Abrindo a viagem…"}</p><p class="small">${t&&t.missing?"Ela pode ter sido apagada ou ser só para os participantes.":""}</p><p style="margin-top:12px"><button class="btn secondary" type="button" onclick="LAT53.go('viagens')">Ver viagens</button></p></div></div></section>`;
  want(t.membros||[]);
  const mem=isMember(t), dono=C.user&&C.user.uid===t.dono;
  const dias=(C.tripDias||[]).slice().sort((a,b)=>(a.data||"9").localeCompare(b.data||"9"));
  const pend=C.sentInv.filter(v=>v.viagem===t.id);
  const today=new Date(); const iso=today.getFullYear()+"-"+String(today.getMonth()+1).padStart(2,"0")+"-"+String(today.getDate()).padStart(2,"0");
  return `<section class="band"><div class="wrap">
    <p class="eyebrow"><button type="button" class="link-btn" onclick="LAT53.go('viagens')">‹ Viagens</button> · ${t.publica?"Pública":"Só participantes"}</p>
    <h1 class="h1">${esc(t.titulo||"Viagem")}</h1>
    ${t.inicio?`<p class="small muted" style="margin:6px 0 0">${esc(fmtRange(t.inicio,t.fim))}</p>`:""}
    ${t.resumo?`<p class="lead" style="margin-top:10px">${esc(t.resumo)}</p>`:""}
    <div class="crew">${(t.membros||[]).map(u=>`<div class="crew-m"><button type="button" class="m-open" data-profile="${esc(u)}">${avatar(u,44)}<span class="c-body"><span class="m-name">${esc(nameOf(u))}</span><span class="tiny">${u===t.dono?"organiza":"viaja junto"}</span></span></button>${dono&&u!==t.dono?`<button type="button" class="link-btn tiny" data-rm-member="${esc(u)}">Remover</button>`:""}</div>`).join("")}
      ${pend.map(v=>`<div class="crew-m pend">${avatar(v.para,44)}<span class="c-body"><span class="m-name">${esc(nameOf(v.para))}</span><span class="tiny">convite enviado</span></span><button type="button" class="link-btn tiny" data-cancel-inv="${esc(v.id)}">Cancelar</button></div>`).join("")}
    </div>
    ${mem?`<div class="actions" style="margin-top:18px"><button class="btn" type="button" data-invite>Convidar para viajar junto</button><button class="btn secondary" type="button" data-edit-trip>Editar viagem</button>${dono?`<button class="btn plain" type="button" data-del-trip>Excluir</button>`:`<button class="btn plain" type="button" data-leave-trip>Sair da viagem</button>`}</div>`:""}
    ${(t.paradas||[]).length?`<div class="tmap" id="tmap" role="img" aria-label="Mapa da viagem" style="margin-top:28px"></div>
      <ol class="rota-stops">${t.paradas.map(p=>`<li class="rs proximo"><span class="rs-dot" aria-hidden="true"></span><span class="flag">${L.flag(p.c)}</span><span class="rs-n">${esc(p.n)}</span><span class="tiny">${esc(L.countryName(p.c))}</span></li>`).join("")}</ol>`:""}
    <div class="head-row" style="margin:40px 0 14px"><h2 class="h2">Roteiro.</h2>${mem?`<div class="actions"><button class="btn" type="button" data-add-dia>Adicionar dia</button></div>`:""}</div>
    ${C.tripDias===null?`<p class="small muted">Carregando o roteiro…</p>`
      : dias.length?dias.map(d=>{ const f=d.data?L.fmtDay(d.data):null; return `<article class="day tday ${d.data===iso?"is-today":""}">
        <div class="date-col">${f?`<div class="dnum">${f.n}</div><div class="dmeta">${esc(f.wd)}<br>${esc(f.mo)}</div>`:`<div class="dmeta">sem data</div>`}</div>
        <div class="day-body">${d.cidade?`<span class="place-chip">${d.paisA2?`<span class="flag">${L.flag(d.paisA2)}</span>`:""}${esc(d.cidade)}</span>`:""}
          <div class="day-title"><h3 class="h3">${esc(d.titulo||"Dia livre")}</h3>${mem?`<button type="button" class="link-btn edit-x small" data-edit-dia="${esc(d.id)}">Editar</button>`:""}</div>
          ${d.plano?`<ul class="plan">${planLines(d.plano)}</ul>`:""}
          ${d.por?`<p class="tiny muted" style="margin:8px 0 0">editado por ${esc(d.por)}</p>`:""}
        </div></article>`; }).join("")
      : `<div class="empty-state"><p class="h3">Roteiro em branco</p><p class="small">${mem?"Adicione o primeiro dia. Quem viaja junto vê e edita na hora.":"Os participantes ainda não montaram o roteiro."}</p></div>`}
  </div></section>`;
}
function drawTripMap(animate){
  const el=document.getElementById("tmap"); if(!el || el.querySelector("svg")) return;
  if(!window.d3 || !window.WORLD){ if(!el.dataset.wait){ el.dataset.wait=1; L.loadMapLib().then(ok=>{ if(ok) drawTripMap(animate); }); } return; }
  const t=tripById(C.tripId); if(!t) return;
  const pts=(t.paradas||[]).filter(p=>isFinite(p.la)&&isFinite(p.lo)).map(p=>[p.lo,p.la]); if(!pts.length) return;
  const d3=window.d3, W=800, H=460;
  const feats=topojson.feature(WORLD, WORLD.objects.countries).features.filter(f=>f.properties.a2!=="AQ");
  const xs=pts.map(p=>p[0]), ys=pts.map(p=>p[1]); const cx=(Math.min(...xs)+Math.max(...xs))/2, cy=(Math.min(...ys)+Math.max(...ys))/2;
  const w=Math.max(Math.max(...xs)-Math.min(...xs),10)*1.3, h=Math.max(Math.max(...ys)-Math.min(...ys),6)*1.3;
  const proj=d3.geoNaturalEarth1().fitExtent([[40,40],[W-40,H-40]],{type:"MultiPoint",coordinates:[[cx-w/2,cy-h/2],[cx+w/2,cy+h/2]]});
  const path=d3.geoPath(proj); const cs=new Set((t.paradas||[]).map(p=>p.c));
  const svg=d3.select(el).append("svg").attr("viewBox",`0 0 ${W} ${H}`).attr("preserveAspectRatio","xMidYMid slice");
  svg.append("g").selectAll("path").data(feats).join("path").attr("d",path).attr("class",f=>cs.has(f.properties.a2)?"rm-land trip":"rm-land");
  if(pts.length>1){ const ln=svg.append("path").attr("class","rm-done").attr("d",path({type:"LineString",coordinates:pts}));
    if(animate && !L.reduceMotion()){ const len=ln.node().getTotalLength(); ln.attr("stroke-dasharray",len).attr("stroke-dashoffset",len).transition().duration(1400).ease(d3.easeCubicInOut).attr("stroke-dashoffset",0); } }
  const xy=pts.map(p=>proj(p));
  (t.paradas||[]).forEach((p,i)=>{ if(!xy[i]) return; const [x,y]=xy[i];
    svg.append("circle").attr("cx",x).attr("cy",y).attr("r",7).attr("class","rm-stop on");
    const crowdR=xy.some((q,j)=>j!==i && q[0]>x && q[0]-x<140 && Math.abs(q[1]-y)<30);
    svg.append("text").attr("x",crowdR?x-13:x+13).attr("y",y+7).attr("text-anchor",crowdR?"end":"start").attr("class","rm-lbl").text(p.n); });
}
/* city picker shared by the trip editor */
function cityPicker(box, list, onChange){
  box.innerHTML=`<div class="chips" data-sel></div><input type="search" placeholder="Buscar cidade (ex.: Lisboa)" autocomplete="off" data-q><div class="pais-list city-list" role="listbox" aria-label="Cidades" hidden data-res></div>`;
  const sel=box.querySelector("[data-sel]"), q=box.querySelector("[data-q]"), res=box.querySelector("[data-res]"); let found=[];
  const drawSel=()=>{ sel.innerHTML=list.length?list.map((c,i)=>`<button type="button" class="chip chip-x" data-rm="${i}"><span class="tiny num">${i+1}</span><span class="flag">${L.flag(c.c)}</span> ${esc(c.n)} <span aria-hidden="true">×</span></button>`).join(""):`<span class="tiny">Adicione as cidades na ordem da viagem.</span>`; onChange&&onChange(); };
  const drawRes=async()=>{ const s=q.value.trim(); if(s.length<2){ res.hidden=true; return; } res.hidden=false;
    if(!window.CITY_DATA){ res.innerHTML=`<p class="tiny" style="padding:10px">Carregando cidades…</p>`; await L.loadCities(); if(q.value.trim()!==s) return; }
    found=L.searchCities(s,8);
    res.innerHTML=found.length?found.map((c,i)=>`<button type="button" role="option" class="pais-opt" data-ci="${i}"><span class="flag">${L.flag(c.c)}</span><span class="pn">${esc(c.n)}<span class="tiny"> ${esc([L.stateName(c.c,c.s),L.countryName(c.c)].filter(Boolean).join(", "))}</span></span><span class="ck">+</span></button>`).join(""):`<p class="tiny" style="padding:10px">Nenhuma cidade com esse nome.</p>`; };
  q.addEventListener("input",drawRes);
  res.addEventListener("click",e=>{ const b=e.target.closest("[data-ci]"); if(!b) return; const c=found[+b.dataset.ci]; if(!c) return;
    if(list.length>=30){ toast("Até 30 paradas."); return; }
    list.push({n:c.n, c:c.c, s:L.stateName(c.c,c.s), la:+c.lat.toFixed(3), lo:+c.lng.toFixed(3)}); q.value=""; res.hidden=true; drawSel(); });
  sel.addEventListener("click",e=>{ const b=e.target.closest("[data-rm]"); if(!b) return; list.splice(+b.dataset.rm,1); drawSel(); });
  drawSel();
}
function openSheet(dlg){ document.body.appendChild(dlg); const close=()=>{ try{ dlg.close(); }catch(e){} dlg.remove(); };
  dlg.querySelectorAll("[data-x]").forEach(b=>b.onclick=close); dlg.addEventListener("cancel",e=>{ e.preventDefault(); close(); });
  if(typeof dlg.showModal==="function"){ try{ dlg.showModal(); }catch(e){ dlg.setAttribute("open",""); dlg.classList.add("no-modal"); } } else { dlg.setAttribute("open",""); dlg.classList.add("no-modal"); }
  return close; }
function tripSheet(t){
  if(!C.user) return needLogin("Entre para criar uma viagem.");
  if(!C.verified){ toast("Confirme seu e-mail para criar viagens."); C.perfilUid=C.user.uid; L.go("perfil"); return; }
  const novo=!t; t=t||{titulo:"",resumo:"",inicio:"",fim:"",publica:false,paradas:[]};
  const paradas=(t.paradas||[]).map(p=>Object.assign({},p));
  const dlg=document.createElement("dialog"); dlg.className="sheet";
  dlg.innerHTML=`<form method="dialog" novalidate><header><h2 class="h3">${novo?"Nova viagem":"Editar viagem"}</h2><button type="button" class="icon-btn" data-x aria-label="Fechar">✕</button></header>
    <div class="body">
      <div class="field"><label for="t-titulo">Nome da viagem</label><input type="text" id="t-titulo" maxlength="80" placeholder="Ex.: Lua de mel na Itália" value="${esc(t.titulo)}"></div>
      <div class="row2"><div class="field"><label for="t-ini">Ida</label><input type="date" id="t-ini" value="${esc(t.inicio)}"></div><div class="field"><label for="t-fim">Volta</label><input type="date" id="t-fim" value="${esc(t.fim)}"></div></div>
      <div class="field"><label>Destinos</label><div id="t-par"></div></div>
      <div class="field"><label for="t-resumo">Sobre a viagem (opcional)</label><textarea id="t-resumo" maxlength="500" rows="3" placeholder="Objetivo, estilo, orçamento…">${esc(t.resumo||"")}</textarea></div>
      <div class="field check-f"><input type="checkbox" id="t-pub" ${t.publica?"checked":""}><label for="t-pub" style="color:var(--ink);font-weight:400;font-size:15px">Pública: a comunidade pode ver o roteiro (só quem participa edita)</label></div>
      <p class="small p-err" id="t-err" hidden></p>
    </div>
    <footer><span class="sp"></span><button type="button" class="btn plain" data-x>Cancelar</button><button type="submit" class="btn" id="t-save">${novo?"Criar viagem":"Salvar"}</button></footer></form>`;
  const close=openSheet(dlg); const $d=q=>dlg.querySelector(q);
  cityPicker($d("#t-par"), paradas);
  $d("form").onsubmit=async e=>{
    e.preventDefault(); const err=$d("#t-err"); const bad=m=>{ err.textContent=m; err.hidden=false; };
    const titulo=$d("#t-titulo").value.trim(); if(!titulo) return bad("Dê um nome para a viagem.");
    const ini=$d("#t-ini").value, fim=$d("#t-fim").value; if(ini&&fim&&fim<ini) return bad("A volta está antes da ida.");
    const data={titulo:titulo.slice(0,80), resumo:$d("#t-resumo").value.trim().slice(0,500), inicio:ini||"", fim:fim||"", publica:$d("#t-pub").checked, paradas:paradas.slice(0,30), atualizadaEm:TS()};
    const btn=$d("#t-save"); btn.disabled=true; err.hidden=true;
    try{
      if(novo){ const ref=db.collection("viagens").doc(); await timed(ref.set(Object.assign({dono:C.user.uid, membros:[C.user.uid], criadaEm:TS()},data)),15000); close(); toast("Viagem criada. Agora convide quem vai junto."); openTrip(ref.id); }
      else { await timed(db.collection("viagens").doc(t.id).update(data),15000); close(); toast("Viagem salva"); }
    }catch(x){ dbError(x,"salvar a viagem"); bad(C.lastError); btn.disabled=false; }
  };
}
function inviteSheet(t){
  loadMembers();
  const dlg=document.createElement("dialog"); dlg.className="sheet";
  dlg.innerHTML=`<form method="dialog" novalidate><header><h2 class="h3">Convidar para viajar junto</h2><button type="button" class="icon-btn" data-x aria-label="Fechar">✕</button></header>
    <div class="body"><p class="small muted" style="margin:0">Quem aceitar vê e edita o roteiro de "${esc(t.titulo)}". A pessoa precisa ter conta no Latitude 53.</p>
      <input type="search" id="i-q" placeholder="Buscar pelo nome" autocomplete="off">
      <div class="inv-list" id="i-list"></div></div>
    <footer><span class="sp"></span><button type="button" class="btn plain" data-x>Fechar</button></footer></form>`;
  const close=openSheet(dlg); const $d=q=>dlg.querySelector(q);
  const draw=()=>{
    const k=L.nrm($d("#i-q").value); const ms=(C.members||[]).filter(m=>!(t.membros||[]).includes(m.id) && (!k || L.nrm(m.nome).includes(k) || L.nrm(m.insta).includes(k)));
    const sent=new Set(C.sentInv.filter(v=>v.viagem===t.id).map(v=>v.para));
    $d("#i-list").innerHTML = C.members===null ? `<p class="tiny">Carregando membros…</p>` : ms.length ? ms.slice(0,40).map(m=>`<div class="inv-row">${avatar(m.id,40)}<span class="c-body"><span class="m-name">${esc(m.nome||"Viajante")}</span><span class="tiny">${esc([m.insta?"@"+m.insta:"",m.cidade].filter(Boolean).join(" · "))}</span></span>
      ${sent.has(m.id)?`<span class="tiny muted">Convidado</span>`:`<button type="button" class="btn secondary" data-send-inv="${esc(m.id)}">Convidar</button>`}</div>`).join("") : `<p class="tiny">${k?"Ninguém com esse nome. Peça para a pessoa criar uma conta e depois procure de novo.":"Nenhum outro membro ainda."}</p>`;
  };
  draw(); $d("#i-q").addEventListener("input",draw);
  const iv=setInterval(()=>{ if(!dlg.isConnected) return clearInterval(iv); if(C.members!==null && $d("#i-list").textContent.includes("Carregando")) draw(); },400);
  $d("#i-list").addEventListener("click",async e=>{ const b=e.target.closest("[data-send-inv]"); if(!b) return; b.disabled=true;
    const para=b.dataset.sendInv;
    try{ await timed(db.collection("convites").doc(t.id+"_"+para).set({viagem:t.id, viagemTitulo:String(t.titulo||"").slice(0,80), de:C.user.uid, deNome:((C.me&&C.me.nome)||"").slice(0,60), para, em:TS()}));
      C.sentInv=C.sentInv.filter(v=>v.id!==t.id+"_"+para).concat([{id:t.id+"_"+para, viagem:t.id, para}]); toast(`Convite enviado para ${nameOf(para)}`); draw(); }
    catch(x){ b.disabled=false; dbError(x,"enviar o convite"); } });
}
async function acceptInvite(id){
  const v=C.invites.find(x=>x.id===id); if(!v) return;
  try{ await timed(db.collection("viagens").doc(v.viagem).update({membros:FV().arrayUnion(C.user.uid), atualizadaEm:TS()}));
    await db.collection("convites").doc(id).delete().catch(()=>{});
    toast("Agora vocês viajam juntos!"); openTrip(v.viagem); }
  catch(x){ if(x&&x.code==="not-found"){ await db.collection("convites").doc(id).delete().catch(()=>{}); toast("Essa viagem não existe mais."); } else dbError(x,"aceitar o convite"); }
}
async function declineInvite(id){ try{ await timed(db.collection("convites").doc(id).delete()); toast("Convite recusado"); }catch(x){ dbError(x,"recusar o convite"); } }
function diaSheet(t,d){
  const novo=!d; const dias=(C.tripDias||[]).map(x=>x.data).filter(Boolean).sort();
  const next = dias.length ? (()=>{ const x=new Date(dias[dias.length-1]+"T12:00:00"); x.setDate(x.getDate()+1); return x.toISOString().slice(0,10); })() : (t.inicio||"");
  d=d||{data:next, cidade:(t.paradas&&t.paradas[0]&&t.paradas[0].n)||"", paisA2:(t.paradas&&t.paradas[0]&&t.paradas[0].c)||"", titulo:"", plano:""};
  const ops=(t.paradas||[]).map(p=>[p.n+"|"+p.c, `${p.n}`]);
  const cur=d.cidade?d.cidade+"|"+(d.paisA2||""):"";
  if(cur && !ops.some(o=>o[0]===cur)) ops.push([cur,d.cidade]);
  const dlg=document.createElement("dialog"); dlg.className="sheet";
  dlg.innerHTML=`<form method="dialog" novalidate><header><h2 class="h3">${novo?"Novo dia":"Editar dia"}</h2><button type="button" class="icon-btn" data-x aria-label="Fechar">✕</button></header>
    <div class="body">
      <div class="row2"><div class="field"><label for="d-data">Data</label><input type="date" id="d-data" value="${esc(d.data||"")}"></div>
      <div class="field"><label for="d-cid">Cidade</label><select id="d-cid"><option value="">Sem cidade</option>${ops.map(([v,l])=>`<option value="${esc(v)}" ${v===cur?"selected":""}>${esc(l)}</option>`).join("")}</select></div></div>
      <div class="field"><label for="d-tit">Título do dia</label><input type="text" id="d-tit" maxlength="100" placeholder="Ex.: Chegada e centro histórico" value="${esc(d.titulo||"")}"></div>
      <div class="field"><label for="d-plano">Plano</label><textarea id="d-plano" rows="7" maxlength="3000" placeholder="Uma atividade por linha. Ex.:&#10;09:00 Café no hotel&#10;10:30 Museu&#10;Jantar no bairro antigo">${esc(d.plano||"")}</textarea><span class="help">Comece a linha com o horário para ele aparecer em destaque.</span></div>
    </div>
    <footer>${novo?"":`<button type="button" class="btn plain" data-del-d>Excluir</button>`}<span class="sp"></span><button type="button" class="btn plain" data-x>Cancelar</button><button type="submit" class="btn" id="d-save">Salvar</button></footer></form>`;
  const close=openSheet(dlg); const $d=q=>dlg.querySelector(q);
  const col=db.collection("viagens").doc(t.id).collection("dias");
  if(!novo) $d("[data-del-d]").onclick=async()=>{ try{ await timed(col.doc(d.id).delete()); close(); toast("Dia excluído"); }catch(x){ dbError(x,"excluir o dia"); } };
  $d("form").onsubmit=async e=>{ e.preventDefault();
    const [cidade,pais]=($d("#d-cid").value||"|").split("|");
    const data={data:$d("#d-data").value||"", cidade:(cidade||"").slice(0,60), paisA2:/^[A-Z]{2}$/.test(pais||"")?pais:"", titulo:$d("#d-tit").value.trim().slice(0,100), plano:$d("#d-plano").value.trim().slice(0,3000), por:((C.me&&C.me.nome)||"").slice(0,60), em:TS()};
    $d("#d-save").disabled=true;
    try{ await timed((novo?col.doc():col.doc(d.id)).set(data)); close(); toast("Roteiro atualizado"); }
    catch(x){ dbError(x,"salvar o dia"); $d("#d-save").disabled=false; } };
}
async function leaveTrip(t,btn){
  if(!btn.dataset.confirm){ btn.dataset.confirm=1; btn.textContent="Toque de novo para sair"; return; }
  try{ await timed(db.collection("viagens").doc(t.id).update({membros:FV().arrayRemove(C.user.uid), atualizadaEm:TS()})); toast("Você saiu da viagem"); L.go("viagens"); }catch(x){ dbError(x,"sair da viagem"); }
}
async function deleteTrip(t,btn){
  if(!btn.dataset.confirm){ btn.dataset.confirm=1; btn.textContent="Toque de novo para excluir a viagem e o roteiro"; return; }
  try{ const ds=await db.collection("viagens").doc(t.id).collection("dias").get();
    for(const d of ds.docs) await d.ref.delete();
    for(const v of C.sentInv.filter(v=>v.viagem===t.id)) await db.collection("convites").doc(v.id).delete().catch(()=>{});
    await timed(db.collection("viagens").doc(t.id).delete()); toast("Viagem excluída"); L.go("viagens"); }
  catch(x){ dbError(x,"excluir a viagem"); }
}
async function removeMember(t,uid,btn){
  if(!btn.dataset.confirm){ btn.dataset.confirm=1; btn.textContent="Confirmar"; return; }
  try{ await timed(db.collection("viagens").doc(t.id).update({membros:FV().arrayRemove(uid), atualizadaEm:TS()})); toast(`${nameOf(uid)} saiu da viagem`); }catch(x){ dbError(x,"remover"); }
}
function tripsForProfile(uid, mine){
  const list = mine ? C.myTrips : C.pubTrips.filter(t=>(t.membros||[]).includes(uid));
  if(!list.length) return mine?`<h2 class="h3 hoje-h">Viagens</h2><p class="small muted">Nenhuma viagem ainda. <button type="button" class="link-btn small" data-new-trip>Criar uma viagem</button></p>`:"";
  return `<h2 class="h3 hoje-h">Viagens</h2><div class="trips">${list.map(tripCardHtml).join("")}</div>`;
}

/* ---------- Comunidade view ---------- */
function loadMembers(){
  if(C.loadingMembers || !C.ready) return;
  if(C.members && Date.now()-(C.membersAt||0) < 60000) return;
  C.loadingMembers=true;
  db.collection("profiles").orderBy("criadoEm","desc").limit(200).get().then(q=>{
    C.members=q.docs.map(d=>Object.assign({id:d.id},d.data())); C.members.forEach(m=>C.profiles[m.id]=m); C.membersAt=Date.now(); C.loadingMembers=false; refresh();
  }).catch(()=>{ C.loadingMembers=false; C.members=[]; refresh(); });
}
function followBtn(uid){
  if(C.user && C.user.uid===uid) return "";
  const on=C.following.has(uid);
  return `<button type="button" class="btn ${on?"plain":""} follow-btn" data-follow="${esc(uid)}" aria-pressed="${on}">${on?"Seguindo":"Seguir"}</button>`;
}
function vComunidade(){
  if(C.failed) return `<section class="band"><div class="wrap"><div class="empty-state"><p class="h3">A comunidade não carregou</p><p class="small">Verifique a internet e recarregue a página.</p></div></div></section>`;
  if(!C.ready) return `<section class="band"><div class="wrap"><p class="eyebrow">Comunidade</p><h1 class="h1">Carregando…</h1></div></section>`;
  loadMembers();
  const feed = (C.filtro==="seguindo" && C.user) ? C.comments.filter(c=>C.following.has(c.uid)) : C.comments;
  let posts = (C.filtro==="seguindo" && C.user) ? C.posts.filter(x=>C.following.has(x.uid)||x.uid===C.user.uid) : C.posts;
  if(C.tipoF!=="tudo") posts = posts.filter(x=>tipoOf(x)===C.tipoF);
  const members = (C.members||[]).slice().sort((a,b)=>(C.admins.has(b.id)-C.admins.has(a.id)));
  setTimeout(bindCommunity,0);
  return `<section class="band"><div class="wrap">
    <div class="head-row"><div><p class="eyebrow">Comunidade</p><h1 class="h1">Quem vem junto.</h1><p class="lead">Gente que acompanha a mudança, comenta os lugares e troca dicas de viagem.</p></div>
    ${C.user?`<div class="actions"><button class="btn secondary" type="button" data-go-me>Meu perfil</button></div>`:`<div class="actions"><button class="btn" type="button" data-login>Criar conta ou entrar</button></div>`}</div>

    <div class="new-post-bar">
      <button type="button" class="np-main" data-new-post="post">${C.user?avatar(C.user.uid,36):`<span class="av" style="--s:36px">+</span>`}<span>${C.user?"Compartilhe uma foto, uma dica ou onde você está…":"Entre para publicar na comunidade"}</span></button>
      <div class="np-quick"><button type="button" class="btn plain" data-new-post="dica">★ Dica</button><button type="button" class="btn plain" data-new-post="checkin">📍 Check-in</button><button type="button" class="btn plain" data-new-post="post">📷 Foto</button></div>
    </div>
    <div class="head-row" style="margin:0 0 14px"><h2 class="h3">Publicações</h2>
      <div class="actions">${C.user?`<div class="segbar" role="group" aria-label="Filtrar" style="margin:0"><button type="button" data-filtro="todos" aria-pressed="${C.filtro!=="seguindo"}">Todos</button><button type="button" data-filtro="seguindo" aria-pressed="${C.filtro==="seguindo"}">Quem eu sigo</button></div>`:""}
      <button class="btn" type="button" data-new-post="post">Publicar</button></div></div>
    <div class="chips tipo-f" role="group" aria-label="Tipo de publicação">${[["tudo","Tudo"],["post","Publicações"],["dica","Dicas"],["checkin","Check-ins"]].map(([k,l])=>`<button type="button" class="chip" data-tipo-f="${k}" aria-pressed="${C.tipoF===k}">${l}</button>`).join("")}</div>
    ${posts.length?`<div class="posts">${posts.map(postCard).join("")}</div>`:`<div class="empty-state"><p class="h3">${C.filtro==="seguindo"?"Quem você segue ainda não postou":"Nada por aqui ainda"}</p><p class="small">Publique uma foto, uma dica de lugar ou um check-in. Quem gostar de uma dica adiciona à lista de desejos.</p></div>`}

    <div style="margin-top:48px">${communityMapHtml()}</div>

    <h2 class="h3" style="margin:48px 0 14px">Membros</h2>
    ${C.members===null?`<p class="muted small">Carregando membros…</p>`:members.length?`<div class="members">${members.map(m=>`<div class="member">
        <button type="button" class="m-open" data-profile="${esc(m.id)}">${avatar(m.id,52)}<span class="m-name">${esc(m.nome||"Viajante")} ${badge(m.id)}</span>
        <span class="tiny">${m.cidade?esc(m.cidade)+" · ":""}${(m.paises||[]).length} ${(m.paises||[]).length===1?"país":"países"}${cidadesOf(m).length?` · ${cidadesOf(m).length} ${cidadesOf(m).length===1?"cidade":"cidades"}`:""}</span></button>
        ${followBtn(m.id)}</div>`).join("")}</div>`:`<div class="empty-state"><p class="h3">Ninguém ainda</p><p class="small">Crie a primeira conta.</p></div>`}

    <div class="head-row" style="margin:48px 0 14px"><h2 class="h3">Comentários recentes</h2></div>
    ${feed.length?`<div class="feed">${feed.slice(0,60).map(c=>`<div class="feed-item">
        <button type="button" class="c-av" data-profile="${esc(c.uid)}" aria-label="Perfil">${avatar(c.uid,36)}</button>
        <div class="c-body"><div class="c-meta"><button type="button" class="link-btn c-name" data-profile="${esc(c.uid)}">${esc(nameOf(c.uid,c.nome))}</button>${badge(c.uid)}<span class="tiny">comentou em <button type="button" class="link-btn tiny" data-alvo="${esc(c.alvo)}">${esc(c.alvoTitulo||"um lugar")}</button> · ${esc(when(c.em))}</span></div>
        <div class="c-text">${esc(c.texto)}</div></div></div>`).join("")}</div>`
      :`<div class="empty-state"><p class="h3">${C.filtro==="seguindo"?"Quem você segue ainda não comentou":"Nenhum comentário ainda"}</p><p class="small">Abra um dia do Roteiro ou um lugar do Mapa e toque em Comentar.</p></div>`}
  </div></section>`;
}
function postCard(x){
  const mine = C.user && (C.user.uid===x.uid || C.admins.has(C.user.uid));
  const tp = tipoOf(x);
  const place=[x.cidade, x.paisA2?L.countryName(x.paisA2):""].filter(Boolean).join(", ");
  const link=L.safeUrl(x.link);
  return `<article class="post t-${tp}" data-post="${esc(x.id)}" data-title="${esc(x.titulo||(tp==="checkin"?"Check-in em "+(x.cidade||""):"Publicação de "+nameOf(x.uid,x.nome)))}">
    <header class="post-h"><button type="button" class="c-av" data-profile="${esc(x.uid)}" aria-label="Perfil">${avatar(x.uid,40)}</button>
      <div class="c-body"><div class="c-meta"><button type="button" class="link-btn c-name" data-profile="${esc(x.uid)}">${esc(nameOf(x.uid,x.nome))}</button>${badge(x.uid)}<span class="tiny">${tp==="checkin"?`fez check-in · `:""}${esc(when(x.em))}</span><span class="tipo-tag tt-${tp}">${esc(TIPOS_POST[tp])}</span>
      ${mine?`<button type="button" class="link-btn tiny c-del" data-del-post="${esc(x.id)}">Apagar</button>`:""}</div>
      ${place&&tp!=="checkin"?`<span class="place-chip">${x.paisA2?`<span class="flag">${L.flag(x.paisA2)}</span>`:""}${esc(place)}</span>`:""}</div></header>
    ${x.temFoto?`<div class="post-img" data-foto="${esc(x.id)}">${C.fotos[x.id]?`<img src="${esc(C.fotos[x.id])}" alt="${esc(x.titulo||"")}" decoding="async">`:""}</div>`:""}
    ${tp==="checkin"&&x.cidade?`<p class="ck-line"><span class="ck-pin" aria-hidden="true"></span>${x.paisA2?`<span class="flag">${L.flag(x.paisA2)}</span> `:""}${esc(x.cidade)}</p>`:""}
    ${x.titulo?`<h3 class="h3 post-t">${esc(x.titulo)}</h3>`:""}
    ${x.texto?`<p class="c-text">${esc(x.texto)}</p>`:""}
    <div class="post-foot">${link?`<a class="small" href="${esc(link)}" target="_blank" rel="noopener">Ver link ↗</a>`:""}${(x.temFoto||x.cidade)?`<button type="button" class="link-btn small pc-btn" data-pc-post="${esc(x.id)}">Cartão para stories</button>`:""}</div>
  </article>`;
}
function loadPostPhotos(){
  if(!db) return;
  document.querySelectorAll(".post-img[data-foto]").forEach(box=>{
    const id=box.dataset.foto;
    if(C.fotos[id]){ if(!box.querySelector("img")) box.innerHTML=`<img src="${esc(C.fotos[id])}" alt="" decoding="async">`; return; }
    if(C.fotoLoading.has(id) || C.fotos[id]===null) return;
    C.fotoLoading.add(id);
    db.collection("fotos").doc(id).get().then(d=>{
      const v=d.exists && d.data().data; C.fotos[id]=(typeof v==="string" && v.startsWith("data:image/jpeg;base64,"))?v:null; C.fotoLoading.delete(id);
      document.querySelectorAll(`.post-img[data-foto="${CSS.escape(id)}"]`).forEach(b=>{ if(C.fotos[id]) b.innerHTML=`<img src="${esc(C.fotos[id])}" alt="" decoding="async">`; else b.remove(); });
    }).catch(()=>{ C.fotoLoading.delete(id); });
  });
}
const TIPOS_POST = {post:"Publicação", dica:"Dica", checkin:"Check-in"};
const tipoOf = x => TIPOS_POST[x.tipo] ? x.tipo : "dica";   // older posts were all tips
function postSheet(tipo0){
  if(!C.user) return needLogin("Entre para publicar.");
  if(!C.verified) { toast("Confirme seu e-mail para publicar."); C.perfilUid=C.user.uid; L.go("perfil"); return; }
  let foto="", tipo=TIPOS_POST[tipo0]?tipo0:"post", geo=null;
  const dlg=document.createElement("dialog"); dlg.className="sheet post-sheet";
  dlg.innerHTML=`<form method="dialog" novalidate><header><h2 class="h3">Nova publicação</h2><button type="button" class="icon-btn" data-x aria-label="Fechar">✕</button></header>
    <div class="body">
      <div class="segbar tipo-bar" role="group" aria-label="Tipo">${Object.entries(TIPOS_POST).map(([k,l])=>`<button type="button" data-tipo="${k}" aria-pressed="${k===tipo}">${l}</button>`).join("")}</div>
      <p class="tiny muted" id="n-help"></p>
      <div class="geo-box" id="n-geo" hidden><button type="button" class="btn secondary" id="n-loc">Usar minha localização</button><span class="tiny" id="n-geo-t">Mostramos só a cidade, nunca o endereço.</span></div>
      <div class="post-photo" id="n-prev"><label for="n-file" class="post-photo-empty">Adicionar foto (opcional)</label></div>
      <input type="file" id="n-file" accept="image/*" class="sr">
      <div class="field" id="n-titulo-f"><label for="n-titulo" id="n-titulo-l">Título</label><input type="text" id="n-titulo" maxlength="100"></div>
      <div class="row2">
        <div class="field"><label for="n-cidade">Cidade ou lugar</label><input type="text" id="n-cidade" maxlength="60" placeholder="Lisboa"></div>
        <div class="field"><label for="n-pais">País</label><select id="n-pais">${L.countryOptions().map(([a,n])=>`<option value="${esc(a)}">${esc(n)}</option>`).join("")}</select></div>
      </div>
      <div class="field"><label for="n-texto" id="n-texto-l">Texto</label><textarea id="n-texto" maxlength="1500" rows="4"></textarea></div>
      <div class="field" id="n-link-f"><label for="n-link">Link (opcional)</label><input type="url" id="n-link" maxlength="300" placeholder="https://"></div>
      <p class="small p-err" id="n-err" hidden></p>
    </div>
    <footer><span class="sp"></span><button type="button" class="btn plain" data-x>Cancelar</button><button type="submit" class="btn" id="n-save">Publicar</button></footer></form>`;
  document.body.appendChild(dlg);
  const $d=q=>dlg.querySelector(q);
  const close=()=>{ try{ dlg.close(); }catch(e){} dlg.remove(); };
  dlg.querySelectorAll("[data-x]").forEach(b=>b.onclick=close);
  dlg.addEventListener("cancel",e=>{ e.preventDefault(); close(); });
  const drawTipo=()=>{
    dlg.querySelectorAll("[data-tipo]").forEach(b=>b.setAttribute("aria-pressed",b.dataset.tipo===tipo));
    $d("#n-help").textContent = tipo==="dica" ? "Um lugar, um restaurante, um passeio: algo que vale a pena para quem viaja."
      : tipo==="checkin" ? "Conte onde você está agora. Aparece no seu perfil e no mural da comunidade."
      : "Uma foto, um momento, uma pergunta para a comunidade.";
    $d("#n-geo").hidden = tipo!=="checkin";
    $d("#n-link-f").hidden = tipo==="checkin";
    $d("#n-titulo-l").textContent = tipo==="dica" ? "Título" : "Título (opcional)";
    $d("#n-titulo").placeholder = tipo==="dica" ? "Ex.: Pôr do sol no Miradouro da Graça" : tipo==="checkin" ? "Ex.: Primeiro dia de neve!" : "Ex.: Mala pronta";
    $d("#n-texto-l").textContent = tipo==="dica" ? "Conte a dica" : tipo==="checkin" ? "Como está sendo? (opcional)" : "O que você quer contar";
    $d("#n-texto").placeholder = tipo==="dica" ? "Por que vale a pena, quanto custa, melhor horário…" : "Escreva aqui…";
  };
  drawTipo();
  dlg.querySelector(".tipo-bar").addEventListener("click",e=>{ const b=e.target.closest("[data-tipo]"); if(!b) return; tipo=b.dataset.tipo; drawTipo(); });
  $d("#n-cidade").addEventListener("input",()=>{ geo=null; });
  $d("#n-loc").onclick=()=>{
    const t=$d("#n-geo-t");
    if(!navigator.geolocation){ t.textContent="Este aparelho não informa a localização. Escreva a cidade."; return; }
    t.textContent="Procurando…";
    navigator.geolocation.getCurrentPosition(async p=>{
      const lat=p.coords.latitude, lng=p.coords.longitude;
      await L.loadCities();
      const c=L.nearestCity(lat,lng);
      if(c){ $d("#n-cidade").value=c.n; $d("#n-pais").value=c.c; geo={lat:+c.lat.toFixed(3), lng:+c.lng.toFixed(3)}; t.textContent=`${c.n}${L.stateName(c.c,c.s)?", "+L.stateName(c.c,c.s):""}. Só a cidade aparece.`; }
      else { geo={lat:+lat.toFixed(1), lng:+lng.toFixed(1)}; t.textContent="Não achei a cidade. Escreva o nome dela; a posição fica aproximada."; }
    },()=>{ t.textContent="Sem permissão de localização. Escreva a cidade."; },{enableHighAccuracy:false,timeout:12000,maximumAge:600000});
  };
  const drawPrev=()=>{ $d("#n-prev").innerHTML = foto ? `<img src="${esc(foto)}" alt="Prévia"><button type="button" class="post-photo-rm" aria-label="Remover foto">×</button>` : `<label for="n-file" class="post-photo-empty">Adicionar foto (opcional)</label>`;
    const rm=$d(".post-photo-rm"); if(rm) rm.onclick=()=>{ foto=""; drawPrev(); }; };
  $d("#n-file").addEventListener("change",async ()=>{ const f=$d("#n-file").files[0]; if(!f) return;
    $d("#n-prev").innerHTML=`<span class="post-photo-empty">Preparando foto…</span>`;
    try{ foto=await shrinkImage(f, 1080, .72, false, 380000); }catch(e){ foto=""; toast("Não deu para usar essa foto. Tente outra."); }
    drawPrev(); $d("#n-file").value=""; });
  $d("form").onsubmit=async e=>{
    e.preventDefault(); const err=$d("#n-err"); const bad=m=>{ err.textContent=m; err.hidden=false; };
    const titulo=$d("#n-titulo").value.trim(), texto=$d("#n-texto").value.trim(), cidade=$d("#n-cidade").value.trim(), pais=$d("#n-pais").value;
    if(tipo==="dica" && !titulo) return bad("Dê um título para a dica.");
    if(tipo==="checkin" && !cidade) return bad("Escreva a cidade ou use sua localização.");
    if(tipo==="post" && !titulo && !texto && !foto) return bad("Escreva algo ou adicione uma foto.");
    const link=tipo==="checkin"?"":$d("#n-link").value.trim(); if(link && !L.safeUrl(link)) return bad("O link precisa começar com https://");
    const btn=$d("#n-save"); btn.disabled=true; btn.textContent="Publicando…"; err.hidden=true;
    if(tipo==="checkin" && !geo && cidade){ try{ await L.loadCities(); const c=L.canonCity(cidade,/^[A-Z]{2}$/.test(pais)?pais:""); if(c) geo={lat:+c.lat.toFixed(3), lng:+c.lng.toFixed(3)}; }catch(x){} }
    try{
      const ref=db.collection("posts").doc();
      const data={uid:C.user.uid, nome:(C.me&&C.me.nome)||"", tipo, titulo:titulo.slice(0,100), cidade:cidade.slice(0,60), paisA2:/^[A-Z]{2}$/.test(pais)?pais:"", texto:texto.slice(0,1500), link:link.slice(0,300), temFoto:!!foto, em:TS()};
      if(tipo==="checkin" && geo){ data.lat=geo.lat; data.lng=geo.lng; }
      await timed(ref.set(data),15000);
      if(foto){ try{ await timed(db.collection("fotos").doc(ref.id).set({uid:C.user.uid, data:foto}),20000); C.fotos[ref.id]=foto; }catch(x){ dbError(x,"enviar a foto"); } }
      close(); toast(tipo==="checkin"?"Check-in feito":tipo==="dica"?"Dica publicada":"Publicado"); L.render();
    }catch(x){ dbError(x,"publicar"); err.textContent=C.lastError; err.hidden=false; btn.disabled=false; btn.textContent="Publicar"; }
  };
  if(typeof dlg.showModal==="function"){ try{ dlg.showModal(); }catch(e){ dlg.setAttribute("open",""); dlg.classList.add("no-modal"); } } else { dlg.setAttribute("open",""); dlg.classList.add("no-modal"); }
}
async function postcardPost(id){
  const x=C.posts.find(p=>p.id===id); if(!x) return;
  if(x.temFoto && !C.fotos[id]){ try{ const d=await db.collection("fotos").doc(id).get(); const v=d.exists&&d.data().data; if(typeof v==="string"&&v.startsWith("data:image/jpeg;base64,")) C.fotos[id]=v; }catch(e){} }
  const dt=x.em&&x.em.toDate?x.em.toDate():new Date();
  const iso=dt.getFullYear()+"-"+String(dt.getMonth()+1).padStart(2,"0")+"-"+String(dt.getDate()).padStart(2,"0");
  L.postcard({cidade:x.cidade||x.titulo||"Latitude 53", paisA2:x.paisA2, lat:x.lat, lng:x.lng, foto:C.fotos[id]||"", titulo:x.cidade?(x.titulo||""):"", data:iso, autor:nameOf(x.uid,x.nome), stampTop:tipoOf(x)==="checkin"?"CHECK-IN":tipoOf(x)==="dica"?"DICA":"LATITUDE 53"});
}

/* ---------- ao vivo: check-ins dos autores alimentam a rota no Início ---------- */
let liveDocs=[];
function pushLive(){
  const list=liveDocs.filter(x=>C.admins.has(x.uid) && isFinite(x.lat) && isFinite(x.lng) && x.lat!=null)
    .map(x=>({lat:x.lat, lng:x.lng, cidade:x.cidade||"", paisA2:x.paisA2||"", t:x.em&&x.em.toMillis?x.em.toMillis():0}))
    .sort((a,b)=>a.t-b.t);
  L.setLive(list);
}

/* ---------- mapa da comunidade ---------- */
function countryCounts(){
  const m={}; (C.members||[]).forEach(p=>(p.paises||[]).forEach(a=>{ if(/^[A-Z]{2}$/.test(a)) m[a]=(m[a]||0)+1; })); return m;
}
function communityMapHtml(){
  if(!C.members || !C.members.length) return "";
  const m=countryCounts(); const keys=Object.keys(m); if(!keys.length) return "";
  const top=keys.sort((a,b)=>m[b]-m[a]||L.countryName(a).localeCompare(L.countryName(b),"pt")).slice(0,8);
  return `<div class="cmap-wrap">
    <div class="head-row" style="margin:0 0 12px"><div><h2 class="h3">O mapa da comunidade</h2><p class="small muted" style="margin:4px 0 0"><b class="num">${C.members.length}</b> ${C.members.length===1?"membro já passou":"membros já passaram"} por <b class="num">${keys.length}</b> ${keys.length===1?"país":"países"}. Marque os seus no perfil.</p></div></div>
    <div class="cmap" id="cmap" role="img" aria-label="Mapa com os países visitados pelos membros"></div>
    <div class="chips cmap-top">${top.map(a=>`<span class="chip"><span class="flag">${L.flag(a)}</span> ${esc(L.countryName(a))} <b class="num">${m[a]}</b></span>`).join("")}</div>
  </div>`;
}
function drawCommunityMap(animate){
  const el=document.getElementById("cmap"); if(!el || el.querySelector("svg")) return;
  if(!window.d3 || !window.WORLD){ if(!el.dataset.wait){ el.dataset.wait=1; L.loadMapLib().then(ok=>{ if(ok) drawCommunityMap(animate); }); } return; }
  const d3=window.d3, m=countryCounts(), max=Math.max(1,...Object.values(m));
  const W=960,H=470;
  const feats=topojson.feature(WORLD, WORLD.objects.countries).features.filter(f=>f.properties.a2!=="AQ");
  const proj=d3.geoNaturalEarth1().fitExtent([[4,4],[W-4,H-4]],{type:"FeatureCollection",features:feats}); const path=d3.geoPath(proj);
  const svg=d3.select(el).append("svg").attr("viewBox",`0 0 ${W} ${H}`);
  svg.append("g").selectAll("path").data(feats).join("path").attr("d",path).attr("class","rm-land")
    .append("title").text(f=>L.countryName(f.properties.a2));
  const hot=feats.filter(f=>m[f.properties.a2]);
  const p=svg.append("g").selectAll("path").data(hot).join("path").attr("d",path).attr("class","cm-hot")
    .style("fill-opacity",f=>(.28+.72*Math.sqrt(m[f.properties.a2]/max)).toFixed(2));
  p.append("title").text(f=>`${L.countryName(f.properties.a2)} · ${m[f.properties.a2]} ${m[f.properties.a2]===1?"membro":"membros"}`);
  if(animate && !L.reduceMotion()) p.style("opacity",0).transition().delay((d,i)=>150+i*25).duration(600).style("opacity",1);
}

/* ---------- passaporte: carimbos por participação ---------- */
const STAMPS = [
  {k:"embarque", n:"Embarque", i:"✈︎", c:"#0071e3", h:"Criou a conta", ok:s=>true},
  {k:"palavra", n:"Primeira palavra", i:"💬", c:"#5e5ce6", h:"Faça 1 comentário", ok:s=>s.comments>=1},
  {k:"papo", n:"Bom de papo", i:"🗣", c:"#bf5af2", h:"Faça 10 comentários", ok:s=>s.comments>=10},
  {k:"post", n:"Primeiro post", i:"✍︎", c:"#ff9f0a", h:"Publique algo", ok:s=>s.posts>=1},
  {k:"dica", n:"Dica de ouro", i:"★", c:"#d4a017", h:"Publique 1 dica", ok:s=>s.dicas>=1},
  {k:"guia", n:"Guia local", i:"🧭", c:"#ff6b35", h:"Publique 5 vezes", ok:s=>s.posts>=5},
  {k:"checkin", n:"Estive aqui", i:"📍", c:"#ff375f", h:"Faça 1 check-in", ok:s=>s.checkins>=1},
  {k:"foto", n:"Olhar de fotógrafo", i:"📷", c:"#64d2ff", h:"Publique uma foto", ok:s=>s.fotos>=1},
  {k:"explorador", n:"Explorador", i:"🗺", c:"#30b05a", h:"Marque 5 países", ok:s=>s.paises>=5},
  {k:"cidades", n:"Colecionador", i:"🏙", c:"#5856d6", h:"Marque 20 cidades", ok:s=>s.cidades>=20},
  {k:"mundo", n:"Cidadão do mundo", i:"🌍", c:"#1f7a35", h:"Marque 15 países", ok:s=>s.paises>=15},
  {k:"rota", n:"Na nossa rota", i:"⚓︎", c:"#0a84ff", h:"Visite Portugal, Holanda ou Irlanda", ok:s=>s.rota},
  {k:"turma", n:"Turma", i:"🤝", c:"#ac8e68", h:"Siga 5 pessoas", ok:s=>s.seguindo>=5},
  {k:"querido", n:"Querido", i:"♥︎", c:"#ff2d55", h:"Tenha 10 seguidores", ok:s=>s.seguidores>=10},
  {k:"sonhador", n:"Sonhador", i:"☁︎", c:"#8e8e93", h:"Guarde 5 desejos", ok:s=>s.salvos>=5, self:true},
  {k:"pioneiro", n:"Pioneiro", i:"⚑", c:"#e8590c", h:"Esteja entre os 50 primeiros", ok:s=>s.pioneiro}
];
function stampStats(uid, p, mine){
  const posts=C.posts.filter(x=>x.uid===uid); const fc=(C.followCache&&C.followCache.uid===uid)?C.followCache:{};
  let pioneiro=false;
  if(C.members && C.members.length && p && p.criadoEm && p.criadoEm.toMillis){
    const older=C.members.filter(m=>m.criadoEm&&m.criadoEm.toMillis&&m.criadoEm.toMillis()<p.criadoEm.toMillis()).length;
    pioneiro = C.members.length<200 && older<50;
  }
  const paises=(p&&p.paises)||[];
  return {comments:C.comments.filter(c=>c.uid===uid).length, posts:posts.length, dicas:posts.filter(x=>tipoOf(x)==="dica").length,
    checkins:posts.filter(x=>tipoOf(x)==="checkin").length, fotos:posts.filter(x=>x.temFoto).length, paises:paises.length, cidades:cidadesOf(p).length,
    rota:paises.some(a=>["PT","NL","IE"].includes(a)), seguindo:fc.seguindo||0, seguidores:fc.seguidores||0,
    salvos:mine?Object.keys(C.saved).length:0, pioneiro};
}
function passportHtml(uid, p, mine){
  const s=stampStats(uid,p,mine);
  const list=STAMPS.filter(x=>mine || !x.self);
  const got=list.filter(x=>x.ok(s));
  const shown = mine ? list : got;
  if(!shown.length) return "";
  const rot=k=>{ let h=0; for(const ch of k) h=(h*31+ch.charCodeAt(0))%997; return (h%17)-8; };
  return `<div class="head-row hoje-h" style="margin-bottom:12px"><h2 class="h3">Passaporte</h2><span class="tiny num">${got.length} de ${list.length} carimbos</span></div>
    <div class="stamps">${shown.map(x=>{ const ok=x.ok(s); return `<div class="stamp ${ok?"on":"off"}" style="--sc:${x.c};--rot:${ok?rot(x.k):0}deg" title="${esc(ok?x.n:x.h)}">
      <span class="st-ring"><span class="st-i" aria-hidden="true">${x.i}</span></span><span class="st-n">${esc(x.n)}</span>${ok?"":`<span class="st-h">${esc(x.h)}</span>`}</div>`; }).join("")}</div>`;
}
async function delPost(id,btn){
  if(!btn.dataset.confirm){ btn.dataset.confirm=1; btn.textContent="Confirmar"; setTimeout(()=>{ if(btn.isConnected){ btn.textContent="Apagar"; delete btn.dataset.confirm; } },3000); return; }
  try{ const x=C.posts.find(p=>p.id===id); if(x&&x.temFoto) await timed(db.collection("fotos").doc(id).delete()).catch(()=>{}); await timed(db.collection("posts").doc(id).delete()); toast("Publicação apagada"); }catch(e){ dbError(e,"apagar a publicação"); }
}
function bindCommunity(){
  const v=document.getElementById("view"); if(!v || v.dataset.cb===L.S.view) return; v.dataset.cb=L.S.view;
  v.addEventListener("click",async e=>{
    if(!CVIEWS.includes(L.S.view)) return;
    const pm=e.target.closest("[data-pmap]"); if(pm){ C.pmapMode=pm.dataset.pmap; C.pmapAnim=true; L.render(); return; }
    const pf=e.target.closest("[data-profile]"); if(pf){ C.perfilUid=pf.dataset.profile; L.go("perfil"); return; }
    if(e.target.closest("[data-login]")) return authSheet("criar");
    if(e.target.closest("[data-go-me]")){ C.perfilUid=C.user.uid; L.go("perfil"); return; }
    const fl=e.target.closest("[data-filtro]"); if(fl){ C.filtro=fl.dataset.filtro; L.render(); return; }
    const al=e.target.closest("[data-alvo]"); if(al) return goTo(al.dataset.alvo);
    const tr=e.target.closest("[data-trip]"); if(tr) return openTrip(tr.dataset.trip);
    if(e.target.closest("[data-new-trip]")) return tripSheet(null);
    const io=e.target.closest("[data-inv-ok]"); if(io) return acceptInvite(io.dataset.invOk);
    const ino=e.target.closest("[data-inv-no]"); if(ino) return declineInvite(ino.dataset.invNo);
    const ci=e.target.closest("[data-cancel-inv]"); if(ci){ try{ await db.collection("convites").doc(ci.dataset.cancelInv).delete(); toast("Convite cancelado"); }catch(x){ dbError(x,"cancelar o convite"); } return; }
    { const t=tripById(C.tripId);
      if(t){ if(e.target.closest("[data-edit-trip]")) return tripSheet(t);
        if(e.target.closest("[data-invite]")) return inviteSheet(t);
        if(e.target.closest("[data-add-dia]")) return diaSheet(t,null);
        const ed=e.target.closest("[data-edit-dia]"); if(ed) return diaSheet(t,(C.tripDias||[]).find(d=>d.id===ed.dataset.editDia));
        const lv=e.target.closest("[data-leave-trip]"); if(lv) return leaveTrip(t,lv);
        const dt=e.target.closest("[data-del-trip]"); if(dt) return deleteTrip(t,dt);
        const rm=e.target.closest("[data-rm-member]"); if(rm) return removeMember(t,rm.dataset.rmMember,rm); } }
    const np=e.target.closest("[data-new-post]"); if(np) return postSheet(np.dataset.newPost);
    const tf=e.target.closest("[data-tipo-f]"); if(tf){ C.tipoF=tf.dataset.tipoF; L.render(); return; }
    const pcp=e.target.closest("[data-pc-post]"); if(pcp) return postcardPost(pcp.dataset.pcPost);
    const uw=e.target.closest("[data-unwish]"); if(uw) return toggleSave(uw.dataset.unwish,"");
    const dp=e.target.closest("[data-del-post]"); if(dp) return delPost(dp.dataset.delPost, dp);
    const fw=e.target.closest("[data-follow]"); if(fw) return toggleFollow(fw.dataset.follow);
    if(e.target.closest("[data-edit-me]")) return editProfile();
    if(e.target.closest("[data-logout]")){ await auth.signOut(); toast("Você saiu da conta"); L.go("comunidade"); return; }
    if(e.target.closest("[data-del-account]")) return deleteAccount(e.target.closest("[data-del-account]"));
    if(e.target.closest("[data-verify]")) return resendVerify();
    if(e.target.closest("[data-diag]")) return runDiag();
    if(e.target.closest("[data-reload]")){ await C.user.reload(); C.verified=!!auth.currentUser.emailVerified; if(C.verified){ await C.user.getIdToken(true); toast("E-mail confirmado!"); } else toast("Ainda não confirmado. Abra o link do e-mail."); L.render(); return; }
  });
}
// the page re-renders #view; rebind when a community view is shown
L.onAfterRender(entering=>{ const v=document.getElementById("view"); if(v && CVIEWS.includes(L.S.view)){ delete v.dataset.cb; bindCommunity(); } drawCommunityMap(entering); drawProfileMap(entering||C.pmapAnim); C.pmapAnim=false; drawTripMap(entering||C.tripAnim); C.tripAnim=false; });

function goTo(alvo){
  const [tipo,id]=alvo.split(":"); C.open.add(alvo);
  L.go(tipo==="dia"?"roteiro":tipo==="post"?"comunidade":"mapa");
  setTimeout(()=>{ const el=document.querySelector(tipo==="dia"?`[data-day="${CSS.escape(id)}"]`:tipo==="post"?`[data-post="${CSS.escape(id)}"]`:`[data-place="${CSS.escape(id)}"]`); if(el){ el.scrollIntoView({behavior:L.reduceMotion()?"auto":"smooth",block:"center"}); el.classList.add("flash"); setTimeout(()=>el.classList.remove("flash"),1600); } },400);
}
async function toggleFollow(uid){
  if(!C.user) return needLogin("Entre para seguir outros membros.");
  const id=C.user.uid+"_"+uid; const ref=db.collection("follows").doc(id);
  try{ if(C.following.has(uid)) await timed(ref.delete()); else await timed(ref.set({from:C.user.uid,to:uid,em:TS()})); C.followCache=null; }catch(e){ dbError(e,"seguir"); }
}

/* ---------- Perfil view ---------- */
function vPerfil(){
  if(!C.ready) return `<section class="band"><div class="wrap"><h1 class="h1">Carregando…</h1></div></section>`;
  const uid=C.perfilUid || (C.user&&C.user.uid);
  if(!uid) return `<section class="band"><div class="wrap"><div class="empty-state"><p class="h3">Entre para ver seu perfil</p><p style="margin-top:12px"><button class="btn" type="button" data-login>Criar conta ou entrar</button></p></div></div></section>`;
  const mine = C.user && C.user.uid===uid;
  let p = C.profiles[uid]; if(!p) want([uid]);
  if(!p && mine) p = {nome:C.user.displayName||(C.user.email||"").split("@")[0], paises:[], foto:googlePhoto(C.user)};
  loadFollowCounts(uid); loadMembers();
  const fc = (C.followCache && C.followCache.uid===uid) ? C.followCache : null;
  const seus = C.comments.filter(c=>c.uid===uid).slice(0,30);
  const salvos = mine ? Object.values(C.saved) : [];
  setTimeout(bindCommunity,0);
  return `<section class="band"><div class="wrap">
    <div class="profile-head">
      ${avatar(uid,96)}
      <div class="ph-text"><p class="eyebrow">${mine?"Seu perfil":"Perfil"}</p><h1 class="h1">${esc(p?p.nome:"…")} ${badge(uid)}</h1>
        <p class="small muted">${p&&p.cidade?esc(p.cidade):""}${p&&p.insta?`${p.cidade?" · ":""}<a href="https://instagram.com/${esc(p.insta)}" target="_blank" rel="noopener">@${esc(p.insta)}</a>`:""}</p>
        ${p&&p.bio?`<p class="lead" style="margin-top:10px">${esc(p.bio)}</p>`:""}
        <div class="ph-stats"><span><b class="num">${fc?fc.seguidores:"–"}</b> ${fc&&fc.seguidores===1?"seguidor":"seguidores"}</span><span><b class="num">${fc?fc.seguindo:"–"}</b> seguindo</span><span><b class="num">${(p&&p.paises||[]).length}</b> ${(p&&p.paises||[]).length===1?"país":"países"}</span>${cidadesOf(p).length?`<span><b class="num">${cidadesOf(p).length}</b> ${cidadesOf(p).length===1?"cidade":"cidades"}</span>`:""}</div>
        ${p&&p.proximo?`<p class="dest-to" style="margin-top:10px">✈︎ Próximo destino: <b>${esc(p.proximo)}</b></p>`:""}
        <div class="actions" style="margin-top:16px">${mine?`<button class="btn secondary" type="button" data-edit-me>Editar perfil e mapa</button><button class="btn plain" type="button" data-logout>Sair</button>`:followBtn(uid)}${C.admins.has(uid)?`<a class="btn plain" href="#viagem">Ver a viagem</a>`:""}</div>
      </div>
    </div>
    ${mine && C.lastError?`<div class="verify-box"><strong>Algo não funcionou</strong><span class="small">${esc(C.lastError)}</span></div>`:""}
    ${mine?invitesHtml():""}
    ${mine && !C.verified?`<div class="verify-box"><strong>Confirme seu e-mail</strong><span class="small">Enviamos um link para ${esc(C.user.email||"")}. Depois de abrir, toque em "Já confirmei".</span><div class="actions"><button class="btn" type="button" data-reload>Já confirmei</button><button class="btn plain" type="button" data-verify>Reenviar</button></div></div>`:""}
    ${p?`<div class="hoje-h">${profileMapHtml(uid,p)}</div>`:""}
    ${mine && p && !(p.paises||[]).length && !cidadesOf(p).length?`<div class="empty-state hoje-h"><p class="h3">Monte o seu mapa</p><p class="small">Marque os países e as cidades que você já conheceu. Quem visitar o seu perfil vê o mapa.</p><p style="margin-top:12px"><button class="btn" type="button" data-edit-me>Marcar lugares</button></p></div>`:""}
    ${(p&&p.paises||[]).length?`<h2 class="h3 hoje-h">Países que já visitou</h2><div class="chips">${p.paises.map(a=>`<span class="chip"><span class="flag">${L.flag(a)}</span> ${esc(L.countryName(a))}</span>`).join("")}</div>`:""}
    ${cidadesOf(p).length?`<h2 class="h3 hoje-h">Cidades</h2><div class="chips">${cidadesOf(p).slice().sort((a,b)=>a.n.localeCompare(b.n,"pt")).map(c=>`<span class="chip"><span class="flag">${L.flag(c.c)}</span> ${esc(c.n)}</span>`).join("")}</div>`:""}
    ${tripsForProfile(uid,mine)}
    ${passportHtml(uid,p,mine)}
    ${(()=>{ const theirs=C.posts.filter(x=>x.uid===uid); return theirs.length?`<h2 class="h3 hoje-h">Publicações</h2><div class="posts">${theirs.map(postCard).join("")}</div>`:(mine?`<h2 class="h3 hoje-h">Publicações</h2><p class="small muted">Você ainda não publicou. <button type="button" class="link-btn small" data-new-post="post">Fazer a primeira publicação</button></p>`:""); })()}
    ${mine?wishlist(salvos):""}
    <h2 class="h3 hoje-h">Comentários</h2>
    ${seus.length?`<div class="feed">${seus.map(c=>`<div class="feed-item"><div class="c-body"><div class="c-meta"><span class="tiny">em <button type="button" class="link-btn tiny" data-alvo="${esc(c.alvo)}">${esc(c.alvoTitulo||"um lugar")}</button> · ${esc(when(c.em))}</span></div><div class="c-text">${esc(c.texto)}</div></div></div>`).join("")}</div>`:`<p class="small muted">Nenhum comentário ainda.</p>`}
    ${mine?`<div class="diag" id="diag-box">${C.diag?C.diag:""}</div><p style="margin-top:56px" class="tiny"><button type="button" class="link-btn tiny" data-diag>Verificar conexão com o banco</button> · <button type="button" class="link-btn tiny" data-del-account>Excluir minha conta</button> · <button type="button" class="link-btn tiny" onclick="LAT53.go('privacidade')">Privacidade</button></p>`:""}
  </div></section>`;
}
function wishlist(salvos){
  const dicas=salvos.filter(x=>x.alvo.startsWith("post:")); const nossos=salvos.filter(x=>!x.alvo.startsWith("post:"));
  const row=x=>{ const id=x.alvo.split(":")[1]; const post=x.alvo.startsWith("post:")?C.posts.find(p=>p.id===id):null;
    const place=post?[post.cidade, post.paisA2?L.countryName(post.paisA2):""].filter(Boolean).join(", "):(x.alvo.startsWith("dia:")?"Roteiro":"Mapa");
    return `<div class="wish">${post&&post.paisA2?`<span class="flag wish-flag">${L.flag(post.paisA2)}</span>`:`<span class="wish-flag">★</span>`}
      <div class="c-body"><button type="button" class="link-btn wish-t" data-alvo="${esc(x.alvo)}">${esc(x.titulo||"Dica")}</button><span class="tiny">${esc(place)}${post?` · por ${esc(nameOf(post.uid,post.nome))}`:""}</span></div>
      <button type="button" class="link-btn tiny" data-unwish="${esc(x.alvo)}" aria-label="Tirar da lista">Tirar</button></div>`; };
  return `<h2 class="h3 hoje-h">Lista de desejos</h2>
    ${salvos.length?`<div class="feed wishes">${dicas.map(row).join("")}${nossos.length?`<div class="tiny wish-sec">Do roteiro de Gustavo e Priscila</div>${nossos.map(row).join("")}`:""}</div>`
    :`<p class="small muted">Toque em "Quero ir" numa dica da comunidade, ou em Salvar num dia do Roteiro ou lugar do Mapa, para montar sua lista.</p>`}`;
}
function loadFollowCounts(uid){
  if(C.followCache && C.followCache.uid===uid && Date.now()-C.followCache.t<30000) return;
  if(C.followLoading===uid) return; C.followLoading=uid;
  Promise.all([db.collection("follows").where("to","==",uid).get(), db.collection("follows").where("from","==",uid).get()])
    .then(([a,b])=>{ C.followCache={uid,seguidores:a.size,seguindo:b.size,t:Date.now()}; C.followLoading=null; if(L.S.view==="perfil") L.render(); })
    .catch(()=>{ C.followLoading=null; });
}
function editProfile(){
  if(!C.user) return needLogin();
  const me=C.me||{nome:C.user.displayName||"", insta:"", cidade:"", bio:"", paises:[], foto:googlePhoto(C.user)};
  let newAvatar = me.avatar||"";
  let paises=(me.paises||[]).slice();
  let cidades=cidadesOf(me).map(c=>Object.assign({},c));
  const all=L.countryOptions().filter(o=>o[0]);
  const dlg=document.createElement("dialog"); dlg.className="sheet profile-sheet";
  dlg.innerHTML=`<form method="dialog" novalidate><header><h2 class="h3">Editar perfil</h2><button type="button" class="icon-btn" data-x aria-label="Fechar">✕</button></header>
    <div class="body">
      <div class="p-photo"><span id="p-av"></span>
        <div class="p-photo-btns"><label class="btn secondary" for="p-file">Trocar foto</label><input type="file" id="p-file" accept="image/*" class="sr">
        <button type="button" class="btn plain" id="p-rmfoto">Remover</button></div></div>
      <div class="field"><label for="p-nome">Nome</label><input type="text" id="p-nome" maxlength="60" autocomplete="name" value="${esc(me.nome||"")}"></div>
      <div class="row2">
        <div class="field"><label for="p-insta">Instagram</label><input type="text" id="p-insta" maxlength="31" autocapitalize="off" spellcheck="false" placeholder="seu.perfil" value="${esc(me.insta||"")}"></div>
        <div class="field"><label for="p-cidade">Onde mora</label><input type="text" id="p-cidade" maxlength="60" placeholder="Salvador, BA" value="${esc(me.cidade||"")}"></div>
      </div>
      <div class="field"><label for="p-bio">Sobre você</label><textarea id="p-bio" maxlength="280" rows="3" placeholder="Uma frase sobre você ou suas viagens">${esc(me.bio||"")}</textarea><span class="help"><span id="p-bio-n">${(me.bio||"").length}</span>/280</span></div>
      <div class="field"><label for="p-prox">Próximo destino</label><input type="text" id="p-prox" maxlength="80" placeholder="Lisboa, dezembro de 2026" value="${esc(me.proximo||"")}"><span class="help">Aparece no seu perfil e no Início, em "Para onde a comunidade vai".</span></div>
      <div class="field"><label for="p-cbusca">Cidades que já visitou <span class="tiny" id="p-ccount"></span></label>
        <div class="chips" id="p-csel"></div>
        <input type="search" id="p-cbusca" placeholder="Buscar cidade (ex.: Lisboa)" autocomplete="off">
        <div class="pais-list city-list" id="p-clist" role="listbox" aria-label="Cidades" hidden></div>
        <span class="help">O país da cidade é marcado sozinho.</span>
      </div>
      <div class="field"><label for="p-busca">Países que já visitou <span class="tiny" id="p-count"></span></label>
        <div class="chips" id="p-sel"></div>
        <input type="search" id="p-busca" placeholder="Buscar país (ex.: Portugal)" autocomplete="off">
        <div class="pais-list" id="p-list" role="listbox" aria-multiselectable="true" aria-label="Países"></div>
      </div>
      <p class="small p-err" id="p-err" hidden></p>
    </div>
    <footer><span class="sp"></span><button type="button" class="btn plain" data-x>Cancelar</button><button type="submit" class="btn" id="p-save">Salvar</button></footer></form>`;
  document.body.appendChild(dlg);
  const $d=q=>dlg.querySelector(q);
  const close=()=>{ try{ dlg.close(); }catch(e){} dlg.remove(); };
  dlg.querySelectorAll("[data-x]").forEach(b=>b.onclick=close);
  dlg.addEventListener("cancel",e=>{ e.preventDefault(); close(); });
  const drawAv=()=>{
    const pic = newAvatar || me.foto || "";
    const n=($d("#p-nome").value||me.nome||"?").trim(); const ini=n.split(/\s+/).map(w=>w[0]).join("").slice(0,2).toUpperCase();
    $d("#p-av").innerHTML = pic ? `<span class="av" style="--s:84px"><img src="${esc(pic)}" alt="Sua foto" referrerpolicy="no-referrer"></span>` : `<span class="av" style="--s:84px">${esc(ini)}</span>`;
    $d("#p-rmfoto").hidden = !newAvatar;
  };
  drawAv();
  $d("#p-file").addEventListener("change",async ()=>{
    const f=$d("#p-file").files[0]; if(!f) return;
    try{ newAvatar = await shrinkImage(f, 256, .85, true, 140000); drawAv(); }
    catch(e){ toast("Não deu para usar essa foto. Tente outra."); }
    $d("#p-file").value="";
  });
  $d("#p-rmfoto").onclick=()=>{ newAvatar=""; drawAv(); };
  $d("#p-bio").addEventListener("input",()=>{ $d("#p-bio-n").textContent=$d("#p-bio").value.length; });
  const drawSel=()=>{
    $d("#p-count").textContent = paises.length ? `(${paises.length})` : "";
    $d("#p-sel").innerHTML = paises.length ? paises.map(a=>`<button type="button" class="chip chip-x" data-rm="${a}" aria-label="Remover ${esc(L.countryName(a))}"><span class="flag">${L.flag(a)}</span> ${esc(L.countryName(a))} <span aria-hidden="true">×</span></button>`).join("") : `<span class="tiny">Toque nos países da lista abaixo para marcar.</span>`;
  };
  const drawList=()=>{
    const k=L.nrm($d("#p-busca").value);
    const rows=all.filter(o=>!k || L.nrm(o[1]).includes(k)).slice(0, k?60:300);
    $d("#p-list").innerHTML = rows.length ? rows.map(([a,n])=>`<button type="button" role="option" class="pais-opt" data-a="${a}" aria-selected="${paises.includes(a)}"><span class="flag">${L.flag(a)}</span><span class="pn">${esc(n)}</span><span class="ck" aria-hidden="true">${paises.includes(a)?"✓":""}</span></button>`).join("") : `<p class="tiny" style="padding:10px">Nenhum país com esse nome.</p>`;
  };
  drawSel(); drawList();
  $d("#p-busca").addEventListener("input",drawList);
  const ckey=c=>c.c+"|"+L.nrm(c.n)+"|"+L.nrm(c.s);
  const drawCSel=()=>{
    $d("#p-ccount").textContent = cidades.length ? `(${cidades.length})` : "";
    $d("#p-csel").innerHTML = cidades.length ? cidades.map((c,i)=>`<button type="button" class="chip chip-x" data-crm="${i}" aria-label="Remover ${esc(c.n)}"><span class="flag">${L.flag(c.c)}</span> ${esc(c.n)} <span aria-hidden="true">×</span></button>`).join("") : `<span class="tiny">Busque e toque numa cidade para marcar.</span>`;
  };
  let found=[];
  const drawCList=async()=>{
    const q=$d("#p-cbusca").value.trim(); const box=$d("#p-clist");
    if(q.length<2){ box.hidden=true; return; }
    box.hidden=false;
    if(!window.CITY_DATA){ box.innerHTML=`<p class="tiny" style="padding:10px">Carregando cidades…</p>`; await L.loadCities(); if($d("#p-cbusca").value.trim()!==q) return; }
    found=L.searchCities(q,10);
    box.innerHTML = found.length ? found.map((c,i)=>{ const st=L.stateName(c.c,c.s); const has=cidades.some(x=>ckey(x)===ckey({c:c.c,n:c.n,s:st}));
      return `<button type="button" role="option" class="pais-opt" data-ci="${i}" aria-selected="${has}"><span class="flag">${L.flag(c.c)}</span><span class="pn">${esc(c.n)}<span class="tiny"> ${esc([st,L.countryName(c.c)].filter(Boolean).join(", "))}</span></span><span class="ck" aria-hidden="true">${has?"✓":""}</span></button>`; }).join("")
      : `<p class="tiny" style="padding:10px">Nenhuma cidade com esse nome.</p>`;
  };
  drawCSel();
  $d("#p-cbusca").addEventListener("input",drawCList);
  $d("#p-clist").addEventListener("click",e=>{ const b=e.target.closest("[data-ci]"); if(!b) return; const c=found[+b.dataset.ci]; if(!c) return;
    const item={n:c.n, c:c.c, s:L.stateName(c.c,c.s), la:+c.lat.toFixed(3), lo:+c.lng.toFixed(3)};
    const i=cidades.findIndex(x=>ckey(x)===ckey(item));
    if(i>=0) cidades.splice(i,1); else { if(cidades.length>=300){ toast("Limite de 300 cidades."); return; } cidades.push(item); if(!paises.includes(c.c)){ paises=paises.concat(c.c); drawSel(); drawList(); } }
    drawCSel(); drawCList(); });
  $d("#p-csel").addEventListener("click",e=>{ const b=e.target.closest("[data-crm]"); if(!b) return; cidades.splice(+b.dataset.crm,1); drawCSel(); if(!$d("#p-clist").hidden) drawCList(); });
  $d("#p-list").addEventListener("click",e=>{ const b=e.target.closest("[data-a]"); if(!b) return; const a=b.dataset.a;
    paises = paises.includes(a) ? paises.filter(x=>x!==a) : paises.concat(a);
    b.setAttribute("aria-selected",paises.includes(a)); b.querySelector(".ck").textContent=paises.includes(a)?"✓":""; drawSel(); });
  $d("#p-sel").addEventListener("click",e=>{ const b=e.target.closest("[data-rm]"); if(!b) return; paises=paises.filter(x=>x!==b.dataset.rm); drawSel(); drawList(); });
  $d("form").onsubmit=async e=>{
    e.preventDefault();
    const nome=$d("#p-nome").value.trim(); const err=$d("#p-err");
    if(!nome){ err.textContent="Escreva seu nome."; err.hidden=false; $d("#p-nome").focus(); return; }
    const data=cleanProfile({nome, insta:$d("#p-insta").value, cidade:$d("#p-cidade").value, bio:$d("#p-bio").value, paises, foto:me.foto, avatar:newAvatar, cidades, proximo:$d("#p-prox").value});
    if(!C.me) data.criadoEm=TS();
    if(!newAvatar && me.avatar) data.avatar=firebase.firestore.FieldValue.delete();
    if(!data.cidades && cidadesOf(me).length) data.cidades=firebase.firestore.FieldValue.delete();
    if(!data.proximo && me.proximo) data.proximo=firebase.firestore.FieldValue.delete();
    const btn=$d("#p-save"); btn.disabled=true; btn.textContent="Salvando…"; err.hidden=true;
    try{
      await timed(db.collection("profiles").doc(C.user.uid).set(data,{merge:true}));
      const back = await timed(db.collection("profiles").doc(C.user.uid).get({source:"server"}));
      if(!back.exists || back.data().nome!==data.nome) throw {code:"not-saved"};
      if(nome!==C.user.displayName) C.user.updateProfile({displayName:nome}).catch(()=>{});
      C.profiles[C.user.uid]=Object.assign({id:C.user.uid},C.me||{},data,{avatar:newAvatar||"", cidades:data.cidades&&data.cidades.length!==undefined?data.cidades:[], proximo:typeof data.proximo==="string"?data.proximo:""});
      C.pmapAnim=true;
      close(); toast("Perfil salvo"); L.render();
    }catch(x){ dbError(x,"salvar o perfil"); err.textContent=C.lastError; err.hidden=false; btn.disabled=false; btn.textContent="Salvar"; }
  };
  if(typeof dlg.showModal==="function"){ try{ dlg.showModal(); }catch(e){ dlg.setAttribute("open",""); dlg.classList.add("no-modal"); } } else { dlg.setAttribute("open",""); dlg.classList.add("no-modal"); }
}
async function runDiag(){
  const out=[]; const line=(ok,t)=>out.push(`<li class="${ok?"ok":"bad"}">${ok?"✓":"✗"} ${esc(t)}</li>`);
  const show=()=>{ C.diag=`<strong>Diagnóstico</strong><ul>${out.join("")}</ul><span class="tiny">Projeto ${esc(CFG.projectId)} · ${esc(new Date().toLocaleString("pt-BR"))}</span>`; const b=document.getElementById("diag-box"); if(b) b.innerHTML=C.diag; };
  out.push(`<li>Testando…</li>`); show(); out.length=0;
  const u=C.user;
  line(!!u, u ? `Conta conectada (${u.providerData.map(p=>p.providerId).join(", ")||"e-mail"}), e-mail ${u.emailVerified?"confirmado":"NÃO confirmado"}` : "Nenhuma conta conectada");
  const code=e=>(e&&e.code)||String(e&&e.message||e);
  try{ const q=await timed(db.collection("admins").get({source:"server"}),10000); line(true,`Leitura do banco funcionando (${q.size} autor${q.size===1?"":"es"} cadastrado${q.size===1?"":"s"})`); if(u) line(q.docs.some(d=>d.id===u.uid), q.docs.some(d=>d.id===u.uid)?"Você tem o selo Autor":`Você ainda não tem o selo Autor (seu UID: ${u.uid})`); }
  catch(e){ line(false,`Leitura do banco falhou: ${code(e)}`); }
  if(u){
    const ref=db.collection("profiles").doc(u.uid);
    try{ const d=await timed(ref.get({source:"server"}),10000); line(d.exists, d.exists?`Seu perfil existe no servidor (nome: ${d.data().nome})`:"Seu perfil NÃO existe no servidor"); }
    catch(e){ line(false,`Leitura do seu perfil falhou: ${code(e)}`); }
    try{
      const cur=(C.me&&C.me.nome)||u.displayName||"Viajante";
      await timed(ref.set(cleanProfile(Object.assign({}, C.me||{nome:cur,paises:[]}, {nome:cur})),{merge:true}),10000);
      const d=await timed(ref.get({source:"server"}),10000);
      line(d.exists,"Gravação de teste no perfil confirmada pelo servidor");
    }catch(e){ line(false,`Gravação no perfil falhou: ${code(e)}`); }
  }
  show();
}
async function deleteAccount(btn){
  if(!btn.dataset.confirm){ btn.dataset.confirm=1; btn.textContent="Toque de novo para excluir sua conta, seus comentários e seus salvos. Não dá para desfazer."; return; }
  const uid=C.user.uid; btn.disabled=true;
  try{
    const qs=await Promise.all([db.collection("fotos").where("uid","==",uid).get(), db.collection("posts").where("uid","==",uid).get(), db.collection("comments").where("uid","==",uid).get(), db.collection("follows").where("from","==",uid).get(), db.collection("follows").where("to","==",uid).get(), db.collection("users").doc(uid).collection("salvos").get()]);
    const refs=[].concat(...qs.map(q=>q.docs.map(d=>d.ref)));
    // viagens: quem organiza e está sozinho apaga; com mais gente, passa a organização adiante
    const ts=await db.collection("viagens").where("membros","array-contains",uid).get();
    for(const d of ts.docs){ const t=d.data(); const rest=(t.membros||[]).filter(x=>x!==uid);
      if(t.dono===uid && !rest.length){ const ds=await d.ref.collection("dias").get(); for(const x of ds.docs) await x.ref.delete(); await d.ref.delete(); }
      else if(t.dono===uid){ await d.ref.update({dono:rest[0], membros:rest, atualizadaEm:TS()}); }
      else await d.ref.update({membros:FV().arrayRemove(uid), atualizadaEm:TS()}); }
    const cv=await Promise.all([db.collection("convites").where("de","==",uid).get(), db.collection("convites").where("para","==",uid).get()]);
    cv.forEach(q=>q.docs.forEach(d=>refs.push(d.ref)));
    for(let i=0;i<refs.length;i+=400){ const b=db.batch(); refs.slice(i,i+400).forEach(r=>b.delete(r)); await b.commit(); }
    await db.collection("profiles").doc(uid).delete();
    await C.user.delete();
    toast("Sua conta foi excluída."); C.perfilUid=null; L.go("inicio");
  }catch(e){ btn.disabled=false; authError(e); }
}

/* ---------- Privacidade ---------- */
function vPrivacidade(){
  return `<section class="band"><div class="wrap" style="max-width:720px">
    <p class="eyebrow">Privacidade</p><h1 class="h1">Seus dados na comunidade.</h1>
    <div class="gsec" style="margin-top:28px"><ul>
      <li><strong>O que guardamos:</strong> seu nome, e-mail (só para login), foto do Google se você entrar com Google, e o que você coloca no perfil (incluindo os países, as cidades e o próximo destino que você marcar), nas publicações e nos comentários.</li>
      <li><strong>Quem vê:</strong> nome, foto, perfil, publicações, comentários e quem você segue ficam visíveis para quem acessa o site. Seu e-mail e seus salvos não aparecem para ninguém.</li>
      <li><strong>Viagens:</strong> uma viagem pública pode ser vista por todos; uma viagem só para participantes fica visível apenas para quem foi convidado e aceitou. Só participantes editam.</li>
      <li><strong>Check-in:</strong> só é salvo quando você publica um. Guardamos a cidade e as coordenadas do centro dela, nunca a sua posição exata.</li>
      <li><strong>Onde fica:</strong> no Firebase, serviço do Google, usado para login e banco de dados.</li>
      <li><strong>Para que usamos:</strong> só para a comunidade funcionar. Não vendemos nem compartilhamos seus dados.</li>
      <li><strong>Como apagar:</strong> no seu perfil, toque em "Excluir minha conta". Isso apaga a conta, os comentários, os salvos e quem você segue.</li>
      <li><strong>Moderação:</strong> Gustavo e Priscila podem apagar comentários ofensivos ou spam.</li>
    </ul></div>
    <p style="margin-top:24px"><button class="btn secondary" type="button" onclick="history.length>1?history.back():LAT53.go('comunidade')">Voltar</button></p>
  </div></section>`;
}
})();
