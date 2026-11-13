#!/usr/bin/env bash
# End-to-end clone benchmark: probe original, probe clone, score.
# Usage: bash run_eval.sh <original-url> <clone-url> [out-dir] [task-space]
#   task-space  name or numeric id of the clone job's ego-browser task space; both sides are
#               probed through that space's first Page. Omitted: the script opens its own
#               space "clone-website eval" and finishes it after a successful run.
# Exit code is the scorer's: 0 pass, 1 fail; 2 when a prerequisite is missing.
set -euo pipefail

ORIG="${1:?original url required}"
CLONE="${2:?clone url required}"
OUT="${3:-./eval-out}"
SPACE="${4:-}"
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"

command -v ego-browser >/dev/null 2>&1 || {
  echo "ego-browser is not on PATH; install ego lite first (references/install.md)" >&2; exit 2; }
PY="$(command -v python3 || command -v python || true)"
[ -n "$PY" ] || { echo "python3 is required for scoring" >&2; exit 2; }

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

# ego's Node.js process sees neither this shell's cwd nor its environment, so every value is
# written into the script as a JSON literal. Paths become native ones under Git Bash on Windows.
native() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
json() { "$PY" -c 'import json, sys; print(json.dumps(sys.argv[1]))' "$1"; }

OWN_SPACE=false
if [[ "$SPACE" =~ ^[0-9]+$ ]]; then SPACE_JS="$SPACE"
elif [ -n "$SPACE" ]; then SPACE_JS="$(json "$SPACE")"
else SPACE_JS="$(json 'clone-website eval')"; OWN_SPACE=true
fi

ego-browser nodejs <<EOF
const { pathToFileURL } = await import('node:url')
const { evalProbe } = await import(pathToFileURL($(json "$(native "$SKILL_DIR/tools/eval-probe.js")")).href)
const OUT = $(json "$(native "$OUT")")
const task = await taskSpace($SPACE_JS)
const page = (await task.pages())[0] ?? (await task.newPage())
console.log(JSON.stringify({ taskSpaceId: task.spaceId, page: page.label }))
for (const [side, url] of [['original', $(json "$ORIG")], ['clone', $(json "$CLONE")]]) {
  const summary = await evalProbe({ page }, {
    url,
    outPath: OUT + '/' + side + '.json',
    screenshotPath: OUT + '/' + side + '-full.png',
  })
  console.log(JSON.stringify({ side, ...summary }))
}
EOF

if [ "$OWN_SPACE" = true ]; then
  ego-browser nodejs <<EOF
const task = await taskSpace($SPACE_JS)
await task.finish({ keep: [] })
EOF
fi

"$PY" "$SKILL_DIR/scripts/eval_score.py" \
  "$OUT/original.json" "$OUT/clone.json" \
  --shots "$OUT/original-full.png" "$OUT/clone-full.png" \
  --out "$OUT"
