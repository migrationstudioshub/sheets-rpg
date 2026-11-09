#!/usr/bin/env bash
# Copies the shared game code into the Apps Script folder AND the Cloud Functions folder,
# so client, Apps Script server and the Firebase referee all run exactly the same rules.
# Run after editing anything in shared/.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p functions/shared
for f in shared/*.js; do
  name=$(basename "$f" .js)
  header="// GENERATED from shared/$name.js by tools/sync_server.sh. Edit the original, not this copy."
  { echo "$header"; cat "$f"; } > "server/shared_$name.js"
  { echo "$header"; cat "$f"; } > "functions/shared/$name.js"
done
echo "synced: server/shared_*.js and functions/shared/*.js"
