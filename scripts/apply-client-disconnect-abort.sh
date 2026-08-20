#!/usr/bin/env bash
# Apply the client-disconnect abort patch to server.js (from repo root).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if ! grep -q 'client_disconnect' server.js 2>/dev/null; then
  patch -p1 < patches/client-disconnect-abort.patch
  echo "Applied client-disconnect abort patch to server.js"
else
  echo "Patch already present in server.js"
fi
node --check server.js
echo "Syntax OK"
