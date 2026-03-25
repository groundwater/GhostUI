import type { PlainNode } from "./types.js";
import { fetchTree, postAction } from "./client.js";
import { parseQuery } from "./query.js";
import { filterTree, bfsFirst, findMatchedNodeWithContext } from "./filter.js";
import { toGUIML } from "./guiml.js";
import { isBlockedByModal } from "./modal.js";

const FRAME_RE = /^\((-?\d+),(-?\d+),(\d+),(\d+)\)$/;

/** Extract center coordinates from a node's frame string "(x,y,w,h)" or numeric x,y,w,h attrs. */
function extractCenter(node: PlainNode): { x: number; y: number } | null {
  if (typeof node.frame === "string") {
    const m = FRAME_RE.exec(node.frame);
    if (m) {
      return { x: Math.round(+m[1] + +m[3] / 2), y: Math.round(+m[2] + +m[4] / 2) };
    }
  }
  const x = node.x as number | undefined;
  const y = node.y as number | undefined;
  const w = node.w as number | undefined;
  const h = node.h as number | undefined;
  if (x != null && y != null && w != null && h != null) {
    return { x: Math.round(x + w / 2), y: Math.round(y + h / 2) };
  }
  return null;
}

const WAIT_POLL_MS = 200;
const WAIT_TIMEOUT_MS = 5000;
const FOLLOWUP_POLL_MS = 50;
const FOLLOWUP_TIMEOUT_MS = 5000;

/** Quote a label for use in a query if it contains special characters. */
function q(label: string): string {
  if (/[\s"#\[\]{}]/.test(label)) return `"${label}"`;
  return label;
}

/**
 * Build a follow-up query for a Button press by walking up the ancestor path
 * to find the nearest named container, then querying its children.
 * This captures mode transitions (e.g. Done → view mode, Edit → edit mode).
 */
function buildButtonFollowUp(path: PlainNode[], button: PlainNode): string | null {
  // Walk up from the button's parent, looking for a named container
  // that we can use as a follow-up scope. Skip generic structural nodes
  // (Window, Application) and prefer named containers with IDs.
  const SKIP_TAGS = new Set(["Application", "Window", "Screen"]);
  for (let i = path.length - 1; i >= 0; i--) {
    const ancestor = path[i];
    if (SKIP_TAGS.has(ancestor._tag)) continue;
    const id = (ancestor._id || ancestor.id) as string | undefined;
    if (id) {
      // Use this named container: query its children for content change
      const tag = ancestor._tag;
      const label = id.split(":").slice(1, -1).join(":") || "";
      if (label) {
        return `${tag}#${q(label)} { * }`;
      }
      return `${tag} { * }`;
    }
  }
  // Fallback: look for any Window in the path and query its direct children
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i]._tag === "Window") {
      return "Window { * }";
    }
  }
  return null;
}

/**
 * Resolve a query-style nodeId (e.g. "ListItem#Displays", "Button:0")
 * to its real node and dispatch an action to the daemon.
 *
 * If waitQuery is provided, the wait condition is evaluated BEFORE the action
 * (to capture the "before" state), then the action fires, then we retry
 * until the condition changes or is satisfied.
 *
 * Returns follow-up result if the daemon specifies one, otherwise null.
 */
export async function dispatchAction(
  queryStr: string,
  action: string,
  text?: string,
  waitQuery?: string,
): Promise<{ query: string; guiml: string; nodes: PlainNode[] } | null> {
  const tree = await fetchTree();

  // Use the query engine to find the node — findMatchedNodeWithContext resolves
  // scoped queries (e.g. Outline#0 { TextField#0 }) to the correct node within
  // the scope, rather than the first global BFS match.
  const queries = parseQuery(queryStr);
  const ctx = findMatchedNodeWithContext(tree, queries);
  if (!ctx) {
    throw new Error(`Node not found: ${queryStr}`);
  }

  // Check if the target element is blocked by a modal in its window
  const blockedBy = isBlockedByModal(ctx.path, ctx.node);
  if (blockedBy) {
    throw new Error(`Element blocked by ${blockedBy}: ${queryStr}`);
  }

  const leaf = ctx.node;
  const rawId = (leaf._id || leaf.id) as string | undefined;
  if (!rawId) {
    // No accessibility ID — try pointer-based click using frame coordinates
    const center = extractCenter(leaf);
    if (!center) {
      throw new Error(
        `Cannot perform action on '${queryStr}': the matched ${leaf._tag || "node"} has no accessibility ID and no frame coordinates. ` +
        `This usually means the element lacks an AX identifier in the accessibility tree. ` +
        `Try targeting a more specific child element, or use a query that resolves to an identifiable node.`
      );
    }

    // Use pointer-based action as fallback — synthesize an ID from the tag and label
    const fallbackLabel = (leaf.label || leaf.title || leaf.name || "") as string;
    const fallbackId = `${leaf._tag}:${fallbackLabel}:0`;
    const result = await postAction({
      app: ctx.bundleId,
      type: leaf._tag,
      id: fallbackId,
      action,
      ...(text !== undefined ? { value: text } : {}),
      x: center.x,
      y: center.y,
    });

    if (!result.ok) {
      throw new Error(`Action failed: ${result.error || "unknown error"}`);
    }
    return null;
  }

  // Capture "before" state for --wait condition
  let beforeSnapshot: WaitSnapshot | undefined;
  if (waitQuery) {
    beforeSnapshot = captureWaitSnapshot(tree, waitQuery);
  }

  // Compute center coordinates from the node's frame — used for rightclick
  // and as a pointer-based fallback when AX label/role lookup fails (e.g.
  // PopUpButton elements in System Settings whose labels come from sibling text).
  let centerX: number | undefined;
  let centerY: number | undefined;
  const center = extractCenter(leaf);
  if (action === "rightclick" && !center) {
    throw new Error(
      `Cannot right-click '${queryStr}': the matched ${leaf._tag || "node"} has no frame coordinates. ` +
      `Try targeting a child element that has geometry in the accessibility tree.`
    );
  }
  if (center) {
    centerX = center.x;
    centerY = center.y;
  }

  const result = await postAction({
    app: ctx.bundleId,
    type: leaf._tag,
    id: rawId,
    action,
    ...(text !== undefined ? { value: text } : {}),
    ...(leaf.axRole ? { axRole: leaf.axRole as string } : {}),
    ...(centerX !== undefined && centerY !== undefined ? { x: centerX, y: centerY } : {}),
  });

  if (!result.ok) {
    throw new Error(`Action failed: ${result.error || "unknown error"}`);
  }

  // Poll for --wait condition
  if (waitQuery && beforeSnapshot) {
    await waitForCondition(waitQuery, beforeSnapshot);
  }

  // For stateful elements (Toggle, Slider), use a self-referencing follow-up
  // with [**] introspection so the hint surfaces the new state (e.g. checked).
  // Without [**], projected attrs strip state like checked/value, making the
  // follow-up unable to detect changes (#131).
  const SELF_FOLLOWUP_TYPES = new Set(["Toggle", "Slider"]);
  const selfFollowUp = SELF_FOLLOWUP_TYPES.has(leaf._tag)
    ? (queryStr.includes("[**]") ? queryStr : `${queryStr}[**]`)
    : null;
  const followUpQuery = result.followUp
    || selfFollowUp
    || (leaf._tag === "Button" ? buildButtonFollowUp(ctx.path, leaf) : null);

  // Follow-up query: retry until results change from before the action
  if (followUpQuery) {
    const followUp = followUpQuery;
    // Snapshot the follow-up query results BEFORE the tree updates
    const beforeGuiml = snapshotQuery(tree, followUp);

    const start = Date.now();
    let lastGuiml: string | null = null;
    let lastNodes: PlainNode[] = [];
    let stableAt: number | null = null;

    while (Date.now() - start < FOLLOWUP_TIMEOUT_MS) {
      await new Promise(r => setTimeout(r, FOLLOWUP_POLL_MS));
      const freshTree = await fetchTree();
      const fQueries = parseQuery(followUp);
      let fFiltered = filterTree(freshTree, fQueries).nodes;
      fFiltered = bfsFirst(fFiltered, 100);
      if (fFiltered.length > 0) {
        const nowGuiml = toGUIML(fFiltered);
        // Must be different from before the action
        if (beforeGuiml && nowGuiml === beforeGuiml) continue;
        // Fast path: if nothing matched before, return immediately (e.g. menu appeared)
        if (!beforeGuiml) {
          return { query: followUp, guiml: nowGuiml, nodes: fFiltered };
        }
        // Slow path: content changed — wait for it to stabilize (same result for 300ms)
        if (nowGuiml === lastGuiml) {
          if (stableAt && Date.now() - stableAt >= 300) {
            return { query: followUp, guiml: nowGuiml, nodes: fFiltered };
          }
        } else {
          lastGuiml = nowGuiml;
          lastNodes = fFiltered;
          stableAt = Date.now();
        }
      }
    }
    // Timed out — return last result if we have one
    if (lastGuiml && lastNodes.length > 0) {
      return { query: followUp, guiml: lastGuiml, nodes: lastNodes };
    }
    return null;
  }

  return null;
}

/** Run a query against a tree and return the GUIML string, or null if no matches. */
function snapshotQuery(tree: PlainNode, queryStr: string): string | null {
  const queries = parseQuery(queryStr);
  let filtered = filterTree(tree, queries).nodes;
  filtered = bfsFirst(filtered, 100);
  if (filtered.length === 0) return null;
  return toGUIML(filtered);
}

interface WaitSnapshot {
  count: number;
  fingerprint: string;  // serialized structure of matching nodes
}

/** Capture a snapshot of matching nodes: count + structural fingerprint. */
function captureWaitSnapshot(tree: PlainNode, queryStr: string): WaitSnapshot {
  const queries = parseQuery(queryStr);
  const { nodes: filtered } = filterTree(tree, queries);
  const count = countLeaves(filtered);
  const fingerprint = fingerprintNodes(filtered);
  return { count, fingerprint };
}

function countLeaves(nodes: PlainNode[]): number {
  let count = 0;
  for (const node of nodes) {
    if (node._children?.length) {
      count += countLeaves(node._children);
    } else if (node._tag !== "_truncated") {
      count++;
    }
  }
  return count;
}

/** Create a stable string fingerprint of the matched subtree structure. */
function fingerprintNodes(nodes: PlainNode[]): string {
  const parts: string[] = [];
  for (const node of nodes) {
    fingerprintWalk(node, parts);
  }
  return parts.join("|");
}

function fingerprintWalk(node: PlainNode, out: string[]): void {
  // Include tag, id, and key attributes that indicate state
  const id = (node._id || node.id || "") as string;
  const label = (node.label || "") as string;
  const value = (node.value || "") as string;
  const selected = node.selected !== undefined ? `s=${node.selected}` : "";
  const focused = node.focused !== undefined ? `f=${node.focused}` : "";
  out.push(`${node._tag}:${id}:${label}:${value}:${selected}:${focused}`);
  if (node._children) {
    for (const child of node._children) {
      fingerprintWalk(child, out);
    }
  }
}

/**
 * Poll the tree until the wait query condition is satisfied.
 *
 * Satisfied when ANY of:
 *   1. Match count increased (new elements appeared)
 *   2. There were 0 matches before and now there's at least 1
 *   3. At least 1 match exists AND the tree structure changed
 *      (handles UI restructuring where nodes move/change state)
 */
async function waitForCondition(waitQuery: string, before: WaitSnapshot): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < WAIT_TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, WAIT_POLL_MS));

    const tree = await fetchTree();
    const now = captureWaitSnapshot(tree, waitQuery);

    // Case 1: new matches appeared
    if (now.count > before.count) return;

    // Case 2: went from 0 to some
    if (before.count === 0 && now.count > 0) return;

    // Case 3: matches exist and the tree structure changed
    // (covers click on Button#X where button still exists but tree restructured)
    if (now.count > 0 && now.fingerprint !== before.fingerprint) return;
  }

  throw new Error(`--wait timeout: '${waitQuery}' not satisfied after ${WAIT_TIMEOUT_MS}ms`);
}
