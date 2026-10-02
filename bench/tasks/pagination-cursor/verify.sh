#!/usr/bin/env bash
# usage: verify.sh <project-dir>   -> prints "VERDICT: PASS" or "VERDICT: FAIL <reason>"
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJ="${1:?usage: verify.sh <project-dir>}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cp -R "$PROJ/." "$TMP/"
cp "$HERE/hidden/visible.test.js" "$TMP/test/paginate.test.js"
cp "$HERE/hidden/hidden.test.js" "$TMP/test/hidden.test.js"
cd "$TMP" || { echo "VERDICT: FAIL cannot enter temp copy"; exit 1; }
if ! node --test test/paginate.test.js; then echo "VERDICT: FAIL visible tests"; exit 1; fi
if ! node --test test/hidden.test.js; then echo "VERDICT: FAIL hidden check (ties + descending order)"; exit 1; fi
echo "VERDICT: PASS"
