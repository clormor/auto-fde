#!/usr/bin/env bash
#
# Validates the extension. Writes nothing.
#
#   ./check.sh
#
# There is no packaging step. The extension is distributed by cloning the repo
# and pointing Chrome's "Load unpacked" at the auto-fde folder, so a zip
# would only be a second copy to keep in step with this one.
#
# No dependencies beyond bash. If node or python3 happen to be present they are
# used for stricter checking; if not, those checks are skipped with a warning
# rather than failing.

set -eu

SRC="auto-fde"

case "${1:-}" in
  "") ;;
  *) echo "unknown option: $1" >&2; exit 2 ;;
esac

cd "$(dirname "$0")"

fail() { echo "  FAIL  $1" >&2; exit 1; }
ok()   { echo "  ok    $1"; }
skip() { echo "  skip  $1"; }

echo "Checking $SRC"

# --- required files ---------------------------------------------------------
for f in manifest.json background.js auto-fde.js gate.js storage.js \
         options.html options.js \
         icons/icon16.png icons/icon32.png icons/icon48.png icons/icon128.png \
         icons/icon16-inactive.png icons/icon32-inactive.png \
         icons/icon48-inactive.png icons/icon128-inactive.png; do
  [ -f "$SRC/$f" ] || fail "missing $SRC/$f"
done
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
# background.js, gate.js, storage.js and options.js are ES modules. node decides
# how to parse a .js file from the nearest package.json, which is why the one at
# the root of this repo sets "type": "module". Run this script from anywhere; it
# cd's to its own directory above, so that package.json is always in scope.
if command -v node >/dev/null 2>&1; then
  for f in "$SRC"/*.js; do
    node --check "$f" || fail "$(basename "$f") has a syntax error"
  done
  ok "javascript parses"
else
  skip "javascript syntax check (no node)"
fi

# --- version ---------------------------------------------------------------
# Chrome shows this on the extension's card, so it is the only way anyone can
# tell which revision they are running.
# "manifest_version" cannot match this pattern: it needs a quote directly
# before the word version.
VERSION=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SRC/manifest.json" | head -1)
[ -n "$VERSION" ] || fail "could not read version out of manifest.json"
ok "version $VERSION"

echo "Checks passed."
