import type { PlainNode } from "./types.js";
import { OBSCURED_THRESHOLD } from "./filter.js";
import { collapseBlockedChildren } from "./modal.js";

const BOOLEAN_STATES = ["checked", "selected", "expanded", "focused"] as const;
type BooleanState = typeof BOOLEAN_STATES[number];

interface TruncatedNode extends PlainNode {
  _tag: "_truncated";
  _truncatedLabel?: string;
  _truncatedCount?: number;
}

// Keys that should never appear as attributes
const SKIP_KEYS = new Set([
  "_tag", "_text", "_children", "_displayName", "_frame", "type", "id", "_id",
  "x", "y", "w", "h", "hidden", "visualOnly", "_projectedAttrs",
]);

const DISPLAY_NAMES: Record<string, string> = {
};

function isTruncatedNode(node: PlainNode): node is TruncatedNode {
  return node._tag === "_truncated";
}

/**
 * Serialize a PlainNode tree to GUIML string format.
 */
export function toGUIML(nodes: PlainNode[], indent: number = 0): string {
  return nodes.map(n => nodeToGUIML(n, indent)).join("\n");
}

function nodeToGUIML(node: PlainNode, indent: number): string {
  const pad = "  ".repeat(indent);

  // Truncation marker from bfsFirst or obscured filter
  if (isTruncatedNode(node)) {
    const label = node._truncatedLabel;
    if (label) return `${pad}{... ${label}}`;
    const count = node._truncatedCount ?? 0;
    return `${pad}{... ${count} more}`;
  }

  const tag = DISPLAY_NAMES[node._tag] || node._tag;
  const { idSuffix, attrs } = buildAttrs(node);
  const attrStr = attrs.length > 0 ? " " + attrs.join(" ") : "";

  // Tag with collapsed ID: <MenuBar#0> or <MenuBarItem#Apple:0>
  const openTag = `${tag}${idSuffix}`;

  let children = node._children;

  if (!children || children.length === 0) {
    return `${pad}<${openTag}${attrStr} />`;
  }

  // Background windows: never been focused, show placeholder
  if (node._tag === "Window" && (node.visualOnly === "true" || node.visualOnly === true)) {
    const innerPad = "  ".repeat(indent + 1);
    return `${pad}<${openTag}${attrStr}>\n${innerPad}{... deflated}\n${pad}</${tag}>`;
  }

  // Obscured windows: replace children with truncation marker
  if (node._tag === "Window" && node.obscured) {
    const pct = Number(node.obscured);
    if (pct >= OBSCURED_THRESHOLD) {
      const innerPad = "  ".repeat(indent + 1);
      return `${pad}<${openTag}${attrStr}>\n${innerPad}{... obscured ${pct}%}\n${pad}</${tag}>`;
    }
  }

  // Modal-blocked windows: collapse non-modal siblings into a marker
  if (node._tag === "Window") {
    children = collapseBlockedChildren(node) || children;
  }

  const childStr = children.map(c => nodeToGUIML(c, indent + 1)).join("\n");
  return `${pad}<${openTag}${attrStr}>\n${childStr}\n${pad}</${tag}>`;
}

function buildAttrs(node: PlainNode): { idSuffix: string; attrs: string[] } {
  const attrs: string[] = [];
  let idSuffix = "";

  // #id — collapsed into tag when redundant
  const rawId = (node._id || node.id) as string | undefined;
  if (rawId) {
    const internalTag = node._tag;
    if (DISPLAY_NAMES[internalTag] && rawId.startsWith(internalTag)) {
      idSuffix = "#0";
    } else if (rawId.startsWith(internalTag + ":")) {
      // Tag:Title:Index → #Title (drop index if title present), #Index (if no title)
      const parts = rawId.slice(internalTag.length + 1).split(":");
      const index = parts[parts.length - 1];
      const title = parts.slice(0, -1).join(":");
      idSuffix = title ? `#${title}` : `#${index}`;
    } else if (rawId.startsWith(internalTag + "-")) {
      // Tag-N → #N (e.g. Button-36 → #36)
      idSuffix = `#${rawId.slice(internalTag.length + 1)}`;
    } else if (rawId.startsWith("app:")) {
      // app:com.microsoft.VSCode → #com.microsoft.VSCode
      idSuffix = `#${rawId.slice(4)}`;
    } else {
      idSuffix = `#${rawId}`;
    }
    // If the id is uninformative (numeric or generic slug), try a meaningful attr instead
    const idVal = idSuffix.slice(1);
    const betterName = bestDisplayName(node);
    if (betterName && (!idVal || /^\d+$/.test(idVal) || /^[a-z]+-\d+$/.test(idVal) || /^[a-z]+-[a-z]+-\d+$/.test(idVal))) {
      idSuffix = `#${betterName}`;
    }

    // Quote the id value if it contains non-identifier chars
    const finalVal = idSuffix.slice(1);
    if (finalVal && !/^[A-Za-z0-9_.:-]+$/.test(finalVal)) {
      idSuffix = `#"${finalVal}"`;
    }
  }

  // Emit all meaningful properties from the node
  for (const [key, val] of Object.entries(node)) {
    if (SKIP_KEYS.has(key)) continue;
    if (val === undefined || val === null || val === "") continue;

    // Boolean states
    if (BOOLEAN_STATES.includes(key as BooleanState)) {
      if (val === true || val === "true") attrs.push(key);
      continue;
    }

    // enabled="false" is worth showing, enabled="true" is noise
    if (key === "enabled") {
      if (val === false || val === "false") attrs.push(`enabled="false"`);
      continue;
    }

    // Boolean true on any key = bare attr name (used by [*] introspection)
    if (val === true) {
      attrs.push(key);
      continue;
    }

    if (typeof val === "string" || typeof val === "number") {
      attrs.push(`${key}=${quote(String(val))}`);
    }
  }

  return { idSuffix, attrs };
}

const DISPLAY_NAME_ATTRS = ["title", "label", "name", "value", "identifier", "placeholder"];

// For TextField/TextArea, prefer placeholder over value so names stay stable after editing
const DISPLAY_NAME_ATTRS_INPUT = ["title", "label", "name", "placeholder", "identifier", "value"];

function displayNameAttrs(tag: string): readonly string[] {
  return (tag === "TextField" || tag === "TextArea" || tag === "SearchField") ? DISPLAY_NAME_ATTRS_INPUT : DISPLAY_NAME_ATTRS;
}

function bestDisplayName(node: PlainNode): string | undefined {
  // _displayName is set by projectAttrs to preserve the name even when attrs are stripped
  if (typeof node._displayName === "string") return node._displayName;
  for (const attr of displayNameAttrs(node._tag)) {
    const val = node[attr];
    if (val !== undefined && val !== null && val !== "" && typeof val === "string") {
      // Skip auto-generated AppKit identifiers (e.g. "_NS:9")
      if (attr === "identifier" && val.startsWith("_NS:")) continue;
      return val;
    }
  }
  return undefined;
}

function quote(s: string): string {
  if (/^\(-?\d+(,-?\d+)*\)$/.test(s)) return s;  // tuples are self-delimiting
  if (/^[A-Za-z0-9_.-]+$/.test(s)) return `"${s}"`;
  return `"${s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}"`;
}
