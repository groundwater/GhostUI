import { axTargetFromNode, type AXTarget } from "./ax-target.js";
import { axTreeToPlain } from "../cli/accessor.js";
import {
  filterForestWithCardinality,
  findMatchedNodeWithContext,
  materializeSelectedMatches,
  selectForestMatchesWithCardinality,
  type QueryCardinality,
  type SelectedForestMatch,
} from "../cli/filter.js";
import { toGUIML } from "../cli/guiml.js";
import { parseQuery } from "../cli/query.js";
import type { PlainNode, QueryNode } from "../cli/types.js";
import type { AXNode } from "../cli/ax.js";

const AX_SOURCE = Symbol("axQuerySource");

export interface AXQuerySourceRef {
  pid: number;
  rawNode: AXNode;
  rawPath: AXNode[];
}

export interface AXSelectedMatch {
  query: QueryNode;
  plainNode: PlainNode;
  plainPath: PlainNode[];
  source: AXQuerySourceRef;
}

export interface AXSelectionResult {
  matches: AXSelectedMatch[];
  matchCount: number;
  selected: SelectedForestMatch[];
}

export interface AXQuerySerializedMatch {
  type: "ax.query-match";
  pid: number;
  node: PlainNode;
  target?: AXTarget;
  targetError?: string;
}

type AXQueryRoot = {
  pid: number;
  tree: AXNode;
};

type AXPlainNode = PlainNode & {
  [AX_SOURCE]?: AXQuerySourceRef;
};

function attachAXSources(rawNode: AXNode, plainNode: AXPlainNode, pid: number, rawPath: AXNode[] = []): void {
  plainNode[AX_SOURCE] = { pid, rawNode, rawPath };
  const rawChildren = rawNode.children || [];
  const plainChildren = plainNode._children || [];
  for (let i = 0; i < Math.min(rawChildren.length, plainChildren.length); i++) {
    attachAXSources(rawChildren[i], plainChildren[i] as AXPlainNode, pid, [...rawPath, rawNode]);
  }
}

function buildAXPlainRoot(pid: number, tree: AXNode): AXPlainNode {
  const root = axTreeToPlain(tree) as AXPlainNode;
  attachAXSources(tree, root, pid);
  return root;
}

function getAXSource(node: PlainNode): AXQuerySourceRef {
  const source = (node as AXPlainNode)[AX_SOURCE];
  if (!source) {
    throw new Error(`Missing AX source metadata for ${node._tag}`);
  }
  return source;
}

function buildSerializableMatch(node: PlainNode, query: QueryNode): AXQuerySerializedMatch {
  const targetNode = query.children && query.children.length > 0
    ? findMatchedNodeWithContext(node, query.children)?.node ?? node
    : node;
  const source = getAXSource(targetNode);
  try {
    return {
      type: "ax.query-match",
      pid: source.pid,
      node,
      target: axTargetFromNode(source.pid, source.rawNode),
    };
  } catch (error: unknown) {
    return {
      type: "ax.query-match",
      pid: source.pid,
      node,
      targetError: error instanceof Error ? error.message : String(error),
    };
  }
}

export function selectAXQueryMatches(
  roots: AXQueryRoot[],
  query: string,
  cardinality: QueryCardinality,
): AXSelectionResult {
  const queries = parseQuery(query);
  const plainRoots = roots.map(({ pid, tree }) => buildAXPlainRoot(pid, tree));
  const selection = selectForestMatchesWithCardinality(plainRoots, queries, cardinality);
  return {
    matches: selection.matches.map(({ node, path, query: selectedQuery }) => ({
      query: selectedQuery,
      plainNode: node,
      plainPath: path,
      source: getAXSource(node),
    })),
    matchCount: selection.matchCount,
    selected: selection.matches,
  };
}

export function renderAXSelectionGuiml(selection: AXSelectionResult): string {
  return toGUIML(materializeSelectedMatches(selection.selected));
}

function renderSplitAXSelectionGuiml(selection: AXSelectionResult): string {
  return materializeSelectedMatches(selection.selected, { merge: false })
    .map(node => toGUIML([node]))
    .join("\n\n");
}

export function serializeAXSelectionMatches(selection: AXSelectionResult): AXQuerySerializedMatch[] {
  return selection.selected.flatMap((selected) =>
    materializeSelectedMatches([selected], { rootless: true, merge: false }).map((node) =>
      buildSerializableMatch(node, selected.query),
    ),
  );
}

export function renderAXQueryGuiml(
  roots: AXQueryRoot[],
  query: string,
  cardinality: QueryCardinality,
): string {
  const selection = selectAXQueryMatches(roots, query, cardinality);
  return cardinality === "each"
    ? renderSplitAXSelectionGuiml(selection)
    : renderAXSelectionGuiml(selection);
}

export function serializeAXQueryMatches(
  roots: AXQueryRoot[],
  query: string,
  cardinality: QueryCardinality,
): AXQuerySerializedMatch[] {
  const selection = selectAXQueryMatches(roots, query, cardinality);
  return serializeAXSelectionMatches(selection);
}

export function filterAXForestWithCardinality(
  roots: AXQueryRoot[],
  query: string,
  cardinality: QueryCardinality,
) {
  const queries = parseQuery(query);
  const plainRoots = roots.map(({ pid, tree }) => buildAXPlainRoot(pid, tree));
  return filterForestWithCardinality(plainRoots, queries, cardinality);
}
