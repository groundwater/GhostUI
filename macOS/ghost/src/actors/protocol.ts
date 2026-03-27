import { normalizeCssColorString } from "../overlay/draw.js";
import type { DrawMarkerShape } from "../overlay/draw.js";
import { parseCLICompositionPayloadStream, requireCLICompositionBounds } from "../cli/payload.js";

export const ACTOR_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type ActorType = "pointer" | "canvas" | "spotlight";
export type PointerMoveStyle = "purposeful" | "fast" | "slow" | "wandering";
export type PointerButton = "left" | "right" | "middle";
export type CanvasDrawShape = DrawMarkerShape;
export type SpotlightShape = "rect" | "circ";
export type SpotlightTransition = "fade" | "instant";
export interface CanvasBox {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface CanvasDrawStyle {
  color: string;
  size: number;
  padding: number;
}
export interface CanvasTextStyle {
  font: string;
  size: number;
  color: string;
  highlight?: string;
}
export const ACTOR_CLICK_VISUAL_DURATION_MS = 260;
export const ACTOR_CLICK_PASSTHROUGH_DELAY_MS = Math.round(ACTOR_CLICK_VISUAL_DURATION_MS / 2);
export type ActorErrorCode =
  | "actor_exists"
  | "unknown_type"
  | "unknown_action"
  | "invalid_args"
  | "actor_not_found"
  | "timeout"
  | "run_preempted"
  | "run_canceled";

export interface ActorSpawnRequest {
  type: ActorType;
  name: string;
  durationScale: number;
  idleMs?: number;
}

export interface ActorListEntry {
  name: string;
  type: ActorType;
}

export type ActorAction =
  | { kind: "move"; to: { x: number; y: number }; style: PointerMoveStyle }
  | { kind: "click"; button: PointerButton; at?: { x: number; y: number } }
  | { kind: "drag"; to: { x: number; y: number } }
  | { kind: "scroll"; dx: number; dy: number }
  | { kind: "think"; forMs: number }
  | { kind: "narrate"; text: string }
  | { kind: "encircle"; center: { x: number; y: number }; radius: number; loops: number; speed: number }
  | { kind: "dismiss" }
  | { kind: "draw"; shape: CanvasDrawShape; style: CanvasDrawStyle; box?: CanvasBox; boxes?: CanvasBox[] }
  | { kind: "text"; text: string; style: CanvasTextStyle; box?: CanvasBox }
  | { kind: "rect"; rects: CanvasBox[]; padding: number; blur: number; speed?: number }
  | { kind: "circ"; rects: CanvasBox[]; padding: number; blur: number; speed?: number }
  | { kind: "on"; transition: SpotlightTransition }
  | { kind: "off"; transition: SpotlightTransition }
  | { kind: "color"; color: string }
  | { kind: "clear" };

export interface ActorRunRequest {
  action: ActorAction;
  timeoutMs?: number;
}

export class ActorApiError extends Error {
  readonly code: ActorErrorCode;
  readonly status: number;

  constructor(code: ActorErrorCode, message: string, status = actorErrorStatus(code)) {
    super(message);
    this.name = "ActorApiError";
    this.code = code;
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ActorApiError("invalid_args", `${label} must be an object`);
  }
  return value;
}

function expectFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ActorApiError("invalid_args", `${label} must be a finite number`);
  }
  return value;
}

function expectPositiveNumber(value: unknown, label: string): number {
  const parsed = expectFiniteNumber(value, label);
  if (parsed <= 0) {
    throw new ActorApiError("invalid_args", `${label} must be greater than 0`);
  }
  return parsed;
}

function expectPositiveInteger(value: unknown, label: string): number {
  const parsed = expectPositiveNumber(value, label);
  if (!Number.isInteger(parsed)) {
    throw new ActorApiError("invalid_args", `${label} must be a positive integer`);
  }
  return parsed;
}

function expectNonNegativeNumber(value: unknown, label: string): number {
  const parsed = expectFiniteNumber(value, label);
  if (parsed < 0) {
    throw new ActorApiError("invalid_args", `${label} must be greater than or equal to 0`);
  }
  return parsed;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ActorApiError("invalid_args", `${label} must be a non-empty string`);
  }
  return value;
}

function expectActorName(name: unknown, label = "name"): string {
  const parsed = expectString(name, label);
  if (!ACTOR_NAME_RE.test(parsed)) {
    throw new ActorApiError("invalid_args", `${label} must match ${ACTOR_NAME_RE.source}`);
  }
  return parsed;
}

function expectActorType(type: unknown): ActorType {
  if (type !== "pointer" && type !== "canvas" && type !== "spotlight") {
    throw new ActorApiError("unknown_type", `Unknown actor type: ${String(type || "")}`);
  }
  return type;
}

function normalizePoint(value: unknown, label: string): { x: number; y: number } {
  const record = expectRecord(value, label);
  return {
    x: expectFiniteNumber(record.x, `${label}.x`),
    y: expectFiniteNumber(record.y, `${label}.y`),
  };
}

function normalizeCanvasBox(value: unknown, label: string): CanvasBox {
  const record = expectRecord(value, label);
  const width = expectPositiveNumber(record.width, `${label}.width`);
  const height = expectPositiveNumber(record.height, `${label}.height`);
  return {
    x: expectFiniteNumber(record.x, `${label}.x`),
    y: expectFiniteNumber(record.y, `${label}.y`),
    width,
    height,
  };
}

function expectCanvasDrawShape(value: unknown, label: string): CanvasDrawShape {
  if (typeof value !== "string") {
    throw new ActorApiError("invalid_args", `${label} must be one of rect, circ, check, cross, underline`);
  }
  const shape = value.trim();
  if (shape !== "rect" && shape !== "circ" && shape !== "check" && shape !== "cross" && shape !== "underline") {
    throw new ActorApiError("invalid_args", `${label} must be one of rect, circ, check, cross, underline`);
  }
  return shape;
}

function expectCanvasColor(value: unknown, label: string, fallback: string): string {
  if (value === undefined) {
    return fallback;
  }
  return normalizeCssColorString(expectString(value, label), label);
}

export function actorErrorStatus(code: ActorErrorCode): number {
  switch (code) {
    case "actor_exists":
    case "run_preempted":
    case "run_canceled":
      return 409;
    case "unknown_type":
    case "unknown_action":
      return 422;
    case "actor_not_found":
      return 404;
    case "timeout":
      return 408;
    case "invalid_args":
    default:
      return 400;
  }
}

export function actorErrorBody(error: unknown): { ok: false; error: ActorErrorCode; message: string; status: number } {
  if (error instanceof ActorApiError) {
    return {
      ok: false,
      error: error.code,
      message: error.message,
      status: error.status,
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    error: "invalid_args",
    message,
    status: 400,
  };
}

export function normalizeActorSpawnRequest(value: unknown): ActorSpawnRequest {
  const record = expectRecord(value, "spawn body");
  return {
    type: expectActorType(record.type),
    name: expectActorName(record.name),
    durationScale: record.durationScale === undefined
      ? 1
      : expectNonNegativeNumber(record.durationScale, "durationScale"),
    idleMs: record.idleMs === undefined
      ? 3000
      : expectNonNegativeNumber(record.idleMs, "idleMs"),
  };
}

export function normalizeActorRunRequest(value: unknown): ActorRunRequest {
  const record = expectRecord(value, "run body");
  const kind = expectString(record.kind, "kind");
  const timeoutMs = record.timeoutMs === undefined ? undefined : Math.trunc(expectPositiveNumber(record.timeoutMs, "timeoutMs"));

  switch (kind) {
    case "move": {
      const style = record.style === undefined ? "purposeful" : expectString(record.style, "style");
      if (!["purposeful", "fast", "slow", "wandering"].includes(style)) {
        throw new ActorApiError("invalid_args", `style must be one of purposeful, fast, slow, wandering`);
      }
      return {
        timeoutMs,
        action: {
          kind,
          to: normalizePoint(record.to, "to"),
          style: style as PointerMoveStyle,
        },
      };
    }
    case "click": {
      const button = record.button === undefined ? "left" : expectString(record.button, "button");
      if (!["left", "right", "middle"].includes(button)) {
        throw new ActorApiError("invalid_args", "button must be one of left, right, middle");
      }
      return {
        timeoutMs,
        action: {
          kind,
          button: button as PointerButton,
          at: record.at === undefined ? undefined : normalizePoint(record.at, "at"),
        },
      };
    }
    case "drag":
      return { timeoutMs, action: { kind, to: normalizePoint(record.to, "to") } };
    case "scroll":
      return {
        timeoutMs,
        action: {
          kind,
          dx: expectFiniteNumber(record.dx, "dx"),
          dy: expectFiniteNumber(record.dy, "dy"),
        },
      };
    case "think":
      return {
        timeoutMs,
        action: {
          kind,
          forMs: record.forMs === undefined ? 1400 : Math.trunc(expectNonNegativeNumber(record.forMs, "forMs")),
        },
      };
    case "narrate":
      return {
        timeoutMs,
        action: {
          kind,
          text: expectString(record.text, "text"),
        },
      };
    case "encircle":
      {
        const loops = record.loops === undefined ? 1 : Math.trunc(expectPositiveNumber(record.loops, "loops"));
        if (loops < 1) {
          throw new ActorApiError("invalid_args", "loops must be greater than 0");
        }

        return {
          timeoutMs,
          action: {
            kind,
            center: normalizePoint(record.center, "center"),
            radius: record.radius === undefined ? 60 : expectPositiveNumber(record.radius, "radius"),
            loops,
            speed: record.speed === undefined ? 400 : expectPositiveNumber(record.speed, "speed"),
          },
        };
      }
    case "dismiss":
      return { timeoutMs, action: { kind } };
    case "rect":
    case "circ": {
      const rects = Array.isArray(record.rects)
        ? record.rects.map((rect, index) => normalizeCanvasBox(rect, `rects[${index}]`))
        : undefined;
      if (!rects || rects.length === 0) {
        throw new ActorApiError("invalid_args", `${kind} requires rects`);
      }
      return {
        timeoutMs,
        action: {
          kind,
          rects,
          padding: record.padding === undefined ? 0 : expectNonNegativeNumber(record.padding, "padding"),
          blur: record.blur === undefined ? 0 : expectNonNegativeNumber(record.blur, "blur"),
          speed: record.speed === undefined ? undefined : expectPositiveNumber(record.speed, "speed"),
        },
      };
    }
    case "on":
    case "off": {
      const transitionRaw = record.transition === undefined ? "fade" : expectString(record.transition, "transition");
      if (transitionRaw !== "fade" && transitionRaw !== "instant") {
        throw new ActorApiError("invalid_args", "transition must be one of fade, instant");
      }
      return {
        timeoutMs,
        action: {
          kind,
          transition: transitionRaw,
        },
      };
    }
    case "color":
      return {
        timeoutMs,
        action: {
          kind,
          color: normalizeCssColorString(expectString(record.color, "color"), "color"),
        },
      };
    case "draw": {
      const shape = expectCanvasDrawShape(record.shape, "shape");
      const styleRecord = isRecord(record.style) ? record.style : {};
      const box = record.box === undefined ? undefined : normalizeCanvasBox(record.box, "box");
      const boxes = Array.isArray(record.boxes)
        ? record.boxes.map((item, index) => normalizeCanvasBox(item, `boxes[${index}]`))
        : undefined;
      if (box && boxes) {
        throw new ActorApiError("invalid_args", "box and boxes cannot both be provided");
      }
      return {
        timeoutMs,
        action: {
          kind,
          shape,
          style: {
            color: expectCanvasColor(styleRecord.color, "style.color", "#FF3B30"),
            size: styleRecord.size === undefined ? 4 : expectPositiveNumber(styleRecord.size, "style.size"),
            padding: styleRecord.padding === undefined ? 0 : expectNonNegativeNumber(styleRecord.padding, "style.padding"),
          },
          box,
          boxes,
        },
      };
    }
    case "text": {
      const styleRecord = isRecord(record.style) ? record.style : {};
      const highlightRaw = styleRecord.highlight === undefined ? undefined : expectString(styleRecord.highlight, "style.highlight");
      return {
        timeoutMs,
        action: {
          kind,
          text: expectString(record.text, "text"),
          style: {
            font: styleRecord.font === undefined ? "SF Pro Text" : expectString(styleRecord.font, "style.font"),
            size: styleRecord.size === undefined ? 36 : expectPositiveNumber(styleRecord.size, "style.size"),
            color: expectCanvasColor(styleRecord.color, "style.color", "#FF3B30"),
            highlight: highlightRaw === undefined || highlightRaw === "none"
              ? undefined
              : normalizeCssColorString(highlightRaw, "style.highlight"),
          },
          box: record.box === undefined ? undefined : normalizeCanvasBox(record.box, "box"),
        },
      };
    }
    case "clear":
      return { timeoutMs, action: { kind } };
    default:
      throw new ActorApiError("unknown_action", `Unknown action: ${kind}`);
  }
}

function requireOptionValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new ActorApiError("invalid_args", `${flag} requires a value`);
  }
  return value;
}

function parseTimeout(args: string[]): number | undefined {
  const index = args.indexOf("--timeout");
  if (index < 0) return undefined;
  const value = Number(requireOptionValue(args, index, "--timeout"));
  args.splice(index, 2);
  return Math.trunc(expectPositiveNumber(value, "--timeout"));
}

function parsePointFlag(args: string[], flag: string): { x: number; y: number } {
  const index = args.indexOf(flag);
  if (index < 0) {
    throw new ActorApiError("invalid_args", `${flag} is required`);
  }
  const x = Number(requireOptionValue(args, index, `${flag} <x>`));
  const yToken = args[index + 2];
  if (!yToken || yToken.startsWith("--")) {
    throw new ActorApiError("invalid_args", `${flag} requires <x> <y>`);
  }
  const y = Number(yToken);
  args.splice(index, 3);
  return {
    x: expectFiniteNumber(x, `${flag} x`),
    y: expectFiniteNumber(y, `${flag} y`),
  };
}

function circleCenterFromBox(box: CanvasBox): { x: number; y: number } {
  return {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  };
}

function defaultEncircleRadius(box?: CanvasBox): number {
  if (!box) {
    return 60;
  }
  return Math.max(36, Math.round(Math.max(box.width, box.height) / 2 + 18));
}

export function parseActorSpawnCLIArgs(args: string[]): ActorSpawnRequest {
  const rest = [...args];
  const type = rest.shift();
  const name = rest.shift();
  if (!type || !name) {
    throw new ActorApiError("invalid_args", "Usage: gui actor spawn <pointer|canvas|spotlight> <name> [--duration-scale <scale>] [--idle <ms>]");
  }

  let durationScale = 1;
  const durationIndex = rest.indexOf("--duration-scale");
  if (durationIndex >= 0) {
    durationScale = expectNonNegativeNumber(Number(requireOptionValue(rest, durationIndex, "--duration-scale")), "--duration-scale");
    rest.splice(durationIndex, 2);
  }

  let idleMs = 3000;
  const idleIndex = rest.indexOf("--idle");
  if (idleIndex >= 0) {
    idleMs = expectNonNegativeNumber(Number(requireOptionValue(rest, idleIndex, "--idle")), "--idle");
    rest.splice(idleIndex, 2);
  }

  if (rest.length > 0) {
    throw new ActorApiError("invalid_args", `Unknown actor spawn args: ${rest.join(" ")}`);
  }

  return {
    type: expectActorType(type),
    name: expectActorName(name),
    durationScale,
    idleMs,
  };
}

function parseCanvasBoxLiteral(args: string[], usageLabel: string): CanvasBox | undefined {
  const index = args.findIndex((token) => !token.startsWith("--") && token !== "-");
  if (index < 0) {
    return undefined;
  }
  const xToken = args[index];
  const yToken = args[index + 1];
  const widthToken = args[index + 2];
  const heightToken = args[index + 3];
  if (!xToken || !yToken || !widthToken || !heightToken) {
    return undefined;
  }
  const x = Number(xToken);
  const y = Number(yToken);
  const width = Number(widthToken);
  const height = Number(heightToken);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
    return undefined;
  }
  if (width <= 0 || height <= 0) {
    throw new ActorApiError("invalid_args", `${usageLabel} literal boxes require positive width and height`);
  }
  args.splice(index, 4);
  return {
    x,
    y,
    width,
    height,
  };
}

function parseCanvasBoxesFromLiteral(args: string[], usageLabel: string): CanvasBox[] | undefined {
  const box = parseCanvasBoxLiteral(args, usageLabel);
  return box ? [box] : undefined;
}

type CanvasBoundsNode = {
  _tag: string;
  _children?: CanvasBoundsNode[];
} & Record<string, unknown>;

function normalizeCanvasBoundsRect(value: unknown): CanvasBox | null {
  if (typeof value === "string") {
    const match = value.trim().match(/^\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)$/);
    if (!match) {
      return null;
    }
    const x = Number(match[1]);
    const y = Number(match[2]);
    const width = Number(match[3]);
    const height = Number(match[4]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return null;
    }
    return { x, y, width, height };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const x = typeof record.x === "number" ? record.x : typeof record.x === "string" ? Number(record.x) : null;
  const y = typeof record.y === "number" ? record.y : typeof record.y === "string" ? Number(record.y) : null;
  const width = typeof record.width === "number" ? record.width : typeof record.width === "string" ? Number(record.width) : null;
  const height = typeof record.height === "number" ? record.height : typeof record.height === "string" ? Number(record.height) : null;

  if (
    x === null || y === null || width === null || height === null
    || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)
    || width <= 0 || height <= 0
  ) {
    return null;
  }

  return { x, y, width, height };
}

function boundsFromCanvasNode(node: CanvasBoundsNode): CanvasBox | null {
  return normalizeCanvasBoundsRect(node.frame)
    ?? normalizeCanvasBoundsRect(node._frame)
    ?? normalizeCanvasBoundsRect(node);
}

function collectCanvasBoundsRects(nodes: CanvasBoundsNode[] | null | undefined): {
  rects: CanvasBox[];
  firstNodeWithoutBounds: CanvasBoundsNode | null;
} {
  const rects: CanvasBox[] = [];
  const seen = new Set<string>();
  let firstNodeWithoutBounds: CanvasBoundsNode | null = null;

  const walk = (node: CanvasBoundsNode): void => {
    if (node._tag !== "VATRoot") {
      const rect = boundsFromCanvasNode(node);
      if (rect) {
        const key = `${rect.x}:${rect.y}:${rect.width}:${rect.height}`;
        if (!seen.has(key)) {
          seen.add(key);
          rects.push(rect);
        }
      } else {
        firstNodeWithoutBounds ??= node;
      }
    }

    for (const child of node._children ?? []) {
      walk(child);
    }
  };

  for (const node of nodes ?? []) {
    walk(node);
  }

  return { rects, firstNodeWithoutBounds };
}

function parseCanvasBoxesFromStdin(
  stdinText: string,
  usageLabel: string,
  options: { preferResolvedBounds?: boolean } = {},
): CanvasBox[] {
  const payloads = parseCLICompositionPayloadStream(stdinText, usageLabel);
  if (payloads.length === 0) {
    throw new ActorApiError("invalid_args", `${usageLabel} stdin mode requires one AX/VAT target-bearing payload`);
  }

  if (payloads.length > 1) {
    throw new ActorApiError("invalid_args", `${usageLabel} stdin mode requires exactly one AX/VAT target-bearing payload`);
  }

  const payload = payloads[0]!;
  if (payload.source === "vat.query" && payload.bounds && (options.preferResolvedBounds || payload.matchCount === 1)) {
    return [requireCLICompositionBounds(payload, usageLabel)];
  }
  if (payload.source === "vat.query" && payload.nodes) {
    const { rects, firstNodeWithoutBounds } = collectCanvasBoundsRects(payload.nodes as CanvasBoundsNode[]);
    if (rects.length > 0) {
      return rects;
    }
    if (firstNodeWithoutBounds) {
      throw new ActorApiError("invalid_args", `${usageLabel} ${firstNodeWithoutBounds._tag} is missing bounds/frame coordinates`);
    }
  }

  const bounds = requireCLICompositionBounds(payload, usageLabel);
  return [bounds];
}

export function parseActorRunCLIArgs(actionName: string, args: string[], stdinText = ""): ActorRunRequest {
  const rest = [...args];
  const timeoutMs = parseTimeout(rest);

  switch (actionName) {
    case "move": {
      const to = parsePointFlag(rest, "--to");
      let style: PointerMoveStyle = "purposeful";
      const styleIndex = rest.indexOf("--style");
      if (styleIndex >= 0) {
        const value = requireOptionValue(rest, styleIndex, "--style");
        if (!["purposeful", "fast", "slow", "wandering"].includes(value)) {
          throw new ActorApiError("invalid_args", "--style must be one of purposeful, fast, slow, wandering");
        }
        style = value as PointerMoveStyle;
        rest.splice(styleIndex, 2);
      }
      if (rest.length > 0) {
        throw new ActorApiError("invalid_args", `Unknown move args: ${rest.join(" ")}`);
      }
      return { timeoutMs, action: { kind: "move", to, style } };
    }
    case "click": {
      let button: PointerButton = "left";
      const buttonIndex = rest.indexOf("--button");
      if (buttonIndex >= 0) {
        const value = requireOptionValue(rest, buttonIndex, "--button");
        if (!["left", "right", "middle"].includes(value)) {
          throw new ActorApiError("invalid_args", "--button must be one of left, right, middle");
        }
        button = value as PointerButton;
        rest.splice(buttonIndex, 2);
      }
      let at: { x: number; y: number } | undefined;
      if (rest.includes("--at")) {
        at = parsePointFlag(rest, "--at");
      }
      if (rest.length > 0) {
        throw new ActorApiError("invalid_args", `Unknown click args: ${rest.join(" ")}`);
      }
      return { timeoutMs, action: { kind: "click", button, at } };
    }
    case "drag": {
      const to = parsePointFlag(rest, "--to");
      if (rest.length > 0) {
        throw new ActorApiError("invalid_args", `Unknown drag args: ${rest.join(" ")}`);
      }
      return { timeoutMs, action: { kind: "drag", to } };
    }
    case "scroll": {
      const dxIndex = rest.indexOf("--dx");
      const dyIndex = rest.indexOf("--dy");
      if (dxIndex < 0 || dyIndex < 0) {
        throw new ActorApiError("invalid_args", "scroll requires --dx <n> --dy <n>");
      }
      const dx = Number(requireOptionValue(rest, dxIndex, "--dx"));
      rest.splice(dxIndex, 2);
      const nextDyIndex = rest.indexOf("--dy");
      const dy = Number(requireOptionValue(rest, nextDyIndex, "--dy"));
      rest.splice(nextDyIndex, 2);
      if (rest.length > 0) {
        throw new ActorApiError("invalid_args", `Unknown scroll args: ${rest.join(" ")}`);
      }
      return {
        timeoutMs,
        action: {
          kind: "scroll",
          dx: expectFiniteNumber(dx, "--dx"),
          dy: expectFiniteNumber(dy, "--dy"),
        },
      };
    }
    case "think": {
      let forMs = 1400;
      const forIndex = rest.indexOf("--for");
      if (forIndex >= 0) {
        forMs = Math.trunc(expectNonNegativeNumber(Number(requireOptionValue(rest, forIndex, "--for")), "--for"));
        rest.splice(forIndex, 2);
      }
      if (rest.length > 0) {
        throw new ActorApiError("invalid_args", `Unknown think args: ${rest.join(" ")}`);
      }
      return { timeoutMs, action: { kind: "think", forMs } };
    }
    case "narrate": {
      const textIndex = rest.indexOf("--text");
      if (textIndex < 0) {
        throw new ActorApiError("invalid_args", "narrate requires --text <text>");
      }
      const text = requireOptionValue(rest, textIndex, "--text");
      rest.splice(textIndex, 2);
      if (rest.length > 0) {
        throw new ActorApiError("invalid_args", `Unknown narrate args: ${rest.join(" ")}`);
      }
      return { timeoutMs, action: { kind: "narrate", text } };
    }
    case "encircle": {
      const stdinIndex = rest.indexOf("-");
      const useStdin = stdinIndex >= 0;
      if (useStdin) {
        rest.splice(stdinIndex, 1);
      }

      let center: { x: number; y: number } | undefined;
      if (rest.includes("--at")) {
        center = parsePointFlag(rest, "--at");
      }

      let radius: number | undefined;
      const radiusIndex = rest.indexOf("--radius");
      if (radiusIndex >= 0) {
        radius = expectPositiveNumber(Number(requireOptionValue(rest, radiusIndex, "--radius")), "--radius");
        rest.splice(radiusIndex, 2);
      }

      let speed = 400;
      const speedIndex = rest.indexOf("--speed");
      if (speedIndex >= 0) {
        speed = expectPositiveNumber(Number(requireOptionValue(rest, speedIndex, "--speed")), "--speed");
        rest.splice(speedIndex, 2);
      }

      let loops = 1;
      const loopsIndex = rest.indexOf("--loops");
      if (loopsIndex >= 0) {
        loops = Math.trunc(expectPositiveNumber(Number(requireOptionValue(rest, loopsIndex, "--loops")), "--loops"));
        rest.splice(loopsIndex, 2);
      }

      let stdinBox: CanvasBox | undefined;
      if (useStdin) {
        const boxes = parseCanvasBoxesFromStdin(stdinText, "actor run encircle", { preferResolvedBounds: true });
        if (boxes.length !== 1) {
          throw new ActorApiError("invalid_args", `actor run encircle stdin mode requires exactly one resolved bounds rectangle; got ${boxes.length}`);
        }
        stdinBox = boxes[0];
        center = center ?? circleCenterFromBox(stdinBox);
      }

      if (!center) {
        throw new ActorApiError("invalid_args", "encircle requires --at <x> <y> or -");
      }
      if (rest.length > 0) {
        throw new ActorApiError("invalid_args", `Unknown encircle args: ${rest.join(" ")}`);
      }

      return {
        timeoutMs,
        action: {
          kind: "encircle",
          center,
          radius: radius ?? defaultEncircleRadius(stdinBox),
          loops,
          speed,
        },
      };
    }
    case "dismiss":
      if (rest.length > 0) {
        throw new ActorApiError("invalid_args", `Unknown dismiss args: ${rest.join(" ")}`);
      }
      return { timeoutMs, action: { kind: "dismiss" } };
    case "rect":
    case "circ": {
      const stdinIndex = rest.indexOf("-");
      if (stdinIndex < 0) {
        throw new ActorApiError("invalid_args", `${actionName} requires -`);
      }
      rest.splice(stdinIndex, 1);
      const style: Record<string, unknown> = {};
      for (let index = 0; index < rest.length; index++) {
        const token = rest[index];
        if (token === "--padding") {
          style.padding = expectNonNegativeNumber(Number(requireOptionValue(rest, index, "--padding")), "--padding");
          rest.splice(index, 2);
          index--;
          continue;
        }
        if (token === "--blur") {
          style.blur = expectNonNegativeNumber(Number(requireOptionValue(rest, index, "--blur")), "--blur");
          rest.splice(index, 2);
          index--;
          continue;
        }
        if (token === "--speed") {
          style.speed = expectPositiveNumber(Number(requireOptionValue(rest, index, "--speed")), "--speed");
          rest.splice(index, 2);
          index--;
          continue;
        }
      }
      if (rest.length > 0) {
        throw new ActorApiError("invalid_args", `Unknown ${actionName} args: ${rest.join(" ")}`);
      }
      const rects = parseCanvasBoxesFromStdin(stdinText, `actor run spotlight ${actionName}`);
      return {
        timeoutMs,
        action: {
          kind: actionName,
          rects,
          padding: style.padding === undefined ? 0 : expectNonNegativeNumber(style.padding, "padding"),
          blur: style.blur === undefined ? 0 : expectNonNegativeNumber(style.blur, "blur"),
          speed: style.speed === undefined ? undefined : expectPositiveNumber(style.speed, "speed"),
        },
      };
    }
    case "on":
    case "off": {
      let transition: SpotlightTransition = "fade";
      const transitionIndex = rest.indexOf("--transition");
      if (transitionIndex >= 0) {
        const value = requireOptionValue(rest, transitionIndex, "--transition");
        if (value !== "fade" && value !== "instant") {
          throw new ActorApiError("invalid_args", "--transition must be one of fade, instant");
        }
        transition = value as SpotlightTransition;
        rest.splice(transitionIndex, 2);
      }
      if (rest.length > 0) {
        throw new ActorApiError("invalid_args", `Unknown ${actionName} args: ${rest.join(" ")}`);
      }
      return { timeoutMs, action: { kind: actionName, transition } };
    }
    case "color": {
      let color = rest.shift();
      if (color === "--color") {
        color = rest.shift();
      }
      if (!color) {
        throw new ActorApiError("invalid_args", "color requires <Color>");
      }
      if (rest.length > 0) {
        throw new ActorApiError("invalid_args", `Unknown color args: ${rest.join(" ")}`);
      }
      return {
        timeoutMs,
        action: {
          kind: "color",
          color: normalizeCssColorString(expectString(color, "color"), "color"),
        },
      };
    }
    case "draw": {
      const shape = expectCanvasDrawShape(rest.shift(), "shape");
      const stdinIndex = rest.indexOf("-");
      const useStdin = stdinIndex >= 0;
      if (useStdin) {
        rest.splice(stdinIndex, 1);
      }
      const style: Record<string, unknown> = {};
      let box: CanvasBox | undefined;
      for (let index = 0; index < rest.length; index++) {
        const token = rest[index];
        if (token === "--box") {
          const xToken = requireOptionValue(rest, index, "--box x");
          const yToken = rest[index + 2];
          const widthToken = rest[index + 3];
          const heightToken = rest[index + 4];
          const x = Number(xToken);
          const y = Number(yToken);
          const width = Number(widthToken);
          const height = Number(heightToken);
          if (
            !Number.isFinite(x)
            || !Number.isFinite(y)
            || !Number.isFinite(width)
            || !Number.isFinite(height)
            || width <= 0
            || height <= 0
          ) {
            throw new ActorApiError("invalid_args", "--box requires finite x y width height with positive width and height");
          }
          box = { x, y, width, height };
          rest.splice(index, 5);
          index--;
          continue;
        }
        if (token === "--padding") {
          style.padding = expectNonNegativeNumber(Number(requireOptionValue(rest, index, "--padding")), "--padding");
          rest.splice(index, 2);
          index--;
          continue;
        }
        if (token === "--size") {
          style.size = expectPositiveNumber(Number(requireOptionValue(rest, index, "--size")), "--size");
          rest.splice(index, 2);
          index--;
          continue;
        }
        if (token === "--color") {
          style.color = normalizeCssColorString(expectString(requireOptionValue(rest, index, "--color"), "--color"), "--color");
          rest.splice(index, 2);
          index--;
          continue;
        }
      }
      if (useStdin && box) {
        throw new ActorApiError("invalid_args", "actor run draw stdin mode cannot be combined with --box");
      }
      let boxes: CanvasBox[] | undefined;
      if (useStdin) {
        boxes = parseCanvasBoxesFromStdin(stdinText, "actor run draw");
        if (boxes.length === 1) {
          box = boxes[0];
        }
      } else if (box === undefined) {
        boxes = parseCanvasBoxesFromLiteral(rest, "actor run draw");
        if (boxes?.length === 1) {
          box = boxes[0];
        }
      }
      if (box && rest.length > 0) {
        throw new ActorApiError("invalid_args", `Unknown draw args: ${rest.join(" ")}`);
      }
      if (rest.length > 0) {
        throw new ActorApiError("invalid_args", `Unknown draw args: ${rest.join(" ")}`);
      }
      return {
        timeoutMs,
        action: {
          kind: "draw",
          shape,
          style: {
            color: expectCanvasColor(style.color, "style.color", "#FF3B30"),
            size: style.size === undefined ? 4 : expectPositiveNumber(style.size, "style.size"),
            padding: style.padding === undefined ? 10 : expectNonNegativeNumber(style.padding, "style.padding"),
          },
          box,
          boxes: boxes && boxes.length > 1 ? boxes : undefined,
        },
      };
    }
    case "text": {
      const textParts: string[] = [];
      while (rest.length > 0 && rest[0] !== "-" && !rest[0].startsWith("--")) {
        textParts.push(rest.shift() as string);
      }
      const text = textParts.join(" ").trim();
      if (!text) {
        throw new ActorApiError("invalid_args", "text requires <text>");
      }
      const stdinIndex = rest.indexOf("-");
      const useStdin = stdinIndex >= 0;
      if (useStdin) {
        rest.splice(stdinIndex, 1);
      }
      const style: Record<string, unknown> = {};
      let box: CanvasBox | undefined;
      for (let index = 0; index < rest.length; index++) {
        const token = rest[index];
        if (token === "--font") {
          style.font = expectString(requireOptionValue(rest, index, "--font"), "--font");
          rest.splice(index, 2);
          index--;
          continue;
        }
        if (token === "--size") {
          style.size = expectPositiveNumber(Number(requireOptionValue(rest, index, "--size")), "--size");
          rest.splice(index, 2);
          index--;
          continue;
        }
        if (token === "--color") {
          style.color = normalizeCssColorString(expectString(requireOptionValue(rest, index, "--color"), "--color"), "--color");
          rest.splice(index, 2);
          index--;
          continue;
        }
        if (token === "--highlight") {
          const rawHighlight = expectString(requireOptionValue(rest, index, "--highlight"), "--highlight");
          style.highlight = rawHighlight === "none" ? undefined : normalizeCssColorString(rawHighlight, "--highlight");
          rest.splice(index, 2);
          index--;
          continue;
        }
        if (token === "--box") {
          const x = Number(requireOptionValue(rest, index, "--box x"));
          const yToken = rest[index + 2];
          const widthToken = rest[index + 3];
          const heightToken = rest[index + 4];
          const y = Number(yToken);
          const width = Number(widthToken);
          const height = Number(heightToken);
          if (
            !Number.isFinite(x)
            || !Number.isFinite(y)
            || !Number.isFinite(width)
            || !Number.isFinite(height)
            || width <= 0
            || height <= 0
          ) {
            throw new ActorApiError("invalid_args", "--box requires finite x y width height with positive width and height");
          }
          box = { x, y, width, height };
          rest.splice(index, 5);
          index--;
          continue;
        }
      }
      if (useStdin && box) {
        throw new ActorApiError("invalid_args", "actor run text stdin mode cannot be combined with --box");
      }
      if (useStdin) {
        const boxes = parseCanvasBoxesFromStdin(stdinText, "actor run text", { preferResolvedBounds: true });
        if (boxes.length !== 1) {
          throw new ActorApiError(
            "invalid_args",
            `actor run text stdin payload from vat.query resolved to ${boxes.length} bounds; canvas text stdin mode supports exactly one resolved bounds rectangle`,
          );
        }
        box = boxes[0]!;
      }
      if (rest.length > 0) {
        throw new ActorApiError("invalid_args", `Unknown text args: ${rest.join(" ")}`);
      }
      return {
        timeoutMs,
        action: {
          kind: "text",
          text,
          style: {
            font: style.font === undefined ? "SF Pro Text" : expectString(style.font, "style.font"),
            size: style.size === undefined ? 36 : expectPositiveNumber(style.size, "style.size"),
            color: expectCanvasColor(style.color, "style.color", "#FF3B30"),
            highlight: style.highlight === undefined ? undefined : expectCanvasColor(style.highlight, "style.highlight", "#FF3B30"),
          },
          box,
        },
      };
    }
    case "clear":
      if (rest.length > 0) {
        throw new ActorApiError("invalid_args", `Unknown clear args: ${rest.join(" ")}`);
      }
      return { timeoutMs, action: { kind: "clear" } };
    default:
      throw new ActorApiError("unknown_action", `Unknown action: ${actionName}`);
  }
}
