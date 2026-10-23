#!/usr/bin/env bash
# Smoke test of the interactive UI: runs Zoi Code in a pseudo-terminal against test/fake-raon.mjs,
# opens the command menu, gets a reply, approves a command, and checks that the command ran and that
# the prompt stayed at the bottom of the screen the whole time. Needs Python 3 with pyte.
# Usage: test/ui-smoke.sh [path/to/cli.js]   (default: dist/cli.js)
set -euo pipefail
cd "$(dirname "$0")/.."
cli=${1:-dist/cli.js}
case $cli in /*) ;; *) cli=$PWD/$cli ;; esac  # tui.py starts it from the project folder
work=$(mktemp -d)
server=
cleanup() {
  [ -n "$server" ] && kill "$server" 2>/dev/null
  rm -rf "$work"
}
trap cleanup EXIT

node test/fake-raon.mjs 0 > "$work/port" &
server=$!
for _ in $(seq 50); do [ -s "$work/port" ] && break; sleep 0.1; done
mkdir -p "$work/proj"

RAON_BASE_URL="http://127.0.0.1:$(cat "$work/port")/v1" RAON_API_KEY=test RAON_MODEL=raon-test \
ZOI_TEST_HOME="$work/home" ZOI_CLI="$cli" TUI_COLS=116 TUI_ROWS=42 \
  python3 test/tui.py "$work/proj" wait:4 snap '<enter>' wait:3 snap / snap '<down><down>' snap '<bs>' snap \
    'hello<enter>' until:'fake server' snap 'please make a file<enter>' until:'Bash command' snap \
    '<enter>' until:'the file is there' snap > "$work/screens"
cat "$work/screens"

[ -f "$work/proj/made-1.txt" ] || { echo 'FAIL: the approved command did not run'; exit 1; }
python3 - "$work/screens" <<'EOF'
import re, sys
screens = open(sys.argv[1], encoding='utf-8').read().split('===== screen')[2:]  # skip the opening scene
bad = []
for i, s in enumerate(screens):
    rows = s.split('\n')[1:43]
    footer = [r + 1 for r, line in enumerate(rows) if re.search('context [▰▱]', line)]
    if footer != [41]:
        bad.append((i, footer))
if bad:
    sys.exit(f'FAIL: the footer under the prompt should stay on row 41 of 42, got (screen, rows): {bad}')
print(f'ok: the command ran, and the prompt stayed at the bottom in all {len(screens)} screens')
EOF
