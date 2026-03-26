/**
 * Raw accessibility tree bypass — queries and actions go directly to the
 * macOS AX tree via the daemon's N-API endpoints, skipping the CRDT entirely.
 */
import {
  assertAXCursor,
  assertAXTarget,
  isAXCursor,
  isAXTarget,
  type AXCursor,
  type AXQueryCardinality,
  type AXTarget,
} from "../a11y/ax-target.js";
import {
  renderAXQueryGuiml as renderCanonicalAXQueryGuiml,
  type AXQuerySerializedMatch,
} from "../a11y/ax-query.js";
import { daemonFetch, fetchRawAXFrontmostPid, fetchRawWorkspaceApps, type RawWorkspaceApp } from "./client.js";
import {
  assertAXQueryMatch,
  isAXQueryMatch,
  normalizeCLICompositionPayload,
  parseCLICompositionPayloadStream,
  parseSingleCLICompositionPayload,
  requireCLICompositionTarget,
} from "./payload.js";
import type { PlainNode } from "./types.js";

export type { AXCursor, AXTarget } from "../a11y/ax-target.js";
export type { AXQuerySerializedMatch as AXQueryMatch } from "../a11y/ax-query.js";
export { assertAXQueryMatch, isAXQueryMatch } from "./payload.js";

export type AXQueryScopeInput =
  | { kind: "all" }
  | { kind: "focused" }
  | { kind: "pid"; pid: number }
  | { kind: "app"; app: string };

export type AXQueryScope =
  | { kind: "all" }
  | { kind: "focused" }
  | { kind: "pid"; pid: number };

// Raw AX tree access — hits /api/ax/snapshot directly, no processing
const BASE = "http://localhost:7861";

function summarizeResponseBody(body: string, limit = 160): string {
  return body.replace(/\s+/g, " ").trim().slice(0, limit);
}

function looksLikeHTMLFallback(contentType: string, body: string): boolean {
  const normalizedType = contentType.toLowerCase();
  const normalizedBody = body.trim().toLowerCase();
  return normalizedType.includes("text/html")
    || normalizedBody.startsWith("<!doctype html")
    || normalizedBody.startsWith("<html")
    || body.includes("__bunfallback");
}

async function formatAXHTTPError(label: string, res: Response): Promise<string> {
  const body = await res.text();
  const contentType = res.headers.get("content-type") || "";
  if (looksLikeHTMLFallback(contentType, body)) {
    const preview = summarizeResponseBody(body);
    return `${label} failed (${res.status}): GhostUI returned an HTML fallback page instead of AX JSON. `
      + `The app/daemon on localhost:7861 is likely stale or wrong; rebuild/restart it. `
      + `Body preview: ${preview}`;
  }
  return `${label} failed (${res.status}): ${body}`;
}

async function expectAXJSON<T>(label: string, res: Response): Promise<T> {
  if (!res.ok) {
    throw new Error(await formatAXHTTPError(label, res));
  }
  const contentType = res.headers.get("content-type") || "";
  const body = await res.text();
  if (!contentType.toLowerCase().includes("application/json")) {
    const preview = summarizeResponseBody(body);
    throw new Error(
      `${label} returned non-JSON response (${contentType || "unknown content-type"}). `
      + `The GhostUI daemon/app is likely stale or wrong on localhost:7861. `
      + `Body preview: ${preview}`,
    );
  }
  try {
    return JSON.parse(body) as T;
  } catch {
    const preview = summarizeResponseBody(body);
    throw new Error(`${label} returned invalid JSON. Body preview: ${preview}`);
  }
}

// ── AX node shape from the snapshot endpoint ──

export interface AXNode {
  role: string;
  title?: string;
  label?: string;
  description?: string;
  value?: string;
  subrole?: string;
  identifier?: string;
  placeholder?: string;
  enabled?: boolean;
  focused?: boolean;
  selected?: boolean;
  frame?: { x: number; y: number; width: number; height: number };
  children?: AXNode[];
  actions?: string[];
  capabilities?: Record<string, unknown>;
}

// ── Fetch the raw AX tree for specific or frontmost app ──

export async function fetchRawAXTree(pid?: number, depth = 1000): Promise<{ app: string; tree: AXNode }> {
  const params = new URLSearchParams({ depth: String(depth) });
  if (pid) params.set("pid", String(pid));
  const res = await daemonFetch(`${BASE}/api/ax/snapshot?${params}`);
  const tree = await expectAXJSON<AXNode>("AX snapshot", res);
  if (!tree) throw new Error("No AX tree returned");
  return { app: tree.title || "unknown", tree };
}

// ── Format AX nodes for display ──

export function formatAXNode(node: AXNode, indent = 0): string {
  const lines: string[] = [];
  const pad = "  ".repeat(indent);
  const role = node.role || "?";

  const attrs: string[] = [];
  if (node.title) attrs.push(`title="${node.title}"`);
  if (node.label && node.label !== node.title) attrs.push(`label="${node.label}"`);
  if (node.description) attrs.push(`desc="${node.description}"`);
  if (node.value !== undefined && node.value !== null && node.value !== "") attrs.push(`value="${node.value}"`);
  if (node.subrole) attrs.push(`subrole="${node.subrole}"`);
  if (node.identifier) attrs.push(`id="${node.identifier}"`);
  // Capabilities from raw N-API format
  const caps = node.capabilities;
  if (node.enabled === false || caps?.enabled === false) attrs.push("disabled");
  if (node.focused || caps?.focused) attrs.push("focused");
  if (node.selected || caps?.selected) attrs.push("selected");
  if (caps?.checked) attrs.push("checked");
  if (caps?.expanded) attrs.push("expanded");
  if (node.frame) {
    attrs.push(`frame=(${node.frame.x},${node.frame.y},${node.frame.width},${node.frame.height})`);
  }

  const attrStr = attrs.length > 0 ? " " + attrs.join(" ") : "";

  if (!node.children || node.children.length === 0) {
    lines.push(`${pad}<${role}${attrStr} />`);
  } else {
    lines.push(`${pad}<${role}${attrStr}>`);
    for (const child of node.children) {
      lines.push(formatAXNode(child, indent + 1));
    }
    lines.push(`${pad}</${role}>`);
  }

  return lines.join("\n");
}

/** Format a flat list of matches (not full tree). */
export function formatAXMatches(matches: { node: AXNode; path: AXNode[] }[]): string {
  return matches.map((m, i) => {
    const pathStr = m.path.map(n => n.role).join(" > ");
    const prefix = pathStr ? `${pathStr} > ` : "";
    return `[${i}] ${prefix}${formatAXNode(m.node, 0)}`;
  }).join("\n\n");
}

export function formatAXQueryGuiml(tree: AXNode, query: string, cardinality: AXQueryCardinality): string {
  return renderCanonicalAXQueryGuiml([{ pid: 1, tree }], query, cardinality);
}

export function formatAXQueryGuimlAcrossTrees(
  trees: AXNode[],
  query: string,
  cardinality: AXQueryCardinality,
): string {
  return renderCanonicalAXQueryGuiml(
    trees.map((tree, index) => ({ pid: index + 1, tree })),
    query,
    cardinality,
  );
}

export function extractAXQueryScope(arr: string[]): AXQueryScopeInput {
  const hasAll = extractBooleanFlag(arr, "--all");
  const hasFocused = extractBooleanFlag(arr, "--focused");
  const pid = extractScopePid(arr);
  const app = extractScopeValue(arr, "--app");
  const count = [hasAll, hasFocused, pid !== undefined, app !== undefined].filter(Boolean).length;
  if (count !== 1) {
    throw new Error([
      "Choose exactly one scope selector:",
      "  --gui",
      "  --visible",
      "  --focused",
      "  --pid <pid>",
      "  --app <bundle|name>",
      "  --all",
    ].join("\n"));
  }
  if (hasAll) return { kind: "all" };
  if (hasFocused) return { kind: "focused" };
  if (pid !== undefined) return { kind: "pid", pid };
  return { kind: "app", app: app! };
}

function extractBooleanFlag(arr: string[], flag: string): boolean {
  const matches = arr.reduce<number[]>((acc, token, index) => token === flag ? [...acc, index] : acc, []);
  if (matches.length > 1) {
    throw new Error(`${flag} may only be specified once.`);
  }
  if (matches.length === 0) return false;
  arr.splice(matches[0], 1);
  return true;
}

function extractScopePid(arr: string[]): number | undefined {
  const matches = arr.reduce<number[]>((acc, token, index) => token === "--pid" ? [...acc, index] : acc, []);
  if (matches.length > 1) {
    throw new Error("--pid may only be specified once.");
  }
  if (matches.length === 0) return undefined;
  const index = matches[0];
  const value = Number(arr[index + 1]);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("--pid requires a positive integer.");
  }
  arr.splice(index, 2);
  return value;
}

function extractScopeValue(arr: string[], flag: string): string | undefined {
  const matches = arr.reduce<number[]>((acc, token, index) => token === flag ? [...acc, index] : acc, []);
  if (matches.length > 1) {
    throw new Error(`${flag} may only be specified once.`);
  }
  if (matches.length === 0) return undefined;
  const index = matches[0];
  const value = arr[index + 1]?.trim();
  if (!value) {
    throw new Error(`${flag} requires a value.`);
  }
  arr.splice(index, 2);
  return value;
}

export function resolveAXQueryApp(apps: RawWorkspaceApp[], target: string): RawWorkspaceApp {
  const normalized = target.trim().toLowerCase();
  const all = apps.filter(app => Number.isInteger(app.pid) && app.pid > 0);
  const exactBundle = all.filter(app => (app.bundleId || "").toLowerCase() === normalized);
  if (exactBundle.length === 1) return exactBundle[0];
  if (exactBundle.length > 1) {
    throw new Error(`AX query scope "${target}" is ambiguous: ${exactBundle.map(describeWorkspaceApp).join(", ")}`);
  }
  const exactName = all.filter(app => (app.name || "").toLowerCase() === normalized);
  if (exactName.length === 1) return exactName[0];
  if (exactName.length > 1) {
    throw new Error(`AX query scope "${target}" is ambiguous: ${exactName.map(describeWorkspaceApp).join(", ")}`);
  }
  const partial = all.filter(app =>
    (app.bundleId || "").toLowerCase().includes(normalized) ||
    (app.name || "").toLowerCase().includes(normalized));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new Error(`AX query scope "${target}" matched multiple apps: ${partial.map(describeWorkspaceApp).join(", ")}`);
  }
  throw new Error(`No running app matched "${target}".`);
}

function describeWorkspaceApp(app: RawWorkspaceApp): string {
  const name = app.name || "unknown";
  const bundleId = app.bundleId || "unknown.bundle";
  return `${name} (${bundleId}, pid ${app.pid})`;
}

export async function resolveAXQueryScope(scope: AXQueryScopeInput): Promise<AXQueryScope> {
  switch (scope.kind) {
    case "all":
    case "focused":
      return scope;
    case "pid":
      return scope;
    case "app": {
      const apps = await fetchRawWorkspaceApps();
      const app = resolveAXQueryApp(apps, scope.app);
      return { kind: "pid", pid: app.pid };
    }
  }
}

async function listAllAXQueryPids(): Promise<number[]> {
  const [apps, frontmost] = await Promise.all([
    fetchRawWorkspaceApps(),
    fetchRawAXFrontmostPid().catch(() => null),
  ]);
  const ordered: number[] = [];
  const seen = new Set<number>();
  const pushPid = (pid?: number) => {
    if (!Number.isInteger(pid) || pid! <= 0 || seen.has(pid!)) return;
    seen.add(pid!);
    ordered.push(pid!);
  };
  pushPid(frontmost ?? undefined);
  for (const app of apps) {
    pushPid(app.pid);
  }
  return ordered;
}

async function fetchAXQueryTrees(scope: AXQueryScope): Promise<Array<{ pid: number; tree: AXNode }>> {
  switch (scope.kind) {
    case "focused": {
      const frontmostPid = await fetchRawAXFrontmostPid();
      if (!frontmostPid) {
        throw new Error("No frontmost PID");
      }
      return [{ pid: frontmostPid, tree: (await fetchRawAXTree(frontmostPid)).tree }];
    }
    case "pid":
      return [{ pid: scope.pid, tree: (await fetchRawAXTree(scope.pid)).tree }];
    case "all": {
      const pids = await listAllAXQueryPids();
      const trees = await Promise.all(pids.map(async (pid) => {
        try {
          return { pid, tree: (await fetchRawAXTree(pid)).tree };
        } catch {
          return null;
        }
      }));
      return trees.filter((tree): tree is { pid: number; tree: AXNode } => tree !== null);
    }
  }
}

export async function renderAXQueryGuimlForScope(
  scope: AXQueryScope,
  query: string,
  cardinality: AXQueryCardinality,
): Promise<string> {
  return renderCanonicalAXQueryGuiml(await fetchAXQueryTrees(scope), query, cardinality);
}

export function formatAXTarget(target: AXTarget): string {
  const attrs = [
    `pid=${target.pid}`,
    `point=(${target.point.x},${target.point.y})`,
  ];
  if (target.bounds) {
    attrs.push(`frame=(${target.bounds.x},${target.bounds.y},${target.bounds.width},${target.bounds.height})`);
  }
  if (target.subrole) attrs.push(`subrole="${target.subrole}"`);
  if (target.title) attrs.push(`title="${target.title}"`);
  if (target.label && target.label !== target.title) attrs.push(`label="${target.label}"`);
  if (target.identifier) attrs.push(`id="${target.identifier}"`);
  return `<${target.role} ${attrs.join(" ")} />`;
}

export function formatAXTargets(targets: AXTarget[]): string {
  return targets.map((target, index) => `[${index}] ${formatAXTarget(target)}`).join("\n\n");
}

export type AXScopePayload =
  | { kind: "cursor"; cursor: AXCursor; pid: number; target: AXTarget }
  | { kind: "target"; target: AXTarget; pid: number };

function scopePayloadFromValue(value: unknown, label: string): AXScopePayload {
  const payload = normalizeCLICompositionPayload(value, label);
  if (payload.cursor) {
    const cursor = assertAXCursor(payload.cursor, `${label}.cursor`);
    return { kind: "cursor", cursor, pid: cursor.target.pid, target: cursor.target };
  }
  const target = requireCLICompositionTarget(payload, label);
  return { kind: "target", target, pid: target.pid };
}

export function parseAXScopePayload(text: string, label = "AX scope payload"): AXScopePayload {
  return scopePayloadFromValue(parseSingleCLICompositionPayload(text, label), label);
}

function targetFromStdinPayload(value: unknown, label: string): AXTarget {
  return requireCLICompositionTarget(normalizeCLICompositionPayload(value, label), label);
}

export function parseAXTargetStream(text: string): AXTarget[] {
  return parseCLICompositionPayloadStream(text).map((payload, index) =>
    requireCLICompositionTarget(payload, `stdin payload[${index}]`),
  );
}

export function parseAXTargetPayload(text: string, label = "AX target payload"): AXTarget {
  const targets = parseAXTargetStream(text);
  if (targets.length === 0) {
    throw new Error(`${label} expected a JSON CLI payload with an AX target`);
  }
  if (targets.length > 1) {
    throw new Error(`${label} expected exactly one JSON CLI payload with an AX target, received ${targets.length}`);
  }
  return targets[0];
}

export async function fetchAXQueryMatches(
  query: string,
  scope: AXQueryScope,
  cardinality?: "first" | "only" | "all" | "each",
  target?: AXTarget,
): Promise<AXQuerySerializedMatch[]> {
  const body: Record<string, unknown> = {
    query,
    ...(cardinality !== undefined ? { cardinality } : {}),
  };
  if (target) {
    body.target = target;
  }
  if (scope.kind === "pid") {
    body.pid = scope.pid;
  } else if (scope.kind === "all") {
    body.all = true;
  }
  const res = await daemonFetch(`${BASE}/api/ax/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await expectAXJSON<unknown>("AX query", res);
  if (!Array.isArray(data)) {
    throw new Error("AX query returned a non-array payload");
  }
  return data.map((item, index) => assertAXQueryMatch(item, `AXQueryMatch[${index}]`));
}

export async function fetchAXQueryTargets(
  query: string,
  scope: AXQueryScope,
  cardinality?: "first" | "only" | "all" | "each",
  target?: AXTarget,
): Promise<AXTarget[]> {
  return (await fetchAXQueryMatches(query, scope, cardinality, target)).map((match, index) =>
    targetFromStdinPayload(match, `AXQueryMatch[${index}]`),
  );
}

export async function fetchAXCursor(): Promise<AXCursor> {
  const res = await daemonFetch(`${BASE}/api/ax/cursor`);
  return assertAXCursor(await expectAXJSON<unknown>("AX cursor", res), "AXCursor");
}

// ── Direct AX actions via daemon HTTP API ──

async function axAction(body: Record<string, unknown>): Promise<void> {
  const res = await daemonFetch(`${BASE}/api/ax/action`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await formatAXHTTPError("AX action", res));
  }
}

export async function axClick(
  label: string | undefined,
  role: string | undefined,
  nth?: number,
  parent?: string,
  target?: string,
): Promise<void> {
  await axAction({ method: "click", label, role, nth, parent, target });
}

export async function axClickTarget(target: AXTarget): Promise<void> {
  await axAction({ method: "click", target: assertAXTarget(target) });
}

export async function axPressTarget(target: AXTarget): Promise<void> {
  await axAction({ method: "press", target: assertAXTarget(target) });
}

export async function axSet(
  value: string,
  label: string | undefined,
  role: string | undefined,
  nth?: number,
  parent?: string,
  target?: string,
): Promise<void> {
  await axAction({ method: "set", value, label, role, nth, parent, target });
}

export async function axSetTarget(value: string, target: AXTarget): Promise<void> {
  await axAction({ method: "set", value, target: assertAXTarget(target) });
}

export async function axHover(
  label: string,
  role: string | undefined,
  nth?: number,
  parent?: string,
  target?: string,
): Promise<void> {
  await axAction({ method: "hover", label, role, nth, parent, target });
}

export async function axHoverTarget(target: AXTarget): Promise<void> {
  await axAction({ method: "hover", target: assertAXTarget(target) });
}

export async function axType(
  value: string,
  label: string | undefined,
  role: string | undefined,
  nth?: number,
  pid?: number,
  parent?: string,
  target?: string,
): Promise<void> {
  const resolvedTarget = target ?? (pid !== undefined ? `pid:${pid}` : undefined);
  await axAction({ method: "type", value, label, role, nth, parent, target: resolvedTarget });
}

export async function axTypeTarget(value: string, target: AXTarget): Promise<void> {
  await axAction({ method: "type", value, target: assertAXTarget(target) });
}

export async function axTypeCursor(value: string, cursor: AXCursor): Promise<void> {
  await axAction({ method: "type", value, target: assertAXCursor(cursor) });
}

export async function axSelectCursor(cursor: AXCursor): Promise<void> {
  await axAction({ method: "select", target: assertAXCursor(cursor) });
}

export async function axFocusWindowTarget(target: AXTarget): Promise<void> {
  const res = await daemonFetch(`${BASE}/api/ax/focus-window`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ target: assertAXTarget(target) }),
  });
  if (!res.ok) {
    throw new Error(await formatAXHTTPError("AX focus-window", res));
  }
}

export async function axFocusTarget(target: AXTarget): Promise<void> {
  const res = await daemonFetch(`${BASE}/api/ax/focus`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ target: assertAXTarget(target) }),
  });
  if (!res.ok) {
    throw new Error(await formatAXHTTPError("AX focus", res));
  }
}

export async function axFocus(
  label: string | undefined,
  role: string | undefined,
  nth?: number,
  pid?: number,
): Promise<void> {
  const body: Record<string, unknown> = {};
  if (label !== undefined) body.label = label;
  if (role !== undefined) body.role = role;
  if (nth !== undefined) body.nth = nth;
  if (pid !== undefined) body.pid = pid;
  const res = await daemonFetch(`${BASE}/api/ax/focus`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await formatAXHTTPError("AX focus", res));
  }
}

export async function axPerformTarget(action: string, target: AXTarget): Promise<void> {
  const res = await daemonFetch(`${BASE}/api/ax/perform`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, target: assertAXTarget(target) }),
  });
  if (!res.ok) {
    throw new Error(await formatAXHTTPError("AX perform", res));
  }
}

export async function axPerform(
  action: string,
  label: string | undefined,
  role: string | undefined,
  nth?: number,
  pid?: number,
): Promise<void> {
  const body: Record<string, unknown> = { action };
  if (label !== undefined) body.label = label;
  if (role !== undefined) body.role = role;
  if (nth !== undefined) body.nth = nth;
  if (pid !== undefined) body.pid = pid;
  const res = await daemonFetch(`${BASE}/api/ax/perform`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await formatAXHTTPError("AX perform", res));
  }
}

export async function fetchAXAt(x: number, y: number, pid?: number): Promise<unknown> {
  const params = new URLSearchParams({ x: String(x), y: String(y) });
  if (pid !== undefined) params.set("pid", String(pid));
  const res = await daemonFetch(`${BASE}/api/ax/at?${params}`);
  return expectAXJSON("AX at", res);
}

export async function fetchAXActions(
  label: string | undefined,
  role: string | undefined,
  pid?: number,
): Promise<string[]> {
  const params = new URLSearchParams();
  if (label) params.set("label", label);
  if (role) params.set("role", role);
  if (pid !== undefined) params.set("pid", String(pid));
  const res = await daemonFetch(`${BASE}/api/ax/actions?${params}`);
  return expectAXJSON("AX actions", res);
}

export async function fetchAXActionsTarget(target: AXTarget): Promise<string[]> {
  const res = await daemonFetch(`${BASE}/api/ax/actions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ target: assertAXTarget(target) }),
  });
  return expectAXJSON("AX actions", res);
}

export async function fetchAXMenuAt(x: number, y: number, pid?: number): Promise<unknown> {
  const params = new URLSearchParams({ x: String(x), y: String(y) });
  if (pid !== undefined) params.set("pid", String(pid));
  const res = await daemonFetch(`${BASE}/api/ax/menu-at?${params}`);
  return expectAXJSON("AX menu-at", res);
}

export function describeAXTarget(target: AXTarget): string {
  const label = target.title || target.label || target.identifier;
  return `${target.role}${label ? ` "${label}"` : ""}`;
}

export function isInlineAXTarget(value: unknown): value is AXTarget {
  return isAXTarget(value);
}

// ── Client-side AX event filtering ──

export interface AXEventFilter {
  pid?: number;
  bundle?: string;
}

/** Returns true if the event matches the filter (empty filter matches all). */
export function axEventMatchesFilter(
  event: { pid?: number; bundleId?: string },
  filter: AXEventFilter,
): boolean {
  if (filter.pid !== undefined && event.pid !== filter.pid) return false;
  if (filter.bundle !== undefined && event.bundleId !== filter.bundle) return false;
  return true;
}
