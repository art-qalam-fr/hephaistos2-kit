#!/usr/bin/env bash
# Mirror art-qalam (origin) state onto art-qalam-fr (temporaire) remote.
# - All origin/* branches -> temporaire heads (force)
# - Local-only branches (not on origin) -> temporaire heads (force)
# - All tags -> temporaire (force)
# Shared branch names: origin (art-qalam) version wins.
set -u

DIRS=(
"C:/Program Files/servers/filesystem"
"C:/Program Files/servers/google-drive"
"C:/Program Files/servers/kaggle-mcp"
"C:/Program Files/servers/mcp-quick-sqlite3"
"%USERPROFILE%/AppData/Local/hermes/mcp-servers/model-discovery"
"C:/Program Files/servers/orchestrator-server"
"C:/Program Files/servers/zvec-mcp-server"
"C:/Program Files/servers/qdrant-mcp-server"
"C:/Program Files/servers/mcp-mux"
"C:/Program Files/servers/puppeteer-repo"
"F:/tools-local/agentMemory"
"F:/tools-local/nim-router-mcp"
"F:/tools-local/opencli-cookies"
"F:/tools-local/beacon-mcp"
"F:/tools-local/Hephaistos-Kit"
)

for dir in "${DIRS[@]}"; do
  echo "=== ${dir##*/} ==="
  GIT_TERMINAL_PROMPT=0 git -C "$dir" fetch origin --tags --prune 2>&1 | tail -2 | sed 's/^/  fetch: /'

  declare -A seen=()
  specs=()
  while read -r ref; do
    short="${ref#refs/remotes/origin/}"
    [ "$short" = "HEAD" ] && continue
    specs+=("$ref:refs/heads/$short")
    seen[$short]=1
  done < <(git -C "$dir" for-each-ref --format='%(refname)' refs/remotes/origin)

  while read -r ref; do
    short="${ref#refs/heads/}"
    if [ -n "${seen[$short]:-}" ]; then
      echo "  local-only-skip (origin wins): $short"
      continue
    fi
    specs+=("$ref:refs/heads/$short")
    echo "  +local-branch: $short"
  done < <(git -C "$dir" for-each-ref --format='%(refname)' refs/heads)

  if [ ${#specs[@]} -gt 0 ]; then
    GIT_TERMINAL_PROMPT=0 git -C "$dir" push temporaire --force "${specs[@]}" 2>&1 | tail -8 | sed 's/^/  push: /'
  fi
  if [ -n "$(git -C "$dir" tag -l)" ]; then
    GIT_TERMINAL_PROMPT=0 git -C "$dir" push temporaire --force 'refs/tags/*:refs/tags/*' 2>&1 | tail -3 | sed 's/^/  tags: /'
  fi
  unset seen specs
done
