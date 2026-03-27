import { resolve } from "path";
import type * as Y from "yjs";
import { CRDTStore } from "./crdt/store.js";
import { handleCLI } from "./server/cli.js";
import { handleVAT } from "./server/vat.js";
import { handleStatic } from "./server/static.js";
import { configureRefresherRuntime, startRefresher, type TreeNode, type Refresher, pruneAppByBundleId } from "./a11y/refresher.js";
import { defaultResolveAction, defaultFollowUp, type ActionTarget, type ActionCommand } from "./apps/traits.js";
import { getBundle } from "./apps/registry.js";
import {
  getNativeAX,
  getAppMetadata,
  buildSnapshot, findAndClick, findAndPerformAction, findAndSetValue, findAndHover, findAndSelectCursor, findAndType, findCursor, resolveAXQuerySubtree,
  pointerEvent, screenshot, setWindowPosition, focusWindow,
  startObserving, stopObserving, type AXObserverEvent,
  getDisplays,
  axAt, axGetActions, axGetActionsForTarget, findAndFocus, focusContainingWindow, menuAt,
} from "./a11y/native-ax.js";
import { createDaemonAuthContext } from "./server/auth.js";
import { buildLazyTree } from "./a11y/live-tree.js";
import { parseQuery } from "./cli/query.js";
import { filterTree, bfsFirst } from "./cli/filter.js";
import { DEFAULT_DOC_PATH, windowDocPath } from "./crdt/doc-paths.js";
import { planAXEventRefresh, type RefreshPlan } from "./ax-event-policy.js";
import { DrawScriptValidationError, normalizeDrawScriptPayload } from "./overlay/draw.js";
import { makeOverlayDrawResponse } from "./overlay/draw-route.js";
import { ActorRuntime } from "./actors/runtime.js";
import { actorErrorBody, normalizeActorRunRequest, normalizeActorSpawnRequest } from "./actors/protocol.js";
import { findWindowFocusMatch, resolveWindowFocusMatch, type FocusableWindowNode } from "./window-targeting.js";
import { shouldClearWindowFocusLease, shouldReconcileWindowFocus } from "./window-focus-reconcile.js";
import { handleRecRoute } from "./rec/runtime.js";
import { createVatRegistry } from "./vat/registry.js";
import { loadVatMountConfig, resolveVatMountConfigPath, saveVatMountConfig } from "./vat/config.js";
import {
  FOCUS_LEASE_MS,
  applyWindowFocus,
  applyWindowPosition,
  clearFocusLease,
  clearPositionLease,
  positionMatchesTarget,
  pruneExpiredWindowLeases,
  readWindowLeaseState,
  readWindowStates,
  shouldYieldFocusLeaseToObservedNative,
  shouldYieldPositionLeaseToObservedNative,
  satisfyFocusLease,
  satisfyPositionLease,
  type PositionLeasePhase,
  type WindowLeaseState,
} from "./window-state.js";
import { assertAXCursor, assertAXTarget, type AXCursor, type AXTarget, type AXQueryCardinality } from "./a11y/ax-target.js";
import { serializeAXQueryMatches } from "./a11y/ax-query.js";
import type { AXNode } from "./apps/types.js";
const PORT = 7861;

const eventListeners = new Set<(event: AXObserverEvent & { plan: RefreshPlan | null; ts: number }) => void>();
const pendingVatRefreshEvents = new Map<string, AXObserverEvent>();
let vatRefreshTimer: ReturnType<typeof setTimeout> | null = null;
const VAT_REFRESH_DEBOUNCE_MS = 150;

interface OverlayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface OverlayScanBody {
  rects: OverlayRect[];
  durationMs?: number;
  outlineRects?: OverlayRect[];
}

interface OverlayFlashBody {
  rect: OverlayRect;
}

interface DrawOverlayDetachPayload {
  attachmentId: string;
  closeAttachment: true;
  items: [];
}

interface AxTreeLike {
  role?: string;
  children?: AxTreeLike[];
}

function parseAXTargetPayload(value: unknown): AXTarget | undefined {
  if (value === undefined) return undefined;
  return assertAXTarget(value, "AXTarget payload");
}

function parseAXCursorPayload(value: unknown): AXCursor | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || (value as { type?: unknown }).type !== "ax.cursor") {
    return undefined;
  }
  return assertAXCursor(value, "AXCursor payload");
}

function listAXQueryTargetPids(pid?: number, all = false): number[] {
  if (!nativeAX || !nativeAX.axIsProcessTrusted()) {
    throw new Error("AX not trusted");
  }
  if (all) {
    const meta = getAppMetadata();
    const ordered: number[] = [];
    const seen = new Set<number>();
    const pushPid = (value?: number) => {
      if (!Number.isInteger(value) || value! <= 0 || seen.has(value!)) return;
      seen.add(value!);
      ordered.push(value!);
    };
    pushPid(meta.frontPid);
    for (const app of meta.apps) {
      if (!app.regular) continue;
      pushPid(app.pid);
    }
    if (ordered.length === 0) {
      throw new Error("No running regular apps for AX query");
    }
    return ordered;
  }
  const targetPid = pid ?? nativeAX.axGetFrontmostPid();
  if (!targetPid) {
    throw new Error("No frontmost PID");
  }
  return [targetPid];
}

function buildAXQueryMatches(
  query: string,
  pid: number | undefined,
  cardinality: AXQueryCardinality = "all",
  all = false,
  axTarget?: AXTarget,
) {
  if (!nativeAX || !nativeAX.axIsProcessTrusted()) {
    throw new Error("AX not trusted");
  }
  const queries = parseQuery(query);
  const roots: Array<{ pid: number; tree: AXNode }> = [];
  if (axTarget) {
    const subtree = resolveAXQuerySubtree(axTarget);
    roots.push(subtree);
    return serializeAXQueryMatches(roots, query, cardinality);
  }
  for (const targetPid of listAXQueryTargetPids(pid, all)) {
    const tree = nativeAX.axSnapshot(targetPid, 1000);
    if (!tree) {
      if (all) continue;
      throw new Error(`Failed to get AX tree for pid ${targetPid}`);
    }
    roots.push({ pid: targetPid, tree: tree as AXNode });
  }
  return serializeAXQueryMatches(roots, query, cardinality);
}

interface WindowFocusRect {
  cgWindowId?: number;
  x: number;
  y: number;
  w: number;
  h: number;
  title?: string;
}

interface ResolvedWindowTarget {
  pid: number;
  bundleId: string;
  title?: string;
  path: number[];
}

interface FailedWindowTargetResolution {
  key: string;
  error: string;
}

interface PendingWindowMove {
  x: number;
  y: number;
  ensureFront: boolean;
  refresh: boolean;
  final: boolean;
}

type WindowMoveResult = { ok: boolean; error?: string; pid?: number; bundleId?: string; title?: string; queued?: boolean };

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return String(error);
}

function clearNativeDrawAttachment(attachmentId: string): void {
  if (!nativeAX?.axPostOverlay) {
    return;
  }

  const payload: DrawOverlayDetachPayload = {
    attachmentId,
    closeAttachment: true,
    items: [],
  };
  try {
    nativeAX.axPostOverlay("draw", JSON.stringify(payload));
  } catch {}
}

function scheduleVatRefresh(event: AXObserverEvent): void {
  const key = `${event.pid}:${event.bundleId ?? ""}:${event.type}`;
  pendingVatRefreshEvents.set(key, event);
  if (vatRefreshTimer) {
    clearTimeout(vatRefreshTimer);
  }

  vatRefreshTimer = setTimeout(() => {
    vatRefreshTimer = null;
    const events = [...pendingVatRefreshEvents.values()];
    pendingVatRefreshEvents.clear();
    for (const pending of events) {
      vatRegistry.handleAXObserverEvent(pending);
    }
  }, VAT_REFRESH_DEBOUNCE_MS);
}

function focusWindowCenterClick(rect: WindowFocusRect): { x: number; y: number } {
  return {
    x: Math.round(rect.x + rect.w / 2),
    y: Math.round(rect.y + Math.min(Math.max(rect.h * 0.08, 8), 18)),
  };
}

function isCGWindowFrontmost(cgWindowId: number, pid: number): boolean {
  const frontPid = nativeAX.axGetFrontmostPid();
  if (frontPid !== pid) return false;

  const rects = nativeAX.cgGetWindowRects();
  const target = rects.find((item) => Number(item.cgWindowId || 0) === cgWindowId);
  if (!target) return false;

  const frontmostForPid = rects.find((item) => item.pid === pid && Number(item.layer || 0) === Number(target.layer || 0));
  return Number(frontmostForPid?.cgWindowId || 0) === cgWindowId;
}

const resolvedWindowTargetCache = new Map<number, ResolvedWindowTarget>();
const failedDragResolutionCache = new Map<number, FailedWindowTargetResolution>();
const windowMoveQueues = new Map<number, {
  inFlight: boolean;
  pending: PendingWindowMove | null;
  waiters: Array<(result: WindowMoveResult) => void>;
}>();

function windowIdentityKey(rect: { pid: number; layer?: number; x: number; y: number; w: number; h: number; title?: string }): string {
  return [
    rect.pid,
    Number(rect.layer || 0),
    Math.round(rect.x),
    Math.round(rect.y),
    Math.round(rect.w),
    Math.round(rect.h),
    String(rect.title || ""),
  ].join("|");
}

function resolveWindowTarget(
  cgWindowId: number,
  rect: { pid: number; x: number; y: number; w: number; h: number; title?: string },
  bundleId: string,
  strict = true,
): { ok: true; path: number[] } | { ok: false; error: string } {
  const snapshot = nativeAX.axSnapshot(rect.pid, 1000) as FocusableWindowNode | null;
  if (!snapshot) {
    return { ok: false, error: `Window AX node not found: ${cgWindowId}` };
  }

  if (!strict) {
    const match = findWindowFocusMatch(snapshot, {
      cgWindowId,
      x: rect.x,
      y: rect.y,
      w: rect.w,
      h: rect.h,
      title: rect.title,
    });
    if (!match) {
      return { ok: false, error: `Window AX node not found: ${cgWindowId}` };
    }
    resolvedWindowTargetCache.set(cgWindowId, {
      pid: rect.pid,
      bundleId,
      title: rect.title,
      path: [...match.path],
    });
    return { ok: true, path: [...match.path] };
  }

  const resolved = resolveWindowFocusMatch(snapshot, {
    cgWindowId,
    x: rect.x,
    y: rect.y,
    w: rect.w,
    h: rect.h,
    title: rect.title,
  });

  if (!resolved.ok) {
    return { ok: false, error: resolved.error };
  }

  resolvedWindowTargetCache.set(cgWindowId, {
    pid: rect.pid,
    bundleId,
    title: rect.title,
    path: [...resolved.match.path],
  });
  return { ok: true, path: [...resolved.match.path] };
}

function focusWindowByCGWindowId(cgWindowId: number): { ok: boolean; error?: string; pid?: number; bundleId?: string; title?: string } {
  if (!Number.isFinite(cgWindowId) || cgWindowId <= 0) {
    return { ok: false, error: `Invalid cgWindowId: ${cgWindowId}` };
  }

  const rects = nativeAX.cgGetWindowRects();
  const rect = rects.find((item) => Number(item.cgWindowId || 0) === cgWindowId);
  if (!rect) {
    return { ok: false, error: `Window not found: ${cgWindowId}` };
  }

  const apps = nativeAX.wsGetRunningApps();
  const app = apps.find((item) => item.pid === rect.pid);
  const bundleId = app?.bundleId || "";
  const appName = app?.name || "";
  const frontPid = nativeAX.axGetFrontmostPid();
  const appWindows = rects.filter((item) =>
    item.pid === rect.pid
    && Number(item.layer || 0) === Number(rect.layer || 0)
    && Number(item.w || 0) > 0
    && Number(item.h || 0) > 0
    && Number(item.cgWindowId || 0) > 0,
  );
  const requiresExactWindowFocus = appWindows.length > 1;

  if (isCGWindowFrontmost(cgWindowId, rect.pid)) {
    clearFocusSettle();
    return { ok: true, pid: rect.pid, bundleId, title: rect.title };
  }

  const waitForFrontmost = (timeoutMs = 750): boolean => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (isCGWindowFrontmost(cgWindowId, rect.pid)) return true;
      Bun.sleepSync(25);
    }
    return isCGWindowFrontmost(cgWindowId, rect.pid);
  };

  if (nativeAX.axSwitchApp && appName) {
    try {
      if (frontPid !== rect.pid) {
        const switched = nativeAX.axSwitchApp(appName);
        if (switched?.ok && !requiresExactWindowFocus && waitForFrontmost()) {
          clearFocusSettle();
          return { ok: true, pid: rect.pid, bundleId, title: rect.title };
        }
      }
    } catch {}
  }

  if (!requiresExactWindowFocus) {
    // Only return early if the app is actually frontmost.
    // When appName was empty, axSwitchApp was skipped and the app may still be in the background.
    if (isCGWindowFrontmost(cgWindowId, rect.pid)) {
      clearFocusSettle();
      return { ok: true, pid: rect.pid, bundleId, title: rect.title };
    }
    // Fall through to focusWindow which will activate the app by pid
  }

  try {
    // AX child ordering shifts when z-order changes, so cached window paths
    // are only reliable for single-window apps.
    const cached = !requiresExactWindowFocus ? resolvedWindowTargetCache.get(cgWindowId) : null;
    if (cached && cached.pid === rect.pid) {
      try {
        focusWindow(cached.pid, cached.path);
        if (waitForFrontmost()) {
          clearFocusSettle();
          return { ok: true, pid: cached.pid, bundleId: cached.bundleId, title: cached.title };
        }
        resolvedWindowTargetCache.delete(cgWindowId);
      } catch {
        resolvedWindowTargetCache.delete(cgWindowId);
      }
    }

    const resolved = resolveWindowTarget(cgWindowId, rect, bundleId, !requiresExactWindowFocus);
    if (!resolved.ok) {
      return { ok: false, error: resolved.error };
    }

    focusWindow(rect.pid, resolved.path);
    if (!waitForFrontmost()) {
      resolvedWindowTargetCache.delete(cgWindowId);
      return { ok: false, error: `Window did not become frontmost: ${cgWindowId}` };
    }
    clearFocusSettle();
    return { ok: true, pid: rect.pid, bundleId, title: rect.title };
  } catch (error: unknown) {
    return { ok: false, error: errorMessage(error) || `Failed to focus window ${cgWindowId}` };
  }
}

function dragWindowByCGWindowId(
  cgWindowId: number,
  targetX: number,
  targetY: number,
  grabOffsetX: number,
  grabOffsetY: number,
): { ok: boolean; error?: string; pid?: number; bundleId?: string; title?: string } {
  if (!Number.isFinite(cgWindowId) || cgWindowId <= 0) {
    return { ok: false, error: `Invalid cgWindowId: ${cgWindowId}` };
  }
  if (!Number.isFinite(targetX) || !Number.isFinite(targetY)) {
    return { ok: false, error: "Invalid drag target" };
  }

  const moved = moveWindowByCGWindowId(cgWindowId, targetX, targetY, false);
  if (moved.ok) return moved;

  const rects = nativeAX.cgGetWindowRects();
  const rect = rects.find((item) => Number(item.cgWindowId || 0) === cgWindowId);
  if (!rect) {
    return { ok: false, error: `Window not found: ${cgWindowId}` };
  }

  const apps = nativeAX.wsGetRunningApps();
  const app = apps.find((item) => item.pid === rect.pid);
  const bundleId = app?.bundleId || "";
  const roundedTargetX = Math.round(targetX);
  const roundedTargetY = Math.round(targetY);
  const roundedCurrentX = Math.round(rect.x);
  const roundedCurrentY = Math.round(rect.y);
  if (roundedCurrentX === roundedTargetX && roundedCurrentY === roundedTargetY) {
    return { ok: true, pid: rect.pid, bundleId, title: rect.title };
  }

  const cached = resolvedWindowTargetCache.get(cgWindowId);
  if (cached && cached.pid === rect.pid) {
    try {
      setWindowPosition(cached.pid, cached.path, roundedTargetX, roundedTargetY);
      failedDragResolutionCache.delete(cgWindowId);
      return { ok: true, pid: cached.pid, bundleId: cached.bundleId, title: cached.title };
    } catch {
      resolvedWindowTargetCache.delete(cgWindowId);
    }
  }

  const identityKey = windowIdentityKey(rect);
  const failed = failedDragResolutionCache.get(cgWindowId);
  if (failed?.key === identityKey) {
    return { ok: false, error: failed.error };
  }

  const resolved = resolveWindowTarget(cgWindowId, rect, bundleId, false);
  if (!resolved.ok) {
    failedDragResolutionCache.set(cgWindowId, { key: identityKey, error: resolved.error });
    const title = rect.title;
    const grab = clampWindowGrabOffset({ x: rect.x, y: rect.y, w: rect.w, h: rect.h, title }, grabOffsetX, grabOffsetY);
    const startX = Math.round(rect.x + grab.x);
    const startY = Math.round(rect.y + grab.y);
    const endX = Math.round(targetX + grab.x);
    const endY = Math.round(targetY + grab.y);
    try {
      pointerEvent({ action: "drag", x: startX, y: startY, endX, endY });
      return { ok: true, pid: rect.pid, bundleId, title };
    } catch (error: unknown) {
      return { ok: false, error: errorMessage(error) || resolved.error };
    }
  }

  failedDragResolutionCache.delete(cgWindowId);
  try {
    setWindowPosition(rect.pid, resolved.path, roundedTargetX, roundedTargetY);
    return { ok: true, pid: rect.pid, bundleId, title: rect.title };
  } catch (error: unknown) {
    resolvedWindowTargetCache.delete(cgWindowId);
    return { ok: false, error: errorMessage(error) || `Failed to move window ${cgWindowId}` };
  }
}

function moveWindowByCGWindowId(
  cgWindowId: number,
  targetX: number,
  targetY: number,
  ensureFront = false,
): { ok: boolean; error?: string; pid?: number; bundleId?: string; title?: string } {
  if (!Number.isFinite(cgWindowId) || cgWindowId <= 0) {
    return { ok: false, error: `Invalid cgWindowId: ${cgWindowId}` };
  }
  if (!Number.isFinite(targetX) || !Number.isFinite(targetY)) {
    return { ok: false, error: "Invalid move target" };
  }

  const rects = nativeAX.cgGetWindowRects();
  const rect = rects.find((item) => Number(item.cgWindowId || 0) === cgWindowId);
  if (!rect) {
    return { ok: false, error: `Window not found: ${cgWindowId}` };
  }

  const apps = nativeAX.wsGetRunningApps();
  const app = apps.find((item) => item.pid === rect.pid);
  const bundleId = app?.bundleId || "";
  const roundedTargetX = Math.round(targetX);
  const roundedTargetY = Math.round(targetY);
  const roundedCurrentX = Math.round(rect.x);
  const roundedCurrentY = Math.round(rect.y);
  if (roundedCurrentX === roundedTargetX && roundedCurrentY === roundedTargetY) {
    if (!ensureFront || isCGWindowFrontmost(cgWindowId, rect.pid)) {
      return { ok: true, pid: rect.pid, bundleId, title: rect.title };
    }
  }
  if (ensureFront) {
    const focused = focusWindowByCGWindowId(cgWindowId);
    if (!focused.ok) return focused;
  }

  // Skip cache for multi-window apps: AX tree paths shift when z-order changes,
  // so a cached path for window A may now point to window B.
  const appWindowCount = rects.filter((item) =>
    item.pid === rect.pid
    && Number(item.layer || 0) === Number(rect.layer || 0)
    && Number(item.w || 0) > 0
    && Number(item.h || 0) > 0
    && Number(item.cgWindowId || 0) > 0,
  ).length;
  const cached = appWindowCount <= 1 ? resolvedWindowTargetCache.get(cgWindowId) : null;
  if (cached && cached.pid === rect.pid) {
    try {
      setWindowPosition(cached.pid, cached.path, roundedTargetX, roundedTargetY);
      return { ok: true, pid: cached.pid, bundleId: cached.bundleId, title: cached.title };
    } catch {
      resolvedWindowTargetCache.delete(cgWindowId);
    }
  }

  const resolved = resolveWindowTarget(cgWindowId, rect, bundleId, false);
  if (!resolved.ok) {
    return { ok: false, error: resolved.error };
  }

  try {
    setWindowPosition(rect.pid, resolved.path, roundedTargetX, roundedTargetY);
    return { ok: true, pid: rect.pid, bundleId, title: rect.title };
  } catch (error: unknown) {
    return { ok: false, error: errorMessage(error) || `Failed to move window ${cgWindowId}` };
  }
}

function queueWindowMove(
  cgWindowId: number,
  targetX: number,
  targetY: number,
  options: { ensureFront?: boolean; refresh?: boolean; final?: boolean } = {},
): Promise<WindowMoveResult> {
  const state = windowMoveQueues.get(cgWindowId) || { inFlight: false, pending: null, waiters: [] };
  windowMoveQueues.set(cgWindowId, state);

  const incoming: PendingWindowMove = {
    x: targetX,
    y: targetY,
    ensureFront: options.ensureFront === true,
    refresh: options.refresh === true,
    final: options.final === true,
  };

  if (state.inFlight) {
    state.pending = state.pending
      ? {
          x: incoming.x,
          y: incoming.y,
          ensureFront: state.pending.ensureFront || incoming.ensureFront,
          refresh: state.pending.refresh || incoming.refresh,
          final: state.pending.final || incoming.final,
        }
      : incoming;
    if (incoming.refresh || incoming.final || incoming.ensureFront) {
      return new Promise((resolve) => {
        state.waiters.push(resolve);
      });
    }
    return Promise.resolve({ ok: true, queued: true });
  }

  state.inFlight = true;

  return new Promise((resolve) => {
    const run = (move: PendingWindowMove): void => {
      const result: WindowMoveResult = moveWindowByCGWindowId(cgWindowId, move.x, move.y, move.ensureFront);
      if (result.ok) {
        scheduleForegroundFill(move.final ? 24 : 72);
      }
      if (result.ok && move.refresh && activeRefresher) {
        activeRefresher.trigger();
      }

      const next = state.pending;
      state.pending = null;
      if (next) {
        run(next);
        return;
      }

      state.inFlight = false;
      const waiters = state.waiters.splice(0, state.waiters.length);
      for (const waiter of waiters) waiter(result);
      resolve(result);
    };

    run(incoming);
  });
}

function updateWindowPositionInTree(root: { get(key: string): unknown; set(key: string, value: unknown): void }, cgWindowId: number, x: number, y: number): boolean {
  const type = String(root.get("type") || root.get("_tag") || "");
  if (type === "Window" && Number(root.get("cgWindowId")) === cgWindowId) {
    root.set("x", x);
    root.set("y", y);
    return true;
  }

  const children = root.get("_children") as { length: number; get(index: number): { get(key: string): unknown; set(key: string, value: unknown): void } } | undefined;
  if (!children) return false;
  for (let i = 0; i < children.length; i++) {
    if (updateWindowPositionInTree(children.get(i), cgWindowId, x, y)) return true;
  }
  return false;
}

function authorWindowPositionToCRDT(
  cgWindowId: number,
  x: number,
  y: number,
  phase: PositionLeasePhase = "gesture",
): void {
  const roundedX = Math.round(x);
  const roundedY = Math.round(y);

  const displayDoc = store.get(DEFAULT_DOC_PATH);
  if (displayDoc) {
    const root = displayDoc.getMap("root");
    displayDoc.transact(() => {
      applyWindowPosition(root, cgWindowId, roundedX, roundedY, {
        source: "daemon",
        phase,
      });
    });
  }
}

function syncWindowPositionToCRDT(cgWindowId: number, x: number, y: number): void {
  const roundedX = Math.round(x);
  const roundedY = Math.round(y);

  const displayDoc = store.get(DEFAULT_DOC_PATH);
  if (displayDoc) {
    const root = displayDoc.getMap("root");
    displayDoc.transact(() => {
      updateWindowPositionInTree(root, cgWindowId, roundedX, roundedY);
      satisfyPositionLease(root, cgWindowId, roundedX, roundedY);
    });
  }

  const perWindowDoc = store.get(windowDocPath(cgWindowId));
  if (!perWindowDoc) return;
  const root = perWindowDoc.getMap("root");
  perWindowDoc.transact(() => {
    root.set("x", roundedX);
    root.set("y", roundedY);
  });
}

function clampWindowGrabOffset(rect: WindowFocusRect, grabOffsetX: number, grabOffsetY: number): { x: number; y: number } {
  return {
    x: Math.min(Math.max(Math.round(grabOffsetX), 16), Math.max(16, Math.round(rect.w) - 16)),
    y: Math.min(Math.max(Math.round(grabOffsetY), 8), Math.min(Math.max(Math.round(rect.h * 0.12), 18), Math.round(rect.h) - 8)),
  };
}

function _ts() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}.${String(d.getMilliseconds()).padStart(3,'0')}`;
}

// Padded, color-coded log components (12 chars wide including brackets)
const _colors: Record<string, string> = {
  daemon:    "\x1b[36m",  // cyan
  "ax-obs":  "\x1b[35m",  // magenta
  a11y:      "\x1b[32m",  // green
  crdt:      "\x1b[34m",  // blue
  icon:      "\x1b[90m",  // gray
  wallpaper: "\x1b[90m",  // gray
};
const _reset = "\x1b[0m";
const _pad = 6; // max component name length

export function _log(component: string, msg: string) {
  const color = _colors[component] || "";
  const tag = `[${component}]`.padEnd(_pad + 2);
  console.log(`${_ts()} ${color}${tag}${_reset} ${msg}`);
}

configureRefresherRuntime({
  refreshWallpaper,
  log: _log,
});

// If launched as a subprocess of GhostUI.app, exit when parent dies
const PARENT_PID = process.env.GHOSTUI_PARENT_PID
  ? parseInt(process.env.GHOSTUI_PARENT_PID, 10)
  : null;
if (PARENT_PID) {
  setInterval(() => {
    try {
      process.kill(PARENT_PID, 0); // signal 0 = check if alive
    } catch {
      _log("daemon", "parent process gone, exiting");
      process.exit(0);
    }
  }, 2000);
}

// N-API AX module is loaded via native-ax.ts
const nativeAX = getNativeAX();

function actorErrorResponse(error: unknown): Response {
  const body = actorErrorBody(error);
  return new Response(JSON.stringify({ ok: false, error: body.error, message: body.message }), {
    status: body.status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });
}

// Actor runtime — wired to Swift overlay via NSDistributedNotification
const actorRuntime = new ActorRuntime({
  postOverlay(kind, payload) {
    if (!nativeAX?.axPostOverlay) {
      throw new Error("N-API axPostOverlay not available");
    }
    nativeAX.axPostOverlay(kind, payload);
  },
  getDisplays: () => getDisplays(),
  getMousePosition: () => nativeAX?.cgGetMousePosition?.() ?? null,
});

const store = new CRDTStore();
const vatRegistry = createVatRegistry();
const vatMountConfigPath = resolveVatMountConfigPath();
try {
  const persistedVatMounts = await loadVatMountConfig(vatMountConfigPath);
  vatRegistry.loadPersisted(persistedVatMounts, (mount, error) => {
    _log("daemon", `failed to realize persisted VAT mount ${mount.path}: ${errorMessage(error)}`);
  });
} catch (error: unknown) {
  _log("daemon", `failed to load VAT mount config ${vatMountConfigPath}: ${errorMessage(error)}`);
}

// Load fixture JSON if available (for development without GhostUI app)
import { existsSync, readFileSync } from "fs";
const FIXTURE_PATH = resolve(import.meta.dir, "..", "..", "..", "ghost-fixture.json");
const FIXTURE_ALT = "/tmp/ghostui-crdt-tree.json";

for (const fp of [FIXTURE_PATH, FIXTURE_ALT]) {
  if (existsSync(fp)) {
    try {
      const raw = readFileSync(fp, "utf-8").trim();
      if (raw) {
        const tree = JSON.parse(raw) as TreeNode;
        store.loadFromTree(DEFAULT_DOC_PATH, tree);
        _log("daemon", `loaded fixture from ${fp}`);
        break;
      }
    } catch (e) {
      console.error(`Failed to load JSON fixture ${fp}:`, e);
    }
  }
}

let activeRefresher: Refresher | null = null;
let foregroundFillTimer: ReturnType<typeof setTimeout> | null = null;
let foregroundFillDueAt = Number.POSITIVE_INFINITY;
const SYNTHETIC_INPUT_FOLLOW_UP_MS = 250;
let syntheticInputFollowUpTimer: ReturnType<typeof setTimeout> | null = null;
let lastReconciledFocusWindowId = 0;
let lastReconciledFocusAt = 0;
const FOCUS_SETTLE_MS = FOCUS_LEASE_MS;
let pendingFocusTargetWindowId = 0;
let pendingFocusExpiresAt = 0;

function beginFocusSettle(cgWindowId: number): void {
  pendingFocusTargetWindowId = cgWindowId;
  pendingFocusExpiresAt = Date.now() + FOCUS_SETTLE_MS;
}

function clearFocusSettle(): void {
  pendingFocusTargetWindowId = 0;
  pendingFocusExpiresAt = 0;
}

function scheduleSyntheticInputFollowUp(): void {
  if (syntheticInputFollowUpTimer) clearTimeout(syntheticInputFollowUpTimer);
  syntheticInputFollowUpTimer = setTimeout(() => {
    syntheticInputFollowUpTimer = null;
    activeRefresher?.trigger();
  }, SYNTHETIC_INPUT_FOLLOW_UP_MS);
}

function scheduleForegroundFill(delayMs: number): void {
  if (!activeRefresher) return;

  const dueAt = Date.now() + delayMs;
  if (foregroundFillTimer && dueAt >= foregroundFillDueAt) return;

  if (foregroundFillTimer) clearTimeout(foregroundFillTimer);
  foregroundFillDueAt = dueAt;
  foregroundFillTimer = setTimeout(() => {
    foregroundFillTimer = null;
    foregroundFillDueAt = Number.POSITIVE_INFINITY;
    activeRefresher?.trigger();
  }, delayMs);
}

function writeWindowFocusToCRDT(cgWindowId: number): boolean {
  const doc = store.getOrCreate(DEFAULT_DOC_PATH);
  const root = doc.getMap("root");
  let applied = false;
  doc.transact(() => {
    applied = applyWindowFocus(root, cgWindowId);
  });
  return applied;
}

function resolveDesiredFrontWindowId(
  desiredStates: ReturnType<typeof readWindowStates>,
  leases: WindowLeaseState,
): number {
  if (leases.focus?.cgWindowId && Number.isFinite(Number(leases.focus.cgWindowId))) {
    return Number(leases.focus.cgWindowId);
  }
  const desired = desiredStates
    .filter((state) => Number.isFinite(state.cgWindowId) && state.cgWindowId > 0)
    .sort((left, right) => (left.z ?? Number.POSITIVE_INFINITY) - (right.z ?? Number.POSITIVE_INFINITY));
  return Number(desired[0]?.cgWindowId || 0);
}

function reconcileWindowFocusFromCRDT(root: Y.Map<unknown>, desiredStates: ReturnType<typeof readWindowStates>, leases: WindowLeaseState): void {
  const desiredFrontId = resolveDesiredFrontWindowId(desiredStates, leases);
  const now = Date.now();
  if (shouldClearWindowFocusLease(leases, desiredFrontId, pendingFocusTargetWindowId, pendingFocusExpiresAt, now)) {
    clearFocusLease(root);
    clearFocusSettle();
    return;
  }
  if (!shouldReconcileWindowFocus(leases, desiredFrontId, pendingFocusTargetWindowId, pendingFocusExpiresAt, now)) return;

  const nativeRects = nativeAX.cgGetWindowRects();
  const nativeFrontId = Number(nativeRects[0]?.cgWindowId || 0);
  if (shouldYieldFocusLeaseToObservedNative(leases.focus, nativeFrontId, now)) {
    clearFocusLease(root);
    clearFocusSettle();
    activeRefresher?.trigger();
    return;
  }

  const desiredFrontRect = nativeRects.find((rect) => Number(rect.cgWindowId || 0) === desiredFrontId);
  if (desiredFrontRect && isCGWindowFrontmost(desiredFrontId, desiredFrontRect.pid)) {
    lastReconciledFocusWindowId = desiredFrontId;
    satisfyFocusLease(root, desiredFrontId);
    clearFocusSettle();
    return;
  }

  if (lastReconciledFocusWindowId === desiredFrontId && now - lastReconciledFocusAt < 150) {
    return;
  }

  const result = focusWindowByCGWindowId(desiredFrontId);
  lastReconciledFocusWindowId = desiredFrontId;
  lastReconciledFocusAt = now;
  if (!result.ok) return;
  beginFocusSettle(desiredFrontId);
  activeRefresher?.trigger();
}

function reconcileWindowPositionsFromCRDT(root: Y.Map<unknown>, _desiredStates: ReturnType<typeof readWindowStates>, leases: WindowLeaseState): void {
  if (!leases.positions || Object.keys(leases.positions).length === 0) return;

  const nativeRects = new Map<number, { x: number; y: number }>();
  for (const rect of nativeAX.cgGetWindowRects()) {
    const cgWindowId = Number(rect.cgWindowId || 0);
    if (!Number.isFinite(cgWindowId) || cgWindowId <= 0) continue;
    nativeRects.set(cgWindowId, { x: Math.round(rect.x), y: Math.round(rect.y) });
  }

  const now = Date.now();
  for (const lease of Object.values(leases.positions)) {
    const cgWindowId = lease.cgWindowId;
    const desiredX = lease.targetX;
    const desiredY = lease.targetY;
    const native = nativeRects.get(cgWindowId);
    if (native && shouldYieldPositionLeaseToObservedNative(lease, native.x, native.y, now)) {
      clearPositionLease(root, cgWindowId);
      syncWindowPositionToCRDT(cgWindowId, native.x, native.y);
      continue;
    }
    if (native && positionMatchesTarget(desiredX, desiredY, native.x, native.y)) {
      satisfyPositionLease(root, cgWindowId, desiredX, desiredY);
      continue;
    }
    void queueWindowMove(cgWindowId, desiredX, desiredY, { refresh: lease.phase !== "gesture" });
  }
}

function reconcileNativeWindowsFromCRDT(): void {
  const doc = store.get(DEFAULT_DOC_PATH);
  if (!doc) return;
  const root = doc.getMap("root");
  let leases: WindowLeaseState;
  doc.transact(() => {
    leases = pruneExpiredWindowLeases(root);
  });
  const desiredStates = readWindowStates(root);
  leases = readWindowLeaseState(root);
  if (desiredStates.length === 0 && !leases.focus && !leases.positions) return;
  reconcileWindowFocusFromCRDT(root, desiredStates, leases);
  reconcileWindowPositionsFromCRDT(root, desiredStates, leases);
}

// Icon cache: app name → PNG bytes (null = known-missing, don't retry)
const iconCache = new Map<string, Uint8Array | null>();

async function runCmd(args: string[]): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout: stdout.trim(), exitCode };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Extract app icon as PNG bytes via Python/AppKit (handles .icns + asset catalogs) */
async function extractIconViaAppKit(appPath: string, tmpPng: string): Promise<boolean> {
  const script = `
import sys
from AppKit import NSWorkspace, NSBitmapImageRep, NSPNGFileType
icon = NSWorkspace.sharedWorkspace().iconForFile_(sys.argv[1])
icon.setSize_((64, 64))
rep = NSBitmapImageRep.imageRepWithData_(icon.TIFFRepresentation())
png = rep.representationUsingType_properties_(NSPNGFileType, None)
with open(sys.argv[2], 'wb') as f:
    f.write(png)
`;
  const proc = Bun.spawn(["python3", "-c", script, appPath, tmpPng], { stdout: "pipe", stderr: "pipe" });
  return (await proc.exited) === 0;
}

async function serveIcon(name: string): Promise<Response> {
  if (!name) return new Response("Missing name parameter", { status: 400 });

  const cached = iconCache.get(name);
  if (cached) {
    return new Response(toArrayBuffer(cached), {
      headers: { "content-type": "image/png", "cache-control": "max-age=3600", "access-control-allow-origin": "*" },
    });
  }
  if (cached === null) {
    return new Response("Not found (cached)", { status: 404, headers: { "access-control-allow-origin": "*" } });
  }

  const tmpPng = `/tmp/ghost-icon-${name.replace(/[^a-zA-Z0-9]/g, "_")}.png`;

  try {
    // Special system icons — use .icns directly
    const systemIcns: Record<string, string> = {
      Trash: "/System/Library/CoreServices/CoreTypes.bundle/Contents/Resources/TrashIcon.icns",
      Downloads: "/System/Library/CoreServices/CoreTypes.bundle/Contents/Resources/DownloadsFolder.icns",
      Documents: "/System/Library/CoreServices/CoreTypes.bundle/Contents/Resources/DocumentsFolderIcon.icns",
    };

    const directIcns = systemIcns[name];
    if (directIcns) {
      const sips = await runCmd(["sips", "-s", "format", "png", "-Z", "64", directIcns, "--out", tmpPng]);
      if (sips.exitCode === 0) {
        const pngData = new Uint8Array(await Bun.file(tmpPng).arrayBuffer());
        iconCache.set(name, pngData);
        return new Response(toArrayBuffer(pngData), {
          headers: { "content-type": "image/png", "cache-control": "max-age=3600", "access-control-allow-origin": "*" },
        });
      }
    }

    // Find app via mdfind
    const find = await runCmd([
      "mdfind",
      `kMDItemDisplayName == '${name.replace(/'/g, "\\'")}' && kMDItemContentType == 'com.apple.application-bundle'`,
    ]);
    const appPath = find.stdout.split("\n")[0];

    if (appPath) {
      // Try .icns first (fast path)
      const plistRead = await runCmd(["defaults", "read", `${appPath}/Contents/Info`, "CFBundleIconFile"]);
      let iconFile = plistRead.stdout;
      if (iconFile) {
        if (!iconFile.endsWith(".icns")) iconFile += ".icns";
        const icnsPath = `${appPath}/Contents/Resources/${iconFile}`;
        const sips = await runCmd(["sips", "-s", "format", "png", "-Z", "64", icnsPath, "--out", tmpPng]);
        if (sips.exitCode === 0) {
          const pngData = new Uint8Array(await Bun.file(tmpPng).arrayBuffer());
          iconCache.set(name, pngData);
          return new Response(toArrayBuffer(pngData), {
            headers: { "content-type": "image/png", "cache-control": "max-age=3600", "access-control-allow-origin": "*" },
          });
        }
      }

      // Fallback: extract via AppKit (handles asset catalogs, any app)
      if (await extractIconViaAppKit(appPath, tmpPng)) {
        // Resize to 64px
        await runCmd(["sips", "-Z", "64", tmpPng]);
        const pngData = new Uint8Array(await Bun.file(tmpPng).arrayBuffer());
        iconCache.set(name, pngData);
        return new Response(toArrayBuffer(pngData), {
          headers: { "content-type": "image/png", "cache-control": "max-age=3600", "access-control-allow-origin": "*" },
        });
      }
    }

    // mdfind missed it — try common app directories directly
    const searchDirs = ["/Applications", "/System/Applications", "/Applications/Utilities", `${process.env.HOME}/Applications`];
    for (const dir of searchDirs) {
      const candidatePath = `${dir}/${name}.app`;
      if (await Bun.file(`${candidatePath}/Contents/Info.plist`).exists()) {
        if (await extractIconViaAppKit(candidatePath, tmpPng)) {
          await runCmd(["sips", "-Z", "64", tmpPng]);
          const pngData = new Uint8Array(await Bun.file(tmpPng).arrayBuffer());
          iconCache.set(name, pngData);
          return new Response(toArrayBuffer(pngData), {
            headers: { "content-type": "image/png", "cache-control": "max-age=3600", "access-control-allow-origin": "*" },
          });
        }
      }
    }

    // Also check .build directory for dev apps like GhostUI
    // import.meta.dir = macOS/ghost/src → macOS/ghost → GhostUI (project root)
    const devPath = `${resolve(import.meta.dir, "..", "..", "..", ".build")}/${name}.app`;
    if (await Bun.file(`${devPath}/Contents/Info.plist`).exists()) {
      if (await extractIconViaAppKit(devPath, tmpPng)) {
        await runCmd(["sips", "-Z", "64", tmpPng]);
        const pngData = new Uint8Array(await Bun.file(tmpPng).arrayBuffer());
        iconCache.set(name, pngData);
        return new Response(toArrayBuffer(pngData), {
          headers: { "content-type": "image/png", "cache-control": "max-age=3600", "access-control-allow-origin": "*" },
        });
      }
    }

    iconCache.set(name, null);
    return new Response("App not found", { status: 404, headers: { "access-control-allow-origin": "*" } });
  } catch (e: unknown) {
    console.error("[icon]", e);
    return new Response("Icon error: " + errorMessage(e), { status: 500, headers: { "access-control-allow-origin": "*" } });
  }
}

// Wallpaper: written to assets dir so it's served as a static file
const WALLPAPER_ASSET = resolve(import.meta.dir, "assets", "wallpaper.jpg");
let lastWallpaperSource = "";

/** Refresh wallpaper asset if the desktop picture changed. Returns the asset URL. */
export async function refreshWallpaper(): Promise<string> {
  const assetUrl = "/assets/wallpaper.jpg";
  try {
    const proc = Bun.spawn(["osascript", "-e", 'tell application "System Events" to get picture of every desktop'], {
      stdout: "pipe", stderr: "pipe",
    });
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    if (!out) return assetUrl;

    if (out === lastWallpaperSource) return assetUrl;
    lastWallpaperSource = out;

    // Convert to JPEG via sips (handles HEIC, PNG, etc.)
    const sips = Bun.spawn(["sips", "-s", "format", "jpeg", "-s", "formatOptions", "70", out, "--out", WALLPAPER_ASSET], {
      stdout: "pipe", stderr: "pipe",
    });
    await sips.exited;
  } catch (e) {
    console.error("[wallpaper]", e);
  }
  return assetUrl;
}

// Refresh wallpaper on startup
refreshWallpaper();

const auth = createDaemonAuthContext();

const server = Bun.serve({
  port: PORT,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const authResponse = auth.authorize(req, url);
    if (authResponse) return authResponse;

    if (url.pathname === "/api/icon") {
      const name = url.searchParams.get("name") || "";
      return await serveIcon(name);
    }

    {
      const recRes = await handleRecRoute(req, url, {
        getDisplays: () => getDisplays(),
        getWindowRects: () => nativeAX.cgGetWindowRects(),
        screenshot: (format?: string) => screenshot(format),
      });
      if (recRes) return recRes;
    }


    // Switch app by display name (e.g. "Finder", "Safari") using native CMD+Tab simulation
    if (req.method === "POST" && url.pathname === "/api/switch-app") {
      try {
        const { name } = await req.json() as { name: string };
        if (!name) {
          return new Response("Missing 'name' field", {
            status: 400,
            headers: { "access-control-allow-origin": "*" },
          });
        }

        if (!nativeAX?.axSwitchApp) {
          return new Response(JSON.stringify({ ok: false, error: "N-API axSwitchApp not available" }), {
            status: 502,
            headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
          });
        }

        const result = nativeAX.axSwitchApp(name);

        // Trigger tree update after switch
        if (result.ok && activeRefresher) {
          activeRefresher.trigger();
        }

        return new Response(JSON.stringify(result), {
          status: result.ok ? 200 : 502,
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      } catch (e: unknown) {
        return new Response(JSON.stringify({ ok: false, error: errorMessage(e) || "switch-app failed" }), {
          status: 502,
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/window/focus") {
      try {
        const { cgWindowId } = await req.json() as { cgWindowId?: number };
        const numericWindowId = Number(cgWindowId);
        if (!Number.isFinite(numericWindowId) || numericWindowId <= 0) {
          return new Response(JSON.stringify({ ok: false, error: `Invalid cgWindowId: ${cgWindowId}` }), {
            status: 404,
            headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
          });
        }
        const result = focusWindowByCGWindowId(numericWindowId);
        if (!result.ok) {
          return new Response(JSON.stringify(result), {
            status: 409,
            headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
          });
        }
        beginFocusSettle(numericWindowId);
        const leased = writeWindowFocusToCRDT(numericWindowId);
        if (leased) {
          reconcileNativeWindowsFromCRDT();
        } else {
          activeRefresher?.trigger();
        }
        return new Response(JSON.stringify({ ...result, leased }), {
          status: 200,
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      } catch (e: unknown) {
        return new Response(JSON.stringify({ ok: false, error: errorMessage(e) || "window focus failed" }), {
          status: 502,
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/window/drag") {
      try {
        const { cgWindowId, targetX, targetY } = await req.json() as {
          cgWindowId?: number;
          targetX?: number;
          targetY?: number;
        };
        const numericWindowId = Number(cgWindowId);
        const x = Number(targetX);
        const y = Number(targetY);
        if (!Number.isFinite(numericWindowId) || numericWindowId <= 0) {
          return new Response(JSON.stringify({ ok: false, error: `Invalid cgWindowId: ${cgWindowId}` }), {
            status: 404,
            headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
          });
        }
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          return new Response(JSON.stringify({ ok: false, error: "Invalid drag target" }), {
            status: 400,
            headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
          });
        }
        authorWindowPositionToCRDT(numericWindowId, x, y, "settling");
        void queueWindowMove(
          numericWindowId,
          x,
          y,
          {
            ensureFront: false,
            refresh: true,
            final: true,
          },
        );
        return new Response(JSON.stringify({ ok: true, queued: true }), {
          status: 202,
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      } catch (e: unknown) {
        return new Response(JSON.stringify({ ok: false, error: errorMessage(e) || "window drag failed" }), {
          status: 502,
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      }
    }

    // AX snapshot via N-API (used by audit)
    if (req.method === "GET" && url.pathname === "/api/a11y/snapshot") {
      try {
        const focusedDepth = parseInt(url.searchParams.get("focusedDepth") || "1000");
        const visibleDepth = parseInt(url.searchParams.get("visibleDepth") || "3");
        const snap = buildSnapshot({ focusedDepth, visibleDepth });
        if (!snap) {
          return new Response(JSON.stringify({ error: "Native AX not available or not trusted" }), {
            status: 502,
            headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
          });
        }
        return new Response(JSON.stringify(snap), {
          status: 200,
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      } catch (e: unknown) {
        return new Response(JSON.stringify({ error: errorMessage(e) || "snapshot failed" }), {
          status: 502,
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      }
    }

    // Keyboard input via N-API CGEvent posting
    if (req.method === "POST" && url.pathname === "/api/input") {
      try {
        const body = await req.json() as { keys?: string[]; modifiers?: string[]; text?: string; rate?: number };
        if (!nativeAX?.axPostKeyboardInput) {
          return new Response(JSON.stringify({ ok: false, error: "N-API axPostKeyboardInput not available" }), {
            status: 502,
            headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
          });
        }
        nativeAX.axPostKeyboardInput(body);
        if (activeRefresher) {
          activeRefresher.trigger();
          scheduleSyntheticInputFollowUp();
        }
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      } catch (e: unknown) {
        return new Response(JSON.stringify({ ok: false, error: errorMessage(e) || "input failed" }), {
          status: 502,
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      }
    }

    // CG pointer injection routes
    if (req.method === "POST" && url.pathname.startsWith("/api/cg/") &&
        ["move", "click", "doubleclick", "drag", "scroll"].some(cmd => url.pathname === `/api/cg/${cmd}`)) {
      try {
        if (!nativeAX?.axPointerEvent) {
          return new Response(JSON.stringify({ ok: false, error: "N-API axPointerEvent not available" }), {
            status: 502,
            headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
          });
        }
        const cgAction = url.pathname.slice("/api/cg/".length);
        const body = await req.json() as Record<string, unknown>;
        const x = Number(body.x);
        const y = Number(body.y);

        if (cgAction === "move") {
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            return new Response(JSON.stringify({ ok: false, error: "x and y must be finite numbers" }), {
              status: 400, headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
            });
          }
          pointerEvent({ action: "move", x, y });
        } else if (cgAction === "click") {
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            return new Response(JSON.stringify({ ok: false, error: "x and y must be finite numbers" }), {
              status: 400, headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
            });
          }
          const button = typeof body.button === "string" ? body.button : undefined;
          pointerEvent({ action: "click", x, y, button });
        } else if (cgAction === "doubleclick") {
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            return new Response(JSON.stringify({ ok: false, error: "x and y must be finite numbers" }), {
              status: 400, headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
            });
          }
          const button = typeof body.button === "string" ? body.button : undefined;
          pointerEvent({ action: "doubleclick", x, y, button });
        } else if (cgAction === "drag") {
          const fromX = Number(body.fromX);
          const fromY = Number(body.fromY);
          const toX = Number(body.toX);
          const toY = Number(body.toY);
          if (!Number.isFinite(fromX) || !Number.isFinite(fromY) || !Number.isFinite(toX) || !Number.isFinite(toY)) {
            return new Response(JSON.stringify({ ok: false, error: "fromX, fromY, toX, toY must be finite numbers" }), {
              status: 400, headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
            });
          }
          const button = typeof body.button === "string" ? body.button : undefined;
          pointerEvent({ action: "drag", x: fromX, y: fromY, endX: toX, endY: toY, button });
        } else {
          // scroll
          const dx = Number(body.dx);
          const dy = Number(body.dy);
          if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(dx) || !Number.isFinite(dy)) {
            return new Response(JSON.stringify({ ok: false, error: "x, y, dx, dy must be finite numbers" }), {
              status: 400, headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
            });
          }
          pointerEvent({ action: "scroll", x, y, deltaX: dx, deltaY: dy });
        }

        if (activeRefresher) {
          activeRefresher.trigger();
          scheduleSyntheticInputFollowUp();
        }
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      } catch (e: unknown) {
        return new Response(JSON.stringify({ ok: false, error: errorMessage(e) || "cg pointer event failed" }), {
          status: 502,
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      }
    }

    // CG keyboard state routes: keydown, keyup, moddown, modup
    if (req.method === "POST" && (
      url.pathname === "/api/cg/keydown" ||
      url.pathname === "/api/cg/keyup" ||
      url.pathname === "/api/cg/moddown" ||
      url.pathname === "/api/cg/modup"
    )) {
      try {
        const cgKbAction = url.pathname.slice("/api/cg/".length) as "keydown" | "keyup" | "moddown" | "modup";
        const body = await req.json() as Record<string, unknown>;

        if (cgKbAction === "keydown" || cgKbAction === "keyup") {
          const fn = cgKbAction === "keydown" ? nativeAX?.cgKeyDown : nativeAX?.cgKeyUp;
          if (!fn) {
            return new Response(JSON.stringify({ ok: false, error: `N-API ${cgKbAction} not available` }), {
              status: 502, headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
            });
          }
          const key = typeof body.key === "string" ? body.key : undefined;
          if (!key) {
            return new Response(JSON.stringify({ ok: false, error: "'key' string required" }), {
              status: 400, headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
            });
          }
          const mods = Array.isArray(body.mods) ? (body.mods as string[]) : undefined;
          fn.call(nativeAX, { key, ...(mods ? { mods } : {}) });
        } else {
          // moddown / modup
          const fn = cgKbAction === "moddown" ? nativeAX?.cgModDown : nativeAX?.cgModUp;
          if (!fn) {
            return new Response(JSON.stringify({ ok: false, error: `N-API ${cgKbAction} not available` }), {
              status: 502, headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
            });
          }
          const mods = Array.isArray(body.mods) ? (body.mods as string[]) : [];
          if (mods.length === 0) {
            return new Response(JSON.stringify({ ok: false, error: "'mods' non-empty array required" }), {
              status: 400, headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
            });
          }
          fn.call(nativeAX, mods);
        }

        if (activeRefresher) {
          activeRefresher.trigger();
          scheduleSyntheticInputFollowUp();
        }
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      } catch (e: unknown) {
        return new Response(JSON.stringify({ ok: false, error: errorMessage(e) || "cg keyboard event failed" }), {
          status: 502, headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      }
    }

    // CG pointer state routes: mousepos, mousestate
    if (req.method === "GET" && (url.pathname === "/api/cg/mousepos" || url.pathname === "/api/cg/mousestate")) {
      try {
        if (url.pathname === "/api/cg/mousepos") {
          if (!nativeAX?.cgGetMousePosition) {
            return new Response(JSON.stringify({ ok: false, error: "N-API cgGetMousePosition not available" }), {
              status: 502, headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
            });
          }
          const pos = nativeAX.cgGetMousePosition();
          return new Response(JSON.stringify(pos), {
            headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
          });
        } else {
          if (!nativeAX?.cgGetMouseState) {
            return new Response(JSON.stringify({ ok: false, error: "N-API cgGetMouseState not available" }), {
              status: 502, headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
            });
          }
          const state = nativeAX.cgGetMouseState();
          return new Response(JSON.stringify(state), {
            headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
          });
        }
      } catch (e: unknown) {
        return new Response(JSON.stringify({ ok: false, error: errorMessage(e) || "cg pointer state failed" }), {
          status: 502, headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      }
    }

    // Overlay scan via NSDistributedNotification to GhostUI Swift app
    if (req.method === "POST" && url.pathname === "/api/overlay/scan") {
      try {
        const body = await req.json() as OverlayScanBody;
        if (!nativeAX?.axPostOverlay) {
          return new Response(JSON.stringify({ ok: false, error: "N-API axPostOverlay not available" }), {
            status: 502,
            headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
          });
        }
        nativeAX.axPostOverlay("scan", JSON.stringify(body));
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      } catch (e: unknown) {
        return new Response(JSON.stringify({ ok: false, error: errorMessage(e) || "overlay failed" }), {
          status: 502,
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      }
    }

    // Overlay draw via NSDistributedNotification to GhostUI Swift app
    if (req.method === "POST" && url.pathname === "/api/overlay/draw") {
      try {
        const body = normalizeDrawScriptPayload(await req.json() as unknown);
        if (!nativeAX?.axPostOverlay) {
          return new Response(JSON.stringify({ ok: false, error: "N-API axPostOverlay not available" }), {
            status: 502,
            headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
          });
        }
        const axPostOverlay = nativeAX.axPostOverlay;

        return makeOverlayDrawResponse(
          body,
          {
            postOverlay: (payload) => axPostOverlay("draw", payload),
            clearAttachment: clearNativeDrawAttachment,
          },
          req.signal,
        );
      } catch (e: unknown) {
        const status = e instanceof DrawScriptValidationError ? 400 : 502;
        return new Response(JSON.stringify({ ok: false, error: errorMessage(e) || "overlay failed" }), {
          status,
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      }
    }

    // Overlay flash via NSDistributedNotification to GhostUI Swift app
    if (req.method === "POST" && url.pathname === "/api/overlay/flash") {
      try {
        const body = await req.json() as OverlayFlashBody;
        if (!nativeAX?.axPostOverlay) {
          return new Response(JSON.stringify({ ok: false, error: "N-API axPostOverlay not available" }), {
            status: 502,
            headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
          });
        }
        nativeAX.axPostOverlay("flash", JSON.stringify(body));
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      } catch (e: unknown) {
        return new Response(JSON.stringify({ ok: false, error: errorMessage(e) || "overlay failed" }), {
          status: 502,
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/actors/spawn") {
      try {
        const body = normalizeActorSpawnRequest(await req.json() as unknown);
        const result = actorRuntime.spawn(body);
        return new Response(JSON.stringify(result), {
          status: 201,
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      } catch (error) {
        return actorErrorResponse(error);
      }
    }

    if (req.method === "GET" && url.pathname === "/api/actors") {
      try {
        return new Response(JSON.stringify(actorRuntime.list()), {
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      } catch (error) {
        return actorErrorResponse(error);
      }
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/actors/")) {
      const actorName = decodeURIComponent(url.pathname.slice("/api/actors/".length));
      if (!actorName || actorName.includes("/")) {
        return new Response(JSON.stringify({ ok: false, error: "invalid_args", message: "Invalid actor name" }), {
          status: 400,
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      }
      try {
        return new Response(JSON.stringify(actorRuntime.kill(actorName)), {
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      } catch (error) {
        return actorErrorResponse(error);
      }
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/actors/") && url.pathname.endsWith("/run")) {
      const actorName = decodeURIComponent(url.pathname.slice("/api/actors/".length, -"/run".length));
      if (!actorName || actorName.includes("/")) {
        return new Response(JSON.stringify({ ok: false, error: "invalid_args", message: "Invalid actor name" }), {
          status: 400,
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      }
      try {
        const body = normalizeActorRunRequest(await req.json() as unknown);
        const result = await actorRuntime.run(actorName, body);
        return new Response(JSON.stringify(result), {
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      } catch (error) {
        return actorErrorResponse(error);
      }
    }

    // Semantic action dispatch: { app, type, id, action }
    if (req.method === "POST" && url.pathname === "/api/action") {
      try {
        const target = await req.json() as ActionTarget;
        // Look up bundle-specific action resolver, fall back to default
        const bundle = getBundle(target.app);
        let cmd: ActionCommand | null = null;
        if (bundle?.resolveAction) {
          // Get current AX tree for context-aware resolution via N-API
          try {
            const snap = buildSnapshot({ focusedDepth: 1000 });
            const axTree = snap?.channels?.focused?.items?.[0]?.tree;
            if (axTree) cmd = bundle.resolveAction(target, axTree);
          } catch {}
        }
        if (!cmd) cmd = defaultResolveAction(target);
        // Pointer-based fallback: if no resolver matched but coordinates are available,
        // use a pointer click. This handles elements that lack an AX identifier but
        // have frame coordinates in the CRDT tree.
        if (!cmd && target.x != null && target.y != null && target.action === "press") {
          cmd = { method: "pointer", x: target.x, y: target.y, action: "click" };
        }
        if (!cmd) {
          return new Response("Cannot resolve action", {
            status: 400,
            headers: { "access-control-allow-origin": "*" },
          });
        }

        // Pass target app so N-API searches in the right process.
        const axTarget = target.app ? `app:${target.app}` : undefined;

        let actionResult: { ok: boolean; error?: string };

        switch (cmd.method) {
          case "axAction":
            actionResult = findAndPerformAction({ label: cmd.label, role: cmd.role, action: cmd.action, target: axTarget, nth: cmd.nth, parent: cmd.parent });
            break;
          case "axHover":
            actionResult = findAndHover({ label: cmd.label!, role: cmd.role, target: axTarget, nth: cmd.nth, parent: cmd.parent });
            break;
          case "axSetValue":
            actionResult = findAndSetValue({ value: cmd.value!, label: cmd.label, role: cmd.role, target: axTarget, nth: cmd.nth, parent: cmd.parent });
            break;
          case "axTypeValue":
            actionResult = findAndType({ value: cmd.value!, label: cmd.label, role: cmd.role, target: axTarget, nth: cmd.nth, parent: cmd.parent });
            break;
          case "pointer":
            actionResult = pointerEvent({ x: cmd.x, y: cmd.y, action: cmd.action! });
            break;
          case "pointerScroll":
            actionResult = pointerEvent({ x: cmd.x, y: cmd.y, action: "scroll", deltaX: cmd.dx, deltaY: cmd.dy });
            break;
          case "keyboard":
            if (nativeAX?.axPostKeyboardInput) {
              nativeAX.axPostKeyboardInput({ keys: cmd.keys, modifiers: cmd.modifiers, text: cmd.text });
              actionResult = { ok: true };
            } else {
              actionResult = { ok: false, error: "N-API keyboard not available" };
            }
            break;
          default:
            actionResult = { ok: false, error: `Unknown action method: ${(cmd as { method: string }).method}` };
        }

        // Pointer fallback: when an axAction fails (element not found)
        // but we have frame coordinates from the CRDT, retry as a pointer click.
        if (!actionResult.ok && cmd.method === "axAction" && cmd.action === "AXPress"
            && target.x != null && target.y != null) {
          actionResult = pointerEvent({ x: target.x, y: target.y, action: "click" });
        }

        // Compute follow-up query
        const followUp = bundle?.followUpQuery?.(target) ?? defaultFollowUp(target.type, target.action, target.axRole);

        // Trigger a CRDT refresh after the action completes.
        if (activeRefresher) {
          activeRefresher.trigger();
        }

        const responseBody = JSON.stringify({
          ok: actionResult.ok,
          ...(followUp ? { followUp } : {}),
          ...(actionResult.ok ? {} : { error: actionResult.error }),
        });
        return new Response(responseBody, {
          status: actionResult.ok ? 200 : 404,
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      } catch (e: unknown) {
        return new Response(errorMessage(e) || "action failed", {
          status: 502,
          headers: { "access-control-allow-origin": "*" },
        });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/trigger") {
      activeRefresher?.trigger();
      return new Response(null, { status: 204 });
    }

    // CORS preflight for action endpoints
    if (req.method === "OPTIONS" && (url.pathname === "/api/action" || url.pathname.startsWith("/api/action/") || url.pathname === "/api/switch-app" || url.pathname === "/api/window/focus" || url.pathname === "/api/window/drag" || url.pathname === "/api/input" || url.pathname.startsWith("/api/overlay/") || url.pathname.startsWith("/api/actors") || url.pathname.startsWith("/api/cg/"))) {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers": "authorization, content-type",
        },
      });
    }

    if (url.pathname === "/api/raw/cg/windows") {
      if (!nativeAX) {
        return new Response(JSON.stringify({ error: "N-API AX module not loaded" }), {
          status: 500, headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      }
      return new Response(JSON.stringify(nativeAX.cgGetWindowRects(), null, 2), {
        headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
      });
    }

    if (url.pathname === "/api/raw/ws/apps") {
      if (!nativeAX) {
        return new Response(JSON.stringify({ error: "N-API AX module not loaded" }), {
          status: 500, headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      }
      return new Response(JSON.stringify(nativeAX.wsGetRunningApps(), null, 2), {
        headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
      });
    }

    if (url.pathname === "/api/raw/ws/frontmost") {
      if (!nativeAX) {
        return new Response(JSON.stringify({ error: "N-API AX module not loaded" }), {
          status: 500, headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      }
      return new Response(JSON.stringify(nativeAX.wsGetFrontmostApp(), null, 2), {
        headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
      });
    }

    if (url.pathname === "/api/raw/ax/frontmost-pid") {
      if (!nativeAX) {
        return new Response(JSON.stringify({ error: "N-API AX module not loaded" }), {
          status: 500, headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      }
      if (!nativeAX.axIsProcessTrusted()) {
        return new Response(JSON.stringify({ error: "AX not trusted" }), {
          status: 403, headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      }
      return new Response(JSON.stringify(nativeAX.axGetFrontmostPid(), null, 2), {
        headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
      });
    }

    if (url.pathname === "/api/raw/screen") {
      if (!nativeAX) {
        return new Response(JSON.stringify({ error: "N-API AX module not loaded" }), {
          status: 500, headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      }
      const frame = nativeAX.wsGetScreenFrame?.() ?? null;
      return new Response(JSON.stringify(frame, null, 2), {
        headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
      });
    }

    if (url.pathname === "/api/raw/leases") {
      const doc = store.get(DEFAULT_DOC_PATH);
      if (!doc) {
        return new Response(JSON.stringify({}), {
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      }
      const root = doc.getMap("root");
      const leaseState = readWindowLeaseState(root);
      const now = Date.now();
      const annotated: Record<string, unknown> = {};
      if (leaseState.focus) {
        annotated.focus = {
          ...leaseState.focus,
          remainingMs: Math.max(0, leaseState.focus.expiresAt - now),
          expired: leaseState.focus.expiresAt <= now,
        };
      }
      if (leaseState.positions) {
        const positions: Record<string, unknown> = {};
        for (const [key, lease] of Object.entries(leaseState.positions)) {
          positions[key] = {
            ...lease,
            remainingMs: Math.max(0, lease.expiresAt - now),
            expired: lease.expiresAt <= now,
          };
        }
        annotated.positions = positions;
      }
      return new Response(JSON.stringify(annotated, null, 2), {
        headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
      });
    }

    if (url.pathname === "/api/raw/events") {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          const listener = (event: AXObserverEvent & { plan: RefreshPlan | null; ts: number }) => {
            try {
              controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
            } catch {
              eventListeners.delete(listener);
            }
          };
          eventListeners.add(listener);
          req.signal.addEventListener("abort", () => {
            eventListeners.delete(listener);
            try { controller.close(); } catch {}
          });
        },
        cancel() {},
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          "access-control-allow-origin": "*",
        },
      });
    }

    if (url.pathname === "/api/ax/snapshot") {
      if (!nativeAX || !nativeAX.axIsProcessTrusted()) {
        return new Response(JSON.stringify({ error: "AX not trusted" }), {
          status: 403, headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      }
      const pid = parseInt(url.searchParams.get("pid") || "") || nativeAX.axGetFrontmostPid();
      const depth = parseInt(url.searchParams.get("depth") || "10");
      const tree = nativeAX.axSnapshot(pid, depth);
      return new Response(JSON.stringify(tree, null, 2), {
        headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
      });
    }

    if (req.method === "POST" && url.pathname === "/api/ax/query") {
      try {
        const body = await req.json() as { query?: string; pid?: number; all?: boolean; cardinality?: AXQueryCardinality; target?: AXTarget };
        if (!body.query) {
          return new Response(JSON.stringify({ error: "query is required" }), {
            status: 400, headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
          });
        }
        const target = parseAXTargetPayload(body.target);
        const matches = buildAXQueryMatches(body.query, body.pid, body.cardinality, body.all === true, target);
        return new Response(JSON.stringify(matches), {
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      } catch (e: unknown) {
        return new Response(JSON.stringify({ error: errorMessage(e) }), {
          status: 500, headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      }
    }

    if (req.method === "GET" && url.pathname === "/api/ax/cursor") {
      try {
        return new Response(JSON.stringify(findCursor()), {
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      } catch (e: unknown) {
        return new Response(JSON.stringify({ error: errorMessage(e) }), {
          status: 500, headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      }
    }

    // Raw AX actions by label/role (used by `gui ax click|press|set|type|hover`)
    if (req.method === "POST" && url.pathname === "/api/ax/action") {
      try {
        const body = await req.json() as {
          method: "click" | "press" | "set" | "type" | "select" | "hover";
          label?: string;
          role?: string;
          nth?: number;
          parent?: string;
          target?: string | AXTarget | AXCursor;
          value?: string;
        };
        const axCursor = typeof body.target === "string" || body.target === undefined ? undefined : parseAXCursorPayload(body.target);
        const axTarget = axCursor?.target ?? (typeof body.target === "string" || body.target === undefined ? undefined : parseAXTargetPayload(body.target));
        const appTarget = typeof body.target === "string" ? body.target : undefined;
        let result: { ok: boolean; error?: string };
        switch (body.method) {
          case "click":
            result = findAndClick({ label: body.label, role: body.role, nth: body.nth, parent: body.parent, target: appTarget, axTarget });
            break;
          case "press":
            result = findAndPerformAction({
              label: body.label,
              role: body.role,
              nth: body.nth,
              parent: body.parent,
              target: appTarget,
              axTarget,
              action: "AXPress",
            });
            break;
          case "set":
            result = findAndSetValue({ value: body.value!, label: body.label, role: body.role, nth: body.nth, parent: body.parent, target: appTarget, axTarget });
            break;
          case "type":
            result = findAndType({ value: body.value!, label: body.label, role: body.role, nth: body.nth, parent: body.parent, target: appTarget, axTarget, axCursor });
            break;
          case "select":
            if (!axCursor) {
              return new Response(JSON.stringify({ ok: false, error: "AX cursor target required for select" }), {
                status: 400, headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
              });
            }
            result = findAndSelectCursor(axCursor);
            break;
          case "hover":
            result = findAndHover({ label: body.label, role: body.role, nth: body.nth, parent: body.parent, target: appTarget, axTarget });
            break;
          default:
            return new Response(JSON.stringify({ ok: false, error: `Unknown method: ${(body as { method: string }).method}` }), {
              status: 400, headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
            });
        }
        return new Response(JSON.stringify(result), {
          status: result.ok ? 200 : 400,
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      } catch (e: unknown) {
        return new Response(JSON.stringify({ ok: false, error: errorMessage(e) }), {
          status: 500,
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      }
    }

    // ── ax at: AX element hit-test at screen coordinate ──
    if (url.pathname === "/api/ax/at") {
      const x = parseFloat(url.searchParams.get("x") || "");
      const y = parseFloat(url.searchParams.get("y") || "");
      const pid = parseInt(url.searchParams.get("pid") || "") || undefined;
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return new Response(JSON.stringify({ error: "x and y are required numeric parameters" }), {
          status: 400, headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      }
      try {
        const match = axAt(x, y, pid);
        return new Response(JSON.stringify(match), {
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      } catch (e: unknown) {
        return new Response(JSON.stringify({ error: errorMessage(e) }), {
          status: 500, headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      }
    }

    // ── ax actions: enumerate available AX actions for a matched element ──
    if (req.method === "POST" && url.pathname === "/api/ax/actions") {
      try {
        const body = await req.json() as { target?: AXTarget };
        const axTarget = parseAXTargetPayload(body.target);
        if (!axTarget) {
          return new Response(JSON.stringify({ error: "target is required" }), {
            status: 400, headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
          });
        }
        const actions = axGetActionsForTarget(axTarget);
        return new Response(JSON.stringify(actions), {
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      } catch (e: unknown) {
        return new Response(JSON.stringify({ error: errorMessage(e) }), {
          status: 500, headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      }
    }

    if (url.pathname === "/api/ax/actions") {
      const label = url.searchParams.get("label") || undefined;
      const role = url.searchParams.get("role") || undefined;
      const nth = parseInt(url.searchParams.get("nth") || "") || undefined;
      const pid = parseInt(url.searchParams.get("pid") || "") || undefined;
      if (!label && !role) {
        return new Response(JSON.stringify({ error: "label or role is required" }), {
          status: 400, headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      }
      try {
        const actions = axGetActions({ label, role, nth, pid });
        return new Response(JSON.stringify(actions), {
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      } catch (e: unknown) {
        return new Response(JSON.stringify({ error: errorMessage(e) }), {
          status: 500, headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      }
    }

    // ── ax perform: perform a named AX action on a matched element ──
    if (req.method === "POST" && url.pathname === "/api/ax/perform") {
      const body = await req.json() as {
        label?: string;
        role?: string;
        action: string;
        nth?: number;
        pid?: number;
        target?: AXTarget;
      };
      if (!body.action) {
        return new Response(JSON.stringify({ ok: false, error: "action is required" }), {
          status: 400, headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      }
      try {
        const axTarget = parseAXTargetPayload(body.target);
        const result = findAndPerformAction({
          label: body.label,
          role: body.role,
          action: body.action,
          nth: body.nth,
          target: axTarget ? undefined : body.pid != null ? `pid:${body.pid}` : undefined,
          axTarget,
        });
        return new Response(JSON.stringify(result), {
          status: result.ok ? 200 : 400,
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      } catch (e: unknown) {
        return new Response(JSON.stringify({ ok: false, error: errorMessage(e) }), {
          status: 500, headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      }
    }

    // ── ax focus: focus an element via AXFocus / AXRaise ──
    if (req.method === "POST" && url.pathname === "/api/ax/focus") {
      const body = await req.json() as {
        label?: string;
        role?: string;
        nth?: number;
        pid?: number;
        target?: AXTarget;
      };
      try {
        const axTarget = parseAXTargetPayload(body.target);
        const result = findAndFocus({
          label: body.label,
          role: body.role,
          nth: body.nth,
          pid: axTarget ? undefined : body.pid,
          axTarget,
        });
        return new Response(JSON.stringify(result), {
          status: result.ok ? 200 : 400,
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      } catch (e: unknown) {
        return new Response(JSON.stringify({ ok: false, error: errorMessage(e) }), {
          status: 500, headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/ax/focus-window") {
      const body = await req.json() as { target?: AXTarget };
      try {
        const axTarget = assertAXTarget(body.target);
        const result = focusContainingWindow({ axTarget });
        return new Response(JSON.stringify(result), {
          status: result.ok ? 200 : 400,
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      } catch (e: unknown) {
        return new Response(JSON.stringify({ ok: false, error: errorMessage(e) }), {
          status: 500, headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      }
    }

    // ── ax menu-at: return AXMenu tree at screen coordinate ──
    if (url.pathname === "/api/ax/menu-at") {
      const x = parseFloat(url.searchParams.get("x") || "");
      const y = parseFloat(url.searchParams.get("y") || "");
      const pid = parseInt(url.searchParams.get("pid") || "") || undefined;
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return new Response(JSON.stringify({ error: "x and y are required numeric parameters" }), {
          status: 400, headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      }
      try {
        const menu = menuAt(x, y, pid);
        return new Response(JSON.stringify(menu), {
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      } catch (e: unknown) {
        return new Response(JSON.stringify({ error: errorMessage(e) }), {
          status: 500, headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        });
      }
    }

    // Static files
    const staticRes = handleStatic(req);
    if (staticRes) return staticRes;

    // Live tree — lazy AX snapshot, query executed server-side
    if (req.method === "GET" && url.pathname === "/cli/live-tree") {
      try {
        const tree = buildLazyTree();
        const q = url.searchParams.get("q");
        if (q) {
          // Run query server-side against lazy tree (only snapshots accessed apps)
          const queries = parseQuery(q);
          const first = parseInt(url.searchParams.get("first") || "100", 10);
          const { nodes, matchCount } = filterTree(tree, queries);
          const truncated = bfsFirst(nodes, first);
          return Response.json({ tree, nodes: truncated, matchCount });
        }
        // No query — materialize full tree.
        return Response.json(tree);
      } catch (e: unknown) {
        return new Response(errorMessage(e), { status: 500 });
      }
    }

    // CLI API (CRDT-based)
    const vatRes = handleVAT(req, vatRegistry, {
      persist: (mounts) => saveVatMountConfig(mounts, vatMountConfigPath),
      triggerStreamRequestInit: auth.secret
        ? { headers: { authorization: `Bearer ${auth.secret}` } }
        : undefined,
    });
    if (vatRes) return vatRes;

    const cliRes = handleCLI(req);
    if (cliRes) return cliRes;

    return new Response("Not found", { status: 404 });
  },
});

_log("daemon", `listening on http://localhost:${PORT}`);

setInterval(() => {
  try {
    reconcileNativeWindowsFromCRDT();
  } catch (error: unknown) {
    _log("daemon", `window reconcile failed: ${errorMessage(error)}`);
  }
}, 16);

// Bootstrap the event-driven AX flow once accessibility is trusted.
async function startAXBootstrap() {
  while (!nativeAX.axIsProcessTrusted()) {
    _log("daemon", "waiting for accessibility trust...");
    await Bun.sleep(3000);
  }

  _log("daemon", "accessibility trusted — starting window sync");
  activeRefresher = startRefresher(store, DEFAULT_DOC_PATH, { autostart: false });
  activeRefresher.trigger();

  try {
    let lastTriggerTime = 0;
    const DEBOUNCE_MS = 100;

    startObserving((event: AXObserverEvent) => {
      scheduleVatRefresh(event);
      const plan = planAXEventRefresh(event);

      // Fan out to all SSE listeners regardless of plan
      const enriched = { ...event, plan, ts: Date.now() };
      for (const listener of eventListeners) listener(enriched);

      if (!plan) return;

      const now = Date.now();
      if (now - lastTriggerTime < DEBOUNCE_MS) return;
      lastTriggerTime = now;

      _log("ax-obs", `${event.type} pid=${event.pid} bundle=${event.bundleId}`);
      if (plan.pruneBundleId) {
        pruneAppByBundleId(store, DEFAULT_DOC_PATH, plan.pruneBundleId);
      }
      if (plan.foregroundDelayMs !== undefined) {
        scheduleForegroundFill(plan.foregroundDelayMs);
      }
    });
    _log("ax-obs", "started");
  } catch (e: unknown) {
    _log("ax-obs", `FAILED to start: ${errorMessage(e)}`);
  }
}
startAXBootstrap();
