import sqlite3, sys

DBS = [
    ("GLOBAL",  r"<sqlite-dir>/current_workspace/graph/memory_mcp.db"),
    ("MEMORYF", r"<sqlite-dir>/memory_mcp.db"),
    ("AGENTMEM", r"<sqlite-dir>/current_workspace/agentmemory/graph/memory_mcp.db"),
]

for label, p in DBS:
    print("==", label, "==", p)
    try:
        c = sqlite3.connect("file:" + p + "?mode=ro", uri=True)
    except Exception as e:
        print("  OPEN FAIL", e); continue
    tables = [r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
    print("  tables:", tables)
    for t in ["entities", "observations", "relations", "memories"]:
        if t in tables:
            cols = [(r[1], r[2]) for r in c.execute(f"PRAGMA table_info({t})")]
            print(f"  {t}: {cols}")
    c.close()
