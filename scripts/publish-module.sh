#!/usr/bin/env bash
# Publish the SpacetimeDB module and regenerate the frontend bindings.
# Usage: scripts/publish-module.sh [local|maincloud] [--reset]
#   local (default)  publish to the local server (`spacetime start` must be running)
#   maincloud        publish the shared dev DB; run from an up-to-date main only
#   --reset          drop all data first (local only)
set -euo pipefail

TARGET="${1:-local}"
RESET="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODULE="$ROOT/backend/module"
DB="${STDB_DB:-remi}"

command -v spacetime >/dev/null || { echo "spacetime CLI not found: https://spacetimedb.com/install" >&2; exit 1; }

FLAGS=(--server "$TARGET" --yes)
if [ "$RESET" = "--reset" ]; then
  [ "$TARGET" = "local" ] || { echo "--reset is local only" >&2; exit 1; }
  FLAGS+=(--delete-data=always)
fi

(cd "$MODULE" && npm ci --silent && npm run typecheck && npm test)
(cd "$MODULE" && spacetime publish "$DB" "${FLAGS[@]}")
(cd "$MODULE" && spacetime generate --lang typescript --out-dir "$ROOT/frontend/src/module_bindings" --module-path .)
echo "Published $DB to $TARGET and regenerated frontend/src/module_bindings."
