#!/usr/bin/env bash
set -euo pipefail

HOST="localhost"
PORT="7860"
APP_NAME=""
SCENE=""
BUNDLE_ID=""
NOTES=""
NO_REDACT="false"
DEPTH="1000"
OUT_ROOT="Documents/Data/A11y"

usage() {
  cat <<USAGE
Usage:
  scripts/a11y/capture-scene.sh --app <AppName> --scene <scene-kebab> [options]

Required:
  --app <name>           Application display name (folder name)
  --scene <name>         Scene id in kebab-case (example: context-menu-open)

Options:
  --bundle <bundleId>    Expected app bundle id metadata (optional)
  --host <host>          GhostUI host (default: localhost)
  --port <port>          GhostUI port (default: 7860)
  --notes <text>         Optional capture notes
  --depth <n>           Tree depth (default: 1000, max: 5000)
  --no-redact            Disable string redaction
  --out-root <path>      Output root (default: Documents/Data/A11y)
  -h, --help             Show this help
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app) APP_NAME="${2:-}"; shift 2 ;;
    --scene) SCENE="${2:-}"; shift 2 ;;
    --bundle) BUNDLE_ID="${2:-}"; shift 2 ;;
    --host) HOST="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --notes) NOTES="${2:-}"; shift 2 ;;
    --depth) DEPTH="${2:-}"; shift 2 ;;
    --no-redact) NO_REDACT="true"; shift ;;
    --out-root) OUT_ROOT="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ -z "$APP_NAME" || -z "$SCENE" ]]; then
  echo "--app and --scene are required" >&2
  usage
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 1
fi

if [[ ! "$SCENE" =~ ^[a-z0-9-]+$ ]]; then
  echo "Scene must be kebab-case [a-z0-9-]" >&2
  exit 1
fi
if ! [[ "$DEPTH" =~ ^[0-9]+$ ]]; then
  echo "--depth must be an integer" >&2
  exit 1
fi
if (( DEPTH < 1 || DEPTH > 5000 )); then
  echo "--depth must be between 1 and 5000" >&2
  exit 1
fi

app_dir="${APP_NAME//\//-}"
out_dir="$OUT_ROOT/$app_dir"
mkdir -p "$out_dir"

timestamp_utc="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
capture_stamp="$(date -u +"%Y%m%dT%H%M%SZ")"
frontmost_bundle="$(curl -sS "http://$HOST:$PORT/api/v1/apps/frontmost" | jq -r '.bundleId // empty' || true)"
os_version="$(sw_vers -productVersion 2>/dev/null || echo unknown)"
host_name="$(scutil --get ComputerName 2>/dev/null || hostname)"

if [[ -z "$BUNDLE_ID" ]]; then
  BUNDLE_ID="$frontmost_bundle"
fi

snapshot_response="$(curl -sS "http://$HOST:$PORT/api/v1/a11y/snapshot?profile=canonical&depth=$DEPTH")"
if ! echo "$snapshot_response" | jq -e '.schemaVersion == "2.0" and (.channels | type == "object")' >/dev/null 2>&1; then
  echo "Capture failed. Response:" >&2
  echo "$snapshot_response" | jq . >&2 || echo "$snapshot_response" >&2
  exit 1
fi
raw_focused_response="$(curl -sS "http://$HOST:$PORT/api/v1/a11y/raw?target=front&depth=$DEPTH&capabilities=1")"
if ! echo "$raw_focused_response" | jq -e '(.target == "front") and (.trees | type == "array")' >/dev/null 2>&1; then
  echo "Raw focused capture failed. Response:" >&2
  echo "$raw_focused_response" | jq . >&2 || echo "$raw_focused_response" >&2
  exit 1
fi

redaction_enabled=true
redaction_rules='["email","url","user_path","long_digits"]'
processed_snapshot="$snapshot_response"
processed_raw_focused="$raw_focused_response"

if [[ "$NO_REDACT" == "true" ]]; then
  redaction_enabled=false
  redaction_rules='[]'
else
  processed_snapshot="$(echo "$snapshot_response" | jq '
    def scrub:
      if type == "string" then
        gsub("(?i)[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}"; "<REDACTED:EMAIL>")
        | gsub("https?://[^\"[:space:]]+"; "<REDACTED:URL>")
        | gsub("/Users/[^\"[:space:]]+"; "<REDACTED:PATH>")
        | gsub("[0-9]{6,}"; "<REDACTED:DIGITS>")
      else
        .
      end;
    walk(scrub)
  ')"
  processed_raw_focused="$(echo "$raw_focused_response" | jq '
    def scrub:
      if type == "string" then
        gsub("(?i)[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}"; "<REDACTED:EMAIL>")
        | gsub("https?://[^\"[:space:]]+"; "<REDACTED:URL>")
        | gsub("/Users/[^\"[:space:]]+"; "<REDACTED:PATH>")
        | gsub("[0-9]{6,}"; "<REDACTED:DIGITS>")
      else
        .
      end;
    walk(scrub)
  ')"
fi

capture_id="${capture_stamp}__${app_dir// /-}__${SCENE}"
out_file="$out_dir/$SCENE.json"
snapshot_tmp="$(mktemp)"
raw_tmp="$(mktemp)"
trap 'rm -f "$snapshot_tmp" "$raw_tmp"' EXIT
printf '%s' "$processed_snapshot" > "$snapshot_tmp"
printf '%s' "$processed_raw_focused" > "$raw_tmp"

jq -n \
  --arg schemaVersion "2.0" \
  --arg captureId "$capture_id" \
  --arg capturedAt "$timestamp_utc" \
  --arg appName "$APP_NAME" \
  --arg bundleId "$BUNDLE_ID" \
  --arg frontmost "$frontmost_bundle" \
  --arg osVersion "$os_version" \
  --arg hostName "$host_name" \
  --arg script "GET /api/v1/a11y/snapshot?profile=canonical&depth=$DEPTH" \
  --arg source "/api/v1/a11y/snapshot" \
  --arg rawScript "GET /api/v1/a11y/raw?target=front&depth=$DEPTH&capabilities=1" \
  --arg rawSource "/api/v1/a11y/raw" \
  --arg host "$HOST" \
  --argjson port "$PORT" \
  --argjson depth "$DEPTH" \
  --arg notes "$NOTES" \
  --argjson redactionEnabled "$redaction_enabled" \
  --argjson redactionRules "$redaction_rules" \
  --slurpfile snapshotFile "$snapshot_tmp" \
  --slurpfile rawFile "$raw_tmp" \
  '{
    schemaVersion: $schemaVersion,
    captureId: $captureId,
    capturedAt: $capturedAt,
    application: {
      name: $appName,
      bundleId: ($bundleId | if . == "" then null else . end),
      version: null,
      frontmostBundleIdAtCapture: ($frontmost | if . == "" then null else . end)
    },
    environment: {
      osVersion: $osVersion,
      host: $hostName,
      displayScale: null,
      tool: {
        name: "ghostui-capture-scene",
        version: "1.0"
      }
    },
    capture: {
      scene: $scene,
      script: $script,
      source: $source,
      rawFocused: {
        source: $rawSource,
        script: $rawScript,
        target: "front",
        capabilities: true
      },
      host: $host,
      port: $port,
      depth: $depth,
      notes: ($notes | if . == "" then null else . end),
      redaction: {
        enabled: $redactionEnabled,
        rules: $redactionRules
      }
    },
    focus: (($snapshotFile[0].focus) // {}),
    channels: (($snapshotFile[0].channels) // {}),
    metrics: (($snapshotFile[0].metrics) // {}),
    snapshotPayload: $snapshotFile[0],
    rawFocused: (($rawFile[0]) // {})
  }' \
  --arg scene "$SCENE" > "$out_file"

echo "Saved: $out_file"
