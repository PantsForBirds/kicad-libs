#!/usr/bin/env bash
# Shallow-fetch kicad-library-utils at the commit pinned in klc_utils.ref into DIR.
# Reuses DIR if it already holds that commit (e.g. restored from actions/cache).
# Prints DIR on success; exits non-zero (and prints nothing) on failure.
# Usage: fetch_klc_utils.sh DIR
set -euo pipefail
dir=${1:?usage: fetch_klc_utils.sh DIR}
ref_file="$(dirname "$0")/klc_utils.ref"
read -r url sha < <(grep -v '^[[:space:]]*#' "$ref_file" | grep -m1 .)
[[ $sha =~ ^[0-9a-f]{40}$ ]] || { echo "bad sha in $ref_file" >&2; exit 1; }

if [ -f "$dir/klc-check/check_footprint.py" ] && [ "$(git -C "$dir" rev-parse HEAD 2>/dev/null)" = "$sha" ]; then
  echo "kicad-library-utils $sha: reusing $dir" >&2
else
  rm -rf "$dir"
  mkdir -p "$dir"
  git -C "$dir" init -q
  git -C "$dir" remote add origin "$url"
  git -C "$dir" -c protocol.version=2 fetch -q --depth 1 origin "$sha"
  git -C "$dir" -c advice.detachedHead=false checkout -q FETCH_HEAD
  [ "$(git -C "$dir" rev-parse HEAD)" = "$sha" ] || { echo "fetched wrong commit" >&2; exit 1; }
  echo "kicad-library-utils $sha: fetched into $dir" >&2
fi
[ -f "$dir/klc-check/check_footprint.py" ] || { echo "no klc-check/check_footprint.py in $dir" >&2; exit 1; }
echo "$dir"
