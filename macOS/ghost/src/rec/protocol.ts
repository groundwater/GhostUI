export type RecMode = "image" | "filmstrip" | "video";
export type RecStillFormat = "png" | "jpeg" | "heic";
export type RecVideoFormat = "mov";
export type RecVideoCodec = "h264";

export interface RecRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RecSize {
  width: number;
  height: number;
}

export interface RecGrid {
  cols: number;
  rows: number;
}

export type RecTarget =
  | { kind: "rect"; rect: RecRect }
  | { kind: "window"; cgWindowId: number };

export type RecFilmstripTiming =
  | { kind: "every"; everyMs: number }
  | { kind: "fps"; fps: number }
  | { kind: "duration"; durationMs: number; frames: number };

export interface RecImageRequest {
  target: RecTarget;
  frameSize?: RecSize;
  format: RecStillFormat;
}

export interface RecFilmstripRequest {
  target: RecTarget;
  grid: RecGrid;
  timing: RecFilmstripTiming;
  frameSize?: RecSize;
  format: RecStillFormat;
}

export interface RecVideoRequest {
  target: RecTarget;
  fps: number;
  durationMs: number;
  frameSize?: RecSize;
  format: RecVideoFormat;
  codec: RecVideoCodec;
}

export class RecApiError extends Error {
  readonly code: "invalid_args" | "not_implemented";
  readonly status: number;

  constructor(code: "invalid_args" | "not_implemented", message: string, status = code === "not_implemented" ? 501 : 400) {
    super(message);
    this.name = "RecApiError";
    this.code = code;
    this.status = status;
  }
}

export class RecProtocolError extends RecApiError {
  readonly usageTopic?: string;

  constructor(message: string, usageTopic?: string, status = 400) {
    super(status === 501 ? "not_implemented" : "invalid_args", message, status);
    this.name = "RecProtocolError";
    this.usageTopic = usageTopic;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new RecApiError("invalid_args", `${label} must be an object`);
  }
  return value;
}

function expectFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RecApiError("invalid_args", `${label} must be a finite number`);
  }
  return value;
}

function expectPositiveNumber(value: unknown, label: string): number {
  const parsed = expectFiniteNumber(value, label);
  if (parsed <= 0) {
    throw new RecApiError("invalid_args", `${label} must be greater than 0`);
  }
  return parsed;
}

function expectPositiveInteger(value: unknown, label: string): number {
  const parsed = expectPositiveNumber(value, label);
  if (!Number.isInteger(parsed)) {
    throw new RecApiError("invalid_args", `${label} must be an integer`);
  }
  return parsed;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RecApiError("invalid_args", `${label} must be a non-empty string`);
  }
  return value.trim();
}

function requireOptionValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new RecApiError("invalid_args", `${flag} requires a value`);
  }
  return value;
}

function takeOptionalFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) {
    return undefined;
  }
  const value = requireOptionValue(args, index, flag);
  args.splice(index, 2);
  if (args.includes(flag)) {
    throw new RecApiError("invalid_args", `${flag} may only be provided once`);
  }
  return value;
}

export function parseRecDurationMs(value: string, label: string): number {
  const trimmed = expectString(value, label).toLowerCase();
  const match = trimmed.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/);
  if (!match) {
    throw new RecApiError("invalid_args", `${label} must use a duration like 500ms, 5s, 2m, or 1h`);
  }
  const amount = Number(match[1]);
  const unit = match[2];
  const factor = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
  return expectPositiveNumber(amount * factor, label);
}

export function parseRecRect(value: string, label: string): RecRect {
  const match = expectString(value, label).match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/);
  if (!match) {
    throw new RecApiError("invalid_args", `${label} must be x,y,w,h`);
  }
  const rect = {
    x: Number(match[1]),
    y: Number(match[2]),
    width: Number(match[3]),
    height: Number(match[4]),
  };
  if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y) || !Number.isFinite(rect.width) || !Number.isFinite(rect.height)) {
    throw new RecApiError("invalid_args", `${label} must contain only finite numbers`);
  }
  if (rect.width <= 0 || rect.height <= 0) {
    throw new RecApiError("invalid_args", `${label} width and height must be greater than 0`);
  }
  return rect;
}

export function parseRecSize(value: string, label: string): RecSize {
  const match = expectString(value, label).match(/^(\d+)x(\d+)$/i);
  if (!match) {
    throw new RecApiError("invalid_args", `${label} must be <width>x<height>`);
  }
  return {
    width: expectPositiveInteger(Number(match[1]), `${label} width`),
    height: expectPositiveInteger(Number(match[2]), `${label} height`),
  };
}

export function parseRecGrid(value: string, label: string): RecGrid {
  const match = expectString(value, label).match(/^(\d+)x(\d+)$/i);
  if (!match) {
    throw new RecApiError("invalid_args", `${label} must be <cols>x<rows>`);
  }
  return {
    cols: expectPositiveInteger(Number(match[1]), `${label} cols`),
    rows: expectPositiveInteger(Number(match[2]), `${label} rows`),
  };
}

export function parseRecStillFormat(value: string, label: string): RecStillFormat {
  const normalized = expectString(value, label).toLowerCase();
  if (normalized !== "png" && normalized !== "jpeg" && normalized !== "heic") {
    throw new RecApiError("invalid_args", `${label} must be one of png, jpeg, heic`);
  }
  return normalized;
}

function normalizeRecTarget(value: unknown): RecTarget {
  const record = expectRecord(value, "target");
  const kind = expectString(record.kind, "target.kind").toLowerCase();
  if (kind === "rect") {
    const rect = expectRecord(record.rect, "target.rect");
    return {
      kind: "rect",
      rect: {
        x: expectFiniteNumber(rect.x, "target.rect.x"),
        y: expectFiniteNumber(rect.y, "target.rect.y"),
        width: expectPositiveNumber(rect.width, "target.rect.width"),
        height: expectPositiveNumber(rect.height, "target.rect.height"),
      },
    };
  }
  if (kind === "window") {
    return {
      kind: "window",
      cgWindowId: expectPositiveInteger(record.cgWindowId, "target.cgWindowId"),
    };
  }
  throw new RecApiError("invalid_args", `target.kind must be rect or window`);
}

function normalizeRecSize(value: unknown, label: string): RecSize {
  const record = expectRecord(value, label);
  return {
    width: expectPositiveInteger(record.width, `${label}.width`),
    height: expectPositiveInteger(record.height, `${label}.height`),
  };
}

function normalizeRecGrid(value: unknown, label: string): RecGrid {
  const record = expectRecord(value, label);
  return {
    cols: expectPositiveInteger(record.cols, `${label}.cols`),
    rows: expectPositiveInteger(record.rows, `${label}.rows`),
  };
}

function normalizeRecTiming(value: unknown): RecFilmstripTiming {
  const record = expectRecord(value, "timing");
  const kind = expectString(record.kind, "timing.kind").toLowerCase();
  if (kind === "every") {
    return { kind: "every", everyMs: expectPositiveNumber(record.everyMs, "timing.everyMs") };
  }
  if (kind === "fps") {
    return { kind: "fps", fps: expectPositiveNumber(record.fps, "timing.fps") };
  }
  if (kind === "duration") {
    return {
      kind: "duration",
      durationMs: expectPositiveNumber(record.durationMs, "timing.durationMs"),
      frames: expectPositiveInteger(record.frames, "timing.frames"),
    };
  }
  throw new RecApiError("invalid_args", `timing.kind must be every, fps, or duration`);
}

export function filmstripCellCount(grid: RecGrid): number {
  return grid.cols * grid.rows;
}

export function buildFilmstripOffsetsMs(request: RecFilmstripRequest): number[] {
  const frameCount = filmstripCellCount(request.grid);
  const timing = request.timing;
  switch (timing.kind) {
    case "every":
      return Array.from({ length: frameCount }, (_, index) => index * timing.everyMs);
    case "fps":
      return Array.from({ length: frameCount }, (_, index) => index * (1000 / timing.fps));
    case "duration": {
      if (timing.frames !== frameCount) {
        throw new RecApiError("invalid_args", `--frames must equal grid cell count (${frameCount})`);
      }
      if (timing.frames === 1) {
        return [0];
      }
      const spacing = timing.durationMs / (timing.frames - 1);
      return Array.from({ length: timing.frames }, (_, index) => index * spacing);
    }
  }
}

export function normalizeRecImageRequest(value: unknown): RecImageRequest {
  const record = expectRecord(value, "rec image body");
  return {
    target: normalizeRecTarget(record.target),
    frameSize: record.frameSize === undefined ? undefined : normalizeRecSize(record.frameSize, "frameSize"),
    format: record.format === undefined ? "png" : parseRecStillFormat(expectString(record.format, "format"), "format"),
  };
}

export function normalizeRecFilmstripRequest(value: unknown): RecFilmstripRequest {
  const record = expectRecord(value, "rec filmstrip body");
  const request: RecFilmstripRequest = {
    target: normalizeRecTarget(record.target),
    grid: normalizeRecGrid(record.grid, "grid"),
    timing: normalizeRecTiming(record.timing),
    frameSize: record.frameSize === undefined ? undefined : normalizeRecSize(record.frameSize, "frameSize"),
    format: record.format === undefined ? "png" : parseRecStillFormat(expectString(record.format, "format"), "format"),
  };
  const frameCount = filmstripCellCount(request.grid);
  if (request.timing.kind === "duration" && request.timing.frames !== frameCount) {
    throw new RecApiError("invalid_args", `timing.frames must equal grid cell count (${frameCount})`);
  }
  return request;
}

export function normalizeRecVideoRequest(_value: unknown): RecVideoRequest {
  throw new RecApiError("not_implemented", "gui rec video is not shipped yet; native recorder is not implemented");
}

function parseRecTargetFromCLI(args: string[]): RecTarget {
  const rectValue = takeOptionalFlagValue(args, "--rect");
  const windowValue = takeOptionalFlagValue(args, "--window");
  if ((rectValue ? 1 : 0) + (windowValue ? 1 : 0) !== 1) {
    throw new RecApiError("invalid_args", `exactly one of --rect or --window is required`);
  }
  if (rectValue) {
    return { kind: "rect", rect: parseRecRect(rectValue, "--rect") };
  }
  return {
    kind: "window",
    cgWindowId: expectPositiveInteger(Number(windowValue), "--window"),
  };
}

function finalizeCLIArgs(args: string[], context: string): void {
  if (args.length > 0) {
    throw new RecApiError("invalid_args", `Unknown ${context} args: ${args.join(" ")}`);
  }
}

export function parseRecImageCLIArgs(args: string[]): { request: RecImageRequest; outPath?: string } {
  const rest = [...args];
  const target = parseRecTargetFromCLI(rest);
  const frameSizeValue = takeOptionalFlagValue(rest, "--frame-size");
  const formatValue = takeOptionalFlagValue(rest, "--format");
  const outPath = takeOptionalFlagValue(rest, "--out");
  if (takeOptionalFlagValue(rest, "--grid") !== undefined
    || takeOptionalFlagValue(rest, "--every") !== undefined
    || takeOptionalFlagValue(rest, "--fps") !== undefined
    || takeOptionalFlagValue(rest, "--duration") !== undefined
    || takeOptionalFlagValue(rest, "--frames") !== undefined) {
    throw new RecApiError("invalid_args", "image mode does not accept filmstrip timing flags");
  }
  finalizeCLIArgs(rest, "rec image");
  return {
    outPath,
    request: {
      target,
      frameSize: frameSizeValue ? parseRecSize(frameSizeValue, "--frame-size") : undefined,
      format: formatValue ? parseRecStillFormat(formatValue, "--format") : "png",
    },
  };
}

export function parseRecFilmstripCLIArgs(args: string[]): { request: RecFilmstripRequest; outPath?: string } {
  const rest = [...args];
  const target = parseRecTargetFromCLI(rest);
  const gridValue = takeOptionalFlagValue(rest, "--grid");
  if (!gridValue) {
    throw new RecApiError("invalid_args", "--grid is required");
  }
  const grid = parseRecGrid(gridValue, "--grid");
  const frameSizeValue = takeOptionalFlagValue(rest, "--frame-size");
  const formatValue = takeOptionalFlagValue(rest, "--format");
  const outPath = takeOptionalFlagValue(rest, "--out");
  const everyValue = takeOptionalFlagValue(rest, "--every");
  const fpsValue = takeOptionalFlagValue(rest, "--fps");
  const durationValue = takeOptionalFlagValue(rest, "--duration");
  const framesValue = takeOptionalFlagValue(rest, "--frames");

  const timingModeCount = [everyValue, fpsValue, durationValue].filter((value) => value !== undefined).length;
  if (timingModeCount !== 1) {
    throw new RecApiError("invalid_args", "filmstrip requires exactly one of --every, --fps, or --duration with --frames");
  }

  const cellCount = filmstripCellCount(grid);
  let timing: RecFilmstripTiming;
  if (everyValue !== undefined) {
    if (framesValue !== undefined) {
      throw new RecApiError("invalid_args", "--frames is only valid with --duration");
    }
    timing = { kind: "every", everyMs: parseRecDurationMs(everyValue, "--every") };
  } else if (fpsValue !== undefined) {
    if (framesValue !== undefined) {
      throw new RecApiError("invalid_args", "--frames is only valid with --duration");
    }
    timing = { kind: "fps", fps: expectPositiveNumber(Number(fpsValue), "--fps") };
  } else {
    if (durationValue === undefined || framesValue === undefined) {
      throw new RecApiError("invalid_args", "--duration requires --frames");
    }
    const frames = expectPositiveInteger(Number(framesValue), "--frames");
    if (frames !== cellCount) {
      throw new RecApiError("invalid_args", `--frames must equal grid cell count (${cellCount})`);
    }
    timing = {
      kind: "duration",
      durationMs: parseRecDurationMs(durationValue, "--duration"),
      frames,
    };
  }

  finalizeCLIArgs(rest, "rec filmstrip");
  return {
    outPath,
    request: {
      target,
      grid,
      timing,
      frameSize: frameSizeValue ? parseRecSize(frameSizeValue, "--frame-size") : undefined,
      format: formatValue ? parseRecStillFormat(formatValue, "--format") : "png",
    },
  };
}

export function parseRecCLIArgs(args: string[]):
  | { mode: "image"; request: RecImageRequest; outPath?: string }
  | { mode: "filmstrip"; request: RecFilmstripRequest; outPath?: string } {
  const [mode, ...rest] = args;
  if (!mode) {
    throw new RecProtocolError("rec requires a mode: image, filmstrip, or video", "rec");
  }

  try {
    if (mode === "image") {
      const parsed = parseRecImageCLIArgs(rest);
      return { mode, ...parsed };
    }
    if (mode === "filmstrip") {
      const parsed = parseRecFilmstripCLIArgs(rest);
      return { mode, ...parsed };
    }
    if (mode === "video") {
      throw new RecProtocolError("gui rec video is not shipped yet; native recorder is not implemented", "rec video", 501);
    }
    throw new RecProtocolError(`Unknown rec mode: ${mode}`, "rec");
  } catch (error) {
    if (error instanceof RecProtocolError) {
      throw error;
    }
    if (error instanceof RecApiError) {
      throw new RecProtocolError(error.message, `rec ${mode}`);
    }
    throw error;
  }
}
