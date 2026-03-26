import type { AXNode, WindowFrame } from "./types.js";

/** Walk AX tree to find first node matching a predicate (depth-first). */
export function findAXNode(node: AXNode, pred: (n: AXNode) => boolean): AXNode | undefined {
  if (pred(node)) return node;
  for (const child of node.children || []) {
    const found = findAXNode(child, pred);
    if (found) return found;
  }
  return undefined;
}

/** Format an AX frame as "(x,y,w,h)" string for CRDT storage. */
export function fmtFrame(f: { x: number; y: number; width: number; height: number } | undefined): string | undefined {
  if (!f) return undefined;
  return `(${Math.round(f.x)},${Math.round(f.y)},${Math.round(f.width)},${Math.round(f.height)})`;
}

/** Format a WindowFrame as "(x,y,w,h)" string. */
export function fmtWinFrame(x: number, y: number, w: number, h: number): string {
  return `(${Math.round(x)},${Math.round(y)},${Math.round(w)},${Math.round(h)})`;
}

/** Find all AX nodes matching a predicate (depth-first). */
export function findAllAXNodes(node: AXNode, pred: (n: AXNode) => boolean, results: AXNode[] = []): AXNode[] {
  if (pred(node)) results.push(node);
  for (const child of node.children || []) findAllAXNodes(child, pred, results);
  return results;
}
