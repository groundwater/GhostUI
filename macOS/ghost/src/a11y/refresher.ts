import * as Y from "yjs";
import type { CRDTStore } from "../crdt/store.js";
import { attachBroadcast } from "../server/ws.js";
import { populateFromDescriptor, type NodeDescriptor } from "../crdt/schema.js";
import { isWindowDocPath, windowDocPath } from "../crdt/doc-paths.js";
import { getAppMetadata } from "./native-ax.js";
import {
  bufferObservedFocusStack,
  bufferObservedWindowPosition,
  projectWindowPosition,
  projectWindowStack,
  pruneExpiredWindowLeases,
  readWindowLeaseState,
  clearFocusLease,
  clearPositionLease,
  satisfyFocusLease,
  satisfyPositionLease,
  shouldYieldFocusLeaseToObservedNative,
  shouldYieldPositionLeaseToObservedNative,
  type WindowLeaseState,
} from "../window-state.js";
export {
  type TreeNode,
  type SnapshotResponse,
  axToTree,
  collectSemanticChildren,
  treeNodeToDescriptor,
  plainNodeToDescriptor,
  snapshotToTree,
  isMenuSeparator,
  ROLE_TO_TAG,
  SUBROLE_TO_TAG,
  SEMANTIC_TAGS,
} from "./ax-tree.js";
import type { TreeNode } from "./ax-tree.js";
let refreshWallpaperFn: () => Promise<string> = async () => "";
let logFn: (component: string, msg: string) => void = () => {};

export function configureRefresherRuntime(runtime: {
  refreshWallpaper?: () => Promise<string>;
  log?: (component: string, msg: string) => void;
}): void {
  if (runtime.refreshWallpaper) refreshWallpaperFn = runtime.refreshWallpaper;
  if (runtime.log) logFn = runtime.log;
}

const broadcastAttachedDocs = new Set<string>();
const lastJSONByPass = new Map<string, string>();

function ensureBroadcast(store: CRDTStore, docPath: string): Y.Doc {
  const doc = store.getOrCreate(docPath);
  if (!broadcastAttachedDocs.has(docPath)) {
    attachBroadcast(doc, docPath);
    broadcastAttachedDocs.add(docPath);
  }
  return doc;
}

type LiveMetadata = ReturnType<typeof getAppMetadata>;
type LiveWindow = LiveMetadata["windowRects"][number];

function groupVisibleWindowsByBundle(windowRects: LiveWindow[]): Map<string, LiveWindow[]> {
  const grouped = new Map<string, LiveWindow[]>();
  for (const rect of windowRects) {
    if (!rect.bundleId || !rect.cgWindowId) continue;
    let list = grouped.get(rect.bundleId);
    if (!list) {
      list = [];
      grouped.set(rect.bundleId, list);
    }
    list.push(rect);
  }
  return grouped;
}

function buildWindowDescriptor(rect: LiveWindow, z: number, focused: boolean): NodeDescriptor {
  const attrs: Record<string, unknown> = {
    doc: windowDocPath(rect.cgWindowId),
    cgWindowId: rect.cgWindowId,
    bundleId: rect.bundleId,
    pid: rect.pid,
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    w: Math.round(rect.w),
    h: Math.round(rect.h),
    z,
    focused: focused ? "true" : "false",
  };
  if (rect.title) attrs.title = rect.title;
  return {
    type: "Window",
    id: `Window:${rect.cgWindowId}`,
    attrs,
  };
}

function readNumericAttr(root: Y.Map<unknown>, key: string): number | null {
  const value = Number(root.get(key));
  return Number.isFinite(value) ? value : null;
}

function readBooleanAttr(root: Y.Map<unknown>, key: string): boolean | null {
  const value = root.get(key);
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  return null;
}

interface CurrentWindowState {
  bundleId?: string;
  z: number | null;
  focused: boolean | null;
}

function collectCurrentWindowStates(root: Y.Map<unknown>): Map<string, CurrentWindowState> {
  const states = new Map<string, CurrentWindowState>();
  const visit = (node: Y.Map<unknown>): void => {
    const type = String(node.get("type") || node.get("_tag") || "");
    if (type === "Window") {
      const docPath = node.get("doc");
      const z = readNumericAttr(node, "z");
      const focused = readBooleanAttr(node, "focused");
      const bundleId = typeof node.get("bundleId") === "string" ? String(node.get("bundleId")) : undefined;
      if (typeof docPath === "string" && docPath) {
        states.set(docPath, { bundleId, z, focused });
      }
    }

    const children = node.get("_children") as Y.Array<Y.Map<unknown>> | undefined;
    if (!children) return;
    for (let i = 0; i < children.length; i++) {
      visit(children.get(i) as Y.Map<unknown>);
    }
  };

  visit(root);
  return states;
}

function resolveAuthoritativeWindowPosition(
  leaseState: WindowLeaseState,
  _docPath: string,
  cgWindowId: number,
  nativeX: number,
  nativeY: number,
  _current: { x: number; y: number } | null | undefined,
): { x: number; y: number } {
  const projected = projectWindowPosition(nativeX, nativeY, leaseState, cgWindowId);
  return {
    x: projected.x ?? nativeX,
    y: projected.y ?? nativeY,
  };
}

function resolveAuthoritativeWindowStack(
  leaseState: WindowLeaseState,
  _docPath: string,
  cgWindowId: number,
  nativeZ: number,
  nativeFocused: boolean,
  _current: CurrentWindowState | null | undefined,
): { z: number; focused: boolean } {
  const projected = projectWindowStack(nativeZ, nativeFocused, leaseState, cgWindowId);
  return {
    z: projected.z ?? nativeZ,
    focused: projected.focused ?? nativeFocused,
  };
}

function resolveHeldFrontBundleId(currentWindowStates: Map<string, CurrentWindowState>): string | null {
  const ordered = [...currentWindowStates.values()]
    .filter((state) => state.bundleId && state.z != null)
    .sort((left, right) => {
      const leftFocused = left.focused === true ? 0 : 1;
      const rightFocused = right.focused === true ? 0 : 1;
      return leftFocused - rightFocused || (left.z ?? Number.POSITIVE_INFINITY) - (right.z ?? Number.POSITIVE_INFINITY);
    });
  return ordered[0]?.bundleId || null;
}

function resolveLeaseFrontBundleId(leaseState: WindowLeaseState, currentWindowStates: Map<string, CurrentWindowState>): string | null {
  if (leaseState.focus?.frontBundleId) return leaseState.focus.frontBundleId;
  return resolveHeldFrontBundleId(currentWindowStates);
}

function preserveWindowRuntimeAttrs(windowRoot: Y.Map<unknown>): Record<string, unknown> {
  return {};
}

function preserveDisplayRuntimeAttrs(displayRoot: Y.Map<unknown>): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  const leases = displayRoot.get("windowLeases");
  if (leases !== undefined) attrs.windowLeases = leases;
  return attrs;
}

function buildDisplayDescriptor(
  metadata: LiveMetadata,
  wallpaper: string | undefined,
  leaseState: WindowLeaseState,
  currentWindowStates: Map<string, CurrentWindowState>,
  shellChildren?: NodeDescriptor[],
): NodeDescriptor {
  const shellNodes = shellChildren ?? [];
  const heldFrontBundleId = resolveLeaseFrontBundleId(leaseState, currentWindowStates);
  const regularBundleIds = new Set(
    metadata.apps
      .filter((item) => item.regular && item.bundleId)
      .map((item) => item.bundleId),
  );
  const visibleWindows = metadata.windowRects.filter((rect) => rect.bundleId && rect.cgWindowId && rect.w > 0 && rect.h > 0 && regularBundleIds.has(rect.bundleId));
  const windowsByBundle = groupVisibleWindowsByBundle(visibleWindows);

  const screenW = Math.max(1, Math.round(metadata.screenW || 1440));
  const screenH = Math.max(1, Math.round(metadata.screenH || 900));
  const children: NodeDescriptor[] = [...shellNodes];

  for (const app of metadata.apps.filter((item) => item.regular && item.bundleId)) {
    const windows = windowsByBundle.get(app.bundleId) || [];
    const windowChildren = windows.map((rect) => {
      const docPath = windowDocPath(rect.cgWindowId);
      const nativeZ = visibleWindows.findIndex((candidate) => candidate.cgWindowId === rect.cgWindowId);
      const nativeFocused = nativeZ === 0 || (metadata.frontPid > 0 && rect.pid === metadata.frontPid && nativeZ === 0);
      const descriptor = buildWindowDescriptor(rect, nativeZ < 0 ? 9999 : nativeZ, nativeFocused);
      const position = resolveAuthoritativeWindowPosition(
        leaseState,
        docPath,
        rect.cgWindowId,
        Math.round(rect.x),
        Math.round(rect.y),
        null,
      );
      const stack = resolveAuthoritativeWindowStack(
        leaseState,
        docPath,
        rect.cgWindowId,
        nativeZ < 0 ? 9999 : nativeZ,
        nativeFocused,
        currentWindowStates.get(docPath),
      );
      descriptor.attrs = {
        ...(descriptor.attrs || {}),
        x: position.x,
        y: position.y,
        z: stack.z,
        focused: stack.focused ? "true" : "false",
      };
      return descriptor;
    });

    children.push({
      type: "Application",
      id: `app:${app.bundleId}`,
      attrs: {
        bundleId: app.bundleId,
        ...(app.name ? { title: app.name } : {}),
        foreground: ((heldFrontBundleId || metadata.frontBundleId) === app.bundleId) ? "true" : "false",
      },
      children: windowChildren.length > 0 ? windowChildren : undefined,
    });
  }

  return {
    type: "Display",
    id: "Display::0",
    attrs: {
      screenW,
      screenH,
      ...((heldFrontBundleId || metadata.frontBundleId) ? { frontApp: heldFrontBundleId || metadata.frontBundleId } : {}),
      ...(wallpaper ? { wallpaper } : {}),
    },
    children,
  };
}

function buildWindowDocDescriptor(rect: LiveWindow, z: number, focused: boolean): NodeDescriptor {
  return buildWindowDescriptor(rect, z, focused);
}

function syncWindowDocs(store: CRDTStore, metadata: LiveMetadata, leaseState: WindowLeaseState): void {
  const regularBundleIds = new Set(
    metadata.apps
      .filter((item) => item.regular && item.bundleId)
      .map((item) => item.bundleId),
  );
  const visibleWindows = metadata.windowRects.filter((rect) => rect.bundleId && rect.cgWindowId && rect.w > 0 && rect.h > 0 && regularBundleIds.has(rect.bundleId));
  const liveDocPaths = new Set<string>();

  visibleWindows.forEach((rect, index) => {
    const docPath = windowDocPath(rect.cgWindowId);
    liveDocPaths.add(docPath);
    const doc = ensureBroadcast(store, docPath);
    const root = doc.getMap("root");
    const nativeZ = index;
    const nativeFocused = index === 0;
    const descriptor = buildWindowDocDescriptor(rect, nativeZ, nativeFocused);
      const position = resolveAuthoritativeWindowPosition(
        leaseState,
        docPath,
        rect.cgWindowId,
        Math.round(rect.x),
        Math.round(rect.y),
        null,
      );
      const stack = resolveAuthoritativeWindowStack(
        leaseState,
        docPath,
        rect.cgWindowId,
        nativeZ,
        nativeFocused,
        {
          z: readNumericAttr(root, "z"),
          focused: readBooleanAttr(root, "focused"),
        },
      );
    descriptor.attrs = {
      ...(descriptor.attrs || {}),
      x: position.x,
      y: position.y,
      z: stack.z,
      focused: stack.focused ? "true" : "false",
    };
    const runtimeAttrs = preserveWindowRuntimeAttrs(root);
    if (Object.keys(runtimeAttrs).length > 0) {
      descriptor.attrs = { ...(descriptor.attrs || {}), ...runtimeAttrs };
    }
    populateFromDescriptor(root, descriptor);
  });

  for (const path of store.paths()) {
    if (!isWindowDocPath(path)) continue;
    if (liveDocPaths.has(path)) continue;
      store.destroy(path);
      broadcastAttachedDocs.delete(path);
    }
  }

export function syncMetadataDocs(
  store: CRDTStore,
  docPath: string,
  metadata: LiveMetadata,
  options: { wallpaper?: string; shellChildren?: NodeDescriptor[]; passKey?: string } = {},
): string | null {
  const doc = ensureBroadcast(store, docPath);
  const root = doc.getMap("root");
  let leaseState: WindowLeaseState = {};
  doc.transact(() => {
    pruneExpiredWindowLeases(root);
    let activeLeases = readWindowLeaseState(root);
    const nativeFrontWindowId = Number(metadata.windowRects[0]?.cgWindowId || 0);
    if (shouldYieldFocusLeaseToObservedNative(activeLeases.focus, nativeFrontWindowId)) {
      clearFocusLease(root);
      activeLeases = readWindowLeaseState(root);
    }
    const nativeStack: Record<string, { z?: number; focused?: boolean }> = {};
    metadata.windowRects.forEach((rect, index) => {
      nativeStack[String(rect.cgWindowId)] = {
        z: index,
        focused: index === 0,
      };
      const activePositionLease = activeLeases.positions?.[String(rect.cgWindowId)];
      if (shouldYieldPositionLeaseToObservedNative(activePositionLease, rect.x, rect.y)) {
        clearPositionLease(root, rect.cgWindowId);
        activeLeases = readWindowLeaseState(root);
      }
      bufferObservedWindowPosition(root, rect.cgWindowId, rect.x, rect.y);
      satisfyPositionLease(root, rect.cgWindowId, rect.x, rect.y);
    });
    bufferObservedFocusStack(root, metadata.frontBundleId, nativeStack);
    if (Number.isFinite(nativeFrontWindowId) && nativeFrontWindowId > 0) {
      satisfyFocusLease(root, nativeFrontWindowId);
    }
    leaseState = readWindowLeaseState(root);
  });
  const currentWindowStates = collectCurrentWindowStates(root);
  const descriptor = buildDisplayDescriptor(metadata, options.wallpaper, leaseState, currentWindowStates, options.shellChildren);
  const runtimeAttrs = preserveDisplayRuntimeAttrs(root);
  if (Object.keys(runtimeAttrs).length > 0) {
    descriptor.attrs = { ...(descriptor.attrs || {}), ...runtimeAttrs };
  }
  const json = JSON.stringify(descriptor);
  const passKey = options.passKey ?? "default";
  const unchanged = json === lastJSONByPass.get(passKey);
  if (!unchanged) {
    lastJSONByPass.set(passKey, json);
    populateFromDescriptor(root, descriptor);
  }
  syncWindowDocs(store, metadata, leaseState);
  return unchanged ? null : metadata.frontBundleId || null;
}

async function syncDisplayAndWindows(store: CRDTStore, docPath: string, passKey = "default"): Promise<string | null> {
  const metadata = getAppMetadata();
  const wallpaper = await refreshWallpaperFn();
  return syncMetadataDocs(store, docPath, metadata, { wallpaper, passKey });
}

export function seedWindowMetadata(store: CRDTStore, docPath: string): string | null {
  const metadata = getAppMetadata();
  return syncMetadataDocs(store, docPath, metadata);
}

function removeNodeById(children: Y.Array<Y.Map<unknown>>, nodeId: string): void {
  for (let i = children.length - 1; i >= 0; i--) {
    if ((children.get(i).get("id") as string | undefined) === nodeId) {
      children.delete(i, 1);
      return;
    }
  }
}

export function pruneAppByBundleId(store: CRDTStore, docPath: string, bundleId: string): void {
  const doc = store.get(docPath);
  if (!doc) return;
  const root = doc.getMap("root");
  const children = root.get("_children") as Y.Array<Y.Map<unknown>> | undefined;
  if (!children) return;

  doc.transact(() => {
    removeNodeById(children, `app:${bundleId}`);
  });

  for (const path of store.paths()) {
    if (!path.startsWith("/windows/")) continue;
    const windowDoc = store.get(path);
    if (!windowDoc) continue;
    const windowRoot = windowDoc.getMap("root");
    if ((windowRoot.get("bundleId") as string | undefined) === bundleId) {
      store.destroy(path);
      broadcastAttachedDocs.delete(path);
    }
  }
}

export function applyTree(store: CRDTStore, docPath: string, tree: TreeNode, passKey = "default", additive = false): boolean {
  const json = JSON.stringify(tree);
  if (json === lastJSONByPass.get(passKey)) return false;
  lastJSONByPass.set(passKey, json);

  const doc = ensureBroadcast(store, docPath);
  const root = doc.getMap("root");
  doc.transact(() => {
    diffApply(root, tree, additive);
  });
  return true;
}

export interface Refresher {
  stop(): void;
  trigger(): void;
}

interface RefresherOptions {
  autostart?: boolean;
}

export function startRefresher(store: CRDTStore, docPath: string, options: RefresherOptions = {}): Refresher {
  let updateInFlight = false;
  let queued = false;

  async function runSync(passKey: string): Promise<void> {
    if (updateInFlight) {
      queued = true;
      return;
    }

    updateInFlight = true;
    try {
      await syncDisplayAndWindows(store, docPath, passKey);
    } catch (error: unknown) {
      logFn("a11y", `window sync failed: ${errorMessage(error)}`);
    } finally {
      updateInFlight = false;
      if (queued) {
        queued = false;
        void runSync(passKey);
      }
    }
  }

  const refresher: Refresher = {
    stop() {},
    trigger() {
      void runSync("default");
    },
  };

  try {
    seedWindowMetadata(store, docPath);
  } catch (error: unknown) {
    logFn("a11y", `bootstrap seed failed: ${errorMessage(error)}`);
  }

  if (options.autostart !== false) {
    setTimeout(() => refresher.trigger(), 0);
  }

  return refresher;
}

const BARE_BOOL_PROPS = new Set(["selected", "checked", "focused", "expanded"]);
const TUPLE_RE = /^\((-?\d+(?:\.\d+)?(?:,-?\d+(?:\.\d+)?)*)\)$/;

function encodePropForCRDT(key: string, value: string): unknown | null {
  if (BARE_BOOL_PROPS.has(key)) {
    return value === "true" ? true : null;
  }
  const m = TUPLE_RE.exec(value);
  if (m) {
    const items = m[1].split(",").map(Number);
    return { _tuple: items };
  }
  return value;
}

function diffApply(ymap: Y.Map<unknown>, node: TreeNode, additive = false): void {
  if (ymap.get("_tag") !== node.tag) ymap.set("_tag", node.tag);
  if (ymap.get("id") !== node.id) ymap.set("id", node.id);

  const existingKeys = new Set<string>();
  for (const key of ymap.keys()) {
    if (!key.startsWith("_")) existingKeys.add(key);
  }

  const newAttrKeys = new Set<string>();
  for (const [key, value] of Object.entries(node.props)) {
    const encoded = encodePropForCRDT(key, value);
    if (encoded === null) {
      if (ymap.has(key)) ymap.delete(key);
      continue;
    }
    newAttrKeys.add(key);
    const current = ymap.get(key);
    if (!deepEqual(current, encoded)) ymap.set(key, encoded);
  }
  newAttrKeys.add("id");

  if (!additive) {
    for (const key of existingKeys) {
      if (!newAttrKeys.has(key)) ymap.delete(key);
    }
    if (ymap.has("_text")) ymap.delete("_text");
  }

  const children = node.children ?? [];
  let ychildren = ymap.get("_children") as Y.Array<Y.Map<unknown>> | undefined;
  if (children.length === 0) {
    if (ychildren) ymap.delete("_children");
    return;
  }

  if (!ychildren) {
    ychildren = new Y.Array<Y.Map<unknown>>();
    ymap.set("_children", ychildren);
    for (const child of children) {
      const childMap = new Y.Map<unknown>();
      populateYMap(childMap, child);
      ychildren.push([childMap]);
    }
    return;
  }

  const oldLen = ychildren.length;
  const newLen = children.length;
  const newIds = children.map((child) => child.id);

  if (oldLen === newLen) {
    let sameOrder = true;
    for (let i = 0; i < newLen; i++) {
      if ((ychildren.get(i).get("id") as string) !== newIds[i]) {
        sameOrder = false;
        break;
      }
    }
    if (sameOrder) {
      for (let i = 0; i < newLen; i++) diffApply(ychildren.get(i), children[i], additive);
      return;
    }
  }

  if (!additive) {
    const newIdSet = new Set(newIds);
    const toRemove: number[] = [];
    for (let i = oldLen - 1; i >= 0; i--) {
      const id = ychildren.get(i).get("id") as string;
      if (!newIdSet.has(id)) toRemove.push(i);
    }
    for (const index of toRemove) ychildren.delete(index, 1);
  }

  const currentById = new Map<string, Y.Map<unknown>>();
  for (let i = 0; i < ychildren.length; i++) {
    const ym = ychildren.get(i);
    currentById.set(ym.get("id") as string, ym);
  }

  let orderMatches = ychildren.length <= newLen;
  if (orderMatches) {
    for (let i = 0; i < ychildren.length; i++) {
      if ((ychildren.get(i).get("id") as string) !== newIds[i]) {
        orderMatches = false;
        break;
      }
    }
  }

  if (orderMatches) {
    for (let i = 0; i < ychildren.length; i++) diffApply(ychildren.get(i), children[i], additive);
    for (let i = ychildren.length; i < newLen; i++) {
      const childMap = new Y.Map<unknown>();
      populateYMap(childMap, children[i]);
      ychildren.push([childMap]);
    }
    return;
  }

  if (!additive) {
    ychildren.delete(0, ychildren.length);
    for (const child of children) {
      const childMap = new Y.Map<unknown>();
      populateYMap(childMap, child);
      ychildren.push([childMap]);
    }
    return;
  }

  for (const child of children) {
    const existing = currentById.get(child.id);
    if (existing) diffApply(existing, child, true);
  }
}

function populateYMap(ymap: Y.Map<unknown>, node: TreeNode): void {
  ymap.set("_tag", node.tag);
  ymap.set("id", node.id);
  for (const [key, value] of Object.entries(node.props)) {
    const encoded = encodePropForCRDT(key, value);
    if (encoded !== null) ymap.set(key, encoded);
  }

  const children = node.children ?? [];
  if (children.length === 0) return;

  const ychildren = new Y.Array<Y.Map<unknown>>();
  ymap.set("_children", ychildren);
  for (const child of children) {
    const childMap = new Y.Map<unknown>();
    populateYMap(childMap, child);
    ychildren.push([childMap]);
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    const aRecord = a as Record<string, unknown>;
    const bRecord = b as Record<string, unknown>;
    return ka.every((key) => deepEqual(aRecord[key], bRecord[key]));
  }
  return false;
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return String(error);
}
