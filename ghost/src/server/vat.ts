import { materializeSelectedMatches, selectForestMatchesWithCardinality } from "../cli/filter.js";
import { buildCLICompositionPayloadFromVatQueryResult } from "../cli/payload.js";
import { parseQuery, queryHasIntrospection } from "../cli/query.js";
import type { PlainNode } from "../cli/types.js";
import type { QueryNode } from "../cli/types.js";
import type { AXObserverEvent } from "../a11y/native-ax.js";
import { normalizeVatMountPolicy } from "../vat/config.js";
import {
  VatApiError,
  type VatMountPolicy,
  type VatMountRequest,
  type VatMountResponse,
  type VatPersistedMount,
  type VatPolicyResponse,
  type VatUnmountResponse,
} from "../vat/types.js";
import type { VatRegistry } from "../vat/registry.js";

interface VatRouteOptions {
  persist?: (mounts: VatPersistedMount[]) => Promise<void>;
  openTriggerStream?: () => Promise<Response>;
}

type VatWatchChangeKind = "added" | "removed" | "updated";

interface VatWatchChange {
  kind: VatWatchChangeKind;
  index: number;
  previous: PlainNode | null;
  current: PlainNode | null;
}

interface VatWatchSummary {
  added: number;
  removed: number;
  updated: number;
  total: number;
}

interface VatQuerySnapshot {
  tree: PlainNode;
  nodes: PlainNode[];
  diffNodes: PlainNode[];
  matchCount: number;
}

interface SnapshotNodeEntry {
  node: PlainNode;
  index: number;
  serialized: string;
}

export function handleVAT(
  req: Request,
  registry: VatRegistry,
  options: VatRouteOptions = {},
): Response | Promise<Response> | null {
  const url = new URL(req.url);

  if (req.method === "POST" && url.pathname === "/api/vat/mount") {
    return handleMount(req, registry, options);
  }

  if (req.method === "DELETE" && url.pathname === "/api/vat/mount") {
    return handleUnmount(url, registry, options);
  }

  if (req.method === "PATCH" && url.pathname === "/api/vat/policy") {
    return handlePolicy(req, url, registry, options);
  }

  if (req.method === "GET" && url.pathname === "/api/vat/mounts") {
    return Response.json(registry.list(), {
      headers: { "access-control-allow-origin": "*" },
    });
  }

  if (req.method === "GET" && url.pathname === "/api/vat/query") {
    return handleQuery(url, registry);
  }

  if (req.method === "GET" && url.pathname === "/api/vat/watch") {
    return handleWatch(req, url, registry, options);
  }

  if (req.method === "GET" && url.pathname === "/api/vat/tree") {
    const path = url.searchParams.get("path");
    try {
      return Response.json(registry.tree(path), {
        headers: { "access-control-allow-origin": "*" },
      });
    } catch (error: unknown) {
      return jsonError(error instanceof Error ? error.message : String(error), error instanceof VatApiError ? error.status : 404);
    }
  }

  return null;
}

function handleQuery(url: URL, registry: VatRegistry): Response {
  const q = url.searchParams.get("q");
  if (!q) {
    return jsonError("VAT query requires a query", 400);
  }
  try {
    return Response.json(executeVatQuery(q, registry), {
      headers: { "access-control-allow-origin": "*" },
    });
  } catch (error: unknown) {
    return jsonError(error instanceof Error ? error.message : String(error), error instanceof VatApiError ? error.status : 400);
  }
}

interface QueryActivationDiscovery {
  paths: string[];
  hasMountTargetingSelector: boolean;
}

function collectTouchedQueryPaths(rawQuery: string, queries: QueryNode[]): QueryActivationDiscovery {
  const paths = new Set<string>();
  let hasRootIdSelector = false;
  const hasCompactMountPathSyntax = isCompactMountPathQuery(rawQuery);

  const visit = (node: QueryNode, chain: string[], isRoot: boolean): void => {
    if (isRoot && node.id !== undefined && node.id !== "") {
      hasRootIdSelector = true;
    }

    const segment = collectQueryActivationSegment(node, isRoot);
    const nextChain = segment !== undefined ? [...chain, segment] : chain;
    if (segment !== undefined) {
      paths.add(`/${nextChain.join("/")}`);
    }

    for (const child of node.children ?? []) {
      visit(child, nextChain, false);
    }
  };

  for (const query of queries) {
    visit(query, [], true);
  }

  return {
    paths: [...paths].sort((a, b) => a.length - b.length || a.localeCompare(b)),
    hasMountTargetingSelector: hasRootIdSelector || (hasCompactMountPathSyntax && queryHasIntrospection(queries)),
  };
}

function executeVatQuery(q: string, registry: VatRegistry): VatQuerySnapshot {
  const queries = parseQuery(q);
  const activation = collectTouchedQueryPaths(q, queries);
  const queryableMountPaths = new Set(registry.list().map((mount) => mount.path));
  const targetedPaths = activation.paths.filter((path) => queryableMountPaths.has(path));

  if (targetedPaths.length > 0) {
    for (const path of targetedPaths) {
      registry.activatePath(path);
    }
  } else if (!activation.hasMountTargetingSelector) {
    registry.activateQueryable();
  }

  const tree = registry.tree().tree as PlainNode;
  const selection = selectForestMatchesWithCardinality([tree], queries, "all");
  const nodes = materializeSelectedMatches(selection.matches);
  const diffNodes = materializeSelectedMatches(selection.matches, { merge: false });
  return { tree, nodes, diffNodes, matchCount: selection.matchCount };
}

function parseWatchKinds(value: string | null): Set<VatWatchChangeKind> | null {
  if (value == null || value.trim() === "") {
    return null;
  }
  const kinds = value
    .split(",")
    .map((kind) => kind.trim())
    .filter(Boolean);
  if (kinds.length === 0) {
    throw new Error("VAT watch filter requires at least one change kind");
  }

  const normalized = new Set<VatWatchChangeKind>();
  for (const kind of kinds) {
    if (kind !== "added" && kind !== "removed" && kind !== "updated") {
      throw new Error(`VAT watch filter kind must be one of: added, removed, updated`);
    }
    normalized.add(kind);
  }
  return normalized;
}

function summarizeChanges(changes: VatWatchChange[]): VatWatchSummary {
  const summary: VatWatchSummary = {
    added: 0,
    removed: 0,
    updated: 0,
    total: changes.length,
  };
  for (const change of changes) {
    summary[change.kind] += 1;
  }
  return summary;
}

function serializeSnapshotNode(node: PlainNode): string {
  return JSON.stringify(node);
}

function nodeStableIdentitySegment(node: PlainNode): string | null {
  const stableFieldNames = ["_id", "id", "identifier", "bundleId", "pid"] as const;
  for (const fieldName of stableFieldNames) {
    const value = node[fieldName];
    if (typeof value === "string" && value.length > 0) {
      return `${node._tag}:${fieldName}:${value}`;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return `${node._tag}:${fieldName}:${value}`;
    }
  }
  return null;
}

function nodeIdentityKey(node: PlainNode): string | null {
  const segments: string[] = [];
  let current: PlainNode | undefined = node;
  let sawStableSegment = false;

  while (current) {
    const stableSegment = nodeStableIdentitySegment(current);
    if (stableSegment) {
      segments.push(stableSegment);
      sawStableSegment = true;
    } else {
      segments.push(current._tag);
    }
    const children = current._children;
    if (!children || children.length !== 1) {
      break;
    }
    current = children[0];
  }

  return sawStableSegment ? segments.join("\0") : null;
}

function queueSnapshotMatches(
  entries: SnapshotNodeEntry[],
  keyForEntry: (entry: SnapshotNodeEntry) => string | null,
): Map<string, SnapshotNodeEntry[]> {
  const queued = new Map<string, SnapshotNodeEntry[]>();
  for (const entry of entries) {
    const key = keyForEntry(entry);
    if (!key) {
      continue;
    }
    const matches = queued.get(key);
    if (matches) {
      matches.push(entry);
      continue;
    }
    queued.set(key, [entry]);
  }
  return queued;
}

function diffQuerySnapshots(previous: VatQuerySnapshot, current: VatQuerySnapshot): VatWatchChange[] {
  const changes: VatWatchChange[] = [];
  const previousEntries = previous.diffNodes.map((node, index) => ({
    node,
    index,
    serialized: serializeSnapshotNode(node),
  }));
  const currentEntries = current.diffNodes.map((node, index) => ({
    node,
    index,
    serialized: serializeSnapshotNode(node),
  }));
  const matchedPrev = new Set<number>();
  const matchedCurr = new Set<number>();

  // Match identical serialized nodes first so insertions/removals do not shift
  // unchanged siblings into false "updated" classifications.
  const prevBySerialized = queueSnapshotMatches(previousEntries, (entry) => entry.serialized);
  for (const entry of currentEntries) {
    const matches = prevBySerialized.get(entry.serialized);
    const prevEntry = matches?.shift();
    if (!prevEntry) {
      continue;
    }
    matchedPrev.add(prevEntry.index);
    matchedCurr.add(entry.index);
  }

  // Pair the remaining nodes only when a stable identity is available. If not,
  // leave them as add/remove instead of inventing a false update.
  const unmatchedPrevEntries = previousEntries.filter((entry) => !matchedPrev.has(entry.index));
  const prevByIdentity = queueSnapshotMatches(unmatchedPrevEntries, (entry) => nodeIdentityKey(entry.node));
  for (const entry of currentEntries) {
    if (matchedCurr.has(entry.index)) {
      continue;
    }
    const identityKey = nodeIdentityKey(entry.node);
    if (!identityKey) {
      continue;
    }
    const matches = prevByIdentity.get(identityKey);
    const prevEntry = matches?.shift();
    if (!prevEntry) {
      continue;
    }
    matchedPrev.add(prevEntry.index);
    matchedCurr.add(entry.index);
    if (prevEntry.serialized !== entry.serialized) {
      changes.push({ kind: "updated", index: entry.index, previous: prevEntry.node, current: entry.node });
    }
  }

  const remainingPrevEntries = previousEntries.filter((entry) => !matchedPrev.has(entry.index));
  const remainingCurrEntries = currentEntries.filter((entry) => !matchedCurr.has(entry.index));
  if (remainingPrevEntries.length === remainingCurrEntries.length) {
    for (let index = 0; index < remainingPrevEntries.length; index += 1) {
      const prevEntry = remainingPrevEntries[index];
      const currEntry = remainingCurrEntries[index];
      matchedPrev.add(prevEntry.index);
      matchedCurr.add(currEntry.index);
      if (prevEntry.serialized !== currEntry.serialized) {
        changes.push({ kind: "updated", index: currEntry.index, previous: prevEntry.node, current: currEntry.node });
      }
    }
  }

  for (const entry of previousEntries) {
    if (!matchedPrev.has(entry.index)) {
      changes.push({ kind: "removed", index: entry.index, previous: entry.node, current: null });
    }
  }

  for (const entry of currentEntries) {
    if (!matchedCurr.has(entry.index)) {
      changes.push({ kind: "added", index: entry.index, previous: null, current: entry.node });
    }
  }

  return changes;
}

function isRetryableWatchStreamError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  return (
    lower.includes("socket connection was closed unexpectedly")
    || lower.includes("econnreset")
    || lower.includes("connection reset")
    || lower.includes("broken pipe")
    || lower.includes("watch trigger stream ended unexpectedly")
  );
}

async function openDefaultWatchTriggerStream(): Promise<Response> {
  const response = await fetch("http://localhost:7861/api/raw/events?follow=1");
  if (!response.ok) {
    throw new Error(`/api/raw/events failed (${response.status}): ${await response.text()}`);
  }
  return response;
}

function parseAXObserverEvent(value: unknown): AXObserverEvent | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.type !== "string" || record.type.length === 0) {
    return null;
  }
  const pid = typeof record.pid === "number" && Number.isFinite(record.pid) ? record.pid : 0;
  const bundleId = typeof record.bundleId === "string" && record.bundleId.length > 0 ? record.bundleId : undefined;
  return {
    type: record.type,
    pid,
    bundleId,
  } as AXObserverEvent;
}

function buildWatchPayload(
  query: string,
  snapshot: VatQuerySnapshot,
  changes: VatWatchChange[],
): Record<string, unknown> {
  return {
    ...buildCLICompositionPayloadFromVatQueryResult(query, snapshot.tree, snapshot.nodes, snapshot.matchCount),
    source: "vat.watch",
    changes,
    changeSummary: summarizeChanges(changes),
  };
}

function handleWatch(
  req: Request,
  url: URL,
  registry: VatRegistry,
  options: VatRouteOptions,
): Response {
  const q = url.searchParams.get("q");
  if (!q) {
    return jsonError("VAT watch requires a query", 400);
  }

  let filterKinds: Set<VatWatchChangeKind> | null;
  try {
    filterKinds = parseWatchKinds(url.searchParams.get("filter"));
  } catch (error: unknown) {
    return jsonError(error instanceof Error ? error.message : String(error), 400);
  }

  const once = url.searchParams.get("once") === "1";
  let baseline: VatQuerySnapshot;
  try {
    baseline = executeVatQuery(q, registry);
  } catch (error: unknown) {
    return jsonError(error instanceof Error ? error.message : String(error), error instanceof VatApiError ? error.status : 400);
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const openTriggerStream = options.openTriggerStream ?? openDefaultWatchTriggerStream;
      let closed = false;
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      let previous = baseline;
      let buffer = "";

      const close = () => {
        if (closed) {
          return;
        }
        closed = true;
        void reader?.cancel().catch(() => {});
        try {
          controller.close();
        } catch {}
      };

      const fail = (error: unknown) => {
        if (closed) {
          return;
        }
        closed = true;
        try {
          controller.error(error);
        } catch {}
      };

      const processTrigger = (event: AXObserverEvent | null) => {
        if (closed) {
          return;
        }
        if (event) {
          registry.handleAXObserverEvent(event);
        }
        const next = executeVatQuery(q, registry);
        const changes = diffQuerySnapshots(previous, next);
        previous = next;
        if (changes.length === 0) {
          return;
        }
        const emittedChanges = filterKinds
          ? changes.filter((change) => filterKinds.has(change.kind))
          : changes;
        if (emittedChanges.length === 0) {
          return;
        }
        controller.enqueue(encoder.encode(JSON.stringify(buildWatchPayload(q, next, emittedChanges)) + "\n"));
        if (once) {
          close();
        }
      };

      req.signal.addEventListener("abort", close, { once: true });

      void (async () => {
        while (!closed) {
          try {
            const response = await openTriggerStream();
            if (!response.body) {
              throw new Error("watch trigger stream missing response body");
            }
            reader = response.body.getReader();
            buffer = "";
            while (!closed) {
              const { value, done } = await reader.read();
              if (done) {
                throw new Error("watch trigger stream ended unexpectedly");
              }
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() ?? "";
              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) {
                  continue;
                }
                let raw: unknown;
                try {
                  raw = JSON.parse(trimmed);
                } catch {
                  continue;
                }
                processTrigger(parseAXObserverEvent(raw));
                if (closed) {
                  return;
                }
              }
            }
          } catch (error: unknown) {
            if (closed) {
              return;
            }
            if (!isRetryableWatchStreamError(error)) {
              fail(error);
              return;
            }
            await Bun.sleep(200);
          }
        }
      })();
    },
    cancel() {},
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache",
      "access-control-allow-origin": "*",
    },
  });
}

function isCompactMountPathQuery(rawQuery: string): boolean {
  // VAT mount-path selectors are compact path forms like `Codex/Window[**]`.
  // Relative structural queries in this route are written with whitespace or
  // brace scopes, so we only treat slash chains with no whitespace around the
  // operator as mount-targeting candidates.
  return /[^\s]\/{1,2}[^\s]/.test(rawQuery);
}

function collectQueryActivationSegment(node: QueryNode, isRoot: boolean): string | undefined {
  if (node.tag === "*" || node.tag === "**") {
    if (isRoot && node.id !== undefined && node.id !== "") {
      return node.id;
    }
    return undefined;
  }
  if (node.id !== undefined && node.id !== "") {
    if (isRoot && (node.tag === "Application" || node.tag === "*")) {
      return node.id;
    }
    return undefined;
  }
  return node.index !== undefined ? `${node.tag}[${node.index}]` : node.tag;
}

async function persistMounts(registry: VatRegistry, persist?: (mounts: VatPersistedMount[]) => Promise<void>): Promise<void> {
  if (!persist) {
    return;
  }
  await persist(registry.exportPersisted());
}

async function persistWithRollback<T>(
  registry: VatRegistry,
  options: VatRouteOptions,
  mutate: () => T,
): Promise<T> {
  const previous = registry.snapshotState();
  const result = mutate();
  try {
    await persistMounts(registry, options.persist);
    return result;
  } catch (error) {
    registry.restoreState(previous);
    throw error;
  }
}

async function handleMount(req: Request, registry: VatRegistry, options: VatRouteOptions): Promise<Response> {
  try {
    const body = await req.json() as Partial<VatMountRequest> & { mountPolicy?: VatMountPolicy };
    if (!body || typeof body !== "object") {
      return jsonError("missing VAT mount request body", 400);
    }
    if (typeof body.path !== "string" || !body.path) {
      return jsonError("VAT mount requires a path", 400);
    }
    if (typeof body.driver !== "string" || !body.driver) {
      return jsonError("VAT mount requires a driver", 400);
    }
    const path = body.path;
    const driver = body.driver;
    const args = Array.isArray(body.args) ? body.args.filter((arg): arg is string => typeof arg === "string") : [];
    const mount = await persistWithRollback(registry, options, () => registry.mount({
      path,
      driver,
      args,
      mountPolicy: normalizeVatMountPolicy(body.mountPolicy),
    }));
    const response: VatMountResponse = {
      ok: true,
      mount: mount.mount,
      activeMount: mount.activeMount,
      ...(mount.tree ? { tree: mount.tree } : {}),
    };
    return Response.json(response, { headers: { "access-control-allow-origin": "*" } });
  } catch (error: unknown) {
    return jsonError(
      error instanceof Error ? error.message : String(error),
      error instanceof VatApiError ? error.status : 400,
    );
  }
}

async function handleUnmount(url: URL, registry: VatRegistry, options: VatRouteOptions): Promise<Response> {
  const path = url.searchParams.get("path");
  if (!path) {
    return jsonError("VAT unmount requires a path", 400);
  }
  try {
    const unmounted = await persistWithRollback(registry, options, () => registry.unmount(path));
    const response: VatUnmountResponse = {
      ok: true,
      unmounted: unmounted.unmounted,
      activeMount: unmounted.activeMount,
    };
    return Response.json(response, { headers: { "access-control-allow-origin": "*" } });
  } catch (error: unknown) {
    return jsonError(
      error instanceof Error ? error.message : String(error),
      error instanceof VatApiError ? error.status : 400,
    );
  }
}

async function handlePolicy(req: Request, url: URL, registry: VatRegistry, options: VatRouteOptions): Promise<Response> {
  const path = url.searchParams.get("path");
  if (!path) {
    return jsonError("VAT policy requires a path", 400);
  }
  try {
    const body = await req.json() as { mountPolicy?: unknown };
    const updated = await persistWithRollback(
      registry,
      options,
      () => registry.setPolicy(path, normalizeVatMountPolicy(body?.mountPolicy)),
    );
    const response: VatPolicyResponse = {
      ok: true,
      mount: updated.mount,
      activeMount: updated.activeMount,
      ...(updated.tree ? { tree: updated.tree } : {}),
    };
    return Response.json(response, { headers: { "access-control-allow-origin": "*" } });
  } catch (error: unknown) {
    return jsonError(
      error instanceof Error ? error.message : String(error),
      error instanceof VatApiError ? error.status : 400,
    );
  }
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    },
  });
}
