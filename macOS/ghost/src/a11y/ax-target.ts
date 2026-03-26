export interface AXTargetPoint {
  x: number;
  y: number;
}

export interface AXTargetBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type AXQueryCardinality = "first" | "only" | "all" | "each";

export interface AXTargetLike {
  role?: string;
  subrole?: string;
  title?: string;
  label?: string;
  identifier?: string;
  frame?: AXTargetBounds;
}

export interface AXTarget {
  type: "ax.target";
  pid: number;
  point: AXTargetPoint;
  role: string;
  bounds?: AXTargetBounds;
  subrole?: string;
  title?: string | null;
  label?: string | null;
  identifier?: string | null;
}

export interface AXSelectionRange {
  location: number;
  length: number;
}

export interface AXCursor {
  type: "ax.cursor";
  target: AXTarget;
  selection?: AXSelectionRange;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function coerceBounds(value: unknown): AXTargetBounds | undefined {
  if (!value || typeof value !== "object") return undefined;
  const bounds = value as Record<string, unknown>;
  if (!finiteNumber(bounds.x) || !finiteNumber(bounds.y) || !finiteNumber(bounds.width) || !finiteNumber(bounds.height)) {
    return undefined;
  }
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  };
}

export function axTargetFromPoint(
  pid: number,
  point: AXTargetPoint,
  options: {
    role?: string;
    subrole?: string;
    title?: string | null;
    label?: string | null;
    identifier?: string | null;
  } = {},
): AXTarget {
  if (!Number.isFinite(pid) || pid <= 0) {
    throw new Error(`Cannot build AXTarget: invalid pid ${pid}`);
  }
  if (!finiteNumber(point.x) || !finiteNumber(point.y)) {
    throw new Error("Cannot build AXTarget: point must contain finite x/y coordinates");
  }
  const role = options.role ?? "CGCursor";
  if (role.length === 0) {
    throw new Error("Cannot build AXTarget: matched target has no role");
  }
  return {
    type: "ax.target",
    pid,
    point: {
      x: point.x,
      y: point.y,
    },
    role,
    ...(options.subrole ? { subrole: options.subrole } : {}),
    title: options.title ?? null,
    label: options.label ?? null,
    identifier: options.identifier ?? null,
  };
}

export function axTargetFromNode(pid: number, node: AXTargetLike): AXTarget {
  if (!Number.isFinite(pid) || pid <= 0) {
    throw new Error(`Cannot build AXTarget: invalid pid ${pid}`);
  }
  const bounds = coerceBounds(node.frame);
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
    throw new Error(`Cannot build AXTarget: ${node.role || "AX element"} has no usable frame`);
  }
  if (!node.role) {
    throw new Error("Cannot build AXTarget: matched AX element has no role");
  }
  return {
    type: "ax.target",
    pid,
    point: {
      x: Math.round(bounds.x + bounds.width / 2),
      y: Math.round(bounds.y + bounds.height / 2),
    },
    bounds,
    role: node.role,
    ...(node.subrole ? { subrole: node.subrole } : {}),
    title: node.title ?? null,
    label: node.label ?? null,
    identifier: node.identifier ?? null,
  };
}

export function selectAXQueryMatches<T>(matches: T[], cardinality: AXQueryCardinality): T[] {
  switch (cardinality) {
    case "first":
      return matches.length > 0 ? [matches[0]] : [];
    case "only":
      if (matches.length !== 1) {
        throw new Error(`Expected exactly one AX match, got ${matches.length}`);
      }
      return matches;
    case "all":
    case "each":
      return matches;
  }
}

export function isAXTarget(value: unknown): value is AXTarget {
  if (!value || typeof value !== "object") return false;
  const target = value as Record<string, unknown>;
  const point = target.point as Record<string, unknown> | undefined;
  if (target.type !== "ax.target") return false;
  if (!finiteNumber(target.pid) || target.pid <= 0) return false;
  if (typeof target.role !== "string" || target.role.length === 0) return false;
  if (!point || !finiteNumber(point.x) || !finiteNumber(point.y)) return false;
  if (target.bounds !== undefined && !coerceBounds(target.bounds)) return false;
  if (target.subrole !== undefined && typeof target.subrole !== "string") return false;
  if (target.title !== undefined && target.title !== null && typeof target.title !== "string") return false;
  if (target.label !== undefined && target.label !== null && typeof target.label !== "string") return false;
  if (target.identifier !== undefined && target.identifier !== null && typeof target.identifier !== "string") return false;
  return true;
}

function isAXSelectionRange(value: unknown): value is AXSelectionRange {
  if (!value || typeof value !== "object") return false;
  const range = value as Record<string, unknown>;
  return finiteNumber(range.location) && range.location >= 0 && finiteNumber(range.length) && range.length >= 0;
}

export function isAXCursor(value: unknown): value is AXCursor {
  if (!value || typeof value !== "object") return false;
  const cursor = value as Record<string, unknown>;
  if (cursor.type !== "ax.cursor") return false;
  if (!isAXTarget(cursor.target)) return false;
  if (cursor.selection !== undefined && !isAXSelectionRange(cursor.selection)) return false;
  return true;
}

export function assertAXTarget(value: unknown, label = "AXTarget"): AXTarget {
  if (!isAXTarget(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

export function assertAXCursor(value: unknown, label = "AXCursor"): AXCursor {
  if (!isAXCursor(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}
