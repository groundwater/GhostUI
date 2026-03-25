import type { VatNode } from "./types.js";

export interface VatPathSegment {
  tag: string;
  occurrence: number;
}

const PATH_SEGMENT_RE = /^(.+?)(?:\[(\d+)])?$/;

function parseVatPathSegment(segment: string): VatPathSegment {
  const match = segment.match(PATH_SEGMENT_RE);
  if (!match) {
    return { tag: segment, occurrence: 0 };
  }

  return {
    tag: match[1],
    occurrence: match[2] ? Number(match[2]) : 0,
  };
}

export function vatPathSegments(path: string): VatPathSegment[] {
  return path.split("/").filter(Boolean).map(parseVatPathSegment);
}

function cloneVatNode(node: VatNode): VatNode {
  const cloned: VatNode = { _tag: node._tag };
  for (const [key, value] of Object.entries(node)) {
    if (key === "_tag") continue;
    if (key === "_children" && Array.isArray(value)) {
      cloned._children = value.map((child) => cloneVatNode(child as VatNode));
      continue;
    }
    if (value !== undefined) {
      cloned[key] = value;
    }
  }
  return cloned;
}

function cloneVatChildren(children: VatNode[]): VatNode[] {
  return children.map((child) => cloneVatNode(child));
}

function findChildIndex(children: VatNode[], tag: string, occurrence = 0): number {
  let seen = 0;
  for (let i = 0; i < children.length; i++) {
    if (children[i]._tag !== tag) continue;
    if (seen === occurrence) return i;
    seen++;
  }
  return -1;
}

function buildVatPathTree(pathSegments: VatPathSegment[], children: VatNode[]): VatNode {
  if (pathSegments.length === 0) {
    if (children.length === 0) {
      return {
        _tag: "VATRoot",
        _children: [],
      };
    }
    if (children.length === 1) {
      return cloneVatNode(children[0]);
    }
    return {
      _tag: "VATRoot",
      _children: cloneVatChildren(children),
    };
  }

  let node: VatNode = {
    _tag: pathSegments[pathSegments.length - 1].tag,
    _children: cloneVatChildren(children),
  };
  for (let i = pathSegments.length - 2; i >= 0; i--) {
    node = {
      _tag: pathSegments[i].tag,
      _children: [node],
    };
  }

  return cloneVatNode(node);
}

function extractOverlayLeafChildren(overlay: VatNode, pathSegments: VatPathSegment[]): VatNode[] {
  if (pathSegments.length === 0) {
    return cloneVatChildren(overlay._children ?? []);
  }

  let current = overlay;
  if (current._tag !== pathSegments[0].tag) {
    return cloneVatChildren(current._children ?? []);
  }

  for (let i = 1; i < pathSegments.length; i++) {
    const segment = pathSegments[i];
    const children: VatNode[] = current._children ?? [];
    const index = findChildIndex(children, segment.tag, segment.occurrence);
    if (index < 0) {
      return cloneVatChildren(current._children ?? []);
    }
    current = children[index];
  }

  return cloneVatChildren(current._children ?? []);
}

export function wrapVatMountPath(path: string, children: VatNode[]): VatNode {
  const segments = vatPathSegments(path);
  if (segments.length === 0) {
    if (children.length === 0) {
      return {
        _tag: "VATRoot",
        _children: [],
      };
    }
    if (children.length === 1) {
      return cloneVatNode(children[0]);
    }
    return {
      _tag: "VATRoot",
      _children: cloneVatChildren(children),
    };
  }

  return buildVatPathTree(segments, children);
}

export function composeVatMountForest(mounts: Array<{ path: string; tree: VatNode }>): VatNode {
  const sortedMounts = [...mounts].sort((a, b) => {
    const aSegments = vatPathSegments(a.path).length;
    const bSegments = vatPathSegments(b.path).length;
    return aSegments - bSegments || a.path.localeCompare(b.path);
  });

  const rootMount = sortedMounts.find((mount) => vatPathSegments(mount.path).length === 0);
  const childMounts = rootMount ? sortedMounts.filter((mount) => mount !== rootMount) : sortedMounts;
  let root = rootMount ? cloneVatNode(rootMount.tree) : { _tag: "VATRoot", _children: [] as VatNode[] };
  for (const mount of childMounts) {
    root = insertVatNodeAtPath(root, mount.tree, vatPathSegments(mount.path));
  }

  return root;
}

export function insertVatNodeAtPath(
  root: VatNode,
  overlay: VatNode,
  pathSegments: VatPathSegment[],
  mountPathSegments: VatPathSegment[] = pathSegments,
): VatNode {
  if (pathSegments.length === 0) {
    return cloneVatNode(overlay);
  }

  const [segment, ...rest] = pathSegments;
  const children = root._children ?? [];
  const index = findChildIndex(children, segment.tag, segment.occurrence);
  if (index < 0) {
    const nextChildren = [...children, buildVatPathTree(pathSegments, extractOverlayLeafChildren(overlay, mountPathSegments))];
    return {
      ...root,
      _children: nextChildren,
    };
  }

  const nextChildren = [...children];
  if (rest.length === 0) {
    nextChildren[index] = {
      ...cloneVatNode(nextChildren[index]),
      _children: extractOverlayLeafChildren(overlay, mountPathSegments),
    };
    return {
      ...root,
      _children: nextChildren,
    };
  }

  nextChildren[index] = insertVatNodeAtPath(nextChildren[index], overlay, rest, mountPathSegments);
  return {
    ...root,
    _children: nextChildren,
  };
}

export function findVatNodeByPath(root: VatNode, pathSegments: VatPathSegment[]): VatNode | undefined {
  let current: VatNode | undefined = root;
  for (const segment of pathSegments) {
    const children: VatNode[] = current._children ?? [];
    const index = findChildIndex(children, segment.tag, segment.occurrence);
    current = index >= 0 ? children[index] : undefined;
    if (!current) return undefined;
  }
  return current;
}
