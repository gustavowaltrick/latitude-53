#!/usr/bin/env python3
"""Gera data.js (versão pública) a partir da exportação do banco do site privado.

Uso:  python3 build/build.py <pasta_exportada> [<pasta_com_fotos>]
A pasta exportada tem as subpastas dias/, itens/, lugares/, guia/ e config/site.json,
no formato salvo pelo ArtifactData (out_dir). A pasta de fotos tem <asset_id>.jpg/png/webp.
Só entram roteiro, mapa e guia: custos, reservas, checklists e gravações nunca são lidos.
O único dado de custo é o resumo por categoria que o próprio site privado grava em config/site
(resumoCustos), e ele só sai quando custosPublico está ligado.
Sai com código 0 e imprime CHANGED ou UNCHANGED.
"""
import json, glob, os, sys, shutil, hashlib, datetime
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = sys.argv[1]; fotos_src = sys.argv[2] if len(sys.argv) > 2 else None

def body(f):
    d = json.load(open(f, encoding="utf-8"))
    if isinstance(d, dict) and isinstance(d.get("data"), dict) and "version" in d: d = d["data"]
    return d

def load(col):
    out = []
    for f in sorted(glob.glob(os.path.join(src, col, "*.json"))):
        d = body(f); d["id"] = os.path.basename(f)[:-5]; out.append(d)
    return out

site = body(os.path.join(src, "config", "site.json")) if os.path.exists(os.path.join(src, "config", "site.json")) else {}
capa = site.pop("capaId", None)
if capa and fotos_src:
    for ext in ("jpg", "png", "webp"):
        p = os.path.join(fotos_src, f"{capa}.{ext}")
        if os.path.exists(p): shutil.copy(p, os.path.join(ROOT, "capa.jpg" if ext == "jpg" else f"capa.{ext}")); site["capaData"] = "capa.jpg" if ext == "jpg" else f"capa.{ext}"; break
site.setdefault("capaData", "capa.jpg")
# "Quanto custou de verdade": só sai o resumo por categoria, e só se os donos ligaram no site privado
if site.get("custosPublico") and isinstance(site.get("resumoCustos"), dict):
    r = site["resumoCustos"]
    def n(v):
        try: return round(float(v), 2)
        except Exception: return 0
    site["resumoCustos"] = {"cambio": n(r.get("cambio")) or 6.3, "em": str(r.get("em") or "")[:10],
        "cats": [{"c": str(c.get("c", ""))[:40], "p": n(c.get("p")), "g": n(c.get("g"))} for c in (r.get("cats") or []) if isinstance(c, dict)][:12]}
else:
    site.pop("resumoCustos", None); site.pop("custosPublico", None)

lugares, seen = [], set()
os.makedirs(os.path.join(ROOT, "fotos"), exist_ok=True)
for l in load("lugares"):
    k = (l.get("paisA2"), (l.get("cidade") or "").strip().lower(), (l.get("estado") or "").strip().lower())
    if k in seen: continue
    seen.add(k)
    ids = l.get("fotos") or []; l["fotos"] = []; l["fotosData"] = []
    for aid in ids:
        if not fotos_src: continue
        for ext in ("jpg", "png", "webp"):
            p = os.path.join(fotos_src, f"{aid}.{ext}")
            if os.path.exists(p):
                shutil.copy(p, os.path.join(ROOT, "fotos", f"{aid}.{ext}"))
                l["fotos"].append(aid); l["fotosData"].append(f"fotos/{aid}.{ext}"); break
    lugares.append(l)

pub = {"site": site, "dias": load("dias"), "itens": load("itens"), "lugares": lugares, "guia": load("guia")}
for k in ("custos", "reservas", "checklists", "takes", "privado"): pub.pop(k, None)
txt = "window.__PUBLIC__=" + json.dumps(pub, ensure_ascii=False, sort_keys=True).replace("</", "<\\/") + ";"
dp = os.path.join(ROOT, "data.js")
old = open(dp, encoding="utf-8").read() if os.path.exists(dp) else ""
if old == txt:
    print("UNCHANGED"); sys.exit(0)
open(dp, "w", encoding="utf-8").write(txt)
# nova versão do cache offline para os celulares baixarem a atualização
sw = os.path.join(ROOT, "sw.js"); s = open(sw, encoding="utf-8").read()
ver = "lat53-" + datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d%H%M") + "-" + hashlib.sha1(txt.encode()).hexdigest()[:6]
import re
s = re.sub(r'const VERSAO="[^"]*";', f'const VERSAO="{ver}";', s)
open(sw, "w", encoding="utf-8").write(s)
print("CHANGED", ver, "dias", len(pub["dias"]), "itens", len(pub["itens"]), "lugares", len(lugares))
