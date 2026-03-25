/**
 * Generalized CRDT Layout Schema
 *
 * 21 node types: 7 layout + 14 semantic.
 * Layout = generic containers (VStack, HStack, Split, etc.)
 * Leaves = semantic types (Tab, Button, ListItem, etc.)
 *
 * Y.Map structure:
 *   type: string       — node type
 *   id: string         — unique id
 *   children: Y.Array  — child Y.Maps
 *   ...attributes      — type-specific attrs
 */
import * as Y from "yjs";

// ── Type definitions ──

export type LayoutType =
  | "Window"
  | "VStack"
  | "HStack"
  | "Split"
  | "Scroll"
  | "TabView"
  | "Spacer";

export type SemanticType =
  | "Titlebar"
  | "Toolbar"
  | "StatusBar"
  | "Tab"
  | "Button"
  | "Icon"
  | "Text"
  | "Heading"
  | "TextField"
  | "TextArea"
  | "Toggle"
  | "ListItem"
  | "SectionHeader"
  | "TreeItem"
  | "Separator"
  | "Image";

export type NodeType = LayoutType | SemanticType;

// Display + system-level types
export type SystemType = "Display" | "Application";

export const ALL_TYPES = new Set<string>([
  // Layout
  "Window", "VStack", "HStack", "Split", "Scroll", "TabView", "Spacer",
  // Semantic
  "Titlebar", "Toolbar", "StatusBar", "Tab", "Button", "Icon", "Text",
  "Heading", "TextField", "TextArea", "Toggle", "ListItem", "SectionHeader",
  "TreeItem", "Separator", "Image",
  // Display + system-level
  "Display", "Application",
]);

// ── Attribute interfaces ──

export interface WindowAttrs {
  doc?: string;
  cgWindowId?: number;
  bundleId?: string;
  pid?: number;
  title?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  z?: number;
  focused?: boolean | string;
  foreground?: boolean | string;
}

export interface StackAttrs {
  gap?: number;
}

export interface SplitAttrs {
  direction: "h" | "v";
  sizes?: (number | null)[];
}

export interface ScrollAttrs {
  axis?: "v" | "h" | "both";
}

export interface TabViewAttrs {
  activeTab?: string;
}

export interface TitlebarAttrs {
  title?: string;
  searchField?: boolean;
}

export interface TabAttrs {
  label: string;
  icon?: string;
  active?: boolean;
}

export interface ButtonAttrs {
  label?: string;
  icon?: string;
  disabled?: boolean;
}

export interface IconAttrs {
  name: string;
  size?: number;
}

export interface TextAttrs {
  value: string;
}

export interface HeadingAttrs {
  value: string;
  level?: number;
}

export interface TextFieldAttrs {
  value?: string;
  placeholder?: string;
}

export interface TextAreaAttrs {
  value?: string;
  language?: string;
}

export interface ToggleAttrs {
  label?: string;
  checked: boolean;
}

export interface ListItemAttrs {
  label: string;
  icon?: string;
  selected?: boolean;
  detail?: string;
  chevron?: boolean;
}

export interface SectionHeaderAttrs {
  label: string;
}

export interface TreeItemAttrs {
  label: string;
  icon?: string;
  expanded?: boolean;
  depth?: number;
  selected?: boolean;
}

export interface SeparatorAttrs {
  direction?: "h" | "v";
}

// ── Builder helpers ──

/** Generic node descriptor for building trees */
export interface NodeDescriptor {
  type: string;
  id?: string;
  attrs?: Record<string, unknown>;
  children?: NodeDescriptor[];
}

let _typeCounters = new Map<string, number>();

/** Create a node descriptor.
 *  IDs are stable per-type: adding/removing a ListItem won't shift Scroll IDs.
 *  Named nodes: Type:name:typeIdx, unnamed: Type-typeIdx. */
export function n(
  type: string,
  attrsOrChildren?: Record<string, unknown> | NodeDescriptor[],
  children?: NodeDescriptor[]
): NodeDescriptor {
  const typeIdx = _typeCounters.get(type) ?? 0;
  _typeCounters.set(type, typeIdx + 1);
  const attrs = Array.isArray(attrsOrChildren) ? undefined : attrsOrChildren;
  const name = attrs?.label ?? attrs?.title;
  const id = (typeof name === "string" && name)
    ? `${type}:${name}:${typeIdx}`
    : `${type}-${typeIdx}`;
  if (Array.isArray(attrsOrChildren)) {
    return { type, id, children: attrsOrChildren };
  }
  return { type, id, attrs: attrs || undefined, children };
}

/** Reset ID counters (call before each tree build for deterministic IDs) */
export function resetIdCounter() {
  _typeCounters = new Map();
}


/** Build a Y.Doc from a node descriptor tree */
export function buildDoc(root: NodeDescriptor): Y.Doc {
  const doc = new Y.Doc();
  const rootMap = doc.getMap("root");
  doc.transact(() => {
    populateFromDescriptor(rootMap, root);
  });
  return doc;
}

/** Deep-equal check for CRDT attr values (primitives, plain objects, arrays) */
function attrEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => attrEqual(v, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    const aRecord = a as Record<string, unknown>;
    const bRecord = b as Record<string, unknown>;
    return ka.every((k) => attrEqual(aRecord[k], bRecord[k]));
  }
  return false;
}

/** Populate a Y.Map from a NodeDescriptor, diffing in-place to minimize CRDT churn.
 *  Matches children by ID and only updates attrs that actually changed. */
export function populateFromDescriptor(ymap: Y.Map<unknown>, desc: NodeDescriptor): void {
  const id = desc.id || desc.type;
  if (ymap.get("type") !== desc.type) ymap.set("type", desc.type);
  if (ymap.get("id") !== id) ymap.set("id", id);
  if (ymap.get("_tag") !== desc.type) ymap.set("_tag", desc.type);

  // Track which attr keys are in the new descriptor
  const newKeys = new Set<string>(["type", "id", "_tag", "_children"]);

  if (desc.attrs) {
    for (const [key, value] of Object.entries(desc.attrs)) {
      if (value === undefined || value === null) continue;
      newKeys.add(key);
      const cur = ymap.get(key);
      if (!attrEqual(cur, value)) {
        ymap.set(key, value);
      }
    }
  }

  // Remove stale attrs (keys present in ymap but not in new descriptor)
  for (const key of ymap.keys()) {
    if (!newKeys.has(key)) {
      ymap.delete(key);
    }
  }

  // --- Children ---
  const descChildren = desc.children && desc.children.length > 0 ? desc.children : null;

  if (!descChildren) {
    if (ymap.has("_children")) ymap.delete("_children");
    return;
  }

  let ychildren = ymap.get("_children") as Y.Array<Y.Map<unknown>> | undefined;

  if (!ychildren) {
    // No existing children — create fresh
    ychildren = new Y.Array<Y.Map<unknown>>();
    ymap.set("_children", ychildren);
    for (const child of descChildren) {
      const childMap = new Y.Map<unknown>();
      ychildren.push([childMap]); // Connect to doc BEFORE populating
      populateFromDescriptor(childMap, child);
    }
    return;
  }

  // Build new ID list
  const newIds = descChildren.map((c) => c.id || c.type);
  const oldLen = ychildren.length;
  const newLen = descChildren.length;

  // Check if IDs match in order (fast path)
  let sameOrder = oldLen === newLen;
  if (sameOrder) {
    for (let i = 0; i < newLen; i++) {
      if ((ychildren.get(i).get("id") as string) !== newIds[i]) {
        sameOrder = false;
        break;
      }
    }
  }

  if (sameOrder) {
    // Same children in same order — just recurse
    for (let i = 0; i < newLen; i++) {
      populateFromDescriptor(ychildren.get(i), descChildren[i]);
    }
    return;
  }

  // IDs changed — rebuild the children array
  ychildren.delete(0, ychildren.length);
  for (const child of descChildren) {
    const childMap = new Y.Map<unknown>();
    ychildren.push([childMap]); // Connect to doc BEFORE populating
    populateFromDescriptor(childMap, child);
  }
}
