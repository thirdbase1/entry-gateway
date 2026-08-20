#!/usr/bin/env bash
# Apply the client-disconnect abort changes (from repo root).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -f upstream-abort.js ]]; then
  echo "error: upstream-abort.js missing (should be on this branch)" >&2
  exit 1
fi

if grep -q 'createUpstreamAbort' server.js 2>/dev/null; then
  echo "Patch already present in server.js"
else
  patch -p1 < patches/client-disconnect-abort.patch
  echo "Applied client-disconnect abort patch to server.js"
fi

node --check upstream-abort.js
node --check server.js
echo "Syntax OK"
