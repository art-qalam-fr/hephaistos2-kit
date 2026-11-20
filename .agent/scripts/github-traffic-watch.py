#!/usr/bin/env python3
"""Archive GitHub traffic stats for the art-qalam-fr public repos.

GitHub only keeps 14 days of traffic data — this appends a daily snapshot
to a permanent JSONL so the history survives.

State: .agent/state/github-traffic.jsonl (one JSON object per run)
Log:   .agent/logs/github-traffic-watch.log
"""
import json, os, subprocess, datetime, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "state", "github-traffic.jsonl")
LOG = os.path.join(ROOT, "logs", "github-traffic-watch.log")
REPOS = ["hephaistos2-kit", "hephaistos2-engine",
         "hephaistos2-search-ext", "hephaistos2-monitor-ext"]
ORG = "art-qalam-fr"

def gh(path):
    r = subprocess.run(["gh", "api", path], capture_output=True, text=True, timeout=30)
    if r.returncode != 0:
        return {"error": r.stderr.strip()[:200]}
    return json.loads(r.stdout)

def log(msg):
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    line = f"{datetime.datetime.now().isoformat(timespec='seconds')} {msg}\n"
    open(LOG, "a", encoding="utf-8").write(line)
    print(line.strip())

def main():
    snap = {"ts": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
            "repos": {}}
    for repo in REPOS:
        base = f"repos/{ORG}/{repo}"
        snap["repos"][repo] = {
            "meta": gh(base + "?fields=stargazers_count,forks_count,subscribers_count"),
            "views": gh(base + "/traffic/views"),
            "clones": gh(base + "/traffic/clones"),
        }
        if repo == "hephaistos2-kit":
            snap["repos"][repo]["referrers"] = gh(base + "/traffic/popular/referrers")
            snap["repos"][repo]["paths"] = gh(base + "/traffic/popular/paths")
            rel = gh(base + "/releases")
            snap["repos"][repo]["release_downloads"] = {
                a["name"]: a.get("download_count", 0)
                for r in (rel if isinstance(rel, list) else [])
                for a in r.get("assets", [])}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "a", encoding="utf-8") as f:
        f.write(json.dumps(snap, ensure_ascii=False) + "\n")
    tot = {r: (d["views"].get("count", 0) if "views" in d and isinstance(d["views"], dict) else "?")
           for r, d in snap["repos"].items()}
    log(f"snapshot archived: {tot}")

if __name__ == "__main__":
    main()
