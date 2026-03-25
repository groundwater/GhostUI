import { buildLazyTree } from "./live-tree.js";
import { getAppMetadata } from "./native-ax.js";
import { filterTree } from "../cli/filter.js";
import { parseQuery } from "../cli/query.js";
import type { PlainNode } from "../cli/types.js";
import { wrapVatMountPath } from "../vat/path.js";
import { VatApiError, type VatMountBuild, type VatMountRequest, type VatNode } from "../vat/types.js";

export interface LiveVatMountDeps {
  buildTree?: () => PlainNode;
}

function clonePlainNode(node: PlainNode): VatNode {
  const cloned: VatNode = { _tag: node._tag };
  for (const [key, value] of Object.entries(node)) {
    if (key === "_tag") continue;
    if (key === "_children" && Array.isArray(value)) {
      cloned._children = value.map((child) => clonePlainNode(child as PlainNode));
      continue;
    }
    if (value !== undefined) {
      cloned[key] = value;
    }
  }
  return cloned;
}

function normalizeQuery(args: string[]): string {
  return args.join(" ").trim();
}

function extractBundleIdFromNode(node: VatNode): string | undefined {
  const rawId = typeof node._id === "string"
    ? node._id
    : typeof node.id === "string"
      ? node.id
      : undefined;
  if (!rawId) return undefined;
  if (rawId.startsWith("app:")) return rawId.slice(4);
  if (rawId.startsWith("bundle:")) return rawId.slice(7);
  return undefined;
}

function collectObserverKeys(node: VatNode, bundleIds = new Set<string>(), pids = new Set<number>()): {
  bundleIds: Set<string>;
  pids: Set<number>;
} {
  const bundleId = node.bundleId ?? extractBundleIdFromNode(node);
  if (typeof bundleId === "string" && bundleId) {
    bundleIds.add(bundleId);
  }

  const pid = node.pid;
  if (typeof pid === "number" && Number.isFinite(pid) && pid > 0) {
    pids.add(pid);
  }

  const rawId = typeof node._id === "string" ? node._id : typeof node.id === "string" ? node.id : undefined;
  if (rawId?.startsWith("app:")) {
    bundleIds.add(rawId.slice(4));
  }

  for (const child of node._children ?? []) {
    collectObserverKeys(child, bundleIds, pids);
  }

  return { bundleIds, pids };
}

function bundleIdsToPids(bundleIds: Set<string>): Set<number> {
  if (bundleIds.size === 0) {
    return new Set<number>();
  }

  const metadata = getAppMetadata();
  const pids = new Set<number>();
  const pidBundleMatch = /^pid:(\d+)$/;
  for (const app of metadata.apps) {
    if (!bundleIds.has(app.bundleId)) continue;
    if (Number.isFinite(app.pid) && app.pid > 0) {
      pids.add(app.pid);
    }
  }
  for (const bundleId of bundleIds) {
    const match = bundleId.match(pidBundleMatch);
    if (!match) continue;
    const pid = Number(match[1]);
    if (Number.isFinite(pid) && pid > 0) {
      pids.add(pid);
    }
  }
  return pids;
}

export function buildLiveVatMountTree(request: VatMountRequest, deps: LiveVatMountDeps = {}): VatMountBuild {
  const query = normalizeQuery(request.args);
  if (!query) {
    throw new VatApiError("invalid_args", "live VAT driver requires a GUIML query");
  }

  let parsedQuery: ReturnType<typeof parseQuery>;
  try {
    parsedQuery = parseQuery(query);
  } catch (error: unknown) {
    throw new VatApiError(
      "invalid_args",
      `Invalid live GUIML query: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let tree: PlainNode;
  try {
    tree = (deps.buildTree ?? buildLazyTree)();
  } catch (error: unknown) {
    throw new VatApiError(
      "invalid_args",
      `Unable to build live tree: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const { nodes } = filterTree(tree, parsedQuery);
  const mountTree = wrapVatMountPath(request.path, nodes.map(clonePlainNode));
  const { bundleIds, pids } = collectObserverKeys(mountTree);
  const observedBundleIds = [...bundleIds];
  const observedPids = [...new Set([...pids, ...bundleIdsToPids(bundleIds)])];

  return {
    tree: mountTree,
    observedBundleIds,
    observedPids,
  };
}
