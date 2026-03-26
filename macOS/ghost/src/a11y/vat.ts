import { getAppMetadata, resolveAXQuerySubtree, snapshotApp } from "./native-ax.js";
import { materializeSelectedMatches, sanitizeMaterializedTree } from "../cli/filter.js";
import { selectAXQueryMatches, serializeAXSelectionMatches } from "./ax-query.js";
import { assertAXQueryMatch, type AXNode, type AXQueryMatch } from "../cli/ax.js";
import { wrapVatMountPath } from "../vat/path.js";
import { assertAXTarget } from "./ax-target.js";
import {
  VAT_A11Y_STDIN_AX_QUERY_ARG,
  VAT_A11Y_STDIN_AX_QUERY_PLAN_ARG,
  VatApiError,
  type VatA11YQueryPlan,
  type VatA11YQueryScope,
  type VatMountBuild,
  type VatMountRequest,
  type VatNode,
} from "../vat/types.js";

type AXQueryRoot = {
  pid: number;
  tree: AXNode;
};

function normalizeQuery(args: string[]): string {
  return args.join(" ").trim();
}

function clonePlainNode(node: VatNode): VatNode {
  const tag = node._tag.startsWith("AX") && node._tag.length > 2 ? node._tag.slice(2) : node._tag;
  const cloned: VatNode = { _tag: tag };
  for (const [key, value] of Object.entries(node)) {
    if (key === "_tag") continue;
    if (key === "_children" && Array.isArray(value)) {
      cloned._children = value.map((child) => clonePlainNode(child as VatNode));
      continue;
    }
    if (value !== undefined) {
      cloned[key] = value;
    }
  }
  return cloned;
}

function countNodes(node: VatNode): number {
  return 1 + (node._children || []).reduce((sum, child) => sum + countNodes(child as VatNode), 0);
}

function stableValueKey(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableValueKey).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableValueKey(entryValue)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function collectStrictDescendantCounts(node: VatNode, counts: Map<string, number>): void {
  for (const child of node._children || []) {
    collectSubtreeCounts(child as VatNode, counts);
  }
}

function collectSubtreeCounts(node: VatNode, counts: Map<string, number>): void {
  const key = stableValueKey(node);
  counts.set(key, (counts.get(key) || 0) + 1);
  for (const child of node._children || []) {
    collectSubtreeCounts(child as VatNode, counts);
  }
}

function selectSerializedMatchRoots(matches: AXQueryMatch[]): VatNode[] {
  const sorted = matches
    .map((match) => ({ pid: match.pid, node: clonePlainNode(match.node as VatNode) }))
    .sort((left, right) => countNodes(right.node) - countNodes(left.node));
  const coveredDescendantsByPid = new Map<number, Map<string, number>>();
  const roots: VatNode[] = [];

  for (const { pid, node } of sorted) {
    const coveredDescendants = coveredDescendantsByPid.get(pid) || new Map<string, number>();
    coveredDescendantsByPid.set(pid, coveredDescendants);
    const key = stableValueKey(node);
    const covered = coveredDescendants.get(key) || 0;
    if (covered > 0) {
      coveredDescendants.set(key, covered - 1);
      continue;
    }
    roots.push(node);
    collectStrictDescendantCounts(node, coveredDescendants);
  }

  return roots;
}

function parseSerializedAXQueryPayload(raw: string): unknown[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    const lines = raw
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      return [];
    }
    return lines.map((line, index) => {
      try {
        return JSON.parse(line) as unknown;
      } catch (error: unknown) {
        throw new VatApiError(
          "invalid_args",
          `Invalid serialized AX query payload on line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  }
}

function parseSerializedAXQueryMatches(args: string[]): AXQueryMatch[] | null {
  if (args[0] !== VAT_A11Y_STDIN_AX_QUERY_ARG) {
    return null;
  }
  if (args.length !== 2) {
    throw new VatApiError(
      "invalid_args",
      `${VAT_A11Y_STDIN_AX_QUERY_ARG} expects exactly one serialized AX query payload argument`,
    );
  }

  const raw = args[1]?.trim();
  if (!raw) {
    throw new VatApiError("invalid_args", "Serialized AX query payload was empty");
  }

  const items = parseSerializedAXQueryPayload(raw);
  if (items.length === 0) {
    throw new VatApiError("invalid_args", "Serialized AX query payload contained no matches");
  }
  return items.map((item, index) => assertAXQueryMatch(item, `AXQueryMatch[${index}]`));
}

function buildPidToBundleIdMap(): Map<number, string> {
  const metadata = getAppMetadata();
  const pidToBundleId = new Map<number, string>();
  for (const app of metadata.apps) {
    pidToBundleId.set(app.pid, app.bundleId);
  }
  return pidToBundleId;
}

function buildVatTreeFromSerializedMatches(
  request: VatMountRequest,
  matches: AXQueryMatch[],
  pidToBundleId = buildPidToBundleIdMap(),
): VatMountBuild {

  const observedPids = [...new Set(matches.map((match) => match.pid).filter((pid) => Number.isFinite(pid) && pid > 0))];
  const observedBundleIds = [...new Set(
    observedPids
      .map((pid) => pidToBundleId.get(pid))
      .filter((bundleId): bundleId is string => typeof bundleId === "string" && bundleId.length > 0),
  )];

  return {
    tree: sanitizeMaterializedTree(wrapVatMountPath(request.path, selectSerializedMatchRoots(matches))),
    observedBundleIds,
    observedPids,
  };
}

function parseAXQueryPlan(args: string[]): VatA11YQueryPlan | null {
  if (args[0] !== VAT_A11Y_STDIN_AX_QUERY_PLAN_ARG) {
    return null;
  }
  if (args.length !== 2) {
    throw new VatApiError(
      "invalid_args",
      `${VAT_A11Y_STDIN_AX_QUERY_PLAN_ARG} expects exactly one AX query plan payload argument`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(args[1] ?? "");
  } catch (error: unknown) {
    throw new VatApiError(
      "invalid_args",
      `Invalid AX query plan payload: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return assertAXQueryPlan(parsed);
}

function buildRawAXRoots(): { roots: AXQueryRoot[]; pidToBundleId: Map<number, string> } {
  const metadata = getAppMetadata();
  const pidToBundleId = new Map<number, string>();
  const roots: AXQueryRoot[] = [];

  for (const app of metadata.apps) {
    pidToBundleId.set(app.pid, app.bundleId);
    const snapshot = snapshotApp(app.pid, 1000);
    if (!snapshot?.tree) continue;
    roots.push({ pid: app.pid, tree: snapshot.tree as AXNode });
  }

  return { roots, pidToBundleId };
}

function describeApp(app: { pid: number; bundleId: string; name: string }): string {
  return `${app.name || "unknown"} (${app.bundleId || "unknown.bundle"}, pid ${app.pid})`;
}

function resolveAppScopePid(scope: Extract<VatA11YQueryScope, { kind: "app" }>, metadata = getAppMetadata()): number {
  const normalized = scope.app.trim().toLowerCase();
  const apps = metadata.apps.filter(app => Number.isInteger(app.pid) && app.pid > 0);
  const exactBundle = apps.filter(app => app.bundleId.toLowerCase() === normalized);
  if (exactBundle.length === 1) return exactBundle[0].pid;
  if (exactBundle.length > 1) {
    throw new VatApiError("invalid_args", `AX query scope "${scope.app}" is ambiguous: ${exactBundle.map(describeApp).join(", ")}`);
  }
  const exactName = apps.filter(app => app.name.toLowerCase() === normalized);
  if (exactName.length === 1) return exactName[0].pid;
  if (exactName.length > 1) {
    throw new VatApiError("invalid_args", `AX query scope "${scope.app}" is ambiguous: ${exactName.map(describeApp).join(", ")}`);
  }
  const partial = apps.filter(app =>
    app.bundleId.toLowerCase().includes(normalized) ||
    app.name.toLowerCase().includes(normalized));
  if (partial.length === 1) return partial[0].pid;
  if (partial.length > 1) {
    throw new VatApiError("invalid_args", `AX query scope "${scope.app}" matched multiple apps: ${partial.map(describeApp).join(", ")}`);
  }
  throw new VatApiError("invalid_args", `No running app matched "${scope.app}".`);
}

function buildRootsForPlan(plan: VatA11YQueryPlan): { roots: AXQueryRoot[]; pidToBundleId: Map<number, string> } {
  const metadata = getAppMetadata();
  const pidToBundleId = new Map<number, string>();
  for (const app of metadata.apps) {
    pidToBundleId.set(app.pid, app.bundleId);
  }

  if (plan.target) {
    try {
      const subtree = resolveAXQuerySubtree(plan.target);
      return {
        roots: [subtree],
        pidToBundleId,
      };
    } catch (error: unknown) {
      throw new VatApiError(
        "invalid_args",
        `Unable to resolve AX query plan target: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const pids = (() => {
    switch (plan.scope.kind) {
      case "all":
        return metadata.apps.map(app => app.pid);
      case "focused":
        return metadata.frontPid > 0 ? [metadata.frontPid] : [];
      case "pid":
        return [plan.scope.pid];
      case "app":
        return [resolveAppScopePid(plan.scope, metadata)];
    }
  })();

  const roots: AXQueryRoot[] = [];
  for (const pid of pids) {
    if (!Number.isFinite(pid) || pid <= 0) continue;
    const snapshot = snapshotApp(pid, 1000);
    if (!snapshot?.tree) continue;
    roots.push({ pid, tree: snapshot.tree as AXNode });
  }
  return { roots, pidToBundleId };
}

function assertAXQueryPlan(value: unknown): VatA11YQueryPlan {
  if (!value || typeof value !== "object") {
    throw new VatApiError("invalid_args", "AX query plan payload must be an object");
  }
  const plan = value as Record<string, unknown>;
  if (plan.type !== "vat.a11y-query-plan") {
    throw new VatApiError("invalid_args", "AX query plan payload must have type \"vat.a11y-query-plan\"");
  }
  if (typeof plan.query !== "string" || !plan.query.trim()) {
    throw new VatApiError("invalid_args", "AX query plan payload must include a query");
  }
  if (plan.cardinality !== "first" && plan.cardinality !== "only" && plan.cardinality !== "all" && plan.cardinality !== "each") {
    throw new VatApiError("invalid_args", "AX query plan payload has an invalid cardinality");
  }
  return {
    type: "vat.a11y-query-plan",
    query: plan.query,
    cardinality: plan.cardinality,
    scope: assertAXQueryPlanScope(plan.scope),
    ...(plan.target !== undefined ? { target: assertAXTarget(plan.target, "VatA11YQueryPlan.target") } : {}),
  };
}

function assertAXQueryPlanScope(value: unknown): VatA11YQueryScope {
  if (!value || typeof value !== "object") {
    throw new VatApiError("invalid_args", "AX query plan scope must be an object");
  }
  const scope = value as Record<string, unknown>;
  switch (scope.kind) {
    case "all":
    case "focused":
      return { kind: scope.kind };
    case "pid":
      if (!Number.isInteger(scope.pid) || Number(scope.pid) <= 0) {
        throw new VatApiError("invalid_args", "AX query plan pid scope requires a positive integer pid");
      }
      return { kind: "pid", pid: Number(scope.pid) };
    case "app":
      if (typeof scope.app !== "string" || !scope.app.trim()) {
        throw new VatApiError("invalid_args", "AX query plan app scope requires a non-empty app identifier");
      }
      return { kind: "app", app: scope.app };
    default:
      throw new VatApiError("invalid_args", "AX query plan scope kind is invalid");
  }
}

function deriveObserverKeys(
  pids: number[],
  pidToBundleId: Map<number, string>,
): { observedBundleIds: string[]; observedPids: number[] } {
  const observedPids = [...new Set(pids.filter((pid) => Number.isFinite(pid) && pid > 0))];
  const observedBundleIds = [...new Set(
    observedPids
      .map((pid) => pidToBundleId.get(pid))
      .filter((bundleId): bundleId is string => typeof bundleId === "string" && bundleId.length > 0),
  )];

  return { observedBundleIds, observedPids };
}

export function buildA11yVatMountTree(request: VatMountRequest): VatMountBuild {
  const queryPlan = parseAXQueryPlan(request.args);
  if (queryPlan) {
    const { roots, pidToBundleId } = buildRootsForPlan(queryPlan);
    if (roots.length === 0) {
      throw new VatApiError("invalid_args", "Unable to build AX query plan tree: no AX snapshots available");
    }

    let selection: ReturnType<typeof selectAXQueryMatches>;
    try {
      selection = selectAXQueryMatches(roots, queryPlan.query, queryPlan.cardinality);
    } catch (error: unknown) {
      throw new VatApiError(
        "invalid_args",
        `Invalid a11y GUIML query: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return buildVatTreeFromSerializedMatches(request, serializeAXSelectionMatches(selection), pidToBundleId);
  }

  const serializedMatches = parseSerializedAXQueryMatches(request.args);
  if (serializedMatches) {
    return buildVatTreeFromSerializedMatches(request, serializedMatches);
  }

  const query = normalizeQuery(request.args);
  if (!query) {
    throw new VatApiError("invalid_args", "a11y VAT driver requires a GUIML query");
  }

  let raw: ReturnType<typeof buildRawAXRoots>;
  try {
    raw = buildRawAXRoots();
  } catch (error: unknown) {
    throw new VatApiError(
      "invalid_args",
      `Unable to build raw a11y tree: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (raw.roots.length === 0) {
    throw new VatApiError("invalid_args", "Unable to build raw a11y tree: no AX snapshots available");
  }

  let selection: ReturnType<typeof selectAXQueryMatches>;
  try {
    selection = selectAXQueryMatches(raw.roots, query, "all");
  } catch (error: unknown) {
    throw new VatApiError(
      "invalid_args",
      `Invalid a11y GUIML query: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const mounted = wrapVatMountPath(
    request.path,
    materializeSelectedMatches(selection.selected)
      .map((node) => clonePlainNode(node as VatNode)),
  );
  const { observedBundleIds, observedPids } = deriveObserverKeys(
    selection.matches.map((match) => match.source.pid),
    raw.pidToBundleId,
  );

  return {
    tree: sanitizeMaterializedTree(mounted),
    observedBundleIds,
    observedPids,
  };
}
