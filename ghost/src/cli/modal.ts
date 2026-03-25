import type { PlainNode } from "./types.js";

/** Modal role tags that block interaction with sibling elements in the same window. */
const MODAL_TAGS = new Set(["Sheet", "Dialog", "Popover"]);

/**
 * Find the first modal child (Sheet, Dialog, Popover) of a Window node.
 * Returns the modal node if found, null otherwise.
 * Only checks direct children — modals are always direct children of Window.
 */
export function findWindowModal(windowNode: PlainNode): PlainNode | null {
  if (windowNode._tag !== "Window") return null;
  if (!windowNode._children) return null;
  for (const child of windowNode._children) {
    if (MODAL_TAGS.has(child._tag)) return child;
  }
  return null;
}

/**
 * Check if a node is blocked by a modal in its containing window.
 * Walks up the ancestor path to find the Window, then checks for modals.
 * Returns the modal tag (e.g. "Sheet") if blocked, null if not.
 */
export function isBlockedByModal(path: PlainNode[], node: PlainNode): string | null {
  // Find the nearest Window ancestor
  for (let i = path.length - 1; i >= 0; i--) {
    const ancestor = path[i];
    if (ancestor._tag !== "Window") continue;

    const modal = findWindowModal(ancestor);
    if (!modal) return null;

    // The node is blocked if it's NOT a descendant of the modal.
    // Check: is the node (or any of its ancestors between Window and node)
    // the modal itself or inside the modal?
    // The path goes: [..., Window, ..., parent-of-node]
    // If any element between Window (exclusive) and node is the modal or
    // inside the modal subtree, the node is not blocked.

    // Simple check: the child of Window that leads to our node —
    // if it's the modal, we're not blocked.
    if (i + 1 < path.length) {
      const windowChild = path[i + 1];
      if (MODAL_TAGS.has(windowChild._tag)) return null;
    }
    // If node itself is the modal
    if (MODAL_TAGS.has(node._tag)) return null;

    return modal._tag;
  }
  return null;
}

/**
 * Transform a Window's children to collapse non-modal siblings when a modal is present.
 * Returns new children array with non-modal children replaced by a truncation marker.
 * If no modal is present, returns the original children unchanged.
 */
export function collapseBlockedChildren(windowNode: PlainNode): PlainNode[] | undefined {
  if (windowNode._tag !== "Window") return windowNode._children;
  if (!windowNode._children) return undefined;

  const modal = findWindowModal(windowNode);
  if (!modal) return windowNode._children;

  // Keep only modal children, replace everything else with a single marker
  const result: PlainNode[] = [];
  result.push({
    _tag: "_truncated",
    _truncatedLabel: `blocked by ${modal._tag}`,
  } as PlainNode);
  for (const child of windowNode._children) {
    if (MODAL_TAGS.has(child._tag)) {
      result.push(child);
    }
  }
  return result;
}
