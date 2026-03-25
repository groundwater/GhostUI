/**
 * Live tree: lazy PlainNode tree built on-demand from AX snapshots.
 * Application nodes have lazy _children — only AX-snapshotted when accessed.
 * Query execution happens server-side so lazy getters actually fire.
 */
import { snapshotApp, getAppMetadata, buildSnapshot } from "./native-ax.js";
import { axToTree, snapshotToTree, type TreeNode } from "./ax-tree.js";
import type { PlainNode } from "../cli/types.js";

interface WindowRect {
  pid: number;
  bundleId: string;
  x: number; y: number; w: number; h: number;
  title?: string;
}

interface WindowObscured {
  bundleId: string;
  x: number; y: number; w: number; h: number;
  pct: number;
}

/**
 * Compute obscured percentage for each window from windowRects (front-to-back z-order).
 * Uses grid sampling (20x20 points per window) to measure coverage by windows above.
 */
function computeObscured(windowRects: WindowRect[]): WindowObscured[] {
  if (!windowRects || windowRects.length === 0) return [];
  const GRID = 20;
  const results: WindowObscured[] = [];
  for (let wi = 0; wi < windowRects.length; wi++) {
    const win = windowRects[wi];
    if (!win.bundleId) continue;
    // Only windows from OTHER apps count as obscuring
    const above = windowRects.slice(0, wi).filter(a => a.bundleId !== win.bundleId);
    if (above.length === 0) {
      results.push({ bundleId: win.bundleId, x: win.x, y: win.y, w: win.w, h: win.h, pct: 0 });
      continue;
    }
    const stepX = win.w / GRID;
    const stepY = win.h / GRID;
    let covered = 0;
    for (let gx = 0; gx < GRID; gx++) {
      for (let gy = 0; gy < GRID; gy++) {
        const px = win.x + stepX * (gx + 0.5);
        const py = win.y + stepY * (gy + 0.5);
        for (const a of above) {
          if (px >= a.x && px < a.x + a.w && py >= a.y && py < a.y + a.h) {
            covered++;
            break;
          }
        }
      }
    }
    results.push({
      bundleId: win.bundleId, x: win.x, y: win.y, w: win.w, h: win.h,
      pct: Math.round((covered / (GRID * GRID)) * 100),
    });
  }
  return results;
}

/** Convert a TreeNode (from snapshotToTree) into a PlainNode (for the query engine). */
export function treeNodeToPlain(node: TreeNode): PlainNode {
  const plain: PlainNode = { _tag: node.tag };
  for (const [k, v] of Object.entries(node.props)) {
    plain[k] = v;
  }
  plain._id = node.id;
  if (node.children && node.children.length > 0) {
    plain._children = node.children.map(treeNodeToPlain);
  }
  return plain;
}

/**
 * Create a lazy Application PlainNode. The `_children` getter triggers an
 * AX snapshot of the app's PID only when the query engine actually descends into it.
 */
function makeLazyApp(
  bundleId: string,
  pid: number,
  name: string,
  windowRects: { x: number; y: number; w: number; h: number; title?: string }[],
  isFront: boolean,
  obscuredByFrame: Map<string, number>,
): PlainNode {
  let resolved = false;
  let children: PlainNode[] | undefined;

  const node: PlainNode = {
    _tag: "Application",
    _id: `app:${bundleId}`,
    bundleId,
    title: name,
    _projectedAttrs: ["bundleId"],
  };
  if (!isFront) node.foreground = "false";

  Object.defineProperty(node, "_children", {
    get() {
      if (!resolved) {
        resolved = true;
        const resp = snapshotApp(pid);
        if (resp?.tree) {
          const treeNode = axToTree(resp.tree);
          // Application's children are windows etc.
          const appChildren = treeNode.tag === "Application"
            ? (treeNode.children || [])
            : [treeNode];
          // Attach window geometry and obscured percentage
          children = appChildren.map((child) => {
            const plain = treeNodeToPlain(child);
            if (child.tag === "Window") {
              const ownFrame = child.props.frame;
              let wx = 0, wy = 0, ww = 0, wh = 0;
              if (ownFrame) {
                const m = ownFrame.match(/\((-?\d+),(-?\d+),(-?\d+),(-?\d+)\)/);
                if (m) {
                  wx = +m[1]; wy = +m[2]; ww = +m[3]; wh = +m[4];
                  plain.x = m[1]; plain.y = m[2]; plain.w = m[3]; plain.h = m[4];
                }
              } else {
                const wr = windowRects[0];
                if (wr) {
                  wx = wr.x; wy = wr.y; ww = wr.w; wh = wr.h;
                  plain.x = String(Math.round(wr.x));
                  plain.y = String(Math.round(wr.y));
                  plain.w = String(Math.round(wr.w));
                  plain.h = String(Math.round(wr.h));
                }
              }
              // Look up obscured percentage by frame key
              const frameKey = `${Math.round(wx)},${Math.round(wy)},${Math.round(ww)},${Math.round(wh)}`;
              const pct = obscuredByFrame.get(frameKey);
              if (pct !== undefined && pct > 0) {
                plain.obscured = String(pct);
              }
            }
            return plain;
          });
        } else {
          // AX snapshot failed — fall back to window rect stubs
          children = windowRects.map((wr, i) => ({
            _tag: "Window",
            _id: `Window:${wr.title || ""}:${i}`,
            ...(wr.title ? { title: wr.title } : {}),
            x: String(Math.round(wr.x)),
            y: String(Math.round(wr.y)),
            w: String(Math.round(wr.w)),
            h: String(Math.round(wr.h)),
          }));
        }
      }
      return children;
    },
    set(v: PlainNode[] | undefined) {
      resolved = true;
      children = v;
    },
    enumerable: true,
    configurable: true,
  });

  return node;
}

/**
 * Build a lazy Display tree. Top-level structure (MenuBar, MenuExtras,
 * Application stubs) is built cheaply from metadata. Each Application's children
 * are only AX-snapshotted when the query engine accesses them.
 */
export function buildLazyTree(): PlainNode {
  const meta = getAppMetadata();

  // We still need a lightweight snapshot for MenuBar and MenuExtras.
  // Use minimal depth for the focused app (just enough for menubar).
  const snap = buildSnapshot({ focusedDepth: 3, visibleDepth: 3, menuDepth: 200 });
  if (!snap) throw new Error("AX snapshot failed — is accessibility trusted?");

  // Build Display shell from snapshot (MenuBar, MenuExtras)
  const shellTree = snapshotToTree(snap);
  if (!shellTree) throw new Error("No tree — is any app running?");
  const display = treeNodeToPlain(shellTree);

  // Replace the shallow Application node with lazy versions for ALL apps
  const systemChildren = (display._children || []).filter(c => c._tag !== "Application");

  // Compute obscured percentages from z-ordered windowRects (cheap, no AX calls)
  const obscured = computeObscured(meta.windowRects);
  const obscuredByFrame = new Map<string, number>();
  for (const wo of obscured) {
    const key = `${Math.round(wo.x)},${Math.round(wo.y)},${Math.round(wo.w)},${Math.round(wo.h)}`;
    obscuredByFrame.set(key, wo.pct);
  }

  // Group windowRects by bundleId
  const rectsByBundle = new Map<string, typeof meta.windowRects>();
  for (const wr of meta.windowRects) {
    if (!wr.bundleId) continue;
    let list = rectsByBundle.get(wr.bundleId);
    if (!list) { list = []; rectsByBundle.set(wr.bundleId, list); }
    list.push(wr);
  }

  // Add lazy Application nodes for every app with visible windows
  const addedBundles = new Set<string>();
  for (const [bundleId, rects] of rectsByBundle) {
    const appInfo = meta.apps.find(a => a.bundleId === bundleId);
    if (!appInfo) continue;
    const isFront = appInfo.pid === meta.frontPid;
    systemChildren.push(makeLazyApp(bundleId, appInfo.pid, appInfo.name, rects, isFront, obscuredByFrame));
    addedBundles.add(bundleId);
  }

  // Also add the frontmost app even if it has no windowRects (rare edge case)
  const frontApp = meta.apps.find(a => a.pid === meta.frontPid);
  if (frontApp && !addedBundles.has(frontApp.bundleId)) {
    systemChildren.push(makeLazyApp(frontApp.bundleId, frontApp.pid, frontApp.name, [], true, obscuredByFrame));
  }

  display._children = systemChildren;
  return display;
}
