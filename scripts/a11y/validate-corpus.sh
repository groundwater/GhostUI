#!/usr/bin/env bash
set -euo pipefail

ROOT="Documents/Data/A11y"
REBUILD_INDEX="false"

usage() {
  cat <<USAGE
Usage:
  scripts/a11y/validate-corpus.sh [--root <path>] [--rebuild-index]

Options:
  --root <path>      Corpus root (default: Documents/Data/A11y)
  --rebuild-index    Rebuild index.json from capture files
  -h, --help         Show help
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root) ROOT="${2:-}"; shift 2 ;;
    --rebuild-index) REBUILD_INDEX="true"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage; exit 1 ;;
  esac
done

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 1
fi

if [[ ! -d "$ROOT" ]]; then
  echo "Missing corpus root: $ROOT" >&2
  exit 1
fi

files=()
while IFS= read -r file; do
  files+=("$file")
done < <(find "$ROOT" -type f -name '*.json' \
  ! -path "$ROOT/index.json" \
  ! -path "$ROOT/schema/*" | sort)

if [[ ${#files[@]} -eq 0 ]]; then
  echo "No capture JSON files found under $ROOT"
  exit 0
fi

echo "Validating ${#files[@]} capture files..."

ids_tmp="$(mktemp)"
trap 'rm -f "$ids_tmp"' EXIT

errors=0
for f in "${files[@]}"; do
  if ! jq -e '
      def base_valid:
        (.captureId | type == "string" and length > 0) and
        (.capturedAt | type == "string" and length > 0) and
        (.application.name | type == "string" and length > 0) and
        (.capture.scene | type == "string" and test("^[a-z0-9-]+$"));

      def v1_valid:
        .schemaVersion == "1.0" and
        (.raw.treePayload | type == "object") and
        (.raw.trees | type == "array");

      def v2_valid:
        .schemaVersion == "2.0" and
        (.channels | type == "object") and
        (.channels.menu.detected | type == "boolean") and
        (.channels.alerts.items | type == "array") and
        (.channels.focused.items | type == "array") and
        (.channels.visible.items | type == "array");

      base_valid and (v1_valid or v2_valid)
    ' "$f" >/dev/null; then
    echo "INVALID: $f"
    errors=$((errors + 1))
    continue
  fi

  jq -r '.captureId' "$f" >> "$ids_tmp"
done

dup_ids="$(sort "$ids_tmp" | uniq -d || true)"
if [[ -n "$dup_ids" ]]; then
  echo "Duplicate captureId values found:"
  echo "$dup_ids"
  errors=$((errors + 1))
fi

if [[ "$REBUILD_INDEX" == "true" ]]; then
  generated_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  jq -n \
    --arg generatedAt "$generated_at" \
    --arg root "$ROOT" \
    --argjson entries "$(
      for f in "${files[@]}"; do
        rel="${f#${ROOT}/}"
        jq --arg path "$rel" '{
          path: $path,
          captureId,
          capturedAt,
          schemaVersion,
          app: .application.name,
          bundleId: .application.bundleId,
          scene: .capture.scene,
          focusedCount: (if .schemaVersion == "2.0" then (.channels.focused.items | length) else (.raw.trees | length) end),
          visibleCount: (if .schemaVersion == "2.0" then (.channels.visible.items | length) else null end),
          alertCount: (if .schemaVersion == "2.0" then (.channels.alerts.items | length) else null end),
          menuDetected: (if .schemaVersion == "2.0" then .channels.menu.detected else null end)
        }' "$f"
      done | jq -s 'sort_by(.capturedAt, .app, .scene)'
    )" \
    '{
      schemaVersion: "1.0",
      generatedAt: $generatedAt,
      entries: $entries
    }' > "$ROOT/index.json"

  echo "Rebuilt: $ROOT/index.json"
fi

if [[ $errors -gt 0 ]]; then
  echo "Validation failed with $errors issue(s)." >&2
  exit 1
fi

echo "Validation passed."
