import { toGUIML } from "./guiml.js";
import type { PlainNode, QueryNode } from "./types.js";

export type IntrospectMode = "*" | "**";

const INTROSPECT_SKIP = new Set(["_tag", "_text", "_children", "type", "id", "_id", "x", "y", "w", "h"]);

/**
 * Transform filtered tree for introspection, then render as GUIML.
 * [*]  — leaf nodes show attr names only (no values), e.g. <Tab label icon />
 * [**] — leaf nodes show all key="val" pairs (normal GUIML but all attrs visible)
 */
export function formatIntrospection(nodes: PlainNode[], mode: IntrospectMode): string {
  const transformed = nodes.map(n => transformForIntrospect(n, mode));
  return toGUIML(transformed);
}

/** Recursively transform a node tree for introspection output. */
export function transformForIntrospect(node: PlainNode, mode: IntrospectMode): PlainNode {
  if (node._children && node._children.length > 0) {
    return {
      ...node,
      _children: node._children.map(c => transformForIntrospect(c, mode)),
    };
  }

  if (mode === "*") {
    const result: PlainNode = { _tag: node._tag };
    if (node._id || node.id) {
      result._id = (node._id || node.id) as string;
    }
    for (const key of Object.keys(node)) {
      if (INTROSPECT_SKIP.has(key)) continue;
      if (node[key] === undefined || node[key] === null || node[key] === "") continue;
      result[key] = true;
    }
    return result;
  }

  return node;
}

/** Recursively find introspect mode in query tree. */
export function findIntrospect(queries: QueryNode[]): IntrospectMode | undefined {
  for (const q of queries) {
    if (q.introspect) return q.introspect;
    if (q.children) {
      const child = findIntrospect(q.children);
      if (child) return child;
    }
  }
  return undefined;
}

export function renderQueryResult(nodes: PlainNode[], queries: QueryNode[]): string {
  const introMode = findIntrospect(queries);
  if (introMode) {
    return formatIntrospection(nodes, introMode);
  }
  return toGUIML(nodes);
}
