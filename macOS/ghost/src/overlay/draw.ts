export interface DrawRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DrawRectStyle {
  stroke: string;
  fill: string;
  lineWidth: number;
  cornerRadius: number;
  opacity: number;
}

export interface DrawRectFrom {
  rect: DrawRect;
  cornerRadius?: number;
}

export type DrawAnimationEase = "linear" | "easeIn" | "easeOut" | "easeInOut";

export interface DrawRectAnimation {
  durMs: number;
  ease: DrawAnimationEase;
}

export interface DrawRectItem {
  id?: string;
  kind: "rect";
  remove?: boolean;
  from?: DrawRectFrom;
  rect?: DrawRect;
  style?: DrawRectStyle;
  animation?: DrawRectAnimation;
}

export interface DrawPoint {
  x: number;
  y: number;
}

export interface DrawLine {
  from: DrawPoint;
  to: DrawPoint;
}

export interface DrawLineStyle {
  stroke: string;
  lineWidth: number;
  opacity: number;
}

export interface DrawLineFrom {
  line: DrawLine;
  stroke?: string;
  lineWidth?: number;
  opacity?: number;
}

export interface DrawLineItem {
  id?: string;
  kind: "line";
  remove?: boolean;
  from?: DrawLineFrom;
  line?: DrawLine;
  style?: DrawLineStyle;
  animation?: DrawRectAnimation;
}

export interface DrawXrayItem {
  id?: string;
  kind: "xray";
  remove?: boolean;
  rect?: DrawRect;
  direction?: DrawXrayDirection;
  animation?: DrawRectAnimation;
}

export type DrawXrayDirection = "leftToRight" | "rightToLeft" | "topToBottom" | "bottomToTop";

export interface DrawSpotlightStyle {
  fill: string;
  cornerRadius: number;
  opacity: number;
}

export interface DrawSpotlightItem {
  id?: string;
  kind: "spotlight";
  remove?: boolean;
  rects?: DrawRect[];
  style?: DrawSpotlightStyle;
}

export type DrawMarkerShape = "rect" | "circ" | "check" | "cross" | "underline";

export interface DrawMarkerStyle {
  color: string;
  size: number;
  padding: number;
  roughness: number;
}

export interface DrawMarkerItem {
  id?: string;
  kind: "marker";
  remove?: boolean;
  shape?: DrawMarkerShape;
  rect?: DrawRect;
  style?: DrawMarkerStyle;
  animation?: DrawRectAnimation;
}

export type DrawItem = DrawRectItem | DrawLineItem | DrawXrayItem | DrawSpotlightItem | DrawMarkerItem;

export interface DrawScript {
  timeout?: number;
  coordinateSpace: "screen";
  items: DrawItem[];
}

type DrawRectStyleInput = Partial<DrawRectStyle>;
type DrawLineStyleInput = Partial<DrawLineStyle>;
type DrawSpotlightStyleInput = Partial<DrawSpotlightStyle>;
type DrawMarkerStyleInput = Partial<DrawMarkerStyle>;

interface DrawRectFromInput {
  rect?: unknown;
  cornerRadius?: unknown;
}

interface DrawLineFromInput {
  line?: unknown;
  stroke?: unknown;
  lineWidth?: unknown;
  opacity?: unknown;
}

interface DrawRectAnimationInput {
  durMs?: unknown;
  ease?: unknown;
}

interface DrawRectItemInput {
  id?: unknown;
  kind?: unknown;
  remove?: unknown;
  from?: unknown;
  rect?: unknown;
  style?: unknown;
  animation?: unknown;
}

interface DrawLineItemInput {
  id?: unknown;
  kind?: unknown;
  remove?: unknown;
  from?: unknown;
  line?: unknown;
  style?: unknown;
  animation?: unknown;
}

interface DrawXrayItemInput {
  id?: unknown;
  kind?: unknown;
  remove?: unknown;
  rect?: unknown;
  direction?: unknown;
  animation?: unknown;
}

interface DrawSpotlightItemInput {
  id?: unknown;
  kind?: unknown;
  remove?: unknown;
  rects?: unknown;
  style?: unknown;
}

interface DrawMarkerItemInput {
  id?: unknown;
  kind?: unknown;
  remove?: unknown;
  shape?: unknown;
  rect?: unknown;
  style?: unknown;
  animation?: unknown;
}

interface DrawScriptInput {
  timeout?: unknown;
  version?: unknown;
  coordinateSpace?: unknown;
  items?: unknown;
}

const DEFAULT_RECT_STYLE: DrawRectStyle = {
  stroke: "#00E5FF",
  fill: "#00E5FF18",
  lineWidth: 2,
  cornerRadius: 8,
  opacity: 1,
};

const DEFAULT_RECT_ANIMATION: DrawRectAnimation = {
  durMs: 250,
  ease: "easeInOut",
};

const DEFAULT_LINE_STYLE: DrawLineStyle = {
  stroke: "#00E5FF",
  lineWidth: 2,
  opacity: 1,
};

const DEFAULT_XRAY_DIRECTION: DrawXrayDirection = "leftToRight";
const DEFAULT_SPOTLIGHT_STYLE: DrawSpotlightStyle = {
  fill: "#000000B8",
  cornerRadius: 18,
  opacity: 1,
};

const CSS_HEX_COLOR_RE = /^#(?:[0-9A-Fa-f]{3,4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/;
const CSS_RGB_COLOR_RE = /^rgb\(\s*([+-]?(?:\d+|\d*\.\d+|\.\d+))\s*,\s*([+-]?(?:\d+|\d*\.\d+|\.\d+))\s*,\s*([+-]?(?:\d+|\d*\.\d+|\.\d+))\s*\)$/;
const CSS_RGBA_COLOR_RE = /^rgba\(\s*([+-]?(?:\d+|\d*\.\d+|\.\d+))\s*,\s*([+-]?(?:\d+|\d*\.\d+|\.\d+))\s*,\s*([+-]?(?:\d+|\d*\.\d+|\.\d+))\s*,\s*([+-]?(?:\d+|\d*\.\d+|\.\d+))\s*\)$/;
const DRAW_ANIMATION_EASES = new Set<DrawAnimationEase>(["linear", "easeIn", "easeOut", "easeInOut"]);
const DRAW_XRAY_DIRECTIONS = new Set<DrawXrayDirection>(["leftToRight", "rightToLeft", "topToBottom", "bottomToTop"]);
const DRAW_MARKER_SHAPES = new Set<DrawMarkerShape>(["rect", "circ", "check", "cross", "underline"]);

export class DrawScriptValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DrawScriptValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new DrawScriptValidationError(`${path} must be an object`);
  }
  return value;
}

function expectFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new DrawScriptValidationError(`${path} must be a finite number`);
  }
  return value;
}

function expectPositiveNumber(value: unknown, path: string): number {
  const parsed = expectFiniteNumber(value, path);
  if (parsed <= 0) {
    throw new DrawScriptValidationError(`${path} must be greater than 0`);
  }
  return parsed;
}

function expectNonNegativeNumber(value: unknown, path: string): number {
  const parsed = expectFiniteNumber(value, path);
  if (parsed < 0) {
    throw new DrawScriptValidationError(`${path} must be greater than or equal to 0`);
  }
  return parsed;
}

function expectOpacity(value: unknown, path: string): number {
  const parsed = expectFiniteNumber(value, path);
  if (parsed < 0 || parsed > 1) {
    throw new DrawScriptValidationError(`${path} must be between 0 and 1`);
  }
  return parsed;
}

function expectRoughness(value: unknown, path: string): number {
  const parsed = expectFiniteNumber(value, path);
  if (parsed < 0 || parsed > 1) {
    throw new DrawScriptValidationError(`${path} must be between 0 and 1`);
  }
  return parsed;
}

function expectCssColor(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new DrawScriptValidationError(`${path} must be a CSS color like #RGB[A], #RRGGBB[AA], rgb(...), or rgba(...)`);
  }

  const trimmed = value.trim();
  if (CSS_HEX_COLOR_RE.test(trimmed)) {
    return trimmed;
  }
  if (CSS_RGB_COLOR_RE.test(trimmed)) {
    const [r, g, b] = trimmed.slice(4, -1).split(",").map((part) => Number(part.trim()));
    if (r < 0 || r > 255 || g < 0 || g > 255 || b < 0 || b > 255) {
      throw new DrawScriptValidationError(`${path} must be a CSS color like #RGB[A], #RRGGBB[AA], rgb(...), or rgba(...)`);
    }
    return trimmed;
  }
  const rgbaMatch = trimmed.match(CSS_RGBA_COLOR_RE);
  if (rgbaMatch) {
    const r = Number(rgbaMatch[1]);
    const g = Number(rgbaMatch[2]);
    const b = Number(rgbaMatch[3]);
    const a = Number(rgbaMatch[4]);
    if (r < 0 || r > 255 || g < 0 || g > 255 || b < 0 || b > 255 || a < 0 || a > 1) {
      throw new DrawScriptValidationError(`${path} must be a CSS color like #RGB[A], #RRGGBB[AA], rgb(...), or rgba(...)`);
    }
    return trimmed;
  }

  throw new DrawScriptValidationError(`${path} must be a CSS color like #RGB[A], #RRGGBB[AA], rgb(...), or rgba(...)`);
}

export function normalizeCssColorString(value: string, path = "color"): string {
  return expectCssColor(value, path);
}

function expectMarkerShape(value: unknown, path: string): DrawMarkerShape {
  if (typeof value !== "string" || !DRAW_MARKER_SHAPES.has(value as DrawMarkerShape)) {
    throw new DrawScriptValidationError(`${path} must be one of rect, circ, check, cross, underline`);
  }
  return value as DrawMarkerShape;
}

function expectOptionalId(value: unknown, path: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DrawScriptValidationError(`${path} must be a non-empty string`);
  }
  return value;
}

function normalizeRect(value: unknown, path: string): DrawRect {
  const rect = expectRecord(value, path);
  return {
    x: expectFiniteNumber(rect.x, `${path}.x`),
    y: expectFiniteNumber(rect.y, `${path}.y`),
    width: expectPositiveNumber(rect.width, `${path}.width`),
    height: expectPositiveNumber(rect.height, `${path}.height`),
  };
}

function normalizeRectStyle(value: unknown, path: string): DrawRectStyle {
  if (value === undefined) {
    return { ...DEFAULT_RECT_STYLE };
  }
  const style = expectRecord(value, path) as DrawRectStyleInput;
  return {
    stroke: style.stroke === undefined ? DEFAULT_RECT_STYLE.stroke : expectCssColor(style.stroke, `${path}.stroke`),
    fill: style.fill === undefined ? DEFAULT_RECT_STYLE.fill : expectCssColor(style.fill, `${path}.fill`),
    lineWidth: style.lineWidth === undefined ? DEFAULT_RECT_STYLE.lineWidth : expectPositiveNumber(style.lineWidth, `${path}.lineWidth`),
    cornerRadius: style.cornerRadius === undefined ? DEFAULT_RECT_STYLE.cornerRadius : expectNonNegativeNumber(style.cornerRadius, `${path}.cornerRadius`),
    opacity: style.opacity === undefined ? DEFAULT_RECT_STYLE.opacity : expectOpacity(style.opacity, `${path}.opacity`),
  };
}

function normalizeRectFrom(value: unknown, path: string): DrawRectFrom {
  const from = expectRecord(value, path) as DrawRectFromInput;
  return {
    rect: normalizeRect(from.rect, `${path}.rect`),
    cornerRadius: from.cornerRadius === undefined ? undefined : expectNonNegativeNumber(from.cornerRadius, `${path}.cornerRadius`),
  };
}

function normalizeRectAnimation(value: unknown, path: string): DrawRectAnimation {
  if (value === undefined) {
    return { ...DEFAULT_RECT_ANIMATION };
  }

  const animation = expectRecord(value, path) as DrawRectAnimationInput;
  const ease = animation.ease === undefined ? DEFAULT_RECT_ANIMATION.ease : animation.ease;
  if (typeof ease !== "string" || !DRAW_ANIMATION_EASES.has(ease as DrawAnimationEase)) {
    throw new DrawScriptValidationError(`${path}.ease must be one of linear, easeIn, easeOut, easeInOut`);
  }

  return {
    durMs: animation.durMs === undefined ? DEFAULT_RECT_ANIMATION.durMs : expectPositiveNumber(animation.durMs, `${path}.durMs`),
    ease: ease as DrawAnimationEase,
  };
}

function normalizeRectItem(value: unknown, index: number): DrawRectItem {
  const item = expectRecord(value, `items[${index}]`) as DrawRectItemInput;
  if (item.kind !== "rect") {
    throw new DrawScriptValidationError(`items[${index}].kind must be "rect"`);
  }

  const id = expectOptionalId(item.id, `items[${index}].id`);
  const remove = item.remove === undefined ? false : item.remove;
  if (typeof remove !== "boolean") {
    throw new DrawScriptValidationError(`items[${index}].remove must be a boolean`);
  }

  if (remove && id === undefined) {
    throw new DrawScriptValidationError(`items[${index}].remove requires items[${index}].id`);
  }

  if (!remove && item.rect === undefined) {
    throw new DrawScriptValidationError(`items[${index}].rect is required`);
  }

  if (item.animation !== undefined && item.from === undefined && id === undefined) {
    throw new DrawScriptValidationError(`items[${index}].animation requires items[${index}].from or items[${index}].id`);
  }

  return {
    id,
    kind: "rect",
    remove,
    from: item.from === undefined ? undefined : normalizeRectFrom(item.from, `items[${index}].from`),
    rect: item.rect === undefined ? undefined : normalizeRect(item.rect, `items[${index}].rect`),
    style: remove ? undefined : normalizeRectStyle(item.style, `items[${index}].style`),
    animation: item.animation !== undefined
      ? normalizeRectAnimation(item.animation, `items[${index}].animation`)
      : (item.from !== undefined ? { ...DEFAULT_RECT_ANIMATION } : undefined),
  };
}

function normalizePoint(value: unknown, path: string): DrawPoint {
  const point = expectRecord(value, path);
  return {
    x: expectFiniteNumber(point.x, `${path}.x`),
    y: expectFiniteNumber(point.y, `${path}.y`),
  };
}

function normalizeLine(value: unknown, path: string): DrawLine {
  const line = expectRecord(value, path);
  return {
    from: normalizePoint(line.from, `${path}.from`),
    to: normalizePoint(line.to, `${path}.to`),
  };
}

function normalizeLineStyle(value: unknown, path: string): DrawLineStyle {
  if (value === undefined) {
    return { ...DEFAULT_LINE_STYLE };
  }
  const style = expectRecord(value, path) as DrawLineStyleInput;
  return {
    stroke: style.stroke === undefined ? DEFAULT_LINE_STYLE.stroke : expectCssColor(style.stroke, `${path}.stroke`),
    lineWidth: style.lineWidth === undefined ? DEFAULT_LINE_STYLE.lineWidth : expectPositiveNumber(style.lineWidth, `${path}.lineWidth`),
    opacity: style.opacity === undefined ? DEFAULT_LINE_STYLE.opacity : expectOpacity(style.opacity, `${path}.opacity`),
  };
}

function normalizeLineFrom(value: unknown, path: string): DrawLineFrom {
  const from = expectRecord(value, path) as DrawLineFromInput;
  return {
    line: normalizeLine(from.line, `${path}.line`),
    stroke: from.stroke === undefined ? undefined : expectCssColor(from.stroke, `${path}.stroke`),
    lineWidth: from.lineWidth === undefined ? undefined : expectPositiveNumber(from.lineWidth, `${path}.lineWidth`),
    opacity: from.opacity === undefined ? undefined : expectOpacity(from.opacity, `${path}.opacity`),
  };
}

function normalizeLineItem(value: unknown, index: number): DrawLineItem {
  const item = expectRecord(value, `items[${index}]`) as DrawLineItemInput;
  if (item.kind !== "line") {
    throw new DrawScriptValidationError(`items[${index}].kind must be "line"`);
  }

  const id = expectOptionalId(item.id, `items[${index}].id`);
  const remove = item.remove === undefined ? false : item.remove;
  if (typeof remove !== "boolean") {
    throw new DrawScriptValidationError(`items[${index}].remove must be a boolean`);
  }

  if (remove && id === undefined) {
    throw new DrawScriptValidationError(`items[${index}].remove requires items[${index}].id`);
  }

  if (!remove && item.line === undefined) {
    throw new DrawScriptValidationError(`items[${index}].line is required`);
  }

  if (item.animation !== undefined && item.from === undefined && id === undefined) {
    throw new DrawScriptValidationError(`items[${index}].animation requires items[${index}].from or items[${index}].id`);
  }

  return {
    id,
    kind: "line",
    remove,
    from: item.from === undefined ? undefined : normalizeLineFrom(item.from, `items[${index}].from`),
    line: item.line === undefined ? undefined : normalizeLine(item.line, `items[${index}].line`),
    style: remove ? undefined : normalizeLineStyle(item.style, `items[${index}].style`),
    animation: item.animation !== undefined
      ? normalizeRectAnimation(item.animation, `items[${index}].animation`)
      : (item.from !== undefined ? { ...DEFAULT_RECT_ANIMATION } : undefined),
  };
}

const DEFAULT_XRAY_ANIMATION: DrawRectAnimation = {
  durMs: 400,
  ease: "easeInOut",
};

function normalizeXrayDirection(value: unknown, path: string): DrawXrayDirection {
  const direction = value === undefined ? DEFAULT_XRAY_DIRECTION : value;
  if (typeof direction !== "string" || !DRAW_XRAY_DIRECTIONS.has(direction as DrawXrayDirection)) {
    throw new DrawScriptValidationError(`${path} must be one of leftToRight, rightToLeft, topToBottom, bottomToTop`);
  }
  return direction as DrawXrayDirection;
}

function normalizeXrayItem(value: unknown, index: number): DrawXrayItem {
  const item = expectRecord(value, `items[${index}]`) as DrawXrayItemInput;
  if (item.kind !== "xray") {
    throw new DrawScriptValidationError(`items[${index}].kind must be "xray"`);
  }

  const id = expectOptionalId(item.id, `items[${index}].id`);
  const remove = item.remove === undefined ? false : item.remove;
  if (typeof remove !== "boolean") {
    throw new DrawScriptValidationError(`items[${index}].remove must be a boolean`);
  }

  if (remove && id === undefined) {
    throw new DrawScriptValidationError(`items[${index}].remove requires items[${index}].id`);
  }

  if (!remove && item.rect === undefined) {
    throw new DrawScriptValidationError(`items[${index}].rect is required`);
  }

  const direction = normalizeXrayDirection(item.direction, `items[${index}].direction`);

  return {
    id,
    kind: "xray",
    remove,
    rect: item.rect === undefined ? undefined : normalizeRect(item.rect, `items[${index}].rect`),
    direction: remove ? undefined : direction,
    animation: item.animation !== undefined
      ? normalizeRectAnimation(item.animation, `items[${index}].animation`)
      : (remove ? undefined : { ...DEFAULT_XRAY_ANIMATION }),
  };
}

function normalizeSpotlightStyle(value: unknown, path: string): DrawSpotlightStyle {
  if (value === undefined) {
    return { ...DEFAULT_SPOTLIGHT_STYLE };
  }
  const style = expectRecord(value, path) as DrawSpotlightStyleInput;
  return {
    fill: style.fill === undefined ? DEFAULT_SPOTLIGHT_STYLE.fill : expectCssColor(style.fill, `${path}.fill`),
    cornerRadius: style.cornerRadius === undefined
      ? DEFAULT_SPOTLIGHT_STYLE.cornerRadius
      : expectNonNegativeNumber(style.cornerRadius, `${path}.cornerRadius`),
    opacity: style.opacity === undefined ? DEFAULT_SPOTLIGHT_STYLE.opacity : expectOpacity(style.opacity, `${path}.opacity`),
  };
}

function normalizeMarkerStyle(value: unknown, path: string): DrawMarkerStyle {
  if (value === undefined) {
    return {
      color: "#FF3B30",
      size: 4,
      padding: 0,
      roughness: 0.2,
    };
  }
  const style = expectRecord(value, path) as DrawMarkerStyleInput;
  return {
    color: style.color === undefined ? "#FF3B30" : expectCssColor(style.color, `${path}.color`),
    size: style.size === undefined ? 4 : expectPositiveNumber(style.size, `${path}.size`),
    padding: style.padding === undefined ? 0 : expectNonNegativeNumber(style.padding, `${path}.padding`),
    roughness: style.roughness === undefined ? 0.2 : expectRoughness(style.roughness, `${path}.roughness`),
  };
}

function normalizeMarkerItem(value: unknown, index: number): DrawMarkerItem {
  const item = expectRecord(value, `items[${index}]`) as DrawMarkerItemInput;
  if (item.kind !== "marker") {
    throw new DrawScriptValidationError(`items[${index}].kind must be "marker"`);
  }

  const id = expectOptionalId(item.id, `items[${index}].id`);
  const remove = item.remove === undefined ? false : item.remove;
  if (typeof remove !== "boolean") {
    throw new DrawScriptValidationError(`items[${index}].remove must be a boolean`);
  }

  if (remove && id === undefined) {
    throw new DrawScriptValidationError(`items[${index}].remove requires items[${index}].id`);
  }

  if (!remove && item.shape === undefined) {
    throw new DrawScriptValidationError(`items[${index}].shape is required`);
  }
  if (!remove && item.rect === undefined) {
    throw new DrawScriptValidationError(`items[${index}].rect is required`);
  }

  return {
    id,
    kind: "marker",
    remove,
    shape: remove ? undefined : expectMarkerShape(item.shape, `items[${index}].shape`),
    rect: item.rect === undefined ? undefined : normalizeRect(item.rect, `items[${index}].rect`),
    style: remove ? undefined : normalizeMarkerStyle(item.style, `items[${index}].style`),
    animation: remove ? undefined : (item.animation !== undefined ? normalizeRectAnimation(item.animation, `items[${index}].animation`) : { ...DEFAULT_RECT_ANIMATION }),
  };
}

function normalizeSpotlightItem(value: unknown, index: number): DrawSpotlightItem {
  const item = expectRecord(value, `items[${index}]`) as DrawSpotlightItemInput;
  if (item.kind !== "spotlight") {
    throw new DrawScriptValidationError(`items[${index}].kind must be "spotlight"`);
  }

  const id = expectOptionalId(item.id, `items[${index}].id`);
  const remove = item.remove === undefined ? false : item.remove;
  if (typeof remove !== "boolean") {
    throw new DrawScriptValidationError(`items[${index}].remove must be a boolean`);
  }

  if (remove && id === undefined) {
    throw new DrawScriptValidationError(`items[${index}].remove requires items[${index}].id`);
  }

  if (!remove && item.rects === undefined) {
    throw new DrawScriptValidationError(`items[${index}].rects is required`);
  }

  if (!remove && !Array.isArray(item.rects)) {
    throw new DrawScriptValidationError(`items[${index}].rects must be an array`);
  }

  if (!remove && Array.isArray(item.rects) && item.rects.length === 0) {
    throw new DrawScriptValidationError(`items[${index}].rects must contain at least one rect`);
  }

  const rects = Array.isArray(item.rects)
    ? item.rects.map((rect, rectIndex) => normalizeRect(rect, `items[${index}].rects[${rectIndex}]`))
    : undefined;

  return {
    id,
    kind: "spotlight",
    remove,
    rects,
    style: remove ? undefined : normalizeSpotlightStyle(item.style, `items[${index}].style`),
  };
}

function normalizeItem(value: unknown, index: number): DrawItem {
  const item = expectRecord(value, `items[${index}]`);
  if (item.kind === "rect") {
    return normalizeRectItem(value, index);
  }
  if (item.kind === "line") {
    return normalizeLineItem(value, index);
  }
  if (item.kind === "xray") {
    return normalizeXrayItem(value, index);
  }
  if (item.kind === "spotlight") {
    return normalizeSpotlightItem(value, index);
  }
  if (item.kind === "marker") {
    return normalizeMarkerItem(value, index);
  }
  throw new DrawScriptValidationError(`items[${index}].kind must be "rect", "line", "xray", "spotlight", or "marker"`);
}

export function normalizeDrawScriptPayload(value: unknown): DrawScript {
  const script = expectRecord(value, "payload") as DrawScriptInput;
  const coordinateSpace = script.coordinateSpace ?? "screen";
  if (coordinateSpace !== "screen") {
    throw new DrawScriptValidationError('coordinateSpace must be "screen"');
  }

  if (!Array.isArray(script.items)) {
    throw new DrawScriptValidationError("items must be an array");
  }

  return {
    timeout: script.timeout === undefined ? undefined : expectPositiveNumber(script.timeout, "timeout"),
    coordinateSpace: "screen",
    items: script.items.map((item, index) => normalizeItem(item, index)),
  };
}

export function normalizeDrawScriptText(raw: string): DrawScript {
  if (!raw.trim()) {
    throw new DrawScriptValidationError("stdin payload is empty");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DrawScriptValidationError(`invalid JSON: ${message}`);
  }

  return normalizeDrawScriptPayload(parsed);
}
