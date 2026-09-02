#!/usr/bin/env bash
set -euo pipefail

# Preflight: Node must satisfy package.json "engines" before we spend minutes
# building. The range is read from package.json so this never drifts from it.
node -e '
const range = require("./package.json").engines?.node ?? ""
const v = process.versions.node.split(".").map(Number)
const parse = (s) => { const p = s.split(".").map(Number); while (p.length < 3) p.push(0); return p }
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
let ok = true
for (const tok of range.split(/\s+/).filter(Boolean)) {
  const m = tok.match(/^(>=|<=|>|<|=)?(\d+(?:\.\d+){0,2})$/)
  if (!m) continue
  const op = m[1] ?? "="
  const c = cmp(v, parse(m[2]))
  ok &&= op === ">=" ? c >= 0 : op === "<=" ? c <= 0 : op === ">" ? c > 0 : op === "<" ? c < 0 : c === 0
}
if (!ok) {
  console.error(`error: Node ${process.versions.node} is outside the supported range "${range}" (package.json engines).`)
  process.exit(1)
}
'

if ! command -v pnpm >/dev/null 2>&1; then
  echo "error: pnpm not found. Enable it with: corepack enable" >&2
  exit 1
fi

echo "Installing dependencies..."
pnpm install

echo "Building all packages..."
pnpm -r run build

echo "Installing canonry globally..."
npm install -g ./packages/canonry

# PATH sanity: a registry install (npm i -g @canonry/canonry) and this folder
# install can coexist in different prefixes; PATH order then silently decides
# which binary runs, and the loser goes stale.
for bin in canonry cnry; do
  dupes=$(which -a "$bin" 2>/dev/null | while IFS= read -r p; do
    readlink -f "$p" 2>/dev/null || printf '%s\n' "$p"
  done | sort -u | grep -c . || true)
  if [ "${dupes:-0}" -gt 1 ]; then
    echo "" >&2
    echo "warning: multiple '$bin' installs resolve to different targets on PATH:" >&2
    which -a "$bin" >&2
    echo "The first one wins. Remove the stale copy (npm rm -g @canonry/canonry in the other prefix)." >&2
  fi
done

echo ""
echo "Done. Run 'canonry --version' to verify."
