#!/usr/bin/env bash
# Regenerate the Swift Codable structs from the JSON Schemas (BUILD_PLAN §4).
#
# Uses quicktype. Output goes to the sidecar's Model/Generated.swift. Run from anywhere;
# paths are resolved relative to this script. CI runs this and fails on an uncommitted diff,
# so the Swift and TypeScript models can never silently drift.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
schema_dir="$here/../schema"
out="$here/../../../native/dollyd/Sources/dollyd/Model/Generated.swift"

if ! command -v quicktype >/dev/null 2>&1; then
  echo "quicktype not found. Install with: npm i -g quicktype" >&2
  exit 1
fi

mkdir -p "$(dirname "$out")"

# One combined Swift file with structs for all three contracts.
quicktype \
  --lang swift \
  --struct-or-class struct \
  --swift-5-support \
  --density dense \
  --access-level public \
  --initializers \
  -o "$out" \
  --src-lang schema \
  "$schema_dir/project.schema.json" \
  "$schema_dir/cursor.schema.json" \
  "$schema_dir/sidecar.schema.json"

echo "wrote $out"
