import type { PlainNode } from "./types.js";
import { displayId } from "./filter.js";

interface Selector {
  tag: string;
  id?: string;
  index?: number;
}

export function parseSelector(token: string): Selector {
  // Tag:N — index
  const colonIdx = token.lastIndexOf(":");
  if (colonIdx > 0) {
    const maybeName = token.slice(0, colonIdx);
    const maybeIdx = token.slice(colonIdx + 1);
    if (/^\d+$/.test(maybeIdx)) {
      const sel = parseTagId(maybeName);
      return { ...sel, index: Number(maybeIdx) };
    }
  }
  return parseTagId(token);
}

function parseTagId(token: string): Selector {
  const hashIdx = token.indexOf("#");
  if (hashIdx > 0) {
    return { tag: token.slice(0, hashIdx), id: stripQuotes(token.slice(hashIdx + 1)) };
  }
  return { tag: token };
}

/** Strip surrounding quotes (double or single) from a string. */
function stripQuotes(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
  return s;
}

interface Match {
  path: string;
  value: string;
}

function nodeLabel(node: PlainNode): string {
  const id = displayId(node);
  return id ? `${node._tag}#${id}` : node._tag;
}

export function matchChain(root: PlainNode, selectors: Selector[], property: string): Match[] {
  // Find all nodes matching the selector chain
  const matched = findMatches(root, selectors, 0);
  const results: Match[] = [];

  for (const { node, selectorPath } of matched) {
    // Search the matched node and all its descendants for the property
    collectProperty(node, property, selectorPath, results, true);
  }

  return results;
}

/** Collect all descendants (including node itself) that have the property. */
function collectProperty(
  node: PlainNode,
  property: string,
  prefix: string,
  results: Match[],
  currentIsPrefix = false,
) {
  const val = node[property];
  if (val !== undefined && val !== null && val !== "") {
    const path = currentIsPrefix ? `${prefix}.${property}` : `${prefix}/${nodeLabel(node)}.${property}`;
    results.push({ path, value: String(val) });
  }
  if (node._children) {
    for (const child of node._children) {
      collectProperty(child, property, prefix, results, false);
    }
  }
}

interface MatchCandidate {
  node: PlainNode;
  selectorPath: string; // compact path built from selector matches only
}

function findMatches(
  root: PlainNode,
  selectors: Selector[],
  depth: number,
  parentPath: string = "",
): MatchCandidate[] {
  if (depth >= selectors.length) {
    return [{ node: root, selectorPath: parentPath }];
  }

  const sel = selectors[depth];
  const isLast = depth === selectors.length - 1;

  const candidates = findDescendants(root, sel);

  // Apply index filter
  const filtered = sel.index !== undefined ? candidates.filter((_, i) => i === sel.index) : candidates;

  if (isLast) {
    return filtered.map(node => ({
      node,
      selectorPath: parentPath + "/" + nodeLabel(node),
    }));
  }

  const results: MatchCandidate[] = [];
  for (const node of filtered) {
    const path = parentPath + "/" + nodeLabel(node);
    results.push(...findMatches(node, selectors, depth + 1, path));
  }
  return results;
}

function findDescendants(root: PlainNode, sel: Selector): PlainNode[] {
  const results: PlainNode[] = [];
  if (!root._children) return results;

  for (const child of root._children) {
    if (nodeMatchesSelector(child, sel)) {
      results.push(child);
    }
    results.push(...findDescendants(child, sel));
  }
  return results;
}

function nodeMatchesSelector(node: PlainNode, sel: Selector): boolean {
  if (node._tag !== sel.tag) return false;
  if (sel.id !== undefined && displayId(node) !== sel.id) return false;
  return true;
}
