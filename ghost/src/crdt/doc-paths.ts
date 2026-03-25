export const DEFAULT_DISPLAY_INDEX = 0;
export const DEFAULT_DOC_PATH = `/display/${DEFAULT_DISPLAY_INDEX}`;
export const WINDOW_DOC_PREFIX = "/windows/";

export function displayDocPath(index: number | string): string {
  const n = typeof index === "string" ? Number.parseInt(index, 10) : index;
  return Number.isFinite(n) && n >= 0 ? `/display/${Math.trunc(n)}` : DEFAULT_DOC_PATH;
}

export function windowDocPath(cgWindowId: number | string): string {
  const id = typeof cgWindowId === "string" ? cgWindowId.trim() : String(Math.trunc(cgWindowId));
  return `${WINDOW_DOC_PREFIX}${id}`;
}

export function isWindowDocPath(path: string): boolean {
  return path.startsWith(WINDOW_DOC_PREFIX) && path.length > WINDOW_DOC_PREFIX.length;
}
