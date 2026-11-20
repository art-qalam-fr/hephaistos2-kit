#!/usr/bin/env python3
"""Compile les rapports de dysfonctionnement du vault en base publique de bugs connus.

Source : "Rapport de dysfonctionnement et correction/*.md"
Sortie : "Rapport de dysfonctionnement et correction/public/known-issues.json"
         "Rapport de dysfonctionnement et correction/public/KNOWN-ISSUES.md"

Seul le repertoire public/ est expose a l'agent du canal Telegram — jamais le
vault brut. La sanitisation retire chemins machine, identifiants, secrets,
noms propres internes et donnees personnelles.
"""
import json, os, re, sys
from pathlib import Path

ROOT = Path(os.environ.get("HEPHAISTOS_ROOT") or Path(__file__).resolve().parents[2])
SRC = ROOT / "Rapport de dysfonctionnement et correction"
OUT = SRC / "public"
MAX_SECTION = 700

def sanitize(text: str) -> str:
    t = text
    # chemins machine Windows / UNC / posix absolus
    t = re.sub(r"[A-Za-z]:\\[^\s\"'`)\]]+", "<chemin>", t)
    t = re.sub(r"\\\\[^\s\"'`)\]]+", "<chemin>", t)
    t = re.sub(r"/(?:home|mnt|opt|usr|var)/[^\s\"'`)\]]+", "<chemin>", t)
    # emails
    t = re.sub(r"[\w.+-]+@[\w-]+\.[\w.-]+", "<email>", t)
    # tokens / cles / longs ids hex ou base64-ish
    t = re.sub(r"\b[A-Za-z0-9_+/-]{40,}={0,2}\b", "<id>", t)
    t = re.sub(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", "<uuid>", t, flags=re.I)
    # ids telegram / chat
    t = re.sub(r"-100\d{9,}", "<chat>", t)
    t = re.sub(r"\b\d{9,11}\b", "<id>", t)
    # noms propres internes / personnels
    for pat, rep in [
        (r"\bIbn(?:\s+lascard)?\b", "<utilisateur>"),
        (r"\blascard\w*\b", "<utilisateur>"),
        (r"\bWebman\b", "<utilisateur>"),
        (r"\bMichel\b", "<personne>"),
        (r"\bChevalier\b", "<personne>"),
        (r"\bTango\b", "agent-AGY"),
        (r"\bCash\b", "agent-Devin"),
        (r"\bBoss\b", "l'utilisateur"),
    ]:
        t = re.sub(pat, rep, t, flags=re.I)
    # IPs non loopback
    t = re.sub(r"\b(?!127\.0\.0\.1)(?:\d{1,3}\.){3}\d{1,3}\b", "<ip>", t)
    return t

def clip(s: str, n: int = MAX_SECTION) -> str:
    s = s.strip()
    return s[:n].rsplit(" ", 1)[0] + "…" if len(s) > n else s

def extract_sections(md: str):
    """Retourne {titre, symptome, cause, correction} a partir d'un rapport."""
    title = ""
    m = re.search(r"^#\s+(.+)$", md, flags=re.M)
    if m:
        title = m.group(1).strip()
    secs = {}
    # decoupe par titres ## 
    parts = re.split(r"^##\s+", md, flags=re.M)
    for p in parts[1:]:
        head, _, body = p.partition("\n")
        key = head.strip().lower()
        if re.search(r"sympt[oô]me|symptom", key):
            secs["symptome"] = body.strip()
        elif re.search(r"cause", key):
            secs["cause"] = body.strip()
        elif re.search(r"correction|fix|solution|r[eé]solution|contournement|workaround", key):
            secs.setdefault("correction", body.strip())
    return title, secs

def main():
    OUT.mkdir(parents=True, exist_ok=True)
    reports = []
    for f in sorted(SRC.glob("*.md")):
        if f.name.startswith("INDEX") or f.parent.name == "public":
            continue
        md = f.read_text(encoding="utf-8", errors="replace")
        title, secs = extract_sections(md)
        if not secs.get("symptome"):
            continue
        reports.append({
            "id": f.stem,
            "titre": sanitize(title) or f.stem,
            "symptome": clip(sanitize(secs.get("symptome", ""))),
            "cause": clip(sanitize(secs.get("cause", ""))),
            "correction": clip(sanitize(secs.get("correction", ""))),
        })
    (OUT / "known-issues.json").write_text(json.dumps(reports, ensure_ascii=False, indent=2), encoding="utf-8")
    lines = ["# Bugs connus et corrections — Hephaistos2-Kit",
             "> Compile automatiquement depuis les rapports de dysfonctionnement (sanitise).",
             ""]
    for r in reports:
        lines.append(f"## {r['titre']}")
        lines.append(f"**Symptome** : {r['symptome']}")
        if r["cause"]:
            lines.append(f"**Cause** : {r['cause']}")
        if r["correction"]:
            lines.append(f"**Correction** : {r['correction']}")
        lines.append("")
    (OUT / "KNOWN-ISSUES.md").write_text("\n".join(lines), encoding="utf-8")
    print(f"{len(reports)} rapports compiles -> {OUT}")

if __name__ == "__main__":
    sys.exit(main())
