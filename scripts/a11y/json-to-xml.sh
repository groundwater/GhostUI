#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<USAGE
Usage:
  scripts/a11y/json-to-xml.sh <input-json-or-dir> [options]

Options:
  --out-dir <dir>         Output dir for .xml files when input is a directory
  --stdout                Print XML to stdout (single-file mode only)
  --gui <path>            gui binary path (default: .build/GhostUI.app/Contents/MacOS/gui)
  -h, --help              Show help
USAGE
}

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

INPUT="$1"
shift
OUT_DIR=""
STDOUT_MODE="false"
GUI_BIN=".build/GhostUI.app/Contents/MacOS/gui"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out-dir)
      OUT_DIR="${2:-}"
      shift 2
      ;;
    --stdout)
      STDOUT_MODE="true"
      shift
      ;;
    --gui)
      GUI_BIN="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ ! -x "$GUI_BIN" ]]; then
  echo "gui binary not executable: $GUI_BIN" >&2
  exit 1
fi

convert_file() {
  local in_file="$1"
  local out_file="$2"
  local args=(a11yxml "$in_file" --output "$out_file")
  "$GUI_BIN" "${args[@]}" >/dev/null
  echo "Wrote: $out_file"
}

if [[ -f "$INPUT" ]]; then
  if [[ "$STDOUT_MODE" == "true" ]]; then
    args=(a11yxml "$INPUT" --stdout)
    "$GUI_BIN" "${args[@]}"
    exit 0
  fi

  out_file="${INPUT%.json}.xml"
  if [[ -n "$OUT_DIR" ]]; then
    mkdir -p "$OUT_DIR"
    out_file="$OUT_DIR/$(basename "${INPUT%.json}").xml"
  fi
  convert_file "$INPUT" "$out_file"
  exit 0
fi

if [[ -d "$INPUT" ]]; then
  if [[ "$STDOUT_MODE" == "true" ]]; then
    echo "--stdout is only supported for single-file input" >&2
    exit 1
  fi

  find "$INPUT" -type f -name '*.json' \
    ! -path '*/schema/*' \
    ! -name 'index.json' \
    | sort | while read -r file; do
      out_file="${file%.json}.xml"
      if [[ -n "$OUT_DIR" ]]; then
        rel="${file#$INPUT/}"
        out_file="$OUT_DIR/${rel%.json}.xml"
        mkdir -p "$(dirname "$out_file")"
      fi
      convert_file "$file" "$out_file"
    done
  exit 0
fi

echo "Input not found: $INPUT" >&2
exit 1
