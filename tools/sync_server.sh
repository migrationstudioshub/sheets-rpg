#!/usr/bin/env bash
# Copies the shared game code into the Apps Script folder, so client and server
# run exactly the same rules. Run after editing anything in shared/.
set -euo pipefail
cd "$(dirname "$0")/.."
for f in shared/*.js; do
  name=$(basename "$f" .js)
  { echo "// GENERATED from shared/$name.js by tools/sync_server.sh. Edit the original, not this copy."; cat "$f"; } > "server/shared_$name.js"
done
echo "synced: $(ls server/shared_*.js | tr '\n' ' ')"
