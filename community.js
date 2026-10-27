/* Latitude 53 — comunidade (Firebase Auth + Firestore).
   Fica desligada enquanto window.FIREBASE_CONFIG não estiver preenchido em firebase-config.js. */
(function(){
"use strict";
const L = window.LAT53;
const CFG = window.FIREBASE_CONFIG;
if(!L || !CFG || !CFG.apiKey) return;

const SDK = "https://www.gstatic.com/firebasejs/10.14.1/";
const C = {
  ready:false, user:null, verified:false, me:null, admins:new Set(),
  comments:[], byTarget:{}, profiles:{}, following:new Set(), saved:{},
  open:new Set(), perfilUid:null, filtro:"todos", members:null, unsub:[]
};
let fb=null, auth=null, db=null;
const esc=L.esc, toast=L.toast;
const TS = () => firebase.firestore.FieldValue.serverTimestamp();
function timed(p, ms){ return Promise.race([p, new Promise((_,rej)=>setTimeout(()=>rej({code:"timeout"}), ms||12000))]); }
function dbError(e, what){
  const code = e && e.code;
  const msg = code==="permission-denied" ? `Sem permissão para ${what}. Confira se as regras do Firestore foram publicadas.`
    : code==="timeout" || code==="unavailable" ? `Não consegui falar com o banco de dados para ${what}. Confira a internet; se continuar, o banco Firestore pode não ter sido criado.`
    : code==="not-found" ? `Banco de dados não encontrado ao ${what}. Confira se o Firestore foi criado como "(default)".`
    : `Não deu para ${what}${code?" ("+code+")":""}.`;
  toast(msg); C.lastError = msg + (code?" ["+code+"]":"");
  return false;
}

/* ---------- views are registered right away so links like #comunidade work ---------- */
L.addView("comunidade","Comunidade",vComunidade,{after:"guia"});
L.addView("perfil","Perfil",vPerfil,{hidden:true});
L.addView("privacidade","Privacidade",vPrivacidade,{hidden:true});
L.addNav(navChip);
L.onAfterRender(decorate);

/* ---------- load the Firebase SDK, then start ---------- */
function load(src){ return new Promise((res,rej)=>{ const s=document.createElement("script"); s.src=SDK+src; s.onload=res; s.onerror=()=>rej(new Error("Não carregou "+src)); document.head.appendChild(s); }); }
load("firebase-app-compat.js").then(()=>Promise.all([load("firebase-auth-compat.js"),load("firebase-firestore-compat.js")])).then(start).catch(()=>{ C.failed=true; L.render(); });

function start(){
  fb = firebase.initializeApp(CFG);
  auth = firebase.auth(); auth.languageCode = "pt";
  db = firebase.firestore();
  C.ready = true;
  db.collection("admins").get().then(q=>{ C.admins=new Set(q.docs.map(d=>d.id)); refresh(); }).catch(()=>{});
  db.collection("comments").orderBy("em","desc").limit(300).onSnapshot(q=>{
    C.comments = q.docs.map(d=>Object.assign({id:d.id},d.data()));
    C.byTarget = {}; C.comments.forEach(c=>{ (C.byTarget[c.alvo]=C.byTarget[c.alvo]||[]).push(c); });
    want(C.comments.map(c=>c.uid)); refresh();
  },()=>{});
  auth.getRedirectResult().catch(e=>authError(e));
  auth.onAuthStateChanged(async u=>{
    C.unsub.forEach(f=>f()); C.unsub=[]; C.user=u; C.me=null; C.following=new Set(); C.saved={};
    if(u){
      C.verified = !!u.emailVerified;
      const ref=db.collection("profiles").doc(u.uid);
      try{
        const snap=await ref.get();
        if(!snap.exists){ await timed(ref.set(cleanProfile({nome:u.displayName||(u.email||"").split("@")[0], foto:googlePhoto(u), insta:"", cidade:"", bio:"", paises:[], criadoEm:TS()}))); }
      }catch(e){ dbError(e,"criar seu perfil"); }
      C.unsub.push(ref.onSnapshot(s=>{ C.me=s.exists?Object.assign({id:u.uid},s.data()):null; if(C.me){ C.profiles[u.uid]=C.me; if(C.members){ const i=C.members.findIndex(m=>m.id===u.uid); if(i>=0) C.members[i]=C.me; else C.members.unshift(C.me); } } L.render(); },()=>{}));
      C.unsub.push(db.collection("follows").where("from","==",u.uid).onSnapshot(q=>{ C.following=new Set(q.docs.map(d=>d.data().to)); refresh(); },()=>{}));
      C.unsub.push(db.collection("users").doc(u.uid).collection("salvos").onSnapshot(q=>{ C.saved={}; q.docs.forEach(d=>C.saved[d.id]=d.data()); refresh(); },()=>{}));
    }
    L.render();
  });
}

/* ---------- helpers ---------- */
function googlePhoto(u){ const p=(u.providerData||[]).find(x=>x.providerId==="google.com"); const url=(p&&p.photoURL)||u.photoURL||""; return /^https:\/\/[a-z0-9.-]*googleusercontent\.com\//i.test(url)?url:""; }
function cleanProfile(p){
  const o={};
  o.nome=String(p.nome||"").trim().slice(0,60)||"Viajante";
  o.insta=String(p.insta||"").replace(/^@/,"").replace(/[^A-Za-z0-9._]/g,"").slice(0,30);
  o.cidade=String(p.cidade||"").trim().slice(0,60);
  o.bio=String(p.bio||"").trim().slice(0,280);
  o.paises=(p.paises||[]).filter(a=>/^[A-Z]{2}$/.test(a)).slice(0,200);
  o.foto=p.foto&&/^https:\/\/[a-z0-9.-]*googleusercontent\.com\//i.test(p.foto)?p.foto:"";
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
  if(p.foto) return `<span class="av" style="--s:${size||36}px"><img src="${esc(p.foto)}" alt="" referrerpolicy="no-referrer"></span>`;
  return `<span class="av" style="--s:${size||36}px;--h:${hue}">${esc(ini)}</span>`;
}
const badge = uid => C.admins.has(uid) ? `<span class="badge-autor">Autor</span>` : "";
function when(ts){ const d=ts&&ts.toDate?ts.toDate():null; if(!d) return "agora"; const s=(Date.now()-d)/1000;
  if(s<60) return "agora"; if(s<3600) return Math.floor(s/60)+" min"; if(s<86400) return Math.floor(s/3600)+" h"; if(s<604800) return Math.floor(s/86400)+" d";
  return d.toLocaleDateString("pt-BR",{day:"numeric",month:"short"}); }
function refresh(){ decorate(false); if(["comunidade","perfil"].includes(L.S.view)) L.render(); }
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
  if(!C.ready) return "";
  if(!C.user) return `<button type="button" class="pill-btn" id="c-entrar">Entrar</button>`;
  return `<button type="button" class="icon-btn c-me" id="c-me" aria-label="Meu perfil">${avatar(C.user.uid,28)}</button>`;
}

/* ---------- decorations on days and places ---------- */
function decorate(){
  const ent=document.getElementById("c-entrar"); if(ent && !ent.dataset.b){ ent.dataset.b=1; ent.onclick=()=>authSheet("entrar"); }
  const me=document.getElementById("c-me"); if(me && !me.dataset.b){ me.dataset.b=1; me.onclick=()=>{ C.perfilUid=C.user.uid; L.go("perfil"); }; }
  if(!C.ready) return;
  document.querySelectorAll("[data-day],[data-place]").forEach(card=>{
    const alvo = card.dataset.day ? "dia:"+card.dataset.day : "lugar:"+card.dataset.place;
    const titulo = card.dataset.title||"";
    const host = card.dataset.day ? (card.querySelector(".day-body")||card) : card;
    let bar = host.querySelector(":scope > .social");
    const list = C.byTarget[alvo]||[];
    const saved = !!C.saved[alvo.replace(":","_")];
    const html = `<div class="social-row">
        <button type="button" class="soc-btn" data-c-open aria-expanded="${C.open.has(alvo)}">${icon.chat}<span>${list.length?list.length+" "+(list.length===1?"comentário":"comentários"):"Comentar"}</span></button>
        <button type="button" class="soc-btn ${saved?"on":""}" data-c-save aria-pressed="${saved}">${saved?icon.starOn:icon.star}<span>${saved?"Salvo":"Salvar"}</span></button>
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
  try{ if(C.saved[id]){ await timed(ref.delete()); toast("Removido dos salvos"); } else { await timed(ref.set({alvo, titulo:String(titulo).slice(0,120), em:TS()})); toast("Salvo"); } }catch(e){ dbError(e,"salvar"); }
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
  const members = (C.members||[]).slice().sort((a,b)=>(C.admins.has(b.id)-C.admins.has(a.id)));
  setTimeout(bindCommunity,0);
  return `<section class="band"><div class="wrap">
    <div class="head-row"><div><p class="eyebrow">Comunidade</p><h1 class="h1">Quem vem junto.</h1><p class="lead">Gente que acompanha a mudança, comenta os lugares e troca dicas de viagem.</p></div>
    ${C.user?`<div class="actions"><button class="btn secondary" type="button" data-go-me>Meu perfil</button></div>`:`<div class="actions"><button class="btn" type="button" data-login>Criar conta ou entrar</button></div>`}</div>

    <h2 class="h3" style="margin-bottom:14px">Membros</h2>
    ${C.members===null?`<p class="muted small">Carregando membros…</p>`:members.length?`<div class="members">${members.map(m=>`<div class="member">
        <button type="button" class="m-open" data-profile="${esc(m.id)}">${avatar(m.id,52)}<span class="m-name">${esc(m.nome||"Viajante")} ${badge(m.id)}</span>
        <span class="tiny">${m.cidade?esc(m.cidade)+" · ":""}${(m.paises||[]).length} ${(m.paises||[]).length===1?"país":"países"}</span></button>
        ${followBtn(m.id)}</div>`).join("")}</div>`:`<div class="empty-state"><p class="h3">Ninguém ainda</p><p class="small">Crie a primeira conta.</p></div>`}

    <div class="head-row" style="margin:48px 0 14px"><h2 class="h3">Atividade recente</h2>
      ${C.user?`<div class="segbar" role="group" aria-label="Filtrar atividade" style="margin:0"><button type="button" data-filtro="todos" aria-pressed="${C.filtro!=="seguindo"}">Todos</button><button type="button" data-filtro="seguindo" aria-pressed="${C.filtro==="seguindo"}">Quem eu sigo</button></div>`:""}</div>
    ${feed.length?`<div class="feed">${feed.slice(0,60).map(c=>`<div class="feed-item">
        <button type="button" class="c-av" data-profile="${esc(c.uid)}" aria-label="Perfil">${avatar(c.uid,36)}</button>
        <div class="c-body"><div class="c-meta"><button type="button" class="link-btn c-name" data-profile="${esc(c.uid)}">${esc(nameOf(c.uid,c.nome))}</button>${badge(c.uid)}<span class="tiny">comentou em <button type="button" class="link-btn tiny" data-alvo="${esc(c.alvo)}">${esc(c.alvoTitulo||"um lugar")}</button> · ${esc(when(c.em))}</span></div>
        <div class="c-text">${esc(c.texto)}</div></div></div>`).join("")}</div>`
      :`<div class="empty-state"><p class="h3">${C.filtro==="seguindo"?"Quem você segue ainda não comentou":"Nenhum comentário ainda"}</p><p class="small">Abra um dia do Roteiro ou um lugar do Mapa e toque em Comentar.</p></div>`}
  </div></section>`;
}
function bindCommunity(){
  const v=document.getElementById("view"); if(!v || v.dataset.cb===L.S.view) return; v.dataset.cb=L.S.view;
  v.addEventListener("click",async e=>{
    if(!["comunidade","perfil","privacidade"].includes(L.S.view)) return;
    const pf=e.target.closest("[data-profile]"); if(pf){ C.perfilUid=pf.dataset.profile; L.go("perfil"); return; }
    if(e.target.closest("[data-login]")) return authSheet("criar");
    if(e.target.closest("[data-go-me]")){ C.perfilUid=C.user.uid; L.go("perfil"); return; }
    const fl=e.target.closest("[data-filtro]"); if(fl){ C.filtro=fl.dataset.filtro; L.render(); return; }
    const al=e.target.closest("[data-alvo]"); if(al) return goTo(al.dataset.alvo);
    const fw=e.target.closest("[data-follow]"); if(fw) return toggleFollow(fw.dataset.follow);
    if(e.target.closest("[data-edit-me]")) return editProfile();
    if(e.target.closest("[data-logout]")){ await auth.signOut(); toast("Você saiu da conta"); L.go("comunidade"); return; }
    if(e.target.closest("[data-del-account]")) return deleteAccount(e.target.closest("[data-del-account]"));
    if(e.target.closest("[data-verify]")) return resendVerify();
    if(e.target.closest("[data-reload]")){ await C.user.reload(); C.verified=!!auth.currentUser.emailVerified; if(C.verified){ await C.user.getIdToken(true); toast("E-mail confirmado!"); } else toast("Ainda não confirmado. Abra o link do e-mail."); L.render(); return; }
  });
}
// the page re-renders #view; rebind when a community view is shown
L.onAfterRender(()=>{ const v=document.getElementById("view"); if(v && ["comunidade","perfil","privacidade"].includes(L.S.view)){ delete v.dataset.cb; bindCommunity(); } });

function goTo(alvo){
  const [tipo,id]=alvo.split(":"); C.open.add(alvo);
  L.go(tipo==="dia"?"roteiro":"mapa");
  setTimeout(()=>{ const el=document.querySelector(tipo==="dia"?`[data-day="${CSS.escape(id)}"]`:`[data-place="${CSS.escape(id)}"]`); if(el){ el.scrollIntoView({behavior:L.reduceMotion()?"auto":"smooth",block:"center"}); el.classList.add("flash"); setTimeout(()=>el.classList.remove("flash"),1600); } },400);
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
  loadFollowCounts(uid);
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
        <div class="ph-stats"><span><b class="num">${fc?fc.seguidores:"–"}</b> ${fc&&fc.seguidores===1?"seguidor":"seguidores"}</span><span><b class="num">${fc?fc.seguindo:"–"}</b> seguindo</span><span><b class="num">${(p&&p.paises||[]).length}</b> ${(p&&p.paises||[]).length===1?"país":"países"}</span></div>
        <div class="actions" style="margin-top:16px">${mine?`<button class="btn secondary" type="button" data-edit-me>Editar perfil</button><button class="btn plain" type="button" data-logout>Sair</button>`:followBtn(uid)}</div>
      </div>
    </div>
    ${mine && C.lastError?`<div class="verify-box"><strong>Algo não funcionou</strong><span class="small">${esc(C.lastError)}</span></div>`:""}
    ${mine && !C.verified?`<div class="verify-box"><strong>Confirme seu e-mail</strong><span class="small">Enviamos um link para ${esc(C.user.email||"")}. Depois de abrir, toque em "Já confirmei".</span><div class="actions"><button class="btn" type="button" data-reload>Já confirmei</button><button class="btn plain" type="button" data-verify>Reenviar</button></div></div>`:""}
    ${(p&&p.paises||[]).length?`<h2 class="h3 hoje-h">Países que já visitou</h2><div class="chips">${p.paises.map(a=>`<span class="chip"><span class="flag">${L.flag(a)}</span> ${esc(L.countryName(a))}</span>`).join("")}</div>`:""}
    ${mine?`<h2 class="h3 hoje-h">Salvos</h2>${salvos.length?`<div class="feed">${salvos.map(s=>`<div class="feed-item"><div class="c-body"><button type="button" class="link-btn" data-alvo="${esc(s.alvo)}">${esc(s.titulo||s.alvo)}</button><span class="tiny"> · ${s.alvo.startsWith("dia:")?"Roteiro":"Mapa"}</span></div></div>`).join("")}</div>`:`<p class="small muted">Toque em Salvar num dia do Roteiro ou num lugar do Mapa para guardar aqui.</p>`}`:""}
    <h2 class="h3 hoje-h">Comentários</h2>
    ${seus.length?`<div class="feed">${seus.map(c=>`<div class="feed-item"><div class="c-body"><div class="c-meta"><span class="tiny">em <button type="button" class="link-btn tiny" data-alvo="${esc(c.alvo)}">${esc(c.alvoTitulo||"um lugar")}</button> · ${esc(when(c.em))}</span></div><div class="c-text">${esc(c.texto)}</div></div></div>`).join("")}</div>`:`<p class="small muted">Nenhum comentário ainda.</p>`}
    ${mine?`<p style="margin-top:56px" class="tiny"><button type="button" class="link-btn tiny" data-del-account>Excluir minha conta</button> · <button type="button" class="link-btn tiny" onclick="LAT53.go('privacidade')">Privacidade</button></p>`:""}
  </div></section>`;
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
  let paises=(me.paises||[]).slice();
  const all=L.countryOptions().filter(o=>o[0]);
  const dlg=document.createElement("dialog"); dlg.className="sheet profile-sheet";
  dlg.innerHTML=`<form method="dialog" novalidate><header><h2 class="h3">Editar perfil</h2><button type="button" class="icon-btn" data-x aria-label="Fechar">✕</button></header>
    <div class="body">
      <div class="field"><label for="p-nome">Nome</label><input type="text" id="p-nome" maxlength="60" autocomplete="name" value="${esc(me.nome||"")}"></div>
      <div class="row2">
        <div class="field"><label for="p-insta">Instagram</label><input type="text" id="p-insta" maxlength="31" autocapitalize="off" spellcheck="false" placeholder="seu.perfil" value="${esc(me.insta||"")}"></div>
        <div class="field"><label for="p-cidade">Onde mora</label><input type="text" id="p-cidade" maxlength="60" placeholder="Salvador, BA" value="${esc(me.cidade||"")}"></div>
      </div>
      <div class="field"><label for="p-bio">Sobre você</label><textarea id="p-bio" maxlength="280" rows="3" placeholder="Uma frase sobre você ou suas viagens">${esc(me.bio||"")}</textarea><span class="help"><span id="p-bio-n">${(me.bio||"").length}</span>/280</span></div>
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
  $d("#p-list").addEventListener("click",e=>{ const b=e.target.closest("[data-a]"); if(!b) return; const a=b.dataset.a;
    paises = paises.includes(a) ? paises.filter(x=>x!==a) : paises.concat(a);
    b.setAttribute("aria-selected",paises.includes(a)); b.querySelector(".ck").textContent=paises.includes(a)?"✓":""; drawSel(); });
  $d("#p-sel").addEventListener("click",e=>{ const b=e.target.closest("[data-rm]"); if(!b) return; paises=paises.filter(x=>x!==b.dataset.rm); drawSel(); drawList(); });
  $d("form").onsubmit=async e=>{
    e.preventDefault();
    const nome=$d("#p-nome").value.trim(); const err=$d("#p-err");
    if(!nome){ err.textContent="Escreva seu nome."; err.hidden=false; $d("#p-nome").focus(); return; }
    const data=cleanProfile({nome, insta:$d("#p-insta").value, cidade:$d("#p-cidade").value, bio:$d("#p-bio").value, paises, foto:me.foto});
    if(!C.me) data.criadoEm=TS();
    const btn=$d("#p-save"); btn.disabled=true; btn.textContent="Salvando…"; err.hidden=true;
    try{
      await timed(db.collection("profiles").doc(C.user.uid).set(data,{merge:true}));
      if(nome!==C.user.displayName) C.user.updateProfile({displayName:nome}).catch(()=>{});
      C.profiles[C.user.uid]=Object.assign({id:C.user.uid},C.me||{},data);
      close(); toast("Perfil salvo"); L.render();
    }catch(x){ dbError(x,"salvar o perfil"); err.textContent=C.lastError; err.hidden=false; btn.disabled=false; btn.textContent="Salvar"; }
  };
  if(typeof dlg.showModal==="function"){ try{ dlg.showModal(); }catch(e){ dlg.setAttribute("open",""); dlg.classList.add("no-modal"); } } else { dlg.setAttribute("open",""); dlg.classList.add("no-modal"); }
}
async function deleteAccount(btn){
  if(!btn.dataset.confirm){ btn.dataset.confirm=1; btn.textContent="Toque de novo para excluir sua conta, seus comentários e seus salvos. Não dá para desfazer."; return; }
  const uid=C.user.uid; btn.disabled=true;
  try{
    const qs=await Promise.all([db.collection("comments").where("uid","==",uid).get(), db.collection("follows").where("from","==",uid).get(), db.collection("follows").where("to","==",uid).get(), db.collection("users").doc(uid).collection("salvos").get()]);
    const refs=[].concat(...qs.map(q=>q.docs.map(d=>d.ref)));
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
      <li><strong>O que guardamos:</strong> seu nome, e-mail (só para login), foto do Google se você entrar com Google, e o que você escreve no perfil e nos comentários.</li>
      <li><strong>Quem vê:</strong> nome, foto, perfil, comentários e quem você segue ficam visíveis para quem acessa o site. Seu e-mail e seus salvos não aparecem para ninguém.</li>
      <li><strong>Onde fica:</strong> no Firebase, serviço do Google, usado para login e banco de dados.</li>
      <li><strong>Para que usamos:</strong> só para a comunidade funcionar. Não vendemos nem compartilhamos seus dados.</li>
      <li><strong>Como apagar:</strong> no seu perfil, toque em "Excluir minha conta". Isso apaga a conta, os comentários, os salvos e quem você segue.</li>
      <li><strong>Moderação:</strong> Gustavo e Priscila podem apagar comentários ofensivos ou spam.</li>
    </ul></div>
    <p style="margin-top:24px"><button class="btn secondary" type="button" onclick="history.length>1?history.back():LAT53.go('comunidade')">Voltar</button></p>
  </div></section>`;
}
})();
