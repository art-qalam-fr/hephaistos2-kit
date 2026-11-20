#!/usr/bin/env python3
"""Watch for Cognition/Ashby/Devin replies on the gmail account.

Polls `cli-anything-mail` (search + SPAM listing), diffs against a state
file of already-seen message IDs, and alerts via the Moi_Hermes_bot
Telegram bot (cli-anything-telegram) when a new inbound message arrives.

State: .agent/state/cognition-mail-watch.json
Log:   .agent/logs/cognition-mail-watch.log
"""
import json, os, re, shutil, subprocess, sys, datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # .agent/
STATE = os.path.join(ROOT, "state", "cognition-mail-watch.json")
LOG = os.path.join(ROOT, "logs", "cognition-mail-watch.log")
SENDERS = ("ashbyhq.com", "cognition.ai", "cognition.com", "devin.ai", "stripe.com")
ME = os.environ.get("HPHE_MAIL_ME", "")

def cli(name, args, timeout=60):
    exe = shutil.which(name) or os.path.join(
        r"<projets>\CLI-Anything\.venv\Scripts", name + ".exe")
    r = subprocess.run([exe, "--json"] + args, capture_output=True, text=True,
                       timeout=timeout, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        raise RuntimeError(f"{name} rc={r.returncode}: {r.stdout[:200]} {r.stderr[:200]}")
    return json.loads(r.stdout) if r.stdout.strip() else []

def log(msg):
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    line = f"{datetime.datetime.now().isoformat(timespec='seconds')} {msg}\n"
    open(LOG, "a", encoding="utf-8").write(line)
    print(line.strip())

def notify(subject, sender, date, where):
    text = (f"REPONSE COGNITION DETECTEE\n\n"
            f"De: {sender}\nSujet: {subject}\nDate: {date}\nDossier: {where}\n\n"
            f"Verifie {ME or 'la boite mail'}")
    try:
        subprocess.run(
            [shutil.which("cli-anything-telegram") or
             r"<projets>\CLI-Anything\.venv\Scripts\cli-anything-telegram.exe",
             "send", "--text", text],
            capture_output=True, timeout=30)
    except Exception as e:
        log(f"telegram send failed: {e}")

def incoming(msg):
    sender = (msg.get("from") or "").lower()
    return ME not in sender and any(d in sender for d in SENDERS)

def main():
    msgs = {}
    for m in cli("cli-anything-mail", ["search", "--account", "gmail",
                                       "--query", "ashby OR cognition OR devin", "--top", "25"]):
        msgs[m["id"]] = (m, "search")
    try:
        for m in cli("cli-anything-mail", ["inbox", "--account", "gmail",
                                           "--folder", "SPAM", "--top", "25"]):
            if incoming(m):
                msgs.setdefault(m["id"], (m, "SPAM"))
    except Exception as e:
        log(f"spam listing skipped: {e}")

    hits = {mid: v for mid, v in msgs.items() if incoming(v[0])}
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    seen = set(json.load(open(STATE)).get("seen", [])) if os.path.exists(STATE) else None

    if seen is None:  # first run: seed baseline, alert armed
        json.dump({"seen": sorted(hits)}, open(STATE, "w"))
        log(f"baseline seeded: {len(hits)} known messages")
        notify(f"Watcher arme - {len(hits)} msg connus en baseline", "cognition-mail-watch", "-", "INBOX+SPAM")
        return

    new = {mid: v for mid, v in hits.items() if mid not in seen}
    for mid, (m, where) in new.items():
        log(f"NEW {mid} from={m.get('from')} subject={m.get('subject')!r} via={where}")
        notify(m.get("subject", "?"), m.get("from", "?"), m.get("date", "?"), where)
    if new:
        seen |= set(new)
        json.dump({"seen": sorted(seen)}, open(STATE, "w"))
    log(f"scan ok: {len(hits)} watched, {len(new)} new")

if __name__ == "__main__":
    main()
