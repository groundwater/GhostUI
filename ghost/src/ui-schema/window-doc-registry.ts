import * as Y from "./lib/yjs";
import type { LiveDocSocketController } from "./ws-client";
import type { WindowDocEntry, WindowDocRegistry, YNode } from "./types";
import { focusedLeaseTarget, readWindowLeaseState } from "../window-state";

const WINDOW_DOC_PREFIX = "/windows/";

export function windowDocPath(docId: string | number): string {
  return `${WINDOW_DOC_PREFIX}${String(docId)}`;
}

function nodeType(node: YNode): string {
  return String(node.get("type") || node.get("_tag") || "");
}

function nodeChildren(node: YNode): YNode[] {
  const raw = node.get("_children") as Y.Array<YNode> | undefined;
  if (!raw || raw.length === 0) return [];
  const children: YNode[] = [];
  for (let i = 0; i < raw.length; i++) children.push(raw.get(i) as YNode);
  return children;
}

function isTruthyAttr(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

function isWindowNode(node: YNode): boolean {
  return nodeType(node) === "Window";
}

function windowDocPathFromNode(node: YNode): string | null {
  const docPath = node.get("doc");
  return typeof docPath === "string" && docPath ? docPath : null;
}

function windowIsFocused(node: YNode): boolean {
  return isTruthyAttr(node.get("focused"));
}

function windowZ(node: YNode): number | null {
  const z = Number(node.get("z"));
  return Number.isFinite(z) ? z : null;
}

function windowCgId(node: YNode): number | null {
  const cgWindowId = Number(node.get("cgWindowId"));
  return Number.isFinite(cgWindowId) && cgWindowId > 0 ? cgWindowId : null;
}

function windowDocPathByCgWindowId(root: YNode, cgWindowId: number): string | null {
  let found: string | null = null;

  function visit(node: YNode): void {
    if (found) return;
    if (isWindowNode(node) && windowCgId(node) === cgWindowId) {
      found = windowDocPathFromNode(node);
      return;
    }
    for (const child of nodeChildren(node)) {
      visit(child);
      if (found) return;
    }
  }

  visit(root);
  return found;
}

function walkWindows(root: YNode, out: string[]): void {
  if (isWindowNode(root)) {
    const docPath = windowDocPathFromNode(root);
    if (docPath) out.push(docPath);
  }
  for (const child of nodeChildren(root)) {
    walkWindows(child, out);
  }
}

export function collectWindowDocPaths(root: YNode): string[] {
  const paths: string[] = [];
  for (const child of nodeChildren(root)) {
    walkWindows(child, paths);
  }
  return paths;
}

export function findFocusedWindowDocPath(root: YNode): string | null {
  let firstByZ: { z: number; path: string } | null = null;
  let firstPath: string | null = null;
  let foundFocusedPath: string | null = null;

  function visit(node: YNode): void {
    if (isWindowNode(node)) {
      const path = windowDocPathFromNode(node);
      if (path) {
        if (firstPath == null) firstPath = path;
        if (windowIsFocused(node)) {
          foundFocusedPath = path;
          return;
        }
        const z = windowZ(node);
        if (z != null && (firstByZ == null || z < firstByZ.z)) {
          firstByZ = { z, path };
        }
      }
    }

    for (const child of nodeChildren(node)) {
      visit(child);
      if (foundFocusedPath) return;
    }
  }

  for (const child of nodeChildren(root)) {
    visit(child);
    if (foundFocusedPath) return foundFocusedPath;
  }

  const fallback = firstByZ as { z: number; path: string } | null;
  return fallback ? fallback.path : firstPath;
}

export function findDesiredWindowDocPath(root: YNode): string | null {
  const leasedCgWindowId = focusedLeaseTarget(readWindowLeaseState(root));
  if (leasedCgWindowId != null) {
    return windowDocPathByCgWindowId(root, leasedCgWindowId) ?? windowDocPath(leasedCgWindowId);
  }
  return findFocusedWindowDocPath(root);
}

interface WindowDocRegistryDeps {
  connect: (docPath: string, doc: Y.Doc) => LiveDocSocketController;
}

interface WindowDocEntryInternal extends WindowDocEntry {
  controller: LiveDocSocketController | null;
}

class WindowDocRegistryImpl implements WindowDocRegistry {
  private readonly entries = new Map<string, WindowDocEntryInternal>();
  private readonly listeners = new Set<() => void>();
  private activePath: string | null = null;

  constructor(private readonly deps: WindowDocRegistryDeps) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getActivePath(): string | null {
    return this.activePath;
  }

  getEntry(docPath: string): WindowDocEntry | undefined {
    return this.entries.get(docPath);
  }

  activate(docPath: string | null): void {
    if (this.activePath === docPath) return;

    if (this.activePath) {
      const previous = this.entries.get(this.activePath);
      if (previous) {
        previous.controller?.dispose();
        previous.controller = null;
        previous.source = "cached";
      }
    }

    this.activePath = docPath;

    if (docPath) {
      const entry = this.ensureEntry(docPath);
      if (!entry.controller) {
        entry.controller = this.deps.connect(docPath, entry.doc);
      }
      entry.source = "live";
    }

    this.emit();
  }

  pruneVisible(docPaths: Iterable<string>): void {
    const visible = new Set<string>();
    for (const docPath of docPaths) {
      if (docPath) visible.add(docPath);
    }

    let changed = false;
    for (const [docPath, entry] of [...this.entries.entries()]) {
      if (docPath === this.activePath) continue;
      if (visible.has(docPath)) continue;

      entry.controller?.dispose();
      entry.doc.destroy();
      this.entries.delete(docPath);
      changed = true;
    }

    if (changed) this.emit();
  }

  destroy(): void {
    for (const entry of this.entries.values()) {
      entry.controller?.dispose();
      entry.doc.destroy();
    }
    this.entries.clear();
    this.activePath = null;
    this.listeners.clear();
  }

  private ensureEntry(docPath: string): WindowDocEntryInternal {
    const existing = this.entries.get(docPath);
    if (existing) return existing;

    const doc = new Y.Doc();
    const entry: WindowDocEntryInternal = {
      docPath,
      doc,
      root: doc.getMap("root"),
      source: "placeholder",
      controller: null,
    };
    this.entries.set(docPath, entry);
    return entry;
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export function createWindowDocRegistry(deps: WindowDocRegistryDeps): WindowDocRegistry {
  return new WindowDocRegistryImpl(deps);
}
