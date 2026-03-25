/**
 * Native AX module — wraps the N-API ghostui_ax.node to provide
 * snapshot, action, pointer, and screenshot capabilities without
 * the Swift HTTP server.
 */
import { resolve } from "path";
import type { AXNode } from "../apps/types.js";
import { axTargetFromNode, type AXCursor, type AXTarget } from "./ax-target.js";

export interface NativeAXFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NativeAXNode {
  [key: string]: unknown;
  role?: string;
  subrole?: string;
  title?: string;
  label?: string;
  description?: string;
  value?: unknown;
  identifier?: string;
  placeholder?: string;
  windowNumber?: number;
  frame?: NativeAXFrame;
  capabilities?: Record<string, unknown>;
  children?: NativeAXNode[];
  enabled?: boolean;
}

export interface NativeAXAppInfo {
  pid: number;
  bundleId?: string;
  name?: string;
  regular?: boolean;
}

export interface NativeAXWindowRect {
  pid: number;
  cgWindowId?: number;
  bundleId?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  title?: string;
  layer?: number;
}

export interface NativeAXPointerOptions {
  action: string;
  x?: number;
  y?: number;
  button?: string;
  endX?: number;
  endY?: number;
  deltaX?: number;
  deltaY?: number;
}

export interface AXObserverEvent {
  type: string;
  pid: number;
  bundleId: string;
}

export type AXObserverBenchmarkMode = "app" | "windows" | "focused";

export interface AXObserverBenchmarkResult {
  pid: number;
  mode: AXObserverBenchmarkMode;
  iterations: number;
  createObserverMs: number;
  addNotificationsMs: number;
  removeNotificationsMs: number;
  totalRegistrations: number;
  successCount: number;
  failureCount: number;
  failuresByCode: Record<string, number>;
  targetCount: number;
}

export interface NativeAXApi {
  axIsProcessTrusted(): boolean;
  axSnapshot(pid: number, depth: number): NativeAXNode | null;
  wsGetRunningApps(): NativeAXAppInfo[];
  wsGetFrontmostApp(): NativeAXAppInfo | null;
  wsGetScreenFrame?(): { x: number; y: number; width: number; height: number } | null;
  cgGetWindowRects(): NativeAXWindowRect[];
  axGetFrontmostPid(): number;
  axPointerEvent(opts: NativeAXPointerOptions): { ok?: boolean; error?: string };
  axPerformAction(pid: number, path: number[], action: string): boolean;
  axSetValue(pid: number, path: number[], value: string): boolean;
  axGetCursor?(): NativeAXCursor | null;
  axSetSelectedTextRange?(pid: number, path: number[], location: number, length: number): boolean;
  axSetWindowPosition?(pid: number, path: number[], x: number, y: number): boolean;
  axFocusWindow?(pid: number, path: number[]): boolean;
  axPostKeyboardInput?(input: { keys?: string[]; modifiers?: string[]; text?: string; rate?: number }): void;
  axPostOverlay?(kind: string, payload: string): void;
  axSwitchApp?(name: string): { ok: boolean; activated?: string; error?: string };
  axStartObserving(callback: (event: AXObserverEvent) => void): boolean;
  axStopObserving(): boolean;
  axBenchmarkObserverNotifications?(opts: {
    pid: number;
    iterations?: number;
    mode?: AXObserverBenchmarkMode;
  }): AXObserverBenchmarkResult;
  axScreenshot(format: string): Uint8Array | null;
  keychainReadGenericPassword?(service: string, account: string, accessGroup?: string): string | null;
  pbRead?(type?: string): string | null;
  pbWrite?(text: string, type?: string): boolean;
  pbTypes?(): string[];
  pbClear?(): boolean;
  wsGetDisplays?(): DisplayInfo[];
  cgKeyDown?(opts: { key: string; mods?: string[] }): void;
  cgKeyUp?(opts: { key: string; mods?: string[] }): void;
  cgModDown?(mods: string[]): void;
  cgModUp?(mods: string[]): void;
  cgGetMousePosition?(): { x: number; y: number };
  cgGetMouseState?(): { x: number; y: number; buttons: { left: boolean; right: boolean; middle: boolean } };
}

export interface NativeAXCursorSelection {
  location: number;
  length: number;
}

export interface NativeAXCursor {
  pid: number;
  node: NativeAXNode;
  selection?: NativeAXCursorSelection;
}

export interface DisplayInfo {
  id: number;
  name: string;
  main: boolean;
  frame: { x: number; y: number; width: number; height: number };
  visibleFrame: { x: number; y: number; width: number; height: number };
  scale: number;
  physicalSize: { width: number; height: number };
  rotation: number;
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return String(error);
}

export function shouldLogNativeAXLoad(): boolean {
  const value = process.env.GHOSTUI_NATIVE_AX_DEBUG;
  return value === "1" || value === "true";
}

// ── N-API module loading ──

const nativeModulePaths = [
  // Running from source (bun ghost/src/daemon.ts)
  resolve(import.meta.dir, "../../native/build/Release/ghostui_ax.node"),
  resolve(import.meta.dir, "../../../native/build/Release/ghostui_ax.node"),
  // Running from helper-local compiled binary inside GhostUICLI.app.
  resolve(process.execPath, "../Frameworks/ghostui_ax.node"),
  // Running from compiled binary inside .app bundle (Contents/MacOS/gui → Contents/Resources/ghost/...)
  resolve(process.execPath, "../../Resources/ghost/native/build/Release/ghostui_ax.node"),
];

function loadNativeAX(): NativeAXApi {
  const errors: string[] = [];
  for (const p of nativeModulePaths) {
    try {
      return require(p) as NativeAXApi;
    } catch (e: unknown) {
      errors.push(`${p}: ${errorMessage(e)}`);
    }
  }
  throw new Error(
    `[native-ax] Failed to load N-API module. Tried:\n${errors.join("\n")}`
  );
}

const loadedNativeAX = loadNativeAX();
let nativeAX: NativeAXApi = loadedNativeAX;

const trusted = nativeAX.axIsProcessTrusted();
if (shouldLogNativeAXLoad()) {
  console.error(`[native-ax] N-API loaded, trusted: ${trusted}`);
}

export function getNativeAX(): NativeAXApi {
  return nativeAX;
}

export function keychainReadGenericPassword(
  service: string,
  account: string,
  accessGroup?: string,
): string | null {
  const read = nativeAX.keychainReadGenericPassword;
  if (!read) {
    throw new Error("Native keychain access is unavailable in this build");
  }
  return read(service, account, accessGroup);
}

export function benchmarkAXObserverNotifications(opts: {
  pid: number;
  iterations?: number;
  mode?: AXObserverBenchmarkMode;
}): AXObserverBenchmarkResult {
  const benchmark = nativeAX.axBenchmarkObserverNotifications;
  if (!benchmark) {
    throw new Error("Native AX observer benchmark is unavailable in this build");
  }
  return benchmark(opts);
}

export function __setNativeAXForTests(mock?: NativeAXApi): void {
  nativeAX = mock ?? loadedNativeAX;
}

export function isAvailable(): boolean {
  return true;
}

/** Snapshot a single app by PID, returning an AXTreeResponse or null. */
export function snapshotApp(pid: number, depth = 1000): AXTreeResponse | null {
  const raw = nativeAX.axSnapshot(pid, depth);
  if (!raw) return null;
  const axNode = napiNodeToAXNode(raw);
  const { menuBar, tree } = separateMenuBar(axNode);
  const frame = getWindowFrame(axNode);
  const apps = nativeAX.wsGetRunningApps();
  const app = apps.find(a => a.pid === pid);
  return {
    app: app?.name || "Unknown",
    bundleId: app?.bundleId || "",
    pid,
    frame,
    menuBar,
    tree,
  };
}

/** Get lightweight app metadata: running apps, window rects, frontmost PID. */
export function getAppMetadata(): {
  apps: { pid: number; bundleId: string; name: string; regular: boolean }[];
  windowRects: { pid: number; cgWindowId: number; bundleId: string; x: number; y: number; w: number; h: number; title?: string }[];
  frontPid: number;
  frontBundleId: string;
  frontName: string;
  screenW: number;
  screenH: number;
} {
  const apps = nativeAX.wsGetRunningApps().map(a => ({
    pid: a.pid as number,
    bundleId: (a.bundleId || "") as string,
    name: (a.name || "") as string,
    regular: a.regular !== false,
  }));
  const frontPid = nativeAX.axGetFrontmostPid();
  const frontApp = apps.find(a => a.pid === frontPid);
  const screen = nativeAX.wsGetScreenFrame?.() || null;
  const rawRects = nativeAX.cgGetWindowRects();
  const windowRects = rawRects
    .filter(wr => wr.layer === 0)
    .map((wr) => {
      const app = apps.find(a => a.pid === wr.pid);
      return {
        pid: wr.pid as number,
        cgWindowId: Number(wr.cgWindowId || 0),
        bundleId: app?.bundleId || "",
        x: wr.x as number,
        y: wr.y as number,
        w: wr.w as number,
        h: wr.h as number,
        title: (wr.title || undefined) as string | undefined,
      };
    });
  return {
    apps,
    windowRects,
    frontPid,
    frontBundleId: frontApp?.bundleId || "",
    frontName: frontApp?.name || "Unknown",
    screenW: Math.round(screen?.width || 1440),
    screenH: Math.round(screen?.height || 900),
  };
}

export function getBootstrapSnapshot(): SnapshotResponse {
  const meta = getAppMetadata();
  if (!meta.frontPid) throw new Error("No frontmost PID — is any app running?");

  const frontBundleId = meta.frontBundleId || `pid:${meta.frontPid}`;
  const windowRects = meta.windowRects.map(rect => (
    rect.pid === meta.frontPid
      ? { ...rect, bundleId: frontBundleId }
      : rect
  ));
  const frontWindow = windowRects.find(wr => wr.pid === meta.frontPid && wr.bundleId === frontBundleId)
    ?? windowRects.find(wr => wr.pid === meta.frontPid)
    ?? windowRects[0];

  const runningBundleIds = meta.apps.flatMap(a => a.bundleId ? [a.bundleId] : []);
  const focusedItems: AXTreeResponse[] = [{
    app: meta.frontName,
    bundleId: frontBundleId,
    pid: meta.frontPid,
    frame: frontWindow
      ? { x: frontWindow.x, y: frontWindow.y, width: frontWindow.w, height: frontWindow.h }
      : undefined,
  }];

  return {
    schemaVersion: "1.0",
    runningBundleIds,
    windowRects,
    focus: {
      frontmostBundleId: frontBundleId,
      frontmostPid: meta.frontPid,
    },
    channels: {
      focused: { items: focusedItems },
      menu: { detected: false },
    },
  };
}

// ── Types matching the Swift snapshot response ──

interface AXTreeResponse {
  app: string;
  bundleId: string;
  pid: number;
  frame?: { x: number; y: number; width: number; height: number };
  menuBar?: AXNode;
  tree?: AXNode;
}

interface WindowRect {
  pid: number;
  cgWindowId?: number;
  bundleId: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SnapshotResponse {
  schemaVersion: string;
  runningBundleIds?: string[];
  menuExtras?: { bundleId: string; items: AXNode[] }[];
  windowRects?: WindowRect[];
  focus: {
    frontmostBundleId: string;
    frontmostPid: number;
  };
  channels: {
    focused: {
      items: AXTreeResponse[];
    };
    visible?: {
      items: AXTreeResponse[];
    };
    menu?: {
      detected: boolean;
      item?: AXTreeResponse;
    };
  };
}

// ── Convert N-API tree to AXNode format ──

function napiNodeToAXNode(node: NativeAXNode): AXNode {
  const result: AXNode = {
    role: node.role || "AXUnknown",
  };
  if (node.subrole) result.subrole = node.subrole;
  if (node.title) result.title = node.title;
  if (node.label) result.label = node.label;
  if (node.value !== undefined && node.value !== null) result.value = String(node.value);
  if (node.identifier) result.identifier = node.identifier;
  if (node.placeholder) result.placeholder = node.placeholder;
  if (typeof node.windowNumber === "number") result.windowNumber = node.windowNumber;
  if (node.frame) {
    result.frame = {
      x: node.frame.x,
      y: node.frame.y,
      width: node.frame.width,
      height: node.frame.height,
    };
  }
  if (node.capabilities) {
    result.capabilities = { ...node.capabilities };
  }
  // Propagate enabled from old flat format if capabilities not present
  if (!result.capabilities && node.enabled === false) {
    result.capabilities = { enabled: false };
  }
  if (Array.isArray(node.actions)) {
    result.actions = [...(node.actions as string[])];
  }
  if (node.children && node.children.length > 0) {
    result.children = node.children.map(napiNodeToAXNode);
  }
  return result;
}

// ── Separate menu bar from app tree ──

function separateMenuBar(tree: AXNode): { menuBar?: AXNode; tree?: AXNode } {
  if (!tree.children) return { tree };

  let menuBar: AXNode | undefined;
  const otherChildren: AXNode[] = [];

  for (const child of tree.children) {
    if (child.role === "AXMenuBar") {
      if (!menuBar) menuBar = child; // keep first as the app menu bar
      // drop all AXMenuBars from the tree — extras are captured separately
    } else {
      otherChildren.push(child);
    }
  }

  const mainTree: AXNode = {
    ...tree,
    children: otherChildren.length > 0 ? otherChildren : undefined,
  };

  return { menuBar, tree: mainTree };
}

// ── Get window frame from AX tree ──

function getWindowFrame(tree: AXNode): { x: number; y: number; width: number; height: number } | undefined {
  if (!tree.children) return undefined;
  for (const child of tree.children) {
    if (child.role === "AXWindow" && child.capabilities?.focused && child.frame) {
      return child.frame;
    }
  }
  for (const child of tree.children) {
    if (child.role === "AXWindow" && child.frame) {
      return child.frame;
    }
  }
  return tree.frame;
}

// ── Detect floating context menus ──

function detectFloatingMenu(
  frontPid: number,
): AXTreeResponse | null {
  // Check for floating menus from the system-wide focused element's parent chain
  // A floating menu is typically owned by a process different from the frontmost app,
  // or is a layer-101+ window.
  const windowRects = nativeAX.cgGetWindowRects();
  // Look for high-layer windows (menus are typically layer 101)
  for (const wr of windowRects) {
    if ((wr.layer ?? 0) >= 101 && wr.pid !== frontPid && wr.w > 10 && wr.h > 10) {
      const tree = nativeAX.axSnapshot(wr.pid, 10);
      if (tree) {
        const axNode = napiNodeToAXNode(tree);
        // Walk children to find AXMenu
        function findMenu(node: AXNode): AXNode | null {
          if (node.role === "AXMenu") return node;
          for (const child of node.children || []) {
            const found = findMenu(child);
            if (found) return found;
          }
          return null;
        }
        const menu = findMenu(axNode);
        if (menu) {
          const apps = nativeAX.wsGetRunningApps();
          const app = apps.find(a => a.pid === wr.pid);
          return {
            app: app?.name || "Unknown",
            bundleId: app?.bundleId || "",
            pid: wr.pid,
            frame: { x: wr.x, y: wr.y, width: wr.w, height: wr.h },
            tree: menu,
          };
        }
      }
    }
  }
  return null;
}

// ── Menu extras (right-side menu bar items) ──

function getMenuExtras(): { bundleId: string; items: AXNode[] }[] {
  const apps = nativeAX.wsGetRunningApps();
  const results: { bundleId: string; items: AXNode[] }[] = [];

  // Scan all non-prohibited apps for menu extras.
  // Use shallow depth (3) since we only need the top-level menu bar items.
  for (const app of apps) {
    const bundleId = app.bundleId;
    if (!bundleId) continue;

    const tree = nativeAX.axSnapshot(app.pid, 3);
    if (!tree) continue;

    const axNode = napiNodeToAXNode(tree);
    // Collect all AXMenuBars, then take items from the last one.
    // Accessory apps (no dock icon) have a single AXMenuBar = the extras bar.
    // Apps like Spotlight have 2: first is the app menu, last is the extras bar.
    const menuBars: AXNode[] = [];
    function collectMenuBars(node: AXNode): void {
      if (node.role === "AXMenuBar") {
        menuBars.push(node);
        return;
      }
      for (const child of node.children || []) {
        collectMenuBars(child);
      }
    }
    collectMenuBars(axNode);

    // No menu bar at all — skip
    if (menuBars.length === 0) continue;

    // Single menu bar: only include if it looks like an extras bar
    // (accessory apps have one bar that IS the extras bar; regular apps
    // have one bar that is their app menu — skip those)
    // Multiple bars: last one is the extras bar
    const extrasBar = menuBars.length > 1
      ? menuBars[menuBars.length - 1]
      : menuBars[0];

    // For single-bar apps, skip if any child has a standard app menu title
    // (Apple, File, Edit, etc.) — that's an app menu, not an extras bar
    if (menuBars.length === 1) {
      const appMenuTitles = new Set(["Apple", "File", "Edit", "View", "Window", "Help"]);
      const hasAppMenu = (extrasBar.children || []).some(
        c => c.title && appMenuTitles.has(c.title)
      );
      if (hasAppMenu) continue;
    }

    const items: AXNode[] = [];
    for (const child of extrasBar.children || []) {
      if (child.role === "AXMenuBarItem" || child.role === "AXMenuExtra") {
        items.push(child);
      }
    }
    if (items.length > 0) {
      results.push({ bundleId, items });
    }
  }

  return results;
}

// ── Build full snapshot response ──

export interface SnapshotOptions {
  focusedDepth?: number;
  visibleDepth?: number;
  menuDepth?: number;
}

export function buildSnapshot(opts: SnapshotOptions = {}): SnapshotResponse | null {
  if (!nativeAX.axIsProcessTrusted()) return null;

  const focusedDepth = opts.focusedDepth ?? 1000;
  const visibleDepth = opts.visibleDepth ?? 3;
  const menuDepth = opts.menuDepth ?? 200;

  if (focusedDepth <= 1) {
    return getBootstrapSnapshot();
  }

  const frontPid = nativeAX.axGetFrontmostPid();
  if (!frontPid) throw new Error("No frontmost PID — is any app running?");

  const apps = nativeAX.wsGetRunningApps();
  const frontApp = apps.find(a => a.pid === frontPid);
  const frontBundleId = frontApp?.bundleId || "";
  const frontName = frontApp?.name || "Unknown";

  // Running bundle IDs
  const runningBundleIds = apps.flatMap(a => a.bundleId ? [a.bundleId] : []);

  // Window rects
  const rawWindowRects = nativeAX.cgGetWindowRects();
  let windowRects: WindowRect[] = rawWindowRects
    .filter(wr => wr.layer === 0)
    .map((wr) => {
      const app = apps.find(a => a.pid === wr.pid);
      return {
        pid: wr.pid,
        bundleId: app?.bundleId || "",
        x: wr.x,
        y: wr.y,
        w: wr.w,
        h: wr.h,
        title: wr.title || undefined,
      };
    });

  // Focused channel: frontmost app
  const focusedItems: AXTreeResponse[] = [];
  const rawTree = nativeAX.axSnapshot(frontPid, focusedDepth);
  if (rawTree) {
    const axNode = napiNodeToAXNode(rawTree);
    const { menuBar, tree } = separateMenuBar(axNode);
    const frame = getWindowFrame(axNode);

    focusedItems.push({
      app: frontName,
      bundleId: frontBundleId,
      pid: frontPid,
      frame,
      menuBar,
      tree,
    });
  }

  // Menu channel: floating context menus
  const floatingMenu = detectFloatingMenu(frontPid);

  // Menu extras
  const menuExtras = getMenuExtras();

  return {
    schemaVersion: "1.0",
    runningBundleIds,
    menuExtras: menuExtras.length > 0 ? menuExtras : undefined,
    windowRects,
    focus: {
      frontmostBundleId: frontBundleId,
      frontmostPid: frontPid,
    },
    channels: {
      focused: { items: focusedItems },
      menu: floatingMenu
        ? { detected: true, item: floatingMenu }
        : { detected: false },
    },
  };
}

// ── Element search by label/role (replaces Swift label/role-based lookup) ──

interface ElementMatch {
  path: number[];  // child index path from app root
  node: AXNode;
}

interface ResolvedElementMatch extends ElementMatch {
  pid: number;
  root: NativeAXNode;
}

function searchByLabelRole(
  node: NativeAXNode,
  label: string | undefined,
  role: string | undefined,
  nth: number | undefined,
  parent: string | undefined,
  currentPath: number[] = [],
  parentLabel: string | undefined = undefined,
): ElementMatch[] {
  const matches: ElementMatch[] = [];

  // Check if parent constraint matches
  const parentOk = !parent || (parentLabel && parentLabel.toLowerCase().includes(parent.toLowerCase()));

  // Check current node
  const nodeLabel = node.title || node.label || "";
  const nodeRole = node.role || "";

  let labelMatch = !label || (
    (node.title && node.title.toLowerCase().includes(label.toLowerCase())) ||
    (node.label && node.label.toLowerCase().includes(label.toLowerCase())) ||
    (node.value != null && String(node.value).toLowerCase().includes(label.toLowerCase()))
  );

  // For container roles (AXRow, AXCell, AXGroup), also match if a child
  // AXStaticText or AXTextField has the label as its value/title.
  // macOS often puts labels in child text elements, not on the container itself.
  if (!labelMatch && label && node.children) {
    const CONTAINER_ROLES = new Set(["AXRow", "AXCell", "AXGroup", "AXList"]);
    if (CONTAINER_ROLES.has(nodeRole)) {
      const lc = label.toLowerCase();
      for (const child of node.children) {
        const cr = child.role || "";
        if (cr === "AXStaticText" || cr === "AXTextField" || cr === "AXCell") {
          if (
            (child.value != null && String(child.value).toLowerCase().includes(lc)) ||
            (child.title && child.title.toLowerCase().includes(lc)) ||
            (child.label && child.label.toLowerCase().includes(lc))
          ) {
            labelMatch = true;
            break;
          }
          // Also check grandchildren (AXCell > AXStaticText)
          if (child.children) {
            for (const gc of child.children) {
              if (
                (gc.value != null && String(gc.value).toLowerCase().includes(lc)) ||
                (gc.title && gc.title.toLowerCase().includes(lc)) ||
                (gc.label && gc.label.toLowerCase().includes(lc))
              ) {
                labelMatch = true;
                break;
              }
            }
            if (labelMatch) break;
          }
        }
      }
    }
  }
  const roleMatch = !role || nodeRole === role;

  if (labelMatch && roleMatch && parentOk && (label || role)) {
    matches.push({
      path: currentPath,
      node: napiNodeToAXNode(node),
    });
  }

  // Recurse into children
  if (node.children) {
    for (let i = 0; i < node.children.length; i++) {
      matches.push(
        ...searchByLabelRole(node.children[i], label, role, undefined, parent, [...currentPath, i], nodeLabel),
      );
    }
  }

  return matches;
}

function resolveTarget(target?: string): number | null {
  if (!target) return nativeAX.axGetFrontmostPid();

  // "app:com.example.App" format
  if (target.startsWith("app:")) {
    const bundleId = target.slice(4);
    const apps = nativeAX.wsGetRunningApps();
    const app = apps.find(a => a.bundleId === bundleId);
    return app?.pid || null;
  }

  // "pid:1234" format
  if (target.startsWith("pid:")) {
    const pid = parseInt(target.slice(4));
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  }

  return nativeAX.axGetFrontmostPid();
}

function frameContainsPoint(
  frame: { x: number; y: number; width: number; height: number } | undefined,
  x: number,
  y: number,
): boolean {
  if (!frame) return false;
  return x >= frame.x && x <= frame.x + frame.width && y >= frame.y && y <= frame.y + frame.height;
}

function boundsCloseEnough(
  frame: { x: number; y: number; width: number; height: number } | undefined,
  bounds: { x: number; y: number; width: number; height: number } | undefined,
  tolerance = 2,
): boolean {
  if (!frame || !bounds) return false;
  return Math.abs(frame.x - bounds.x) <= tolerance
    && Math.abs(frame.y - bounds.y) <= tolerance
    && Math.abs(frame.width - bounds.width) <= tolerance
    && Math.abs(frame.height - bounds.height) <= tolerance;
}

function candidateIdentityScore(node: AXNode, target: AXTarget): number {
  if (node.role !== target.role) return -1;
  if (target.subrole && node.subrole !== target.subrole) return -1;

  let score = 10;
  const identityMatches: boolean[] = [];
  if (target.identifier) identityMatches.push(node.identifier === target.identifier);
  if (target.title) identityMatches.push(node.title === target.title || node.label === target.title);
  if (target.label) identityMatches.push(node.label === target.label || node.title === target.label);
  if (identityMatches.length > 0) {
    if (!identityMatches.some(Boolean)) return -1;
    score += identityMatches.filter(Boolean).length * 10;
  }

  if (target.bounds) {
    if (boundsCloseEnough(node.frame, target.bounds)) {
      score += 5;
    } else if (!frameContainsPoint(node.frame, target.point.x, target.point.y)) {
      return -1;
    }
  }

  return score;
}

function nodeAtPath(root: NativeAXNode, path: number[]): NativeAXNode | null {
  let current: NativeAXNode | undefined = root;
  for (const index of path) {
    current = current?.children?.[index];
    if (!current) return null;
  }
  return current ?? null;
}

function collectAncestorCandidates(root: NativeAXNode, path: number[]): ElementMatch[] {
  const candidates: ElementMatch[] = [];
  for (let depth = path.length; depth >= 0; depth--) {
    const candidatePath = path.slice(0, depth);
    const candidate = nodeAtPath(root, candidatePath);
    if (!candidate) continue;
    candidates.push({
      path: candidatePath,
      node: napiNodeToAXNode(candidate),
    });
  }
  return candidates;
}

function resolveElementMatch(opts: {
  label?: string;
  role?: string;
  target?: string;
  nth?: number;
  parent?: string;
  axTarget?: AXTarget;
}): ResolvedElementMatch {
  if (opts.axTarget) {
    const pid = opts.axTarget.pid;
    const tree = nativeAX.axSnapshot(pid, 1000);
    if (!tree) throw new Error(`Failed to get AX tree for pid ${pid}`);
    const hit = axAt(opts.axTarget.point.x, opts.axTarget.point.y, pid);
    if (!hit) {
      throw new Error(`AX target no longer resolves at (${opts.axTarget.point.x},${opts.axTarget.point.y})`);
    }
    const candidates = collectAncestorCandidates(tree, hit.path)
      .map(match => ({ ...match, score: candidateIdentityScore(match.node, opts.axTarget!) }))
      .filter(match => match.score >= 0)
      .sort((left, right) => right.score - left.score);
    if (candidates.length === 0) {
      throw new Error(`AX target validation failed for ${opts.axTarget.role}`);
    }
    const best = candidates[0];
    return { pid, path: best.path, node: best.node, root: tree };
  }

  const pid = resolveTarget(opts.target);
  if (!pid) throw new Error(`Target app not found: ${opts.target || "frontmost"}`);
  const tree = nativeAX.axSnapshot(pid, 100);
  if (!tree) throw new Error(`Failed to get AX tree for pid ${pid}`);
  const matches = searchByLabelRole(tree, opts.label, opts.role, opts.nth, opts.parent);
  if (matches.length === 0) {
    throw new Error(`Element not found: label=${opts.label} role=${opts.role}`);
  }
  const match = opts.nth != null && opts.nth < matches.length ? matches[opts.nth] : matches[0];
  return { pid, path: match.path, node: match.node, root: tree };
}

function findWindowAncestorPath(root: NativeAXNode, path: number[]): number[] | null {
  for (let depth = path.length; depth >= 0; depth--) {
    const candidatePath = path.slice(0, depth);
    const candidate = nodeAtPath(root, candidatePath);
    if (!candidate) continue;
    if (candidate.role === "AXWindow" || candidate.role === "AXSheet") {
      return candidatePath;
    }
  }
  return null;
}

function raiseResolvedMatch(match: ResolvedElementMatch): void {
  const windowPath = findWindowAncestorPath(match.root, match.path);
  if (windowPath && nativeAX.axFocusWindow) {
    nativeAX.axFocusWindow(match.pid, windowPath);
    Bun.sleepSync(75);
    return;
  }

  if (nativeAX.axSwitchApp) {
    const app = nativeAX.wsGetRunningApps().find(candidate => candidate.pid === match.pid);
    if (app?.name) {
      nativeAX.axSwitchApp(app.name);
      Bun.sleepSync(75);
    }
  }
}

export function focusContainingWindow(opts: {
  axTarget: AXTarget;
}): { ok: boolean; error?: string } {
  const match = resolveElementMatch({ axTarget: opts.axTarget });
  const windowPath = findWindowAncestorPath(match.root, match.path);
  if (!windowPath) {
    throw new Error(`No AXWindow or AXSheet ancestor found for ${opts.axTarget.role}`);
  }
  focusWindow(match.pid, windowPath);
  Bun.sleepSync(75);
  return { ok: true };
}

export function findAndClick(opts: {
  label?: string;
  role?: string;
  target?: string;
  nth?: number;
  parent?: string;
  axTarget?: AXTarget;
}): { ok: boolean; error?: string } {
  const match = resolveElementMatch(opts);
  const frame = match.node.frame;
  if (!frame) {
    throw new Error(`Element has no frame: label=${opts.label} role=${opts.role}`);
  }

  raiseResolvedMatch(match);

  const cx = frame.x + frame.width / 2;
  const cy = frame.y + frame.height / 2;
  const result = nativeAX.axPointerEvent({ action: "click", x: cx, y: cy });
  if (!result?.ok) {
    throw new Error(`Pointer click failed for label=${opts.label} role=${opts.role}`);
  }
  return { ok: true };
}

export function findAndPerformAction(opts: {
  label?: string;
  role?: string;
  action?: string;
  target?: string;
  nth?: number;
  parent?: string;
  axTarget?: AXTarget;
}): { ok: boolean; error?: string } {
  const action = opts.action || "AXPress";
  const match = resolveElementMatch(opts);

  const result = nativeAX.axPerformAction(match.pid, match.path, action);
  if (result !== true) {
    throw new Error(`axPerformAction failed for label=${opts.label} role=${opts.role} action=${action}`);
  }
  return { ok: true };
}

export function findAndSetValue(opts: {
  value: string;
  label?: string;
  role?: string;
  target?: string;
  nth?: number;
  parent?: string;
  axTarget?: AXTarget;
}): { ok: boolean; error?: string } {
  const match = resolveElementMatch(opts);
  const result = nativeAX.axSetValue(match.pid, match.path, opts.value);
  if (result !== true) {
    throw new Error(`axSetValue failed for label=${opts.label} role=${opts.role}`);
  }
  return { ok: true };
}

export function findAndHover(opts: {
  label?: string;
  role?: string;
  target?: string;
  nth?: number;
  parent?: string;
  axTarget?: AXTarget;
}): { ok: boolean; error?: string } {
  const match = resolveElementMatch(opts);
  const frame = match.node.frame;
  if (!frame) throw new Error(`Element has no frame: label=${opts.label} role=${opts.role}`);

  // Move mouse to center of element
  const cx = frame.x + frame.width / 2;
  const cy = frame.y + frame.height / 2;
  const result = nativeAX.axPointerEvent({ action: "move", x: cx, y: cy });
  if (!result?.ok) throw new Error(`Pointer move failed for label=${opts.label}`);
  return { ok: true };
}

export function findAndType(opts: {
  value: string;
  label?: string;
  role?: string;
  target?: string;
  nth?: number;
  parent?: string;
  axTarget?: AXTarget;
  axCursor?: AXCursor;
}): { ok: boolean; error?: string } {
  if (opts.axCursor) {
    const match = resolveElementMatch({ axTarget: opts.axCursor.target });
    const currentValue = typeof match.node.value === "string" ? match.node.value : "";
    const selection = opts.axCursor.selection;
    if (!selection) {
      throw new Error("AX cursor has no selection");
    }
    const safeLocation = Math.max(0, Math.min(selection.location, currentValue.length));
    const safeLength = Math.max(0, Math.min(selection.length, currentValue.length - safeLocation));
    const nextValue = currentValue.slice(0, safeLocation) + opts.value + currentValue.slice(safeLocation + safeLength);
    const result = nativeAX.axSetValue(match.pid, match.path, nextValue);
    if (result !== true) {
      throw new Error(`axSetValue failed for cursor ${opts.axCursor.target.role}`);
    }
    applyCursorSelection({ pid: match.pid, path: match.path }, opts.axCursor, safeLocation + opts.value.length, 0);
    return { ok: true };
  }

  const match = resolveElementMatch(opts);

  // Focus the element first (click on it)
  const frame = match.node.frame;
  if (frame) {
    const cx = frame.x + frame.width / 2;
    const cy = frame.y + frame.height / 2;
    nativeAX.axPointerEvent({ action: "click", x: cx, y: cy });
    Bun.sleepSync(100);
  }

  // Select all existing text and replace
  const postKeyboardInput = nativeAX.axPostKeyboardInput;
  if (!postKeyboardInput) throw new Error("Native AX keyboard input not available");
  postKeyboardInput({ keys: ["a"], modifiers: ["command"] });
  Bun.sleepSync(50);

  // Type the value
  postKeyboardInput({ text: opts.value });
  return { ok: true };
}

function applyCursorSelection(
  match: { pid: number; path: number[] },
  cursor: AXCursor,
  caretLocation?: number,
  lengthOverride?: number,
): void {
  const selection = cursor.selection;
  if (!selection) {
    throw new Error("AX cursor has no selection");
  }
  const setSelection = nativeAX.axSetSelectedTextRange;
  if (!setSelection) {
    throw new Error("Native AX selected-text-range setter not available");
  }
  const location = caretLocation ?? selection.location;
  const length = lengthOverride ?? selection.length;
  let selectionApplied = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const selectionResult = setSelection(match.pid, match.path, location, length);
    if (selectionResult !== true) {
      throw new Error(`axSetSelectedTextRange failed for cursor ${cursor.target.role}`);
    }
    const liveCursor = nativeAX.axGetCursor?.();
    if (
      liveCursor?.selection &&
      liveCursor.selection.location === location &&
      liveCursor.selection.length === length
    ) {
      selectionApplied = true;
      break;
    }
    Bun.sleepSync(20);
  }
  if (!selectionApplied) {
    throw new Error(`axSetSelectedTextRange did not stick for cursor ${cursor.target.role}`);
  }
}

export function findAndSelectCursor(cursor: AXCursor): { ok: boolean; error?: string } {
  const match = resolveElementMatch({ axTarget: cursor.target });
  applyCursorSelection({ pid: match.pid, path: match.path }, cursor);
  return { ok: true };
}

export function findCursor(): AXCursor {
  if (!nativeAX.axGetCursor) {
    throw new Error("Native AX cursor lookup not available");
  }
  const cursor = nativeAX.axGetCursor();
  if (!cursor) {
    throw new Error("No focused text cursor available");
  }
  return {
    type: "ax.cursor",
    target: axTargetFromNode(cursor.pid, napiNodeToAXNode(cursor.node)),
    ...(cursor.selection ? { selection: cursor.selection } : {}),
  };
}

export function resolveAXQuerySubtree(axTarget: AXTarget): { pid: number; tree: AXNode } {
  const match = resolveElementMatch({ axTarget });
  return { pid: match.pid, tree: match.node };
}

export function pointerEvent(opts: {
  action: string;
  x?: number;
  y?: number;
  button?: string;
  endX?: number;
  endY?: number;
  deltaX?: number;
  deltaY?: number;
}): { ok: boolean; error?: string } {
  const result = nativeAX.axPointerEvent(opts);
  if (!result?.ok) throw new Error(`Pointer event failed: ${opts.action}`);
  return { ok: true };
}

export function setWindowPosition(pid: number, path: number[], x: number, y: number): { ok: boolean; error?: string } {
  if (!nativeAX.axSetWindowPosition) throw new Error("Native AX window positioning not available");
  const result = nativeAX.axSetWindowPosition(pid, path, x, y);
  if (!result) throw new Error(`axSetWindowPosition failed for pid=${pid}`);
  return { ok: true };
}

export function focusWindow(pid: number, path: number[]): { ok: boolean; error?: string } {
  if (!nativeAX.axFocusWindow) throw new Error("Native AX window focus not available");
  const result = nativeAX.axFocusWindow(pid, path);
  if (!result) throw new Error(`axFocusWindow failed for pid=${pid}`);
  return { ok: true };
}

export function screenshot(format?: string): Uint8Array | null {
  return nativeAX.axScreenshot(format || "png");
}

// ── AXObserver API ──

export interface AXObserverEvent {
  type: string;
  pid: number;
  bundleId: string;
}

/** Start AXObserver thread, observe all running apps, fire callback on AX events. */
export function startObserving(callback: (event: AXObserverEvent) => void): boolean {
  return nativeAX.axStartObserving(callback);
}

/** Stop AXObserver thread and clean up all observers. */
export function stopObserving(): boolean {
  return nativeAX.axStopObserving();
}

// ── Pasteboard API ──

export function pbRead(type?: string): string | null {
  if (!nativeAX.pbRead) throw new Error("Native pasteboard not available");
  return nativeAX.pbRead(type);
}

export function pbWrite(text: string, type?: string): boolean {
  if (!nativeAX.pbWrite) throw new Error("Native pasteboard not available");
  return nativeAX.pbWrite(text, type);
}

export function pbTypes(): string[] {
  if (!nativeAX.pbTypes) throw new Error("Native pasteboard not available");
  return nativeAX.pbTypes();
}

export function pbClear(): boolean {
  if (!nativeAX.pbClear) throw new Error("Native pasteboard not available");
  return nativeAX.pbClear();
}

// ── Display API ──

export function getDisplays(): DisplayInfo[] {
  if (!nativeAX.wsGetDisplays) throw new Error("Native display info not available");
  return nativeAX.wsGetDisplays();
}

// ── AX hit-test: find deepest element at screen coordinate ──

/** Walk an AXNode tree and return the deepest child whose frame contains (x, y). */
function hitTestNode(
  node: NativeAXNode,
  x: number,
  y: number,
  path: number[],
): { node: AXNode; path: number[] } | null {
  const f = node.frame;
  // If this node has a frame and the point is outside it, bail immediately.
  if (f && (x < f.x || x > f.x + f.width || y < f.y || y > f.y + f.height)) {
    return null;
  }

  // Try children first (prefer the deepest/smallest containing element).
  if (node.children) {
    for (let i = 0; i < node.children.length; i++) {
      const match = hitTestNode(node.children[i], x, y, [...path, i]);
      if (match) return match;
    }
  }

  // This node contains the point.
  if (f && x >= f.x && x <= f.x + f.width && y >= f.y && y <= f.y + f.height) {
    return { node: napiNodeToAXNode(node), path };
  }
  return null;
}

/**
 * Find the deepest AX element at screen coordinate (x, y).
 * If pid is omitted, uses the frontmost app.
 */
export function axAt(
  x: number,
  y: number,
  pid?: number,
): { node: AXNode; path: number[] } | null {
  const targetPid = pid ?? nativeAX.axGetFrontmostPid();
  if (!targetPid) return null;
  const raw = nativeAX.axSnapshot(targetPid, 1000);
  if (!raw) return null;
  return hitTestNode(raw, x, y, []);
}

// ── AX action enumeration (role-based inference) ──

const ROLE_ACTIONS: Record<string, string[]> = {
  AXButton:             ["AXPress"],
  AXCheckBox:           ["AXPress"],
  AXRadioButton:        ["AXPress"],
  AXMenuItem:           ["AXPress", "AXCancel"],
  AXMenuBarItem:        ["AXPress"],
  AXMenu:               ["AXCancel"],
  AXTextField:          ["AXConfirm"],
  AXTextArea:           ["AXConfirm"],
  AXSlider:             ["AXIncrement", "AXDecrement"],
  AXScrollBar:          ["AXIncrement", "AXDecrement"],
  AXIncrementor:        ["AXIncrement", "AXDecrement"],
  AXWindow:             ["AXRaise", "AXMinimize", "AXZoom", "AXClose"],
  AXSheet:              ["AXRaise"],
  AXPopUpButton:        ["AXPress", "AXShowMenu"],
  AXComboBox:           ["AXPress", "AXShowMenu"],
  AXDisclosureTriangle: ["AXPress"],
  AXLink:               ["AXPress"],
  AXTab:                ["AXPress"],
  AXTabGroup:           ["AXPress"],
};

const FALLBACK_ACTIONS = ["AXPress"];

/**
 * Return the known AX actions for the element matching the given label/role.
 * Uses a role-to-actions lookup since the N-API doesn't expose action enumeration.
 */
export function axGetActions(opts: {
  label?: string;
  role?: string;
  nth?: number;
  pid?: number;
}): string[] {
  const pid = opts.pid ?? nativeAX.axGetFrontmostPid();
  if (!pid) throw new Error("No frontmost PID");
  const tree = nativeAX.axSnapshot(pid, 100);
  if (!tree) throw new Error(`Failed to get AX tree for pid ${pid}`);
  const matches = searchByLabelRole(tree, opts.label, opts.role, opts.nth, undefined);
  if (matches.length === 0) {
    throw new Error(`Element not found: label=${opts.label} role=${opts.role}`);
  }
  const match = opts.nth != null && opts.nth < matches.length ? matches[opts.nth] : matches[0];
  return ROLE_ACTIONS[match.node.role] ?? FALLBACK_ACTIONS;
}

export function axGetActionsForTarget(axTarget: AXTarget): string[] {
  const match = resolveElementMatch({ axTarget });
  return ROLE_ACTIONS[match.node.role] ?? FALLBACK_ACTIONS;
}

// ── AX focus: focus element via AXFocus or AXRaise ──

/**
 * Focus the element matching opts, using AXRaise for windows and AXFocus for others.
 * Falls back to a click at the element center if the AX action fails.
 */
export function findAndFocus(opts: {
  label?: string;
  role?: string;
  nth?: number;
  pid?: number;
  axTarget?: AXTarget;
}): { ok: boolean; error?: string } {
  const match = opts.axTarget
    ? resolveElementMatch({ axTarget: opts.axTarget })
    : resolveElementMatch({ label: opts.label, role: opts.role, nth: opts.nth, target: opts.pid != null ? `pid:${opts.pid}` : undefined });
  const node = match.node;
  const role = node.role;

  const action = (role === "AXWindow" || role === "AXSheet") ? "AXRaise" : "AXFocus";
  const result = nativeAX.axPerformAction(match.pid, match.path, action);
  if (result) return { ok: true };

  // Fallback: click the element center
  if (node.frame) {
    const cx = node.frame.x + node.frame.width / 2;
    const cy = node.frame.y + node.frame.height / 2;
    const ptrResult = nativeAX.axPointerEvent({ action: "click", x: cx, y: cy });
    if (ptrResult?.ok) return { ok: true };
  }
  throw new Error(`axFocus failed for label=${opts.label} role=${opts.role}`);
}

// ── AX menu at coordinate ──

/**
 * Return the AXMenu node from a floating context-menu window at screen point (x, y).
 * Examines all high-layer (>= 101) windows whose bounds contain the point.
 */
export function menuAt(x: number, y: number, pid?: number): AXNode | null {
  const windowRects = nativeAX.cgGetWindowRects();
  for (const wr of windowRects) {
    if ((wr.layer ?? 0) < 101) continue;
    if (pid !== undefined && wr.pid !== pid) continue;
    if (wr.w < 10 || wr.h < 10) continue;
    if (x < wr.x || x > wr.x + wr.w || y < wr.y || y > wr.y + wr.h) continue;
    const tree = nativeAX.axSnapshot(wr.pid, 10);
    if (!tree) continue;
    const axNode = napiNodeToAXNode(tree);
    const found = findMenuNode(axNode);
    if (found) return found;
  }
  return null;
}

function findMenuNode(node: AXNode): AXNode | null {
  if (node.role === "AXMenu") return node;
  for (const child of node.children || []) {
    const found = findMenuNode(child);
    if (found) return found;
  }
  return null;
}
