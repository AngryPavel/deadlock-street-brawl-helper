#!/usr/bin/env bash
# Syncs+builds on the Windows-side copy, then runs scripts/win/demo-main.cjs with real Windows electron.exe:
# opens the demo backdrop + overlay showing a real draft screenshot, screenshots it to logs/win-demo.png, and
# copies that back. See PLAN.md item 4. Usage: npm run win:demo -- [choice1|choice2] (default choice1).
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WIN_COPY="/mnt/c/Users/Jaxon/brawl-helper-win"
WIN_COPY_WIN=$(wslpath -w "$WIN_COPY")

"$(dirname "${BASH_SOURCE[0]}")/sync.sh" || exit 1

CHOICE="${1:-choice1}"

ELECTRON_BIN="node_modules\\.bin\\electron.cmd"
powershell.exe -NoProfile -Command \
  "\$env:Path = 'C:\Program Files\nodejs;' + \$env:Path; Set-Location '$WIN_COPY_WIN'; & \"$ELECTRON_BIN\" 'scripts\\win\\demo-main.cjs' '$CHOICE'; exit \$LASTEXITCODE"
EXIT_CODE=$?

mkdir -p "$REPO_ROOT/logs"
case "$CHOICE" in choice1|choice2) OUT="win-demo.png" ;; *) OUT="win-demo-$CHOICE.png" ;; esac
if [ -f "$WIN_COPY/logs/$OUT" ]; then
  cp "$WIN_COPY/logs/$OUT" "$REPO_ROOT/logs/$OUT"
  cp "$WIN_COPY/logs/${OUT%.png}.json" "$REPO_ROOT/logs/${OUT%.png}.json" 2>/dev/null || true
else
  echo "ERROR: no screenshot at $WIN_COPY/logs/$OUT" >&2
  EXIT_CODE=1
fi

exit $EXIT_CODE
