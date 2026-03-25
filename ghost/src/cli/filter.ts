import type { PlainNode, Predicate, QueryNode } from "./types.js";
import { findWindowModal } from "./modal.js";

/**
 * Minimum obscured percentage at which a window's subtree is suppressed.
 * Windows below this threshold are treated as fully visible and actionable.
 */
export const OBSCURED_THRESHOLD = 50;

/**
 * Check if a Window node is obscured beyond threshold but should NOT be
 * suppressed because it has a modal child (Sheet/Dialog/Popover).
 * Modal children are always the active interaction target, so obscured
 * windows with modals must remain queryable.
 */
function isWindowEffectivelyObscured(node: PlainNode): boolean {
  if (node._tag !== "Window") return false;
  if (node.obscured == null) return false;
  if (Number(node.obscured) < OBSCURED_THRESHOLD) return false;
  // Window is obscured, but if it has a modal child, don't suppress it
  if (findWindowModal(node)) return false;
  return true;
}

/** Check if a Window node is a visual-only stub without a hydrated AX subtree. */
function isWindowVisualOnly(node: PlainNode): boolean {
  return node._tag === "Window" && node.visualOnly === "true";
}

/**
 * Build a collapsed Window node for visual-only windows.
 */
function buildVisualOnlyWindow(node: PlainNode): PlainNode {
  const result: PlainNode = cloneNodeSymbols({ _tag: node._tag } as PlainNode, node);
  let displayName: string | undefined;
  for (const attr of containerDisplayNameAttrs(node._tag)) {
    const val = node[attr];
    if (val !== undefined && val !== null && val !== "" && typeof val === "string") {
      if (attr === "identifier" && val.startsWith("_NS:")) continue;
      displayName = val;
      break;
    }
  }
  if (displayName) {
    result._id = displayName;
  } else if (node._id !== undefined) {
    result._id = node._id as string;
  } else if (node.id !== undefined) {
    result.id = node.id;
  }
  if (node.z !== undefined) result.z = node.z;
  result.visualOnly = "true";
  result._children = [{ _tag: "_truncated", _truncatedLabel: "deflated" } as PlainNode];
  return result;
}

/**
 * Build a collapsed Window node for obscured windows.
 * Only includes structural keys (_tag, _id/id, display name) — no leaked attrs.
 */
function buildObscuredWindow(node: PlainNode): PlainNode {
  const result: PlainNode = cloneNodeSymbols({ _tag: node._tag } as PlainNode, node);
  // Preserve display name for GUIML rendering
  let displayName: string | undefined;
  for (const attr of containerDisplayNameAttrs(node._tag)) {
    const val = node[attr];
    if (val !== undefined && val !== null && val !== "" && typeof val === "string") {
      if (attr === "identifier" && val.startsWith("_NS:")) continue;
      displayName = val;
      break;
    }
  }
  if (displayName) {
    result._id = displayName;
  } else if (node._id !== undefined) {
    result._id = node._id as string;
  } else if (node.id !== undefined) {
    result.id = node.id;
  }
  if (node.z !== undefined) result.z = node.z;
  if (node.obscured !== undefined) result.obscured = node.obscured;
  result._children = [{ _tag: "_truncated", _truncatedLabel: `obscured ${node.obscured}%` } as PlainNode];
  return result;
}

/**
 * Filter a tree according to parsed queries.
 * Returns top-level matched nodes with container hierarchy preserved.
 */
export interface FilterResult {
  nodes: PlainNode[];
  /** Number of actual query matches. */
  matchCount: number;
}

export type QueryCardinality = "first" | "only" | "all" | "each";

export interface SelectedForestMatch extends Candidate {
  query: QueryNode;
}

export interface SelectedForestResult {
  matches: SelectedForestMatch[];
  matchCount: number;
}

export function filterTree(root: PlainNode, queries: QueryNode[]): FilterResult {
  const results: PlainNode[] = [];
  for (const q of queries) {
    // Phase 1: collect all nodes matching tag+id+predicates
    const candidates = collectCandidates(root, q);
    // Phase 2: apply nth-child slice
    const selected = nthChildSlice(candidates, q);
    // Phase 3: finalize each — apply child queries, projection, wrap in ancestor path
    for (const { node, path } of selected) {
      const finalized = finalizeMatch(node, q);
      if (finalized) {
        for (const item of finalized) {
          results.push(queryOmitsAncestors(q) ? item : wrapInPath(item, path));
        }
      }
    }
  }

  const matchCount = results.length;

  return { nodes: mergeResults(results).map(stripContainerAttrs), matchCount };
}

interface SelectedCandidate extends Candidate {
  query: QueryNode;
}

function selectCandidatesByCardinality(
  candidates: SelectedCandidate[],
  cardinality: QueryCardinality,
): SelectedCandidate[] {
  switch (cardinality) {
    case "first":
      return candidates.length > 0 ? [candidates[0]] : [];
    case "only":
      if (candidates.length !== 1) {
        throw new Error(`Expected exactly one AX match, got ${candidates.length}`);
      }
      return candidates;
    case "all":
    case "each":
      return candidates;
  }
}

/**
 * Canonical filtering across a forest of roots with CLI cardinality semantics
 * applied before final GUIML shaping.
 */
export function filterForestWithCardinality(
  roots: PlainNode[],
  queries: QueryNode[],
  cardinality: QueryCardinality,
): FilterResult {
  const selection = selectForestMatchesWithCardinality(roots, queries, cardinality);
  return {
    nodes: materializeSelectedMatches(selection.matches),
    matchCount: selection.matchCount,
  };
}

export function selectForestMatchesWithCardinality(
  roots: PlainNode[],
  queries: QueryNode[],
  cardinality: QueryCardinality,
): SelectedForestResult {
  const candidates: SelectedCandidate[] = [];
  for (const q of queries) {
    const matches = roots.flatMap(root => collectCandidates(root, q));
    const selected = nthChildSlice(matches, q);
    for (const { node, path } of selected) {
      candidates.push({ node, path, query: q });
    }
  }

  const selected = selectCandidatesByCardinality(candidates, cardinality);
  return {
    matches: selected,
    matchCount: candidates.length,
  };
}

export function materializeSelectedMatches(
  selected: SelectedForestMatch[],
  options: { rootless?: boolean; merge?: boolean } = {},
): PlainNode[] {
  const { rootless = false, merge = true } = options;
  const results: PlainNode[] = [];
  for (const { node, path, query } of selected) {
    const finalized = finalizeMatch(node, query);
    if (!finalized) continue;
    for (const item of finalized) {
      results.push(rootless || queryOmitsAncestors(query) ? item : wrapInPath(item, path));
    }
  }

  const shaped = merge ? mergeResults(results) : results;
  return shaped.map(stripContainerAttrs);
}

/** Info about an app with obscured windows. */
export interface ObscuredAppInfo {
  appName: string;
  bundleId: string;
  obscuredCount: number;
}

/**
 * Walk the tree and find Application nodes that have obscured windows (>=OBSCURED_THRESHOLD%).
 * Returns a summary per app for use in warnings.
 */
export function collectObscuredApps(root: PlainNode): ObscuredAppInfo[] {
  const apps: ObscuredAppInfo[] = [];

  function walk(node: PlainNode) {
    if (node._tag === "Application" && node._children) {
      let obscuredCount = 0;
      for (const child of node._children) {
        if (isWindowEffectivelyObscured(child)) {
          obscuredCount++;
        }
      }
      if (obscuredCount > 0) {
        const appName = String(node.title || node.label || node.name || "");
        const rawId = String(node._id || node.id || "");
        const bundleId = rawId.startsWith("app:") ? rawId.slice(4) : rawId;
        apps.push({ appName, bundleId, obscuredCount });
      }
    }
    if (node._children) {
      for (const child of node._children) {
        walk(child);
      }
    }
  }

  walk(root);
  return apps;
}


/**
 * Merge sibling result trees that share the same tag+id at each level.
 * This deduplicates ancestor wrappers when multiple matches share parents.
 */
function mergeResults(trees: PlainNode[]): PlainNode[] {
  const groups = new Map<string, PlainNode>();
  const order: string[] = [];
  let duplicateLeafIndex = 0;

  for (const tree of trees) {
    const key = `${tree._tag}\0${tree._id ?? tree.id ?? ""}`;
    const existing = groups.get(key);
    if (existing) {
      const existingIsLeaf = !existing._children || existing._children.length === 0;
      const treeIsLeaf = !tree._children || tree._children.length === 0;
      const hasStableIdentity = existing._id !== undefined || existing.id !== undefined || tree._id !== undefined || tree.id !== undefined;
      if (!hasStableIdentity && existingIsLeaf && treeIsLeaf) {
        const duplicateKey = `${key}\0dup:${duplicateLeafIndex++}`;
        order.push(duplicateKey);
        groups.set(duplicateKey, { ...tree });
        continue;
      }
      // Merge children
      const merged = [...(existing._children || []), ...(tree._children || [])];
      existing._children = mergeResults(merged);
    } else {
      order.push(key);
      groups.set(key, { ...tree, _children: tree._children ? [...tree._children] : undefined });
    }
  }

  return order.map(k => groups.get(k)!);
}

function cloneNodeSymbols<T extends PlainNode>(target: T, source: PlainNode): T {
  for (const symbol of Object.getOwnPropertySymbols(source)) {
    Reflect.set(target, symbol, Reflect.get(source, symbol));
  }
  return target;
}

/** Modal role tags that block interaction with sibling elements. */
const MODAL_TAGS = new Set(["Sheet", "Dialog", "Popover"]);

/**
 * For Window nodes with a modal child, return only the modal children.
 * For all other nodes, return all children unchanged.
 */
function modalFilterChildren(node: PlainNode): PlainNode[] {
  if (node._tag !== "Window" || !node._children) return node._children || [];
  const modal = findWindowModal(node);
  if (!modal) return node._children;
  // Only descend into modal children — everything else is blocked
  return node._children.filter(c => MODAL_TAGS.has(c._tag));
}

interface Candidate {
  node: PlainNode;    // the matched node (original, with _children)
  path: PlainNode[];  // ancestor chain from root down to (not including) node
}

/**
 * Find all nodes in the tree matching tag+id+predicates (ignoring index/children).
 * Returns each match with its ancestor path for hierarchy reconstruction.
 */
function collectCandidates(root: PlainNode, query: QueryNode, path: PlainNode[] = []): Candidate[] {
  // ** — match everything recursively
  if (query.tag === "**") {
    // No predicates/id: match root and preserve full subtree
    if (!query.predicates && query.id === undefined) {
      return [{ node: root, path }];
    }
    // With predicates: recursively find all descendants matching
    const results: Candidate[] = [];
    if (specifierMatches(root, query)) {
      results.push({ node: root, path });
    }
    // Don't descend into obscured or visual-only windows
    if (isWindowEffectivelyObscured(root) || isWindowVisualOnly(root)) {
      return results;
    }
    const children = modalFilterChildren(root);
    for (const child of children) {
      results.push(...collectCandidates(child, query, [...path, root]));
    }
    return results;
  }

  if (tagMatches(root, query.tag) && specifierMatches(root, query)) {
    return [{ node: root, path }];
  }

  // Don't descend into obscured or visual-only windows — their content isn't available
  if (isWindowEffectivelyObscured(root) || isWindowVisualOnly(root)) {
    return [];
  }

  // Recurse into children (respecting modal blocking for Window nodes)
  if (!root._children) return [];
  const children = modalFilterChildren(root);
  const results: Candidate[] = [];
  for (const child of children) {
    results.push(...collectCandidates(child, query, [...path, root]));
  }
  return results;
}

function collectDescendantCandidates(
  root: PlainNode,
  query: QueryNode,
  path: PlainNode[] = [],
): Candidate[] {
  const results: Candidate[] = [];

  if (specifierMatches(root, query)) {
    results.push({ node: root, path });
  }

  if (isWindowEffectivelyObscured(root) || isWindowVisualOnly(root)) {
    return results;
  }

  const children = modalFilterChildren(root);
  for (const child of children) {
    results.push(...collectDescendantCandidates(child, query, [...path, root]));
  }
  return results;
}

/** Apply nth-child or slice [start, end) to candidates. */
function nthChildSlice(candidates: Candidate[], query: QueryNode): Candidate[] {
  if (query.index === undefined) return candidates;
  const start = query.index;
  const end = query.indexEnd ?? start + 1;
  return candidates.slice(start, end);
}

/** Apply tag rename if query has `as`. */
function applyTagRename(node: PlainNode, query: QueryNode): PlainNode {
  if (!query.as) return node;
  return { ...node, _tag: query.as };
}

function queryOmitsWrapper(query: QueryNode): boolean {
  return Boolean(query.omitWrapper);
}

function queryOmitsAncestors(query: QueryNode): boolean {
  return Boolean(query.omitAncestors);
}

function queryErasesScopeHierarchy(query: QueryNode): boolean {
  return queryOmitsAncestors(query) && query.tag === "**";
}

function queryIsTransparentScopeAlias(query: QueryNode): boolean {
  return queryOmitsWrapper(query)
    && query.tag === "**"
    && query.id === undefined
    && query.index === undefined
    && !query.predicates?.length;
}

/** Structural keys that should not be converted to bare attr names by [*] introspection. */
const STRUCTURAL_KEYS = new Set(["_tag", "_id", "id", "_text", "_children", "_displayName", "_frame", "_projectedAttrs", "_truncatedCount", "_truncatedLabel"]);

/**
 * For [*] introspection: replace all non-structural attr values with `true`
 * so the GUIML renderer emits bare key names instead of key=value pairs.
 */
function keysOnly(node: PlainNode): PlainNode {
  const result: PlainNode = cloneNodeSymbols({ _tag: node._tag } as PlainNode, node);
  for (const key of Object.keys(node)) {
    if (STRUCTURAL_KEYS.has(key) || key.startsWith("_")) {
      result[key] = node[key];
    } else {
      result[key] = true;
    }
  }
  return result;
}

/** Recursively apply keysOnly to a node and all its children. */
function keysOnlyRecursive(node: PlainNode): PlainNode {
  const result = keysOnly(node);
  if (node._children) {
    result._children = node._children.map(keysOnlyRecursive);
  }
  return result;
}

/** Apply introspection transform: [*] strips values to bare keys, [**] keeps values. */
function applyIntrospect(node: PlainNode, mode: "*" | "**"): PlainNode {
  return mode === "*" ? keysOnly(node) : node;
}

function shapeNodeAttrs(node: PlainNode, query: QueryNode): PlainNode {
  if (!query.introspect) return projectAttrs(node, query);
  if (!query.introspectRemainder) return applyIntrospect(node, query.introspect);
  return projectAttrsWithRemainder(node, query, query.introspect);
}

/** Finalize a matched node: apply child queries and attr projection. */
function finalizeMatch(node: PlainNode, query: QueryNode): PlainNode[] | null {
  if (query.children && query.children.length > 0) {
    if (queryOmitsWrapper(query)) {
      return applyTransparentChildQueries(node, query.children, queryErasesScopeHierarchy(query));
    }
    const result = applyChildQueries(node, query.children);
    if (!result) return null;
    const projected = shapeNodeAttrs(result, query);
    return [applyTagRename(projected, query)];
  }

  // ** preserves full subtree (or projects attrs when predicates present)
  if (query.tag === "**") {
    if (query.introspect && !query.introspectRemainder) {
      return [applyTagRename(applyIntrospect(node, query.introspect), query)];
    }
    if (query.predicates || query.introspectRemainder) {
      const { _children, ...rest } = node;
      return [applyTagRename(shapeNodeAttrs(rest as PlainNode, query), query)];
    }
    return [applyTagRename(stripLeafAttrs(node), query)];
  }

  // Leaf match — strip children, project attrs
  const { _children, ...rest } = node;
  const leaf = rest as PlainNode;
  const projected = shapeNodeAttrs(leaf, query);
  return [applyTagRename(projected, query)];
}

/**
 * Apply scoped child queries within a matched node.
 * Each child query searches descendants of this node.
 */
function collectChildMatches(
  node: PlainNode,
  queries: QueryNode[],
  transparentScope = false,
  eraseScopeHierarchy = false,
): PlainNode[] | null {
  // Visual-only windows: no hydrated AX subtree, show placeholder
  if (isWindowVisualOnly(node)) {
    return transparentScope ? null : [buildVisualOnlyWindow(node)];
  }

  // Obscured windows: show the window but replace children with marker
  // (unless the window has a modal child — those remain interactive)
  if (isWindowEffectivelyObscured(node)) {
    return transparentScope ? null : [buildObscuredWindow(node)];
  }

  const matchedChildren: PlainNode[] = [];

  // Use modal-filtered children for Window nodes with active modals
  const searchableChildren = modalFilterChildren(node);

  for (const q of queries) {
    // * in scope: collect ALL descendants recursively, mirroring collectDescendantCandidatesG.
    // Top-level bare * still matches only the root — this path is only reached inside a scope.
    if (q.tag === "*" && !q.directChild && q.index === undefined && !q.predicates && q.id === undefined && !q.children?.length) {
      if (searchableChildren.length > 0) {
        const gatherAll = (n: PlainNode, relativePath: PlainNode[]): void => {
          const finalized = finalizeMatch(n, q);
          if (finalized) {
            for (const item of finalized) {
              matchedChildren.push(
                queryOmitsAncestors(q) || eraseScopeHierarchy ? item : wrapInPath(item, relativePath),
              );
            }
          }
          for (const k of modalFilterChildren(n)) {
            gatherAll(k, [...relativePath, n]);
          }
        };
        for (const child of searchableChildren) {
          gatherAll(child, []);
        }
      }
      continue;
    }
    // ** = keep full subtree structure
    if (q.tag === "**" && q.index === undefined && !q.predicates && !q.children?.length) {
      if (searchableChildren.length > 0) {
        const mapper = q.introspect === "*" ? keysOnlyRecursive : q.introspect ? (n: PlainNode) => n : stripLeafAttrs;
        matchedChildren.push(...searchableChildren.map(mapper));
      }
      continue;
    }

    // Collect candidates — direct children only when directChild is set
    const candidates: Candidate[] = [];
    if (queryIsTransparentScopeAlias(q)) {
      candidates.push({ node, path: [node] });
    } else {
      if (searchableChildren.length === 0) continue;

      if (q.directChild) {
        for (const child of searchableChildren) {
          if (tagMatches(child, q.tag) && specifierMatches(child, q)) {
            candidates.push({ node: child, path: [node] });
          }
        }
      } else {
        for (const child of searchableChildren) {
          candidates.push(
            ...(q.tag === "*" ? collectDescendantCandidates(child, q) : collectCandidates(child, q)),
          );
        }
      }
    }
    const selected = nthChildSlice(candidates, q);
    for (const { node: matched, path } of selected) {
      const finalized = finalizeMatch(matched, q);
      if (finalized) {
        // Wrap in ancestor path (relative to parent node) to preserve containers
        const relativePath = path.filter(p => p !== node);
        for (const item of finalized) {
          matchedChildren.push(
            queryOmitsAncestors(q) || eraseScopeHierarchy
              ? item
              : wrapInPath(item, relativePath),
          );
        }
      }
    }
  }

  const attrOnlyQueries = queries.length > 0 && queries.every(q =>
    !q.children?.length && (Boolean(q.introspect) || Boolean(q.predicates?.length)),
  );

  // Include obscured/visual-only windows as stubs so the user sees what's blocked
  if (!transparentScope && node._tag === "Application" && node._children && !attrOnlyQueries) {
    for (const child of node._children) {
      const alreadyMatched = matchedChildren.some(existing =>
        existing._tag === child._tag &&
        String(existing._id || existing.id || "") === String(child._id || child.id || ""),
      );
      if (alreadyMatched) continue;
      if (isWindowEffectivelyObscured(child)) {
        matchedChildren.push(buildObscuredWindow(child));
      } else if (isWindowVisualOnly(child)) {
        matchedChildren.push(buildVisualOnlyWindow(child));
      }
    }
  }

  return matchedChildren;
}

function applyChildQueries(node: PlainNode, queries: QueryNode[]): PlainNode | null {
  // Collapsed windows should stay single-wrapped even when the query asks for children.
  if (isWindowVisualOnly(node)) return buildVisualOnlyWindow(node);
  if (isWindowEffectivelyObscured(node)) return buildObscuredWindow(node);

  const matchedChildren = collectChildMatches(node, queries, false) || [];
  if (matchedChildren.length === 0) {
    return null;
  }
  // Merge duplicate containers (e.g. two Buttons in the same Window)
  return { ...node, _children: mergeResults(matchedChildren) };
}

function applyTransparentChildQueries(
  node: PlainNode,
  queries: QueryNode[],
  eraseScopeHierarchy = false,
): PlainNode[] | null {
  const matchedChildren = collectChildMatches(node, queries, true, eraseScopeHierarchy);
  if (!matchedChildren || matchedChildren.length === 0) return null;
  return mergeResults(matchedChildren);
}

/** Wrap a node in its ancestor path (for preserving container hierarchy).
 *  Only copies structural keys from ancestors — no data leak from siblings. */
function wrapInPath(node: PlainNode, path: PlainNode[]): PlainNode {
  let result = node;
  for (let i = path.length - 1; i >= 0; i--) {
    const ancestor = path[i];
    const wrapper: PlainNode = cloneNodeSymbols({ _tag: ancestor._tag, _children: [result] } as PlainNode, ancestor);
    if (ancestor._id !== undefined) wrapper._id = ancestor._id as string;
    if (ancestor.id !== undefined) wrapper.id = ancestor.id;
    if (ancestor.frame !== undefined) wrapper._frame = ancestor.frame;
    if (ancestor._frame !== undefined) wrapper._frame = ancestor._frame;
    // Preserve display-name attrs so stripContainerAttrs can pick the best name
    if (ancestor.title !== undefined) wrapper.title = ancestor.title;
    if (ancestor.label !== undefined) wrapper.label = ancestor.label;
    if (ancestor.name !== undefined) wrapper.name = ancestor.name;
    result = wrapper;
  }
  return result;
}

const INPUT_TAGS = new Set(["TextField", "TextArea", "SearchField", "ComboBox"]);

function tagMatches(node: PlainNode, tag: string): boolean {
  if (tag === "*") return true;
  if (tag === "Input") {
    const nodeTag = node._tag.startsWith("AX") ? node._tag.slice(2) : node._tag;
    return INPUT_TAGS.has(nodeTag);
  }
  if (node._tag === tag) return true;
  // Also match AX-prefixed roles: query "Button" matches _tag "AXButton"
  if (node._tag.startsWith("AX") && node._tag.slice(2) === tag) return true;
  return false;
}

/** Attrs to check for a meaningful display name (same as guiml.ts). */
const DISPLAY_NAME_ATTRS_ID = ["title", "label", "name", "identifier", "placeholder"];
// For TextField/TextArea, prefer placeholder over value so names stay stable after editing
const DISPLAY_NAME_ATTRS_ID_INPUT = ["title", "label", "name", "placeholder", "identifier"];

/** Compute the display id (what appears after # in GUIML) from the raw node. */
export function displayId(node: PlainNode): string | undefined {
  const rawId = (node._id || node.id) as string | undefined;
  if (!rawId) return undefined;
  const tag = node._tag;

  let baseId: string;
  if (rawId.startsWith(tag + ":")) {
    const parts = rawId.slice(tag.length + 1).split(":");
    const index = parts[parts.length - 1];
    const title = parts.slice(0, -1).join(":");
    baseId = title || index;
  } else if (rawId.startsWith(tag + "-")) {
    baseId = rawId.slice(tag.length + 1);
  } else if (rawId.startsWith("app:")) {
    baseId = rawId.slice(4);
  } else {
    baseId = rawId;
  }

  // If the id is uninformative (numeric or generic slug), prefer a meaningful attr
  // This must match the logic in guiml.ts bestDisplayName
  if (/^\d+$/.test(baseId) || /^[a-z]+-\d+$/.test(baseId) || /^[a-z]+-[a-z]+-\d+$/.test(baseId)) {
    const idAttrs = (tag === "TextField" || tag === "TextArea") ? DISPLAY_NAME_ATTRS_ID_INPUT : DISPLAY_NAME_ATTRS_ID;
    for (const attr of idAttrs) {
      const val = node[attr];
      if (val !== undefined && val !== null && val !== "" && typeof val === "string") {
        // Skip auto-generated AppKit identifiers (e.g. "_NS:9")
        if (attr === "identifier" && val.startsWith("_NS:")) continue;
        return val;
      }
    }
  }

  return baseId;
}

function specifierMatches(node: PlainNode, query: QueryNode): boolean {
  if (query.id !== undefined) {
    const did = displayId(node);
    if (did !== query.id) {
      // Fallback: check display-name attrs (title, label, name) so that e.g.
      // App#Calculator matches an Application whose displayId is a bundle-id
      // like "com.apple.calculator" but whose title is "Calculator".
      const fallback = DISPLAY_NAME_ATTRS_ID.some(
        attr => node[attr] !== undefined && node[attr] !== null && String(node[attr]) === query.id
      );
      if (!fallback) return false;
    }
  }
  if (query.predicates) {
    for (const pred of query.predicates) {
      if (!predicateMatches(node, pred)) return false;
    }
  }
  return true;
}

function predicateMatches(node: PlainNode, pred: Predicate): boolean {
  const val = node[pred.attr];
  const str = val === undefined || val === null ? undefined : String(val);
  switch (pred.op) {
    case "exists": return str !== undefined && str !== "";
    case "=":      return str === pred.value;
    case "!=":     return str !== pred.value;
    case "~=":     return str !== undefined && str.includes(pred.value!);
  }
}

/** Attrs to use as display name for containers, in priority order. */
const DISPLAY_NAME_ATTRS = ["title", "label", "name", "activeTab", "direction", "identifier", "placeholder"];
// For TextField/TextArea containers, prefer placeholder over value
const DISPLAY_NAME_ATTRS_CONTAINER_INPUT = ["title", "label", "name", "placeholder", "activeTab", "direction", "identifier"];

function containerDisplayNameAttrs(tag: string): readonly string[] {
  return (tag === "TextField" || tag === "TextArea") ? DISPLAY_NAME_ATTRS_CONTAINER_INPUT : DISPLAY_NAME_ATTRS;
}

/**
 * Recursively strip attrs from any node that has children (it's structural).
 * Only leaf nodes keep their attributes.
 * Container ids are replaced with the best meaningful attr value.
 */
function stripContainerAttrs(node: PlainNode): PlainNode {
  if (!node._children || node._children.length === 0) return node;
  // Truncate visual-only windows
  if (isWindowVisualOnly(node)) {
    return buildVisualOnlyWindow(node);
  }
  // Truncate obscured windows
  if (isWindowEffectivelyObscured(node)) {
    return buildObscuredWindow(node);
  }
  const container: PlainNode = cloneNodeSymbols({ _tag: node._tag } as PlainNode, node);
  if (node._frame !== undefined) container._frame = node._frame;
  if (node.frame !== undefined) container._frame = node.frame;

  let displayName: string | undefined;
  for (const attr of containerDisplayNameAttrs(node._tag)) {
    const val = node[attr];
    if (val !== undefined && val !== null && val !== "") {
      // Skip auto-generated AppKit identifiers (e.g. "_NS:68")
      if (attr === "identifier" && String(val).startsWith("_NS:")) continue;
      displayName = String(val);
      break;
    }
  }

  if (displayName) {
    container._id = displayName;
  } else if (node._id !== undefined) {
    container._id = node._id as string;
  } else if (node.id !== undefined) {
    container.id = node.id;
  }

  const projectedAttrs = Array.isArray(node._projectedAttrs) ? node._projectedAttrs as string[] : [];
  for (const key of projectedAttrs) {
    const value = node[key];
    if (value !== undefined && value !== null) container[key] = value;
  }

  container._children = node._children.map(stripContainerAttrs);
  return container;
}

/** Recursively strip attributes from leaf nodes (used by ** subtree expansion). */
function stripLeafAttrs(node: PlainNode): PlainNode {
  // Truncate visual-only windows
  if (isWindowVisualOnly(node)) {
    return buildVisualOnlyWindow(node);
  }
  // Truncate obscured windows — don't dump their full subtree
  if (isWindowEffectivelyObscured(node)) {
    return buildObscuredWindow(node);
  }
  if (node._children && node._children.length > 0) {
    return { ...node, _children: node._children.map(stripLeafAttrs) };
  }
  // Leaf node — keep only structural keys
  const result: PlainNode = cloneNodeSymbols({ _tag: node._tag } as PlainNode, node);
  if (node._id !== undefined) result._id = node._id as string;
  if (node.id !== undefined) result.id = node.id;
  if (node._text !== undefined) result._text = node._text;
  // Preserve display name for guiml rendering
  for (const attr of containerDisplayNameAttrs(node._tag)) {
    const val = node[attr];
    if (val !== undefined && val !== null && val !== "" && typeof val === "string") {
      result._displayName = val;
      break;
    }
  }
  return result;
}

/**
 * BFS-truncate: keep at most `n` nodes in breadth-first order.
 * Parents are visited before children, so the tree structure is naturally preserved.
 * Wherever children are dropped, a `{... N more}` marker is inserted.
 */
export function bfsFirst(roots: PlainNode[], n: number): PlainNode[] {
  if (!isFinite(n) || n <= 0) return roots;

  const kept = new Set<PlainNode>();
  const queue: PlainNode[] = [...roots];
  let count = 0;

  while (queue.length > 0 && count < n) {
    const node = queue.shift()!;
    kept.add(node);
    count++;
    if (node._children) {
      for (const child of node._children) {
        queue.push(child);
      }
    }
  }

  function prune(node: PlainNode): PlainNode {
    if (!node._children) return node;
    const keptChildren = node._children.filter(c => kept.has(c));
    const dropped = node._children.length - keptChildren.length;
    const pruned = keptChildren.map(prune);
    if (dropped > 0) {
      pruned.push({ _tag: "_truncated", _truncatedCount: dropped } as PlainNode);
    }
    return pruned.length > 0 ? { ...node, _children: pruned } : { ...node, _children: undefined };
  }

  const keptRoots = roots.filter(r => kept.has(r));
  const droppedRoots = roots.length - keptRoots.length;
  const result = keptRoots.map(prune);
  if (droppedRoots > 0) {
    result.push({ _tag: "_truncated", _truncatedCount: droppedRoots } as PlainNode);
  }
  return result;
}

/**
 * Project a matched node down to only the attrs requested by non-suppressed predicates.
 * No predicates = no attrs (just tag + id). Suppressed predicates filter but don't show.
 */
function projectAttrs(node: PlainNode, query: QueryNode): PlainNode {
  const result: PlainNode = cloneNodeSymbols({ _tag: node._tag } as PlainNode, node);
  const projectedAttrs: string[] = [];
  if (node._id !== undefined) result._id = node._id as string;
  if (node.id !== undefined) result.id = node.id;
  if (node._text !== undefined) result._text = node._text;
  if (node._children) result._children = node._children;
  // Preserve hidden flag for GUIML rendering (#146)
  if (node.hidden !== undefined) result.hidden = node.hidden;
  // Preserve frame for scan overlay (collectRects needs it), hidden from GUIML via _ prefix
  if (node.frame !== undefined) result._frame = node.frame;

  // Preserve best display name for guiml rendering even if attr isn't requested
  for (const attr of containerDisplayNameAttrs(node._tag)) {
    const val = node[attr];
    if (val !== undefined && val !== null && val !== "" && typeof val === "string") {
      result._displayName = val;
      break;
    }
  }

  if (!query.predicates) return result;

  for (const pred of query.predicates) {
    if (pred.suppress) continue;
    const val = node[pred.attr];
    if (val !== undefined && val !== null) {
      const key = pred.as || pred.attr;
      const str = pred.transform ? pred.transform(String(val)) : val;
      result[key] = str;
      projectedAttrs.push(key);
    }
  }
  if (projectedAttrs.length > 0) result._projectedAttrs = projectedAttrs;
  return result;
}

function projectAttrsWithRemainder(node: PlainNode, query: QueryNode, mode: "*" | "**"): PlainNode {
  const result = projectAttrs(node, query);
  const projectedAttrs = Array.isArray(result._projectedAttrs) ? [...result._projectedAttrs as string[]] : [];
  const consumedAttrs = new Set<string>();

  if (query.predicates) {
    for (const pred of query.predicates) {
      if (pred.suppress) continue;
      consumedAttrs.add(pred.attr);
      if (pred.as) consumedAttrs.add(pred.as);
    }
  }

  for (const [key, value] of Object.entries(node)) {
    if (STRUCTURAL_KEYS.has(key) || key.startsWith("_")) continue;
    if (consumedAttrs.has(key) || Object.hasOwn(result, key)) continue;
    result[key] = mode === "*" ? true : value;
    projectedAttrs.push(key);
  }

  if (projectedAttrs.length > 0) result._projectedAttrs = projectedAttrs;
  return result;
}

/**
 * Find the deepest matching node in the tree for a parsed query, preserving all
 * original attributes (including frame coordinates x, y, w, h).
 * Used by `gui img` where we need geometry, not display output.
 */
export function findMatchedNode(root: PlainNode, queries: QueryNode[]): PlainNode | null {
  const result = findMatchedNodeWithContext(root, queries);
  return result ? result.node : null;
}

export interface MatchedNodeContext {
  node: PlainNode;
  bundleId: string;
  /** Ancestor path from root to (but not including) the matched node. */
  path: PlainNode[];
}

/**
 * Find the deepest matching node with its app context (bundleId).
 * Uses the query engine to resolve scoped queries correctly, unlike a naive
 * DFS id-lookup which would find the first global match.
 */
export function findMatchedNodeWithContext(root: PlainNode, queries: QueryNode[]): MatchedNodeContext | null {
  for (const q of queries) {
    const candidates = collectCandidates(root, q);
    const selected = nthChildSlice(candidates, q);
    if (selected.length === 0) continue;

    // If there are child queries, find the deepest match within the matched parent
    if (q.children && q.children.length > 0) {
      for (const { node, path } of selected) {
        const child = findMatchedNodeWithContext(node, q.children);
        if (child) {
          // If child didn't resolve a bundleId, try from the outer path
          if (!child.bundleId) {
            child.bundleId = extractBundleId(path) || "";
          }
          // Prepend outer path if child path doesn't include it
          if (child.path.length === 0 || child.path[0] !== path[0]) {
            child.path = [...path, node, ...child.path];
          }
          return child;
        }
      }
    }

    // Return the first selected node (with all original attrs intact)
    const { node, path } = selected[0];
    const bundleId = extractBundleId([...path, node]);
    return { node, bundleId: bundleId || "", path };
  }
  return null;
}

/** Extract bundleId from an ancestor path by finding the nearest Application node. */
function extractBundleId(path: PlainNode[]): string | undefined {
  for (const node of path) {
    if (node.bundleId) return node.bundleId as string;
    if (node._tag === "Application") {
      const rawId = (node._id || node.id) as string | undefined;
      if (rawId?.startsWith("app:")) return rawId.slice(4);
      return rawId;
    }
  }
  return undefined;
}

// ── Generic matching engine ──
// Shared query matching that works with any tree shape via NodeAccessor<T>.
// Used by `matchTree` (for AX queries) and could replace PlainNode-specific
// matching above in the future.

import type { NodeAccessor } from "./types.js";

export interface TreeMatch<T> {
  node: T;
  path: T[];
}

function tagMatchesG<T>(node: T, tag: string, acc: NodeAccessor<T>): boolean {
  if (tag === "*") return true;
  const nodeTag = acc.tag(node);
  if (tag === "Input") {
    return INPUT_TAGS.has(nodeTag.startsWith("AX") ? nodeTag.slice(2) : nodeTag);
  }
  return nodeTag === tag || `AX${nodeTag}` === tag;
}

function predicateMatchesG<T>(node: T, pred: Predicate, acc: NodeAccessor<T>): boolean {
  const str = acc.attr(node, pred.attr);
  switch (pred.op) {
    case "exists": return str !== undefined && str !== "";
    case "=":      return str === pred.value;
    case "!=":     return str !== pred.value;
    case "~=":     return str !== undefined && str.includes(pred.value!);
  }
}

const FALLBACK_ID_ATTRS = ["title", "label", "name", "identifier", "placeholder"];

function specifierMatchesG<T>(node: T, query: QueryNode, acc: NodeAccessor<T>): boolean {
  if (query.id !== undefined) {
    const did = acc.id(node);
    if (did !== query.id) {
      const fallback = FALLBACK_ID_ATTRS.some(attr => {
        const v = acc.attr(node, attr);
        return v !== undefined && v === query.id;
      });
      if (!fallback) return false;
    }
  }
  if (query.predicates) {
    for (const pred of query.predicates) {
      if (!predicateMatchesG(node, pred, acc)) return false;
    }
  }
  return true;
}

function collectCandidatesG<T>(
  root: T, query: QueryNode, acc: NodeAccessor<T>, path: T[],
): TreeMatch<T>[] {
  if (query.tag === "**") {
    if (!query.predicates && query.id === undefined) {
      return [{ node: root, path }];
    }
    const results: TreeMatch<T>[] = [];
    if (specifierMatchesG(root, query, acc)) {
      results.push({ node: root, path });
    }
    const children = acc.children(root) || [];
    for (const child of children) {
      results.push(...collectCandidatesG(child, query, acc, [...path, root]));
    }
    return results;
  }

  if (tagMatchesG(root, query.tag, acc) && specifierMatchesG(root, query, acc)) {
    return [{ node: root, path }];
  }

  const children = acc.children(root) || [];
  const results: TreeMatch<T>[] = [];
  for (const child of children) {
    results.push(...collectCandidatesG(child, query, acc, [...path, root]));
  }
  return results;
}

function collectDescendantCandidatesG<T>(
  root: T,
  query: QueryNode,
  acc: NodeAccessor<T>,
  path: T[],
): TreeMatch<T>[] {
  const results: TreeMatch<T>[] = [];

  if (specifierMatchesG(root, query, acc)) {
    results.push({ node: root, path });
  }

  const children = acc.children(root) || [];
  for (const child of children) {
    results.push(...collectDescendantCandidatesG(child, query, acc, [...path, root]));
  }
  return results;
}

function nthChildSliceG<T>(candidates: TreeMatch<T>[], query: QueryNode): TreeMatch<T>[] {
  if (query.index === undefined) return candidates;
  const start = query.index;
  const end = query.indexEnd ?? start + 1;
  return candidates.slice(start, end);
}

/**
 * Generic tree matching: find all nodes matching queries using a NodeAccessor.
 * Returns flat list of matches with ancestor paths. No CRDT-specific post-processing.
 * Used by `gui ax q` and other non-CRDT query callers.
 */
export function matchTree<T>(
  root: T, queries: QueryNode[], acc: NodeAccessor<T>,
): TreeMatch<T>[] {
  const results: TreeMatch<T>[] = [];
  for (const q of queries) {
    const candidates = collectCandidatesG(root, q, acc, []);
    const selected = nthChildSliceG(candidates, q);
    for (const { node, path } of selected) {
      if (q.children && q.children.length > 0) {
        const sub = matchInSubtree(node, q.children, acc);
        for (const s of sub) {
          results.push({ node: s.node, path: [...path, node, ...s.path] });
        }
      } else {
        results.push({ node, path });
      }
    }
  }
  return results;
}

function matchInSubtree<T>(
  parent: T, queries: QueryNode[], acc: NodeAccessor<T>,
): TreeMatch<T>[] {
  const children = acc.children(parent) || [];
  const results: TreeMatch<T>[] = [];
  for (const q of queries) {
    const candidates: TreeMatch<T>[] = [];
    if (q.directChild) {
      // Direct child: only check immediate children, no recursion
      for (const child of children) {
        if (tagMatchesG(child, q.tag, acc) && specifierMatchesG(child, q, acc)) {
          candidates.push({ node: child, path: [] });
        }
      }
    } else {
      for (const child of children) {
        candidates.push(
          ...(q.tag === "*" ? collectDescendantCandidatesG(child, q, acc, []) : collectCandidatesG(child, q, acc, [])),
        );
      }
    }
    const selected = nthChildSliceG(candidates, q);
    for (const { node, path } of selected) {
      if (q.children && q.children.length > 0) {
        const sub = matchInSubtree(node, q.children, acc);
        for (const s of sub) {
          results.push({ node: s.node, path: [...path, node, ...s.path] });
        }
      } else {
        results.push({ node, path });
      }
    }
  }
  return results;
}
