import type { AXNode } from "../apps/types.js";
import { wrapVatMountPath } from "./path.js";
import { VatApiError, type VatMountBuild, type VatMountRequest, type VatNode } from "./types.js";

const DOCK_BUNDLE_ID = "com.apple.dock";
const DEFAULT_SNAPSHOT_DEPTH = 1000;

interface DockAppMetadata {
  apps: Array<{ pid: number; bundleId: string; name: string; regular: boolean }>;
}

interface DockSnapshot {
  tree?: AXNode;
}

export interface DockVatDeps {
  getAppMetadata?: () => DockAppMetadata;
  snapshotApp?: (pid: number, depth?: number) => DockSnapshot | null;
}

function loadNativeAXHelpers(): Required<DockVatDeps> {
  const nativeAX = require("../a11y/native-ax.js") as {
    getAppMetadata: () => DockAppMetadata;
    snapshotApp: (pid: number, depth?: number) => DockSnapshot | null;
  };
  return {
    getAppMetadata: nativeAX.getAppMetadata,
    snapshotApp: nativeAX.snapshotApp,
  };
}

function inferNodeText(node: AXNode): string | undefined {
  return [node.title, node.label, node.value, node.identifier]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0)
    ?.trim();
}

function describeNode(node: AXNode): string {
  return [
    node.role,
    node.subrole,
    node.title,
    node.label,
    node.value,
    node.identifier,
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase();
}

function frameToString(frame: AXNode["frame"]): string | undefined {
  if (!frame) {
    return undefined;
  }
  return `(${frame.x},${frame.y},${frame.width},${frame.height})`;
}

function parseBadge(text: string): string | undefined {
  const match = text.match(/\bbadge[:=\s]+(\d+)\b/i)
    ?? text.match(/\b(\d+)\s+(?:badge|badges|notification|notifications|unread|alerts?)\b/i);
  return match?.[1];
}

function inferBoolean(text: string, patterns: RegExp[]): boolean | undefined {
  for (const pattern of patterns) {
    if (pattern.test(text)) {
      return true;
    }
  }
  return undefined;
}

function classifyDockNode(node: AXNode): VatNode | null {
  const description = describeNode(node);
  if (!description) {
    return null;
  }

  let tag: string | null = null;
  if (
    node.role === "AXSeparator"
    || description.includes("separator")
  ) {
    tag = "Separator";
  } else if (description.includes("trash")) {
    tag = "Trash";
  } else if (description.includes("minimized")) {
    tag = "MinimizedWindow";
  } else if (
    description.includes("stack")
    || description.includes("folder")
    || description.includes("directory")
  ) {
    tag = "Stack";
  } else if (
    description.includes("applicationdockitem")
    || description.includes("app icon")
    || description.includes("dock item")
    || description.includes("dockitem")
    || (node.role === "AXButton" && !node.children?.length)
  ) {
    tag = "AppIcon";
  }

  if (!tag) {
    return null;
  }

  const dockNode: VatNode = { _tag: tag };
  const text = inferNodeText(node);
  if (text) {
    dockNode._text = text;
  }

  const frame = frameToString(node.frame);
  if (frame) {
    dockNode.frame = frame;
  }
  if (node.identifier) {
    dockNode.identifier = node.identifier;
  }

  const badge = parseBadge(description);
  if (badge) {
    dockNode.badge = badge;
  }

  const running = inferBoolean(description, [/\brunning\b/i, /\bactive\b/i]);
  if (running !== undefined && tag === "AppIcon") {
    dockNode.running = running;
  }

  const bouncing = inferBoolean(description, [/\bbouncing\b/i, /\bbounce\b/i]);
  if (bouncing !== undefined) {
    dockNode.bouncing = bouncing;
  }

  const empty = inferBoolean(description, [/\bempty\b/i]);
  if (empty !== undefined && tag === "Trash") {
    dockNode.empty = empty;
  }

  return dockNode;
}

function collectDockItems(node: AXNode, items: VatNode[] = []): VatNode[] {
  const dockNode = classifyDockNode(node);
  if (dockNode) {
    items.push(dockNode);
    return items;
  }

  for (const child of node.children ?? []) {
    collectDockItems(child, items);
  }
  return items;
}

function resolveDockPid(metadata: DockAppMetadata): number {
  const dockApp = metadata.apps.find((app) => app.bundleId === DOCK_BUNDLE_ID);
  if (!dockApp) {
    throw new VatApiError("invalid_args", `Unable to find a running Dock app (${DOCK_BUNDLE_ID})`);
  }
  return dockApp.pid;
}

export function buildDockVatMountTree(request: VatMountRequest, deps: DockVatDeps = {}): VatMountBuild {
  if (request.args.length > 0) {
    throw new VatApiError("invalid_args", "dock VAT driver does not accept any args");
  }

  const nativeAX = deps.getAppMetadata && deps.snapshotApp ? null : loadNativeAXHelpers();
  const getAppMetadata = deps.getAppMetadata ?? nativeAX?.getAppMetadata;
  const snapshotApp = deps.snapshotApp ?? nativeAX?.snapshotApp;
  if (!getAppMetadata || !snapshotApp) {
    throw new VatApiError("invalid_args", "Dock VAT driver could not resolve native AX helpers");
  }

  const dockPid = resolveDockPid(getAppMetadata());
  const snapshot = snapshotApp(dockPid, DEFAULT_SNAPSHOT_DEPTH);
  if (!snapshot?.tree) {
    throw new VatApiError("invalid_args", "Unable to snapshot the Dock AX tree");
  }

  return {
    tree: wrapVatMountPath(request.path, collectDockItems(snapshot.tree)),
    observedBundleIds: [DOCK_BUNDLE_ID],
    observedPids: [dockPid],
  };
}
