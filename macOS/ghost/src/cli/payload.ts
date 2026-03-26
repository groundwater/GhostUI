import {
  assertAXCursor,
  assertAXTarget,
  isAXCursor,
  isAXTarget,
  type AXCursor,
  type AXTarget,
} from "../a11y/ax-target.js";
import type { AXQuerySerializedMatch } from "../a11y/ax-query.js";
import type { VatA11YQueryPlan, VatA11YQueryScope } from "../vat/types.js";
import type { PlainNode } from "./types.js";

export interface CLICompositionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CLICompositionPoint {
  x: number;
  y: number;
}

export interface CLICompositionPayload {
  type: "gui.payload";
  version: 1;
  source: string;
  query: string | null;
  tree: PlainNode | null;
  nodes: PlainNode[] | null;
  matchCount: number | null;
  node: PlainNode | null;
  target: AXTarget | null;
  cursor: AXCursor | null;
  axQueryMatch: AXQuerySerializedMatch | null;
  vatQueryPlan: VatA11YQueryPlan | null;
  bounds: CLICompositionRect | null;
  point: CLICompositionPoint | null;
  issues: string[];
}

type JSONRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JSONRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPlainNodeLike(value: unknown): value is PlainNode {
  return isRecord(value) && typeof value._tag === "string";
}

function normalizeFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function normalizeRect(value: unknown): CLICompositionRect | null {
  if (typeof value === "string") {
    const match = value.trim().match(/^\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)$/);
    if (!match) return null;
    return {
      x: Number(match[1]),
      y: Number(match[2]),
      width: Number(match[3]),
      height: Number(match[4]),
    };
  }
  if (!isRecord(value)) {
    return null;
  }
  const x = normalizeFiniteNumber(value.x);
  const y = normalizeFiniteNumber(value.y);
  const width = normalizeFiniteNumber(value.width);
  const height = normalizeFiniteNumber(value.height);
  if (x === null || y === null || width === null || height === null) {
    return null;
  }
  return { x, y, width, height };
}

function normalizePoint(value: unknown): CLICompositionPoint | null {
  if (!isRecord(value)) {
    return null;
  }
  const x = normalizeFiniteNumber(value.x);
  const y = normalizeFiniteNumber(value.y);
  if (x === null || y === null) {
    return null;
  }
  return { x, y };
}

function isVatA11YQueryScope(value: unknown): value is VatA11YQueryScope {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "all":
    case "focused":
      return true;
    case "pid":
      return Number.isInteger(value.pid) && Number(value.pid) > 0;
    case "app":
      return typeof value.app === "string" && value.app.trim().length > 0;
    default:
      return false;
  }
}

function isVatA11YQueryPlan(value: unknown): value is VatA11YQueryPlan {
  if (!isRecord(value)) return false;
  if (value.type !== "vat.a11y-query-plan") return false;
  if (typeof value.query !== "string" || value.query.trim().length === 0) return false;
  if (value.cardinality !== "first" && value.cardinality !== "only" && value.cardinality !== "all" && value.cardinality !== "each") {
    return false;
  }
  if (!isVatA11YQueryScope(value.scope)) return false;
  if (value.target !== undefined && !isAXTarget(value.target)) return false;
  return true;
}

function assertVatA11YQueryPlan(value: unknown, label: string): VatA11YQueryPlan {
  if (!isVatA11YQueryPlan(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function assertSupportedPayloadVersion(value: unknown, label: string): void {
  if (value !== 1) {
    throw new Error(`Invalid ${label}.version: expected 1, received ${String(value)}`);
  }
}

function centerPoint(bounds: CLICompositionRect): CLICompositionPoint {
  return {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
}

function describeSource(payload: CLICompositionPayload): string {
  return payload.source || "unknown source";
}

function describeTarget(target: AXTarget): string {
  const label = target.title || target.label || target.identifier;
  return `${target.role}${label ? ` "${label}"` : ""}`;
}

function describeNode(node: PlainNode): string {
  const record = node as PlainNode & Record<string, unknown>;
  const label = typeof record.title === "string"
    ? record.title
    : typeof record.label === "string"
      ? record.label
      : typeof record._displayName === "string"
        ? record._displayName
        : typeof record._label === "string"
          ? record._label
        : typeof record._id === "string"
          ? record._id
          : typeof record._text === "string"
            ? record._text
            : undefined;
  return `${node._tag}${label ? ` "${label}"` : ""}`;
}

function boundsFromPlainNode(node: PlainNode | null | undefined): CLICompositionRect | null {
  if (!node) return null;
  const record = node as PlainNode & Record<string, unknown>;
  const frame = normalizeRect(record.frame) ?? normalizeRect(record._frame);
  if (frame) return frame;
  const x = normalizeFiniteNumber(record.x ?? record._x);
  const y = normalizeFiniteNumber(record.y ?? record._y);
  const width = normalizeFiniteNumber(record.width ?? record._width);
  const height = normalizeFiniteNumber(record.height ?? record._height);
  if (x === null || y === null || width === null || height === null) {
    return null;
  }
  return { x, y, width, height };
}

function findPrimaryVatNode(root: PlainNode | null | undefined): PlainNode | null {
  if (!root) return null;
  function walk(node: PlainNode): { boundsNode: PlainNode | null; fallbackNode: PlainNode | null } {
    let fallbackNode: PlainNode | null = null;

    for (const child of node._children ?? []) {
      const childResult = walk(child);
      if (childResult.boundsNode) {
        return childResult;
      }
      fallbackNode ??= childResult.fallbackNode;
    }

    if (node._tag !== "VATRoot") {
      if (boundsFromPlainNode(node)) {
        return { boundsNode: node, fallbackNode: fallbackNode ?? node };
      }
      const record = node as PlainNode & Record<string, unknown>;
      if (
        fallbackNode == null
        && (
          typeof record.title === "string"
          || typeof record.label === "string"
          || typeof record._displayName === "string"
          || typeof record._label === "string"
          || typeof record._id === "string"
          || typeof record._text === "string"
          || typeof record.bundleId === "string"
          || typeof record.identifier === "string"
        )
      ) {
        fallbackNode = node;
      }
      fallbackNode ??= node;
    }

    return { boundsNode: null, fallbackNode };
  }

  const result = walk(root);
  return result.boundsNode ?? result.fallbackNode;
}

export function isAXQueryMatch(value: unknown): value is AXQuerySerializedMatch {
  if (!isRecord(value)) return false;
  if (value.type !== "ax.query-match") return false;
  if (typeof value.pid !== "number" || !Number.isFinite(value.pid) || value.pid <= 0) return false;
  if (!isPlainNodeLike(value.node)) return false;
  if (value.target !== undefined && !isAXTarget(value.target)) return false;
  if (value.targetError !== undefined && typeof value.targetError !== "string") return false;
  return true;
}

export function assertAXQueryMatch(value: unknown, label = "AXQueryMatch"): AXQuerySerializedMatch {
  if (!isAXQueryMatch(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

export function buildCLICompositionPayloadFromAXTarget(
  target: AXTarget,
  source = "ax.target",
): CLICompositionPayload {
  return {
    type: "gui.payload",
    version: 1,
    source,
    query: null,
    tree: null,
    nodes: null,
    matchCount: null,
    node: null,
    target,
    cursor: null,
    axQueryMatch: null,
    vatQueryPlan: null,
    bounds: target.bounds ?? null,
    point: target.point,
    issues: [],
  };
}

export function buildCLICompositionPayloadFromAXCursor(
  cursor: AXCursor,
  source = "ax.cursor",
): CLICompositionPayload {
  return {
    ...buildCLICompositionPayloadFromAXTarget(cursor.target, source),
    cursor,
  };
}

export function buildCLICompositionPayloadFromAXQueryMatch(
  match: AXQuerySerializedMatch,
  source = "ax.query-match",
  vatQueryPlan: VatA11YQueryPlan | null = null,
): CLICompositionPayload {
  const target = match.target ? assertAXTarget(match.target, `${source}.target`) : null;
  return {
    type: "gui.payload",
    version: 1,
    source,
    query: null,
    tree: null,
    nodes: [match.node],
    matchCount: 1,
    node: match.node,
    target,
    cursor: null,
    axQueryMatch: match,
    vatQueryPlan,
    bounds: target?.bounds ?? boundsFromPlainNode(match.node),
    point: target?.point ?? (target?.bounds ? centerPoint(target.bounds) : null),
    issues: match.targetError ? [match.targetError] : [],
  };
}

export function buildCLICompositionPayloadFromVatQueryResult(
  query: string,
  tree: PlainNode,
  nodes: PlainNode[],
  matchCount: number,
): CLICompositionPayload {
  const node = nodes.length === 1 ? findPrimaryVatNode(nodes[0]) : null;
  const bounds = boundsFromPlainNode(node);
  return {
    type: "gui.payload",
    version: 1,
    source: "vat.query",
    query,
    tree,
    nodes,
    matchCount,
    node,
    target: null,
    cursor: null,
    axQueryMatch: null,
    vatQueryPlan: null,
    bounds,
    point: bounds ? centerPoint(bounds) : null,
    issues: [],
  };
}

export function normalizeCLICompositionPayload(value: unknown, label = "payload"): CLICompositionPayload {
  const rawVatQueryPlan = isRecord(value) && value.vatQueryPlan != null
    ? assertVatA11YQueryPlan(value.vatQueryPlan, `${label}.vatQueryPlan`)
    : null;
  if (isAXCursor(value)) {
    return buildCLICompositionPayloadFromAXCursor(assertAXCursor(value, label), "ax.cursor");
  }
  if (isAXTarget(value)) {
    return buildCLICompositionPayloadFromAXTarget(assertAXTarget(value, label), "ax.target");
  }
  if (isAXQueryMatch(value)) {
    return buildCLICompositionPayloadFromAXQueryMatch(assertAXQueryMatch(value, label), "ax.query-match", rawVatQueryPlan);
  }
  if (!isRecord(value)) {
    throw new Error(`Invalid ${label}`);
  }
  if (value.type !== "gui.payload") {
    throw new Error(`Invalid ${label}`);
  }
  assertSupportedPayloadVersion(value.version, label);

  const source = typeof value.source === "string" && value.source.trim().length > 0
    ? value.source
    : "unknown";
  const cursor = value.cursor == null ? null : assertAXCursor(value.cursor, `${label}.cursor`);
  const axQueryMatch = value.axQueryMatch == null ? null : assertAXQueryMatch(value.axQueryMatch, `${label}.axQueryMatch`);
  const vatQueryPlan = value.vatQueryPlan == null ? rawVatQueryPlan : assertVatA11YQueryPlan(value.vatQueryPlan, `${label}.vatQueryPlan`);
  const target = value.target == null
    ? cursor?.target ?? (axQueryMatch?.target ? assertAXTarget(axQueryMatch.target, `${label}.axQueryMatch.target`) : null)
    : assertAXTarget(value.target, `${label}.target`);
  const nodes = value.nodes == null
    ? null
    : assertPlainNodeArray(value.nodes, `${label}.nodes`);
  const node = value.node == null
    ? (
      axQueryMatch?.node
      ?? (source === "vat.query" && nodes?.length === 1 ? findPrimaryVatNode(nodes[0]) : null)
      ?? (nodes?.length === 1 ? nodes[0] : null)
    )
    : assertPlainNode(value.node, `${label}.node`);
  const normalizedNodes = nodes ?? (node ? [node] : null);
  const tree = value.tree == null ? null : assertPlainNode(value.tree, `${label}.tree`);
  const bounds = normalizeRect(value.bounds)
    ?? normalizeRect(value.frame)
    ?? target?.bounds
    ?? boundsFromPlainNode(node)
    ?? (normalizedNodes?.length === 1 ? boundsFromPlainNode(normalizedNodes[0]) : null);
  const point = normalizePoint(value.point)
    ?? target?.point
    ?? (bounds ? centerPoint(bounds) : null);
  const matchCount = typeof value.matchCount === "number" && Number.isFinite(value.matchCount)
    ? value.matchCount
    : normalizedNodes?.length ?? null;
  const query = typeof value.query === "string" ? value.query : null;
  const issues = Array.isArray(value.issues)
    ? value.issues.filter((item): item is string => typeof item === "string")
    : [];

  return {
    type: "gui.payload",
    version: 1,
    source,
    query,
    tree,
    nodes: normalizedNodes,
    matchCount,
    node,
    target,
    cursor,
    axQueryMatch,
    vatQueryPlan,
    bounds,
    point,
    issues,
  };
}

function assertPlainNode(value: unknown, label: string): PlainNode {
  if (!isPlainNodeLike(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function assertPlainNodeArray(value: unknown, label: string): PlainNode[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value.map((item, index) => assertPlainNode(item, `${label}[${index}]`));
}

function parseJSONLine(line: string, label: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    throw new Error(`${label} expected JSON`);
  }
}

function stripLeadingTerminalNoise(text: string): string {
  let result = text;
  // Drop ANSI/OSC-style escape sequences that may be emitted by terminal wrappers.
  result = result.replace(/^(?:\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b\[[0-?]*[ -/]*[@-~])+/u, "");
  // Drop leading C0 control chars except JSON-significant whitespace.
  result = result.replace(/^[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/u, "");
  return result;
}

export function parseCLICompositionPayloadStream(text: string, streamLabel = "stdin"): CLICompositionPayload[] {
  const trimmed = stripLeadingTerminalNoise(text).trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.map((item, index) => normalizeCLICompositionPayload(item, `${streamLabel} payload[${index}]`));
    }
    return [normalizeCLICompositionPayload(parsed, `${streamLabel} payload`)];
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Invalid ")) {
      throw error;
    }
    return trimmed
      .split(/\r?\n/)
      .map(line => stripLeadingTerminalNoise(line).trim())
      .filter(Boolean)
      .map((line, index) => normalizeCLICompositionPayload(parseJSONLine(line, `${streamLabel} line ${index + 1}`), `${streamLabel} line ${index + 1}`));
  }
}

export function parseSingleCLICompositionPayload(text: string, label = "payload"): CLICompositionPayload {
  const payloads = parseCLICompositionPayloadStream(text, label);
  if (payloads.length === 0) {
    throw new Error(`${label} expected a JSON CLI composition payload`);
  }
  if (payloads.length > 1) {
    throw new Error(`${label} expected exactly one JSON CLI composition payload, received ${payloads.length}`);
  }
  return payloads[0];
}

function stripLeadingJSONNoise(text: string): string {
  return stripLeadingTerminalNoise(text).replace(/^[\s\uFEFF]+/u, "");
}

function findCompleteJSONObjectOrArrayEnd(text: string): number | null {
  const input = stripLeadingJSONNoise(text);
  if (!input) {
    return null;
  }

  const open = input[0];
  if (open !== "{" && open !== "[") {
    return null;
  }

  const stack: Array<"}" | "]"> = [open === "{" ? "}" : "]"];
  let inString = false;
  let escaped = false;

  for (let index = 1; index < input.length; index++) {
    const char = input[index]!;
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      stack.push("}");
      continue;
    }
    if (char === "[") {
      stack.push("]");
      continue;
    }
    if (char === "}" || char === "]") {
      const expected = stack.pop();
      if (expected !== char) {
        throw new Error("invalid JSON frame");
      }
      if (stack.length === 0) {
        return index + 1;
      }
      continue;
    }
  }

  return null;
}

export async function readFirstJSONFrame(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let closed = false;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        closed = true;
        return stripLeadingJSONNoise(buffer).trim();
      }

      buffer += decoder.decode(value, { stream: true });
      const end = findCompleteJSONObjectOrArrayEnd(buffer);
      if (end !== null) {
        return stripLeadingJSONNoise(buffer).slice(0, end).trim();
      }
    }
  } finally {
    if (!closed) {
      try {
        await reader.cancel();
      } catch {}
    }
    try {
      reader.releaseLock();
    } catch {}
  }
}

export function requireCLICompositionTarget(payload: CLICompositionPayload, label: string): AXTarget {
  if (payload.target) {
    return payload.target;
  }
  const issue = payload.issues[0];
  if (issue) {
    throw new Error(`${label} payload from ${describeSource(payload)} has no AX target: ${issue}`);
  }
  throw new Error(`${label} payload from ${describeSource(payload)} has no AX target`);
}

export function requireCLICompositionBounds(
  payload: CLICompositionPayload,
  label: string,
): CLICompositionRect {
  if (payload.bounds && payload.bounds.width > 0 && payload.bounds.height > 0) {
    return payload.bounds;
  }
  if (payload.target) {
    throw new Error(`${label} ${describeTarget(payload.target)} is missing bounds/frame coordinates`);
  }
  if (payload.node) {
    throw new Error(`${label} ${describeNode(payload.node)} is missing bounds/frame coordinates`);
  }
  throw new Error(`${label} payload from ${describeSource(payload)} is missing bounds/frame coordinates`);
}

export function serializeCLICompositionPayload(
  payload: CLICompositionPayload,
  tty = process.stdout.isTTY,
): string {
  return JSON.stringify(payload, null, tty ? 2 : 0);
}
