import { filterTree } from "../cli/filter.js";
import { parseQuery, queryHasIntrospection } from "../cli/query.js";
import type { QueryNode } from "../cli/types.js";
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
    const q = url.searchParams.get("q");
    if (!q) {
      return jsonError("VAT query requires a query", 400);
    }
    try {
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
      const tree = registry.tree().tree;
      const { nodes, matchCount } = filterTree(tree, queries);
      return Response.json({ tree, nodes, matchCount }, {
        headers: { "access-control-allow-origin": "*" },
      });
    } catch (error: unknown) {
      return jsonError(error instanceof Error ? error.message : String(error), error instanceof VatApiError ? error.status : 400);
    }
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
