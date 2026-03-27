import type { AXObserverEvent } from "../a11y/native-ax.js";
import { buildA11yVatMountTree } from "../a11y/vat.js";
import { buildLiveVatMountTree } from "../a11y/live-vat.js";
import { buildDockVatMountTree } from "./dock.js";
import { composeVatMountForest, findVatNodeByPath, vatPathSegments, wrapVatMountPath, type VatPathSegment } from "./path.js";
import { normalizeVatMountPolicy, normalizeVatPersistedMount } from "./config.js";
import {
  VatApiError,
  type VatMountBuild,
  type VatMountPolicy,
  type VatMountRecord,
  type VatMountRequest,
  type VatMountSummary,
  type VatNode,
  type VatPersistedMount,
  type VatTreeResponse,
} from "./types.js";

type VatDriver = (request: VatMountRequest) => VatMountBuild;

interface VatMountRuntime {
  request: VatMountRequest;
  createdAt: number;
  tree: VatNode;
  observedBundleIds: Set<string>;
  observedPids: Set<number>;
}

interface VatMountRuntimeSnapshot {
  path: string;
  runtime: VatMountRuntime;
  idleDeadline: number | null;
}

export interface VatRegistryStateSnapshot {
  definitions: VatPersistedMount[];
  activeMounts: VatMountRuntimeSnapshot[];
}

function buildFixedMountTree(request: VatMountRequest): VatMountBuild {
  const label = request.args.length > 0 ? request.args.join(" ") : request.path;
  return {
    tree: wrapVatMountPath(request.path, [
      {
        _tag: "VATValue",
        _text: label,
      },
    ]),
  };
}

const VAT_DRIVERS = new Map<string, VatDriver>([
  ["fixed", buildFixedMountTree],
  ["a11y", buildA11yVatMountTree],
  ["live", buildLiveVatMountTree],
  ["dock", buildDockVatMountTree],
]);

function clonePolicy(policy: VatMountPolicy): VatMountPolicy {
  switch (policy.kind) {
    case "always":
      return { kind: "always" };
    case "disabled":
      return { kind: "disabled" };
    case "auto":
      return {
        kind: "auto",
        unmountTimeout: policy.unmountTimeout.kind === "never"
          ? { kind: "never" }
          : { kind: "seconds", seconds: policy.unmountTimeout.seconds },
      };
  }
}

function clonePersistedMount(mount: VatPersistedMount): VatPersistedMount {
  return {
    path: mount.path,
    driver: mount.driver,
    args: [...mount.args],
    mountPolicy: clonePolicy(mount.mountPolicy),
  };
}

function cloneVatNode(tree: VatNode): VatNode {
  return structuredClone(tree);
}

function createRuntime(request: VatMountRequest, build: VatMountBuild): VatMountRuntime {
  return {
    request: {
      path: request.path,
      driver: request.driver,
      args: [...request.args],
    },
    createdAt: Date.now(),
    tree: cloneVatNode(build.tree),
    observedBundleIds: new Set(build.observedBundleIds ?? []),
    observedPids: new Set(build.observedPids ?? []),
  };
}

function cloneRuntime(runtime: VatMountRuntime): VatMountRuntime {
  return {
    request: {
      path: runtime.request.path,
      driver: runtime.request.driver,
      args: [...runtime.request.args],
    },
    createdAt: runtime.createdAt,
    tree: cloneVatNode(runtime.tree),
    observedBundleIds: new Set(runtime.observedBundleIds),
    observedPids: new Set(runtime.observedPids),
  };
}

function compareMountPaths(a: string, b: string): number {
  const aDepth = vatPathSegments(a).length;
  const bDepth = vatPathSegments(b).length;
  return aDepth - bDepth || a.localeCompare(b);
}

function pathPrefixMatches(mountPath: VatPathSegment[], requestedPath: VatPathSegment[]): boolean {
  if (mountPath.length > requestedPath.length) {
    return false;
  }
  for (let i = 0; i < mountPath.length; i++) {
    const mountSegment = mountPath[i];
    const requestedSegment = requestedPath[i];
    if (!requestedSegment || mountSegment.tag !== requestedSegment.tag) {
      return false;
    }
    if (mountSegment.occurrence !== requestedSegment.occurrence) {
      return false;
    }
  }
  return true;
}

export interface VatRegistry {
  mount(request: VatMountRequest & { mountPolicy?: VatMountPolicy }): { mount: VatMountSummary; activeMount: VatMountRecord | null; tree?: VatNode };
  unmount(path: string): { unmounted: VatMountSummary; activeMount: VatMountRecord | null };
  setPolicy(path: string, policy: VatMountPolicy): { mount: VatMountSummary; activeMount: VatMountRecord | null; tree?: VatNode };
  get(path: string): VatMountSummary | undefined;
  list(): VatMountSummary[];
  tree(path?: string | null): VatTreeResponse;
  exportPersisted(): VatPersistedMount[];
  loadPersisted(mounts: VatPersistedMount[], onError?: (mount: VatPersistedMount, error: Error) => void): void;
  snapshotState(): VatRegistryStateSnapshot;
  restoreState(snapshot: VatRegistryStateSnapshot): void;
  activatePath(path: string): VatMountRecord[];
  activateQueryable(): VatMountRecord[];
  handleAXObserverEvent(event: AXObserverEvent): number;
}

export function createVatRegistry(options: { drivers?: Map<string, VatDriver> } = {}): VatRegistry {
  const definitions = new Map<string, VatPersistedMount>();
  const activeMounts = new Map<string, VatMountRuntime>();
  const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const idleDeadlines = new Map<string, number>();
  const drivers = new Map<string, VatDriver>([
    ...VAT_DRIVERS,
    ...(options.drivers ? [...options.drivers] : []),
  ]);

  function assertDriverKnown(driver: string): void {
    if (!drivers.has(driver)) {
      throw new VatApiError("unknown_driver", `Unknown VAT driver: ${driver}`);
    }
  }

  function buildRuntime(request: VatMountRequest): VatMountRuntime {
    const driver = drivers.get(request.driver);
    if (!driver) {
      throw new VatApiError("unknown_driver", `Unknown VAT driver: ${request.driver}`);
    }
    const build = driver(request);
    return createRuntime(request, build);
  }

  function clearIdleTimer(path: string): void {
    const timer = idleTimers.get(path);
    if (timer) {
      clearTimeout(timer);
      idleTimers.delete(path);
    }
    idleDeadlines.delete(path);
  }

  function deactivate(path: string): VatMountRuntime | null {
    clearIdleTimer(path);
    const runtime = activeMounts.get(path) ?? null;
    activeMounts.delete(path);
    return runtime;
  }

  function scheduleIdleUnmount(definition: VatPersistedMount, runtime: VatMountRuntime, deadline?: number): void {
    clearIdleTimer(definition.path);
    if (definition.mountPolicy.kind !== "auto") {
      return;
    }
    if (definition.mountPolicy.unmountTimeout.kind === "never") {
      return;
    }
    const nextDeadline = deadline ?? Date.now() + definition.mountPolicy.unmountTimeout.seconds * 1000;
    idleDeadlines.set(definition.path, nextDeadline);
    const delayMs = Math.max(0, nextDeadline - Date.now());
    idleTimers.set(definition.path, setTimeout(() => {
      const currentDefinition = definitions.get(definition.path);
      const currentRuntime = activeMounts.get(definition.path);
      if (!currentDefinition || !currentRuntime) {
        idleTimers.delete(definition.path);
        return;
      }
      if (currentDefinition.mountPolicy.kind !== "auto") {
        idleTimers.delete(definition.path);
        return;
      }
      if (currentRuntime.createdAt !== runtime.createdAt) {
        idleTimers.delete(definition.path);
        return;
      }
      activeMounts.delete(definition.path);
      idleTimers.delete(definition.path);
      idleDeadlines.delete(definition.path);
    }, delayMs));
  }

  function markTouched(path: string): void {
    const definition = definitions.get(path);
    const runtime = activeMounts.get(path);
    if (!definition || !runtime) {
      return;
    }
    scheduleIdleUnmount(definition, runtime);
  }

  function ensureActive(path: string, options: { touch?: boolean } = {}): VatMountRuntime | null {
    const definition = definitions.get(path);
    if (!definition || definition.mountPolicy.kind === "disabled") {
      return null;
    }
    const current = activeMounts.get(path);
    if (current) {
      if (options.touch) {
        markTouched(path);
      }
      return current;
    }
    const runtime = buildRuntime(definition);
    activeMounts.set(path, runtime);
    if (options.touch) {
      scheduleIdleUnmount(definition, runtime);
    }
    return runtime;
  }

  function listDefinitionRecords(): VatPersistedMount[] {
    return [...definitions.values()]
      .map(clonePersistedMount)
      .sort((a, b) => compareMountPaths(a.path, b.path));
  }

  function toSummary(definition: VatPersistedMount): VatMountSummary {
    const runtime = activeMounts.get(definition.path);
    return {
      ...clonePersistedMount(definition),
      active: runtime !== undefined,
      activeSince: runtime?.createdAt ?? null,
    };
  }

  function toRecordForDefinition(definition: VatPersistedMount, runtime: VatMountRuntime): VatMountRecord {
    return {
      ...clonePersistedMount(definition),
      active: true,
      activeSince: runtime.createdAt,
      tree: runtime.tree,
    };
  }

  function toRecord(path: string, runtime: VatMountRuntime): VatMountRecord {
    const definition = definitions.get(path);
    if (!definition) {
      throw new VatApiError("mount_not_found", `No VAT mount at path: ${path}`);
    }
    return toRecordForDefinition(definition, runtime);
  }

  function buildRootTree(): VatNode {
    return composeVatMountForest([...activeMounts.entries()]
      .map(([path, runtime]) => ({ path, tree: runtime.tree }))
      .sort((a, b) => compareMountPaths(a.path, b.path)));
  }

  function refreshMount(path: string, runtime: VatMountRuntime): boolean {
    const driver = drivers.get(runtime.request.driver);
    if (!driver) {
      return false;
    }
    try {
      const next = driver(runtime.request);
      runtime.tree = cloneVatNode(next.tree);
      runtime.observedBundleIds = new Set(next.observedBundleIds ?? []);
      runtime.observedPids = new Set(next.observedPids ?? []);
      return true;
    } catch {
      return false;
    }
  }

  function matchesEvent(runtime: VatMountRuntime, event: AXObserverEvent): boolean {
    if (event.bundleId && runtime.observedBundleIds.has(event.bundleId)) {
      return true;
    }
    if (Number.isFinite(event.pid) && runtime.observedPids.has(event.pid)) {
      return true;
    }
    return false;
  }

  function activateMatchingPaths(paths: string[]): VatMountRecord[] {
    const activated = new Map<string, VatMountRecord>();
    const definitionsByDepth = listDefinitionRecords()
      .filter((definition) => definition.mountPolicy.kind !== "disabled")
      .map((definition) => ({
        definition,
        segments: vatPathSegments(definition.path),
      }))
      .sort((a, b) => b.segments.length - a.segments.length || a.definition.path.localeCompare(b.definition.path));

    for (const path of paths) {
      const requestedPath = vatPathSegments(path);
      const match = definitionsByDepth.find(({ segments }) => pathPrefixMatches(segments, requestedPath));
      if (!match) {
        continue;
      }
      const runtime = ensureActive(match.definition.path, { touch: true });
      if (runtime) {
        activated.set(match.definition.path, toRecord(match.definition.path, runtime));
      }
    }
    return [...activated.values()].sort((a, b) => compareMountPaths(a.path, b.path));
  }

  return {
    mount(request: VatMountRequest & { mountPolicy?: VatMountPolicy }): { mount: VatMountSummary; activeMount: VatMountRecord | null; tree?: VatNode } {
      const definition = normalizeVatPersistedMount(request);
      assertDriverKnown(definition.driver);
      const nextRuntime = definition.mountPolicy.kind === "always" ? buildRuntime(definition) : null;

      clearIdleTimer(definition.path);
      definitions.set(definition.path, clonePersistedMount(definition));
      if (nextRuntime) {
        activeMounts.set(definition.path, nextRuntime);
      } else {
        activeMounts.delete(definition.path);
      }

      const summary = toSummary(definition);
      const activeMount = nextRuntime ? toRecord(definition.path, nextRuntime) : null;
      return {
        mount: summary,
        activeMount,
        ...(activeMount ? { tree: activeMount.tree } : {}),
      };
    },

    unmount(path: string): { unmounted: VatMountSummary; activeMount: VatMountRecord | null } {
      const definition = definitions.get(path);
      if (!definition) {
        throw new VatApiError("mount_not_found", `No VAT mount at path: ${path}`);
      }
      const activeMount = activeMounts.get(path);
      const summary = toSummary(definition);
      definitions.delete(path);
      deactivate(path);
      return {
        unmounted: summary,
        activeMount: activeMount ? toRecordForDefinition(definition, activeMount) : null,
      };
    },

    setPolicy(path: string, policy: VatMountPolicy): { mount: VatMountSummary; activeMount: VatMountRecord | null; tree?: VatNode } {
      const current = definitions.get(path);
      if (!current) {
        throw new VatApiError("mount_not_found", `No VAT mount at path: ${path}`);
      }
      const nextPolicy = normalizeVatMountPolicy(policy);
      const nextDefinition = clonePersistedMount({
        ...current,
        mountPolicy: nextPolicy,
      });
      let runtime = activeMounts.get(path) ?? null;
      if (nextPolicy.kind === "disabled") {
        deactivate(path);
        runtime = null;
      } else if (nextPolicy.kind === "always") {
        runtime = runtime ?? buildRuntime(nextDefinition);
        activeMounts.set(path, runtime);
        clearIdleTimer(path);
      } else if (runtime) {
        activeMounts.set(path, runtime);
        scheduleIdleUnmount(nextDefinition, runtime);
      }
      definitions.set(path, nextDefinition);
      const summary = toSummary(nextDefinition);
      const activeMount = runtime ? toRecord(path, runtime) : null;
      return {
        mount: summary,
        activeMount,
        ...(activeMount ? { tree: activeMount.tree } : {}),
      };
    },

    get(path: string): VatMountSummary | undefined {
      const definition = definitions.get(path);
      return definition ? toSummary(definition) : undefined;
    },

    list(): VatMountSummary[] {
      return listDefinitionRecords().map(toSummary);
    },

    tree(path?: string | null): VatTreeResponse {
      if (path) {
        const tree = findVatNodeByPath(buildRootTree(), vatPathSegments(path));
        if (!tree) {
          throw new VatApiError("mount_not_found", `No VAT mount at path: ${path}`);
        }
        return { path, tree };
      }
      return { path: null, tree: buildRootTree() };
    },

    exportPersisted(): VatPersistedMount[] {
      return listDefinitionRecords();
    },

    loadPersisted(mounts: VatPersistedMount[], onError?: (mount: VatPersistedMount, error: Error) => void): void {
      definitions.clear();
      activeMounts.clear();
      for (const timer of idleTimers.values()) {
        clearTimeout(timer);
      }
      idleTimers.clear();
      idleDeadlines.clear();
      for (const mount of mounts) {
        try {
          this.mount(mount);
        } catch (error: unknown) {
          if (onError) {
            onError(mount, error instanceof Error ? error : new Error(String(error)));
          }
        }
      }
    },

    snapshotState(): VatRegistryStateSnapshot {
      return {
        definitions: listDefinitionRecords(),
        activeMounts: [...activeMounts.entries()]
          .map(([path, runtime]) => ({
            path,
            runtime: cloneRuntime(runtime),
            idleDeadline: idleDeadlines.get(path) ?? null,
          }))
          .sort((a, b) => compareMountPaths(a.path, b.path)),
      };
    },

    restoreState(snapshot: VatRegistryStateSnapshot): void {
      definitions.clear();
      activeMounts.clear();
      for (const timer of idleTimers.values()) {
        clearTimeout(timer);
      }
      idleTimers.clear();
      idleDeadlines.clear();

      for (const mount of snapshot.definitions) {
        definitions.set(mount.path, clonePersistedMount(mount));
      }

      for (const entry of snapshot.activeMounts) {
        const definition = definitions.get(entry.path);
        if (!definition || definition.mountPolicy.kind === "disabled") {
          continue;
        }
        const runtime = cloneRuntime(entry.runtime);
        activeMounts.set(entry.path, runtime);
        if (
          definition.mountPolicy.kind === "auto"
          && definition.mountPolicy.unmountTimeout.kind === "seconds"
          && entry.idleDeadline !== null
        ) {
          scheduleIdleUnmount(definition, runtime, entry.idleDeadline);
        }
      }
    },

    activatePath(path: string): VatMountRecord[] {
      return activateMatchingPaths([path]);
    },

    activateQueryable(): VatMountRecord[] {
      const paths = listDefinitionRecords()
        .filter((definition) => definition.mountPolicy.kind !== "disabled")
        .map((definition) => definition.path);
      return activateMatchingPaths(paths);
    },

    handleAXObserverEvent(event: AXObserverEvent): number {
      let refreshed = 0;
      for (const [path, runtime] of activeMounts.entries()) {
        if (!matchesEvent(runtime, event)) continue;
        if (refreshMount(path, runtime)) {
          refreshed += 1;
        }
      }
      return refreshed;
    },
  };
}
