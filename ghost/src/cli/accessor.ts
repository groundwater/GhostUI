import type { PlainNode, NodeAccessor } from "./types.js";
import type { AXNode } from "./ax.js";
import { displayId } from "./filter.js";

/** Accessor for CRDT PlainNode trees. */
export const plainNodeAccessor: NodeAccessor<PlainNode> = {
  tag: (n) => n._tag,
  children: (n) => n._children,
  attr: (n, name) => {
    const v = n[name];
    return v == null ? undefined : String(v);
  },
  id: (n) => displayId(n),
  attrs: (n) =>
    Object.fromEntries(
      Object.entries(n)
        .filter(([k]) => !k.startsWith("_"))
        .filter(([, v]) => v != null)
        .map(([k, v]) => [k, String(v)]),
    ),
};

/** Convert an AXNode tree to PlainNode for filterTree + toGUIML. Faithful 1:1 copy. */
export function axTreeToPlain(node: AXNode): PlainNode {
  const plain: PlainNode = { _tag: node.role };
  // _id for display in GUIML tags
  const id = node.title || node.label || node.identifier;
  if (id) plain._id = id;
  // Copy every known field verbatim
  for (const key of ["title", "label", "description", "value", "subrole", "identifier", "placeholder"] as const) {
    if (node[key] != null && node[key] !== "") plain[key] = node[key];
  }
  for (const key of ["enabled", "focused", "selected"] as const) {
    if (node[key] !== undefined) plain[key] = node[key];
  }
  if (node.frame) {
    plain.frame = `(${node.frame.x},${node.frame.y},${node.frame.width},${node.frame.height})`;
  }
  if (node.actions && node.actions.length > 0) plain.actions = node.actions.join(",");
  // Flatten capabilities into top-level attrs
  if (node.capabilities) {
    for (const [k, v] of Object.entries(node.capabilities)) {
      if (v != null && !(k in plain)) plain[k] = v;
    }
  }
  if (node.children && node.children.length > 0) {
    plain._children = node.children.map(axTreeToPlain);
  }
  return plain;
}

/** Accessor for raw AX tree nodes. */
export const axNodeAccessor: NodeAccessor<AXNode> = {
  tag: (n) => n.role.replace(/^AX/, ""),
  children: (n) => n.children,
  attr: (n, name) => {
    // Frame sub-fields: x, y, width, height
    if (n.frame) {
      if (name === "x") return String(n.frame.x);
      if (name === "y") return String(n.frame.y);
      if (name === "width") return String(n.frame.width);
      if (name === "height") return String(n.frame.height);
    }
    // Capabilities (enabled, focused, selected, checked, expanded, etc.)
    const capVal = n.capabilities?.[name];
    if (capVal != null) return String(capVal);
    // Direct properties
    const v = (n as AXNode & Record<string, unknown>)[name];
    return v == null ? undefined : String(v);
  },
  id: (n) => n.title || n.label || n.identifier,
  attrs: (n) => {
    const result: Record<string, string> = {};
    if (n.title) result.title = n.title;
    if (n.label) result.label = n.label;
    if (n.description) result.description = n.description;
    if (n.value != null && n.value !== "") result.value = String(n.value);
    if (n.subrole) result.subrole = n.subrole;
    if (n.identifier) result.identifier = n.identifier;
    if (n.placeholder) result.placeholder = n.placeholder;
    if (n.frame) {
      result.x = String(n.frame.x);
      result.y = String(n.frame.y);
      result.width = String(n.frame.width);
      result.height = String(n.frame.height);
    }
    if (n.capabilities) {
      for (const [k, v] of Object.entries(n.capabilities)) {
        if (v != null) result[k] = String(v);
      }
    }
    if (n.enabled === false) result.enabled = "false";
    if (n.focused) result.focused = "true";
    if (n.selected) result.selected = "true";
    return result;
  },
};
