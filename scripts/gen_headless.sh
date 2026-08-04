#!/usr/bin/env bash
# Regenerate the generated adapter layer for the headless/desktop dual build.
#
# Usage:
#   scripts/gen_headless.sh
#
# Pipeline:
#   1. scripts/build_type_map.py   -> type-name mapping from src/*.rs  (target/gen-meta)
#   2. scripts/gen_adapters.py     -> src/commands/adapters.rs        (from scripts/manifest/commands.json)
#
# The command manifest (scripts/manifest/commands.json) is the committed source
# of truth for the 234 Tauri commands. When you add/remove/rename a command:
#   - update scripts/manifest/commands.json
#   - add the business fn in src/commands/*
#   - run this script
#   - add/keep the matching dispatch arm in src/headless.rs (verified by
#     scripts/verify_headless.py in CI)
#
# This script does NOT touch src/headless.rs: it is the hand-maintained server
# skeleton and is only checked (not regenerated) for dispatch coverage.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

META="crates/agent-gui/src-tauri/target/gen-meta"
mkdir -p "$META"

python3 scripts/build_type_map.py --out "$META/type_map.json"
python3 scripts/gen_adapters.py \
    --commands "scripts/manifest/commands.json" \
    --types "$META/type_map.json" \
    --out "crates/agent-gui/src-tauri/src/commands/adapters.rs"

echo
echo "done. regenerated metadata + adapters.rs"
echo "no-drift check:  git diff --exit-code crates/agent-gui/src-tauri/src/commands/adapters.rs"
echo "dispatch check:  python3 scripts/verify_headless.py"