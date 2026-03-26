#!/bin/bash
set -euo pipefail

ROOT="${PROJECT_DIR}"
BUN="${HOME}/.bun/bin/bun"
GHOST_DIR="${ROOT}/macOS/ghost"
NATIVE_DIR="${GHOST_DIR}/native"
APP="${TARGET_BUILD_DIR}/${WRAPPER_NAME}"
HELPERS="${APP}/Contents/Helpers"
RESOURCES="${APP}/Contents/Resources"
HELPER_APP="${BUILT_PRODUCTS_DIR}/GhostUICLI.app"
HELPER_DEST="${HELPERS}/GhostUICLI.app"
BUILT_PRODUCTS="${BUILT_PRODUCTS_DIR}"
SOURCE_NATIVE_MODULE="${NATIVE_DIR}/build/Release/ghostui_ax.node"
CODE_SIGN_IDENTITY_VALUE="${EXPANDED_CODE_SIGN_IDENTITY:-}"

sign_nested_code() {
  local path="$1"
  if [[ -n "${CODE_SIGN_IDENTITY_VALUE}" && -e "${path}" ]]; then
    codesign --force --sign "${CODE_SIGN_IDENTITY_VALUE}" --timestamp=none --generate-entitlement-der "${path}"
  fi
}

sign_nested_bundle() {
  local path="$1"
  if [[ -n "${CODE_SIGN_IDENTITY_VALUE}" && -d "${path}" ]]; then
    codesign --force --sign "${CODE_SIGN_IDENTITY_VALUE}" --preserve-metadata=entitlements --timestamp=none "${path}"
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

(cd "${GHOST_DIR}" && "${BUN}" run build:display-ui)
mkdir -p "${HELPERS}" "${RESOURCES}/ghost/native/build/Release"
rm -rf "${HELPER_DEST}"
rm -f "${APP}/Contents/MacOS/gui"
cp "${BUN}" "${HELPERS}/bun"
chmod +x "${HELPERS}/bun"
sign_nested_code "${HELPERS}/bun"
rsync -a --delete "${GHOST_DIR}/" "${RESOURCES}/ghost/"

if [[ ! -d "${HELPER_APP}" ]]; then
  echo "Missing built GhostUICLI.app at ${HELPER_APP}" >&2
  exit 1
fi

ditto "${HELPER_APP}" "${HELPER_DEST}"
sign_nested_bundle "${HELPER_DEST}"

if [[ -f "${SOURCE_NATIVE_MODULE}" ]]; then
  cp "${SOURCE_NATIVE_MODULE}" "${RESOURCES}/ghost/native/build/Release/ghostui_ax.node"
  sign_nested_code "${RESOURCES}/ghost/native/build/Release/ghostui_ax.node"
else
  echo "Missing native AX module. Run make native or rebuild the app target." >&2
  exit 1
fi
