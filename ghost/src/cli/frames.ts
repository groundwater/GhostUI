import type { PlainNode } from "./types.js";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const FRAME_RE = /^\((-?\d+),(-?\d+),(\d+),(\d+)\)$/;

function parseFrame(raw: unknown): Rect | null {
  if (typeof raw === "string") {
    const m = FRAME_RE.exec(raw);
    if (m) return { x: +m[1], y: +m[2], width: +m[3], height: +m[4] };
  }
  // CRDT tuple encoding: {_tuple: [x, y, w, h]}
  if (raw && typeof raw === "object" && "_tuple" in raw) {
    const t = (raw as { _tuple: number[] })._tuple;
    if (t.length >= 4) return { x: t[0], y: t[1], width: t[2], height: t[3] };
  }
  return null;
}

/** Try to extract a Rect from a node's frame attr or individual x,y,w,h attrs. */
function extractRect(node: PlainNode): Rect | null {
  if (node._frame !== undefined) return parseFrame(node._frame);
  if (node.frame !== undefined) return parseFrame(node.frame);
  const x = node.x, y = node.y, w = node.w, h = node.h;
  if (x !== undefined && y !== undefined && w !== undefined && h !== undefined) {
    return { x: Number(x), y: Number(y), width: Number(w), height: Number(h) };
  }
  return null;
}

const SKIP_TYPES = new Set(["Display", "Application", "MenuBar"]);
const OUTLINE_TYPES = new Set(["Window"]);

/** Recursively collect IDs from leaf nodes in a filtered result tree.
 *  Only leaves (no _children) are actual query matches — containers are
 *  structural wrappers that should not be highlighted by scan overlay. */
export function collectIds(nodes: PlainNode[]): Set<string> {
  const ids = new Set<string>();
  function walk(node: PlainNode) {
    if (node._children && node._children.length > 0) {
      for (const child of node._children) walk(child);
    } else {
      const id = (node._id ?? node.id) as string | undefined;
      if (id) ids.add(id);
    }
  }
  for (const n of nodes) walk(n);
  return ids;
}

/** Extract rects directly from leaf nodes in the filtered result tree.
 *  No ID lookup needed — the matched nodes already carry frame data. */
export function collectRects(nodes: PlainNode[]): { rects: Rect[]; outlineRects: Rect[] } {
  const rects: Rect[] = [];
  const outlineRects: Rect[] = [];

  function walk(node: PlainNode) {
    if (SKIP_TYPES.has(node._tag)) {
      if (node._children) for (const child of node._children) walk(child);
      return;
    }
    if (node._children && node._children.length > 0) {
      // Container — recurse, but check if it's a Window (outline)
      if (OUTLINE_TYPES.has(node._tag)) {
        const rect = extractRect(node);
        if (rect && rect.width > 0 && rect.height > 0) outlineRects.push(rect);
      }
      for (const child of node._children) walk(child);
    } else {
      // Leaf — actual match
      const rect = extractRect(node);
      if (rect && rect.width > 0 && rect.height > 0) rects.push(rect);
    }
  }

  for (const n of nodes) walk(n);
  return { rects, outlineRects };
}

/** Walk the full tree, collecting frames for nodes whose IDs are in matchedIds. */
export function resolveFrames(
  fullTree: PlainNode,
  matchedIds: Set<string>,
): { rects: Rect[]; outlineRects: Rect[] } {
  const rects: Rect[] = [];
  const outlineRects: Rect[] = [];

  function walk(node: PlainNode) {
    const id = (node._id ?? node.id) as string | undefined;
    if (id && matchedIds.has(id) && !SKIP_TYPES.has(node._tag)) {
      const rect = extractRect(node);
      if (rect && rect.width > 0 && rect.height > 0) {
        if (OUTLINE_TYPES.has(node._tag)) {
          outlineRects.push(rect);
        } else {
          rects.push(rect);
        }
      }
    }
    if (node._children) {
      for (const child of node._children) walk(child);
    }
  }

  walk(fullTree);
  return { rects, outlineRects };
}
