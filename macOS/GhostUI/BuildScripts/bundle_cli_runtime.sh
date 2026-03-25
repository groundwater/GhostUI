#!/bin/bash
set -euo pipefail

ROOT="${PROJECT_DIR}"
BUN="${HOME}/.bun/bin/bun"
GHOST_DIR="${ROOT}/ghost"
NATIVE_DIR="${GHOST_DIR}/native"
APP="${TARGET_BUILD_DIR}/${WRAPPER_NAME}"
MACOS_DIR="${APP}/Contents/MacOS"
FRAMEWORKS_DIR="${APP}/Contents/Frameworks"
RESOURCES="${APP}/Contents/Resources"
SOURCE_NATIVE_MODULE="${NATIVE_DIR}/build/Release/ghostui_ax.node"
CODE_SIGN_IDENTITY_VALUE="${EXPANDED_CODE_SIGN_IDENTITY:-}"

sign_nested_code() {
  local path="$1"
  if [[ -n "${CODE_SIGN_IDENTITY_VALUE}" && -e "${path}" ]]; then
    codesign --force --sign "${CODE_SIGN_IDENTITY_VALUE}" --timestamp=none --generate-entitlement-der "${path}"
  fi
}

if [[ ! -x "${BUN}" ]]; then
  echo "Missing bun runtime at ${BUN}" >&2
  exit 1
fi

if [[ ! -d "${GHOST_DIR}/node_modules" ]]; then
  (cd "${GHOST_DIR}" && "${BUN}" install)
fi

if [[ ! -d "${NATIVE_DIR}/node_modules" ]]; then
  (cd "${NATIVE_DIR}" && npm install --ignore-scripts)
fi

mkdir -p "${NATIVE_DIR}/build/Release/.deps/Release/obj.target/ghostui_ax"
(cd "${NATIVE_DIR}" && npm run build)

mkdir -p "${FRAMEWORKS_DIR}"
rm -rf "${APP}/Contents/_CodeSignature"
rm -rf "${RESOURCES}/ghost"
rm -f "${RESOURCES}/gui-runtime"
rm -f "${MACOS_DIR}/gui-runtime"
"${BUN}" build "${GHOST_DIR}/src/cli/main.ts" --compile --outfile "${MACOS_DIR}/gui-runtime"
chmod +x "${MACOS_DIR}/gui-runtime"
sign_nested_code "${MACOS_DIR}/gui-runtime"

if [[ -f "${SOURCE_NATIVE_MODULE}" ]]; then
  cp "${SOURCE_NATIVE_MODULE}" "${FRAMEWORKS_DIR}/ghostui_ax.node"
  sign_nested_code "${FRAMEWORKS_DIR}/ghostui_ax.node"
else
  echo "Missing native AX module. Run make native or rebuild the helper target." >&2
  exit 1
fi
