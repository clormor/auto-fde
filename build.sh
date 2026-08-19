#!/usr/bin/env bash
#
# Validates and packages the AI FDE AutoAllow extension.
#
#   ./build.sh            validate, then write a zip to dist/
#   ./build.sh --check    validate only, write nothing
#   ./build.sh --store    also write a Chrome Web Store zip (manifest at the root)
#
# No dependencies beyond bash and zip. If node or python3 happen to be present
# they are used for stricter checking; if not, those checks are skipped with a
# warning rather than failing the build.
#
# Nothing is ever overwritten. If a zip for the current version already exists,
# the new one gets a -2, -3 and so on.

set -eu

SRC="ai-fde-autoallow"
OUT="dist"
MODE="build"

case "${1:-}" in
  --check) MODE="check" ;;
  --store) MODE="store" ;;
  "") ;;
  *) echo "unknown option: $1" >&2; exit 2 ;;
esac

cd "$(dirname "$0")"

fail() { echo "  FAIL  $1" >&2; exit 1; }
ok()   { echo "  ok    $1"; }
skip() { echo "  skip  $1"; }

echo "Checking $SRC"

# --- required files ---------------------------------------------------------
for f in manifest.json background.js autoallow.js \
         icons/icon16.png icons/icon32.png icons/icon48.png icons/icon128.png; do
  [ -f "$SRC/$f" ] || fail "missing $SRC/$f"
done
[ -f INSTALL.md ] || fail "missing INSTALL.md (it ships inside the zip)"
ok "all required files present"

# --- manifest parses -------------------------------------------------------
if command -v python3 >/dev/null 2>&1; then
  python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$SRC/manifest.json" \
    || fail "manifest.json is not valid JSON"
  ok "manifest.json parses"
elif command -v node >/dev/null 2>&1; then
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$SRC/manifest.json" \
    || fail "manifest.json is not valid JSON"
  ok "manifest.json parses"
else
  skip "manifest JSON check (no python3 or node)"
fi

# --- javascript syntax -----------------------------------------------------
if command -v node >/dev/null 2>&1; then
  for f in background.js autoallow.js; do
    node --check "$SRC/$f" || fail "$f has a syntax error"
  done
  ok "javascript parses"
else
  skip "javascript syntax check (no node)"
fi

# --- version ---------------------------------------------------------------
# "manifest_version" cannot match this pattern: it needs a quote directly
# before the word version.
VERSION=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SRC/manifest.json" | head -1)
[ -n "$VERSION" ] || fail "could not read version out of manifest.json"
ok "version $VERSION"

if [ "$MODE" = "check" ]; then
  echo "Checks passed. Nothing written."
  exit 0
fi

command -v zip >/dev/null 2>&1 || fail "zip is not installed"
mkdir -p "$OUT"

# Never overwrite: find the next free filename.
next_free() {
  base="$1"; ext="$2"
  candidate="$base$ext"
  n=2
  while [ -e "$candidate" ]; do
    candidate="$base-$n$ext"
    n=$((n + 1))
  done
  printf '%s' "$candidate"
}

STAGE=$(mktemp -d)

# zip builds its output via a temp file in the target directory and then renames
# it. Some mounts (the Cowork device bridge, network shares, a few sync clients)
# forbid that rename, so the zip is assembled in a temp directory and copied
# into place. Costs one copy and works everywhere.
emit() {
  staged="$1"; final="$2"
  cp "$staged" "$final"
  ok "wrote $final"
}

# Zipping the folder rather than its contents means unzipping produces a
# correctly named folder, ready to point "Load unpacked" at.
# INSTALL.md rides along at the root of the zip so whoever receives it sees the
# instructions before the folder of code.
ZIP=$(next_free "$OUT/ai-fde-autoallow-v$VERSION" ".zip")
zip -r -q -X "$STAGE/plain.zip" "$SRC" INSTALL.md -x '*/.*' '.*'
emit "$STAGE/plain.zip" "$ZIP"

if [ "$MODE" = "store" ]; then
  # The Web Store rejects zips with a wrapper folder, so this variant puts
  # manifest.json at the root.
  STORE=$(next_free "$OUT/ai-fde-autoallow-v$VERSION-store" ".zip")
  ( cd "$SRC" && zip -r -q -X "$STAGE/store.zip" . -x '.*' '*/.*' )
  emit "$STAGE/store.zip" "$STORE"
fi

echo "  note  staging directory left at $STAGE (your OS clears it)"

echo "Done."
