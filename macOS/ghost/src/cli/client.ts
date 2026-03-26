import type { PlainNode } from "./types.js";
import type { DrawScript } from "../overlay/draw.js";
import type { ActorAction, ActorListEntry } from "../actors/protocol.js";
import type { RecFilmstripRequest, RecImageRequest } from "../rec/protocol.js";
import type { VatMountPolicy, VatMountRequest, VatMountResponse, VatMountSummary, VatPersistedMount, VatPolicyResponse, VatTreeResponse, VatUnmountResponse } from "../vat/types.js";
import { existsSync } from "fs";
import { dirname, resolve } from "path";

const BASE = "http://localhost:7861";
const AUTH_SERVICE = "org.ghostvm.GhostUI.local-auth";
const AUTH_ACCOUNT = "daemon-http";
let cachedAuthAccessGroup: string | null | undefined;

let cachedDaemonAuthSecret: string | null | undefined;
let daemonAuthSecretReader: () => Promise<string | null> = readNativeKeychainDaemonAuthSecret;
let authAccessGroupReader: () => Promise<string | null> = readAuthAccessGroupFromEnclosingInfoPlist;

function readPlistString(text: string, key: string): string | null {
  const match = text.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`));
  return match?.[1]?.trim() || null;
}

async function readAuthAccessGroupFromEnclosingInfoPlist(): Promise<string | null> {
  const fromEnv = process.env.GHOSTUI_KEYCHAIN_ACCESS_GROUP?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  const infoPlistPath = resolve(dirname(process.execPath), "../Info.plist");
  if (!existsSync(infoPlistPath)) {
    return null;
  }
  try {
    const plist = await Bun.file(infoPlistPath).text();
    return readPlistString(plist, "GhostUIKeychainAccessGroup");
  } catch {
    return null;
  }
}

async function getAuthAccessGroup(): Promise<string | null> {
  if (cachedAuthAccessGroup !== undefined) {
    return cachedAuthAccessGroup;
  }
  cachedAuthAccessGroup = await authAccessGroupReader();
  return cachedAuthAccessGroup;
}

async function readNativeKeychainDaemonAuthSecret(): Promise<string | null> {
  try {
    const { keychainReadGenericPassword } = await import("../a11y/native-ax.js");
    return keychainReadGenericPassword(AUTH_SERVICE, AUTH_ACCOUNT, await getAuthAccessGroup() ?? undefined);
  } catch {
    return null;
  }
}

export async function getDaemonAuthSecret(): Promise<string | null> {
  if (cachedDaemonAuthSecret !== undefined) {
    return cachedDaemonAuthSecret;
  }
  const fromEnv = process.env.GHOSTUI_AUTH_SECRET?.trim();
  if (fromEnv) {
    cachedDaemonAuthSecret = fromEnv;
    return cachedDaemonAuthSecret;
  }
  cachedDaemonAuthSecret = await daemonAuthSecretReader();
  return cachedDaemonAuthSecret;
}

export function resetDaemonAuthSecretCache(): void {
  cachedDaemonAuthSecret = undefined;
}

export function __setDaemonAuthSecretReaderForTests(
  reader?: () => Promise<string | null>,
): void {
  daemonAuthSecretReader = reader ?? readNativeKeychainDaemonAuthSecret;
  resetDaemonAuthSecretCache();
}

export function __setAuthAccessGroupReaderForTests(
  reader?: () => Promise<string | null>,
): void {
  authAccessGroupReader = reader ?? readAuthAccessGroupFromEnclosingInfoPlist;
  cachedAuthAccessGroup = undefined;
  resetDaemonAuthSecretCache();
}

export async function daemonFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const secret = await getDaemonAuthSecret();
  const headers = new Headers(init?.headers);
  if (secret) {
    headers.set("Authorization", `Bearer ${secret}`);
  }
  return fetch(input, { ...init, headers });
}

export class VatMountRequestError extends Error {
  constructor(status: number, body: string) {
    super(`/api/vat/mount failed (${status}): ${body}`);
    this.name = "VatMountRequestError";
  }
}

async function readVatErrorBody(res: Response): Promise<string> {
  const text = await res.text();
  if (!text) return `HTTP ${res.status}`;
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === "string" && parsed.error) {
      return parsed.error;
    }
  } catch {}
  return text;
}

export async function fetchTree(): Promise<PlainNode> {
  const res = await daemonFetch(`${BASE}/cli/live-tree`);
  if (!res.ok) {
    throw new Error(`/cli/live-tree failed (${res.status}): ${await res.text()}`);
  }
  return res.json() as Promise<PlainNode>;
}

export async function fetchCRDTTree(): Promise<PlainNode> {
  const res = await daemonFetch(`${BASE}/cli/tree`);
  if (!res.ok) {
    throw new Error(`/cli/tree failed (${res.status}): ${await res.text()}`);
  }
  return res.json() as Promise<PlainNode>;
}

export async function postVatMount(request: VatMountRequest & { mountPolicy?: VatMountPolicy }): Promise<VatMountResponse> {
  try {
    const res = await daemonFetch(`${BASE}/api/vat/mount`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    if (!res.ok) {
      throw new VatMountRequestError(res.status, await readVatErrorBody(res));
    }
    return res.json() as Promise<VatMountResponse>;
  } catch (error) {
    if (error instanceof VatMountRequestError) {
      throw error;
    }
    throw new VatMountRequestError(0, error instanceof Error ? error.message : String(error));
  }
}

export async function deleteVatMount(path: string): Promise<VatUnmountResponse> {
  const params = new URLSearchParams({ path });
  const res = await daemonFetch(`${BASE}/api/vat/mount?${params}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    throw new Error(`/api/vat/mount failed (${res.status}): ${await res.text()}`);
  }
  return res.json() as Promise<VatUnmountResponse>;
}

export async function fetchVatMounts(): Promise<VatMountSummary[]> {
  const res = await daemonFetch(`${BASE}/api/vat/mounts`);
  if (!res.ok) {
    throw new Error(`/api/vat/mounts failed (${res.status}): ${await res.text()}`);
  }
  return res.json() as Promise<VatMountSummary[]>;
}

export async function fetchVatTree(path?: string): Promise<VatTreeResponse> {
  const params = new URLSearchParams();
  if (path) params.set("path", path);
  const url = params.toString() ? `${BASE}/api/vat/tree?${params}` : `${BASE}/api/vat/tree`;
  const res = await daemonFetch(url);
  if (!res.ok) {
    throw new Error(`/api/vat/tree failed (${res.status}): ${await res.text()}`);
  }
  return res.json() as Promise<VatTreeResponse>;
}

export async function postVatPolicy(path: string, mountPolicy: VatMountPolicy): Promise<VatPolicyResponse> {
  const params = new URLSearchParams({ path });
  const res = await daemonFetch(`${BASE}/api/vat/policy?${params}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mountPolicy }),
  });
  if (!res.ok) {
    throw new Error(`/api/vat/policy failed (${res.status}): ${await readVatErrorBody(res)}`);
  }
  return res.json() as Promise<VatPolicyResponse>;
}

export async function fetchVatQuery(query: string): Promise<LiveQueryResult> {
  const params = new URLSearchParams({ q: query });
  const res = await daemonFetch(`${BASE}/api/vat/query?${params}`);
  if (!res.ok) {
    throw new Error(`/api/vat/query failed (${res.status}): ${await readVatErrorBody(res)}`);
  }
  return res.json() as Promise<LiveQueryResult>;
}

export async function openVatWatchStream(
  query: string,
  options: { once?: boolean; filter?: Array<"added" | "removed" | "updated"> } = {},
): Promise<Response> {
  const params = new URLSearchParams({ q: query });
  if (options.once) {
    params.set("once", "1");
  }
  if (options.filter && options.filter.length > 0) {
    params.set("filter", options.filter.join(","));
  }
  const res = await daemonFetch(`${BASE}/api/vat/watch?${params}`);
  if (!res.ok) {
    throw new Error(`/api/vat/watch failed (${res.status}): ${await readVatErrorBody(res)}`);
  }
  return res;
}

export async function fetchLogs(last = 20): Promise<string> {
  const params = new URLSearchParams({ last: String(last) });
  const res = await daemonFetch(`${BASE}/cli/log?${params}`);
  if (!res.ok) {
    throw new Error(`/cli/log failed (${res.status}): ${await res.text()}`);
  }
  return res.text();
}

export async function openLogStream(last = 20): Promise<Response> {
  const params = new URLSearchParams({ last: String(last), follow: "1" });
  const res = await daemonFetch(`${BASE}/cli/log?${params}`);
  if (!res.ok) {
    throw new Error(`/cli/log failed (${res.status}): ${await res.text()}`);
  }
  return res;
}

export interface LiveQueryResult {
  tree: PlainNode;
  nodes: PlainNode[];
  matchCount: number;
}

/** Execute a query server-side against the lazy live tree. Only snapshots apps the query touches. */
export async function fetchLiveQuery(query: string, first = 100): Promise<LiveQueryResult> {
  const params = new URLSearchParams({ q: query, first: String(first) });
  const res = await daemonFetch(`${BASE}/cli/live-tree?${params}`);
  if (!res.ok) {
    throw new Error(`/cli/live-tree?q failed (${res.status}): ${await res.text()}`);
  }
  return res.json() as Promise<LiveQueryResult>;
}

export async function postRecImage(request: RecImageRequest): Promise<Buffer> {
  const res = await daemonFetch(`${BASE}/api/rec/image`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!res.ok) {
    throw new Error(`rec image failed (${res.status}): ${await res.text()}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

export async function postRecFilmstrip(request: RecFilmstripRequest): Promise<Buffer> {
  const res = await daemonFetch(`${BASE}/api/rec/filmstrip`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!res.ok) {
    throw new Error(`rec filmstrip failed (${res.status}): ${await res.text()}`);
  }
  return Buffer.from(await res.arrayBuffer());
}


export async function postScanOverlay(
  rects: { x: number; y: number; width: number; height: number }[],
  durationMs = 500,
  outlineRects?: { x: number; y: number; width: number; height: number }[],
): Promise<void> {
  const payload: Record<string, unknown> = { rects, durationMs };
  if (outlineRects && outlineRects.length > 0) {
    payload.outlineRects = outlineRects;
  }
  const res = await daemonFetch(`${BASE}/api/overlay/scan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`overlay/scan failed (${res.status}): ${await res.text()}`);
  }
}

export async function postDrawOverlay(payload: DrawScript, signal?: AbortSignal): Promise<Response> {
  const res = await daemonFetch(`${BASE}/api/overlay/draw`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal,
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`overlay/draw failed (${res.status}): ${await res.text()}`);
  }
  return res;
}

export async function postKeyboardInput(keys: string[], modifiers?: string[], text?: string): Promise<void> {
  const payload: Record<string, unknown> = {};
  if (text !== undefined) payload.text = text;
  else payload.keys = keys;
  if (modifiers && modifiers.length > 0) payload.modifiers = modifiers;
  const res = await daemonFetch(`${BASE}/api/input`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`keyboard input failed (${res.status}): ${await res.text()}`);
  }
}

export async function switchApp(nameOrBundleId: string): Promise<{ ok: boolean; activated?: string; error?: string }> {
  // Use the daemon's switch-app endpoint which uses System Events for reliable
  // activation (works for Finder and other always-running apps)
  const res = await daemonFetch(`${BASE}/api/switch-app`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: nameOrBundleId }),
  });
  const text = await res.text();
  if (!res.ok) {
    try { return JSON.parse(text); } catch {}
    return { ok: false, error: text || `HTTP ${res.status}` };
  }
  try {
    return JSON.parse(text);
  } catch {
    return { ok: true };
  }
}

export async function focusWindow(cgWindowId: number): Promise<{ ok: boolean; queued?: boolean; leased?: boolean; commandId?: string; pid?: number; bundleId?: string; title?: string; error?: string }> {
  const res = await daemonFetch(`${BASE}/api/window/focus`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cgWindowId }),
  });
  const text = await res.text();
  if (!res.ok) {
    try { return JSON.parse(text); } catch {}
    return { ok: false, error: text || `HTTP ${res.status}` };
  }
  try {
    return JSON.parse(text);
  } catch {
    return { ok: true };
  }
}

export async function dragWindow(
  cgWindowId: number,
  toX: number,
  toY: number,
): Promise<{ ok: boolean; queued?: boolean; commandId?: string; pid?: number; bundleId?: string; title?: string; error?: string }> {
  const res = await daemonFetch(`${BASE}/api/window/drag`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cgWindowId, targetX: toX, targetY: toY }),
  });
  const text = await res.text();
  if (!res.ok) {
    try { return JSON.parse(text); } catch {}
    return { ok: false, error: text || `HTTP ${res.status}` };
  }
  try {
    return JSON.parse(text);
  } catch {
    return { ok: true };
  }
}

export async function spawnActor(
  type: "pointer",
  name: string,
  durationScale?: number,
): Promise<{ ok: true; name: string; type: string; durationScale: number }> {
  const body: Record<string, unknown> = { type, name };
  if (durationScale !== undefined) body.durationScale = durationScale;
  const res = await daemonFetch(`${BASE}/api/actors/spawn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`/api/actors/spawn failed (${res.status}): ${text}`);
  }
  return JSON.parse(text) as { ok: true; name: string; type: string; durationScale: number };
}

export async function killActor(name: string): Promise<{ ok: true; name: string; killed: true }> {
  const res = await daemonFetch(`${BASE}/api/actors/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`/api/actors/${name} failed (${res.status}): ${text}`);
  }
  return JSON.parse(text) as { ok: true; name: string; killed: true };
}

export async function runActor(
  name: string,
  action: ActorAction,
  timeoutMs?: number,
): Promise<{ ok: true; name: string; completed: true }> {
  const body: Record<string, unknown> = { ...action };
  if (timeoutMs !== undefined) body.timeoutMs = timeoutMs;
  const res = await daemonFetch(`${BASE}/api/actors/${encodeURIComponent(name)}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`/api/actors/${name}/run failed (${res.status}): ${text}`);
  }
  return JSON.parse(text) as { ok: true; name: string; completed: true };
}

export async function listActors(): Promise<{ ok: true; actors: ActorListEntry[] }> {
  const res = await daemonFetch(`${BASE}/api/actors`);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`/api/actors failed (${res.status}): ${text}`);
  }
  return JSON.parse(text) as { ok: true; actors: ActorListEntry[] };
}

export interface RawCGWindow {
  pid: number;
  cgWindowId?: number;
  windowNumber?: number;
  x: number;
  y: number;
  w: number;
  h: number;
  layer?: number;
  title?: string;
  owner?: string;
}

export interface RawWorkspaceApp {
  pid: number;
  bundleId?: string;
  name?: string;
}

export async function fetchScreen(): Promise<unknown> {
  const res = await daemonFetch(`${BASE}/api/raw/screen`);
  if (!res.ok) {
    throw new Error(`/api/raw/screen failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

export async function fetchLeases(): Promise<unknown> {
  const res = await daemonFetch(`${BASE}/api/raw/leases`);
  if (!res.ok) {
    throw new Error(`/api/raw/leases failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

export async function openEventStream(): Promise<Response> {
  const res = await daemonFetch(`${BASE}/api/raw/events?follow=1`);
  if (!res.ok) {
    throw new Error(`/api/raw/events failed (${res.status}): ${await res.text()}`);
  }
  return res;
}

export async function fetchRawCGWindows(): Promise<RawCGWindow[]> {
  const res = await daemonFetch(`${BASE}/api/raw/cg/windows`);
  if (!res.ok) {
    throw new Error(`/api/raw/cg/windows failed (${res.status}): ${await res.text()}`);
  }
  return res.json() as Promise<RawCGWindow[]>;
}

export async function fetchFilteredCGWindows(layer?: number): Promise<RawCGWindow[]> {
  const windows = await fetchRawCGWindows();
  if (layer === undefined) return windows;
  return windows.filter((window) => Number(window.layer ?? 0) === layer);
}

export function findCGWindowAt(
  windows: RawCGWindow[],
  x: number,
  y: number,
  layer?: number,
): RawCGWindow | null {
  for (const window of windows) {
    if (layer !== undefined && Number(window.layer ?? 0) !== layer) continue;
    if (x < window.x || x > window.x + window.w || y < window.y || y > window.y + window.h) continue;
    return window;
  }
  return null;
}

export async function fetchRawWorkspaceApps(): Promise<RawWorkspaceApp[]> {
  const res = await daemonFetch(`${BASE}/api/raw/ws/apps`);
  if (!res.ok) {
    throw new Error(`/api/raw/ws/apps failed (${res.status}): ${await res.text()}`);
  }
  return res.json() as Promise<RawWorkspaceApp[]>;
}

export async function fetchRawAXFrontmostPid(): Promise<number> {
  const res = await daemonFetch(`${BASE}/api/raw/ax/frontmost-pid`);
  if (!res.ok) {
    throw new Error(`/api/raw/ax/frontmost-pid failed (${res.status}): ${await res.text()}`);
  }
  return res.json() as Promise<number>;
}

export async function fetchRawWorkspaceFrontmost(): Promise<RawWorkspaceApp> {
  const res = await daemonFetch(`${BASE}/api/raw/ws/frontmost`);
  if (!res.ok) {
    throw new Error(`/api/raw/ws/frontmost failed (${res.status}): ${await res.text()}`);
  }
  return res.json() as Promise<RawWorkspaceApp>;
}

// ── Pasteboard ──

export async function fetchPbRead(type?: string): Promise<{ value: string | null }> {
  const params = new URLSearchParams();
  if (type) params.set("type", type);
  const qs = params.toString();
  const res = await daemonFetch(`${BASE}/api/pb/read${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error(`/api/pb/read failed (${res.status}): ${await res.text()}`);
  return res.json() as Promise<{ value: string | null }>;
}

export async function postPbWrite(text: string, type?: string): Promise<{ ok: boolean }> {
  const body: Record<string, string> = { text };
  if (type) body.type = type;
  const res = await daemonFetch(`${BASE}/api/pb/write`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`/api/pb/write failed (${res.status}): ${await res.text()}`);
  return res.json() as Promise<{ ok: boolean }>;
}

export async function fetchPbTypes(): Promise<string[]> {
  const res = await daemonFetch(`${BASE}/api/pb/types`);
  if (!res.ok) throw new Error(`/api/pb/types failed (${res.status}): ${await res.text()}`);
  return res.json() as Promise<string[]>;
}

export async function postPbClear(): Promise<{ ok: boolean }> {
  const res = await daemonFetch(`${BASE}/api/pb/clear`, { method: "POST" });
  if (!res.ok) throw new Error(`/api/pb/clear failed (${res.status}): ${await res.text()}`);
  return res.json() as Promise<{ ok: boolean }>;
}

// ── Display ──

export interface DisplayInfoResponse {
  id: number;
  name: string;
  main: boolean;
  frame: { x: number; y: number; width: number; height: number };
  visibleFrame: { x: number; y: number; width: number; height: number };
  scale: number;
  physicalSize: { width: number; height: number };
  rotation: number;
}

export async function fetchDisplayList(): Promise<DisplayInfoResponse[]> {
  const res = await daemonFetch(`${BASE}/api/display/list`);
  if (!res.ok) throw new Error(`/api/display/list failed (${res.status}): ${await res.text()}`);
  return res.json() as Promise<DisplayInfoResponse[]>;
}

export async function fetchDisplayMain(): Promise<DisplayInfoResponse | null> {
  const res = await daemonFetch(`${BASE}/api/display/main`);
  if (!res.ok) throw new Error(`/api/display/main failed (${res.status}): ${await res.text()}`);
  return res.json() as Promise<DisplayInfoResponse | null>;
}

export async function fetchDisplayById(id: number): Promise<DisplayInfoResponse> {
  const res = await daemonFetch(`${BASE}/api/display/${id}`);
  if (!res.ok) throw new Error(`/api/display/${id} failed (${res.status}): ${await res.text()}`);
  return res.json() as Promise<DisplayInfoResponse>;
}

// ── Defaults ──

export async function fetchDefaultsRead(domain: string, key?: string): Promise<unknown> {
  const params = new URLSearchParams({ domain });
  if (key) params.set("key", key);
  const res = await daemonFetch(`${BASE}/api/defaults/read?${params}`);
  if (!res.ok) throw new Error(`/api/defaults/read failed (${res.status}): ${await res.text()}`);
  return res.json();
}

export async function postDefaultsWrite(domain: string, key: string, value: string, type?: string): Promise<{ ok: boolean }> {
  const body: Record<string, string> = { domain, key, value };
  if (type) body.type = type;
  const res = await daemonFetch(`${BASE}/api/defaults/write`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`/api/defaults/write failed (${res.status}): ${await res.text()}`);
  return res.json() as Promise<{ ok: boolean }>;
}

export async function fetchDefaultsDomains(): Promise<string[]> {
  const res = await daemonFetch(`${BASE}/api/defaults/domains`);
  if (!res.ok) throw new Error(`/api/defaults/domains failed (${res.status}): ${await res.text()}`);
  return res.json() as Promise<string[]>;
}

// ── AX primitive routes ──

export interface AXNodeResult {
  role: string;
  title?: string;
  label?: string;
  value?: string;
  frame?: { x: number; y: number; width: number; height: number };
  children?: AXNodeResult[];
  [key: string]: unknown;
}

/** AX hit-test: returns the deepest element at screen point (x, y). */
export async function fetchAxAt(
  x: number,
  y: number,
  pid?: number,
): Promise<{ node: AXNodeResult; path: number[] } | null> {
  const params = new URLSearchParams({ x: String(x), y: String(y) });
  if (pid != null) params.set("pid", String(pid));
  const res = await daemonFetch(`${BASE}/api/ax/at?${params}`);
  if (!res.ok) throw new Error(`/api/ax/at failed (${res.status}): ${await res.text()}`);
  return res.json() as Promise<{ node: AXNodeResult; path: number[] } | null>;
}

/** AX action enumeration: returns known AX actions for the matched element. */
export async function fetchAxActions(opts: {
  label?: string;
  role?: string;
  nth?: number;
  pid?: number;
}): Promise<string[]> {
  const params = new URLSearchParams();
  if (opts.label) params.set("label", opts.label);
  if (opts.role) params.set("role", opts.role);
  if (opts.nth != null) params.set("nth", String(opts.nth));
  if (opts.pid != null) params.set("pid", String(opts.pid));
  const res = await daemonFetch(`${BASE}/api/ax/actions?${params}`);
  if (!res.ok) throw new Error(`/api/ax/actions failed (${res.status}): ${await res.text()}`);
  return res.json() as Promise<string[]>;
}

/** AX perform: perform a named AX action on the matched element. */
export async function postAxPerform(opts: {
  label?: string;
  role?: string;
  action: string;
  nth?: number;
  pid?: number;
}): Promise<{ ok: boolean; error?: string }> {
  const res = await daemonFetch(`${BASE}/api/ax/perform`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(opts),
  });
  if (!res.ok) {
    const text = await res.text();
    return { ok: false, error: text || `HTTP ${res.status}` };
  }
  return res.json() as Promise<{ ok: boolean; error?: string }>;
}

/** AX focus: focus the element matching the given label/role. */
export async function postAxFocus(opts: {
  label?: string;
  role?: string;
  nth?: number;
  pid?: number;
}): Promise<{ ok: boolean; error?: string }> {
  const res = await daemonFetch(`${BASE}/api/ax/focus`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(opts),
  });
  if (!res.ok) {
    const text = await res.text();
    return { ok: false, error: text || `HTTP ${res.status}` };
  }
  return res.json() as Promise<{ ok: boolean; error?: string }>;
}

/** AX menu-at: return the AXMenu node from a floating context menu at (x, y). */
export async function fetchAxMenuAt(
  x: number,
  y: number,
  pid?: number,
): Promise<AXNodeResult | null> {
  const params = new URLSearchParams({ x: String(x), y: String(y) });
  if (pid != null) params.set("pid", String(pid));
  const res = await daemonFetch(`${BASE}/api/ax/menu-at?${params}`);
  if (!res.ok) throw new Error(`/api/ax/menu-at failed (${res.status}): ${await res.text()}`);
  return res.json() as Promise<AXNodeResult | null>;
}

// ── CG pointer injection ──

export async function postCgMove(x: number, y: number): Promise<{ ok: boolean }> {
  const res = await daemonFetch(`${BASE}/api/cg/move`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ x, y }),
  });
  if (!res.ok) throw new Error(`/api/cg/move failed (${res.status}): ${await res.text()}`);
  return res.json() as Promise<{ ok: boolean }>;
}

export async function postCgClick(x: number, y: number, button?: string): Promise<{ ok: boolean }> {
  const body: Record<string, unknown> = { x, y };
  if (button) body.button = button;
  const res = await daemonFetch(`${BASE}/api/cg/click`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`/api/cg/click failed (${res.status}): ${await res.text()}`);
  return res.json() as Promise<{ ok: boolean }>;
}

export async function postCgDoubleClick(x: number, y: number, button?: string): Promise<{ ok: boolean }> {
  const body: Record<string, unknown> = { x, y };
  if (button) body.button = button;
  const res = await daemonFetch(`${BASE}/api/cg/doubleclick`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`/api/cg/doubleclick failed (${res.status}): ${await res.text()}`);
  return res.json() as Promise<{ ok: boolean }>;
}

export async function postCgDrag(fromX: number, fromY: number, toX: number, toY: number, button?: string): Promise<{ ok: boolean }> {
  const body: Record<string, unknown> = { fromX, fromY, toX, toY };
  if (button) body.button = button;
  const res = await daemonFetch(`${BASE}/api/cg/drag`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`/api/cg/drag failed (${res.status}): ${await res.text()}`);
  return res.json() as Promise<{ ok: boolean }>;
}

export async function postCgScroll(x: number, y: number, dx: number, dy: number): Promise<{ ok: boolean }> {
  const res = await daemonFetch(`${BASE}/api/cg/scroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ x, y, dx, dy }),
  });
  if (!res.ok) throw new Error(`/api/cg/scroll failed (${res.status}): ${await res.text()}`);
  return res.json() as Promise<{ ok: boolean }>;
}

export async function postCgKeyDown(key: string, mods?: string[]): Promise<{ ok: boolean }> {
  const body: Record<string, unknown> = { key };
  if (mods && mods.length > 0) body.mods = mods;
  const res = await daemonFetch(`${BASE}/api/cg/keydown`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`/api/cg/keydown failed (${res.status}): ${await res.text()}`);
  return res.json() as Promise<{ ok: boolean }>;
}

export async function postCgKeyUp(key: string, mods?: string[]): Promise<{ ok: boolean }> {
  const body: Record<string, unknown> = { key };
  if (mods && mods.length > 0) body.mods = mods;
  const res = await daemonFetch(`${BASE}/api/cg/keyup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`/api/cg/keyup failed (${res.status}): ${await res.text()}`);
  return res.json() as Promise<{ ok: boolean }>;
}

export async function postCgModDown(mods: string[]): Promise<{ ok: boolean }> {
  const res = await daemonFetch(`${BASE}/api/cg/moddown`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mods }),
  });
  if (!res.ok) throw new Error(`/api/cg/moddown failed (${res.status}): ${await res.text()}`);
  return res.json() as Promise<{ ok: boolean }>;
}

export async function postCgModUp(mods: string[]): Promise<{ ok: boolean }> {
  const res = await daemonFetch(`${BASE}/api/cg/modup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mods }),
  });
  if (!res.ok) throw new Error(`/api/cg/modup failed (${res.status}): ${await res.text()}`);
  return res.json() as Promise<{ ok: boolean }>;
}

export async function fetchCgMousePos(): Promise<{ x: number; y: number }> {
  const res = await daemonFetch(`${BASE}/api/cg/mousepos`);
  if (!res.ok) throw new Error(`/api/cg/mousepos failed (${res.status}): ${await res.text()}`);
  return res.json() as Promise<{ x: number; y: number }>;
}

export async function fetchCgMouseState(): Promise<{ x: number; y: number; buttons: { left: boolean; right: boolean; middle: boolean } }> {
  const res = await daemonFetch(`${BASE}/api/cg/mousestate`);
  if (!res.ok) throw new Error(`/api/cg/mousestate failed (${res.status}): ${await res.text()}`);
  return res.json() as Promise<{ x: number; y: number; buttons: { left: boolean; right: boolean; middle: boolean } }>;
}

export async function postAction(body: {
  app: string;
  type: string;
  id: string;
  action: string;
  value?: string;
  axRole?: string;
  x?: number;
  y?: number;
}): Promise<{ ok: boolean; error?: string; followUp?: string }> {
  const res = await daemonFetch(`${BASE}/api/action`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    return { ok: false, error: text || `HTTP ${res.status}` };
  }
  try {
    return JSON.parse(text);
  } catch {
    // Server returned non-JSON success (e.g. plain "ok")
    return { ok: true };
  }
}
