import { join } from "path";
import type { DisplayInfo, NativeAXWindowRect } from "../a11y/native-ax.js";
import {
  RecApiError,
  buildFilmstripOffsetsMs,
  normalizeRecFilmstripRequest,
  normalizeRecImageRequest,
  type RecFilmstripRequest,
  type RecImageRequest,
  type RecRect,
  type RecSize,
  type RecStillFormat,
  type RecTarget,
} from "./protocol.js";

export interface RecRunCmdResult {
  stdout: string;
  exitCode: number;
}

export interface RecRuntimeDeps {
  screenshot(format?: string): Uint8Array | null;
  getDisplays(): DisplayInfo[];
  getWindowRects(): NativeAXWindowRect[];
  runCmd?(args: string[]): Promise<RecRunCmdResult>;
  sleep?(ms: number): Promise<void>;
  now?(): number;
}

export interface CaptureArtifact {
  bytes: Uint8Array;
  contentType: string;
  format: RecStillFormat;
}

export interface ResolvedCaptureRect {
  logicalRect: RecRect;
  pixelRect: RecRect;
}

const CORS_HEADERS = { "access-control-allow-origin": "*" };

function tempPath(label: string, ext: string): string {
  return join("/tmp", `ghost-rec-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`);
}

function rectRight(rect: RecRect): number {
  return rect.x + rect.width;
}

function rectBottom(rect: RecRect): number {
  return rect.y + rect.height;
}

function containsRect(bounds: RecRect, rect: RecRect): boolean {
  return rect.x >= bounds.x
    && rect.y >= bounds.y
    && rectRight(rect) <= rectRight(bounds)
    && rectBottom(rect) <= rectBottom(bounds);
}

function clipRect(rect: RecRect, bounds: RecRect): RecRect {
  const x = Math.max(rect.x, bounds.x);
  const y = Math.max(rect.y, bounds.y);
  const right = Math.min(rectRight(rect), rectRight(bounds));
  const bottom = Math.min(rectBottom(rect), rectBottom(bounds));
  return {
    x,
    y,
    width: Math.max(0, right - x),
    height: Math.max(0, bottom - y),
  };
}

function displayBounds(display: DisplayInfo): RecRect {
  return {
    x: display.frame.x,
    y: display.frame.y,
    width: display.frame.width,
    height: display.frame.height,
  };
}

function displayLocalRectToPixels(rect: RecRect, display: DisplayInfo): RecRect {
  const scale = display.scale || 1;
  return {
    x: Math.round(rect.x * scale),
    y: Math.round(rect.y * scale),
    width: Math.max(1, Math.round(rect.width * scale)),
    height: Math.max(1, Math.round(rect.height * scale)),
  };
}

function stillContentType(format: RecStillFormat): string {
  switch (format) {
    case "jpeg":
      return "image/jpeg";
    case "heic":
      return "image/heic";
    case "png":
    default:
      return "image/png";
  }
}

async function defaultRunCmd(args: string[]): Promise<RecRunCmdResult> {
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout: stdout.trim(), exitCode };
}

function getRunCmd(deps: RecRuntimeDeps): (args: string[]) => Promise<RecRunCmdResult> {
  return deps.runCmd ?? defaultRunCmd;
}

function getSleep(deps: RecRuntimeDeps): (ms: number) => Promise<void> {
  return deps.sleep ?? ((ms: number) => Bun.sleep(ms));
}

function getNow(deps: RecRuntimeDeps): () => number {
  return deps.now ?? Date.now;
}

async function cleanup(paths: string[]): Promise<void> {
  const existing = paths.filter(Boolean);
  if (existing.length === 0) {
    return;
  }
  try {
    await Bun.spawn(["rm", "-f", ...existing], { stdout: "ignore", stderr: "ignore" }).exited;
  } catch {}
}

async function runOrThrow(runCmd: (args: string[]) => Promise<RecRunCmdResult>, args: string[], message: string): Promise<void> {
  const result = await runCmd(args);
  if (result.exitCode !== 0) {
    throw new Error(`${message}: ${args.join(" ")}`);
  }
}

function frameOutputSize(requested: RecSize | undefined, resolvedPixelRect: RecRect): RecSize {
  return requested ?? { width: resolvedPixelRect.width, height: resolvedPixelRect.height };
}

export function getMainDisplay(displays: DisplayInfo[]): DisplayInfo {
  const main = displays.find((display) => display.main);
  if (!main) {
    throw new RecApiError("invalid_args", "Main display not available", 500);
  }
  return main;
}

export function resolveCaptureRect(target: RecTarget, display: DisplayInfo, windowRects: NativeAXWindowRect[]): ResolvedCaptureRect {
  if (target.kind === "rect") {
    const logicalRect = { ...target.rect };
    if (logicalRect.x < 0 || logicalRect.y < 0) {
      throw new RecApiError("invalid_args", "Rect target must stay on the current main display");
    }
    if (logicalRect.width <= 0 || logicalRect.height <= 0) {
      throw new RecApiError("invalid_args", "Rect target width and height must be greater than 0");
    }
    if (logicalRect.x + logicalRect.width > display.frame.width || logicalRect.y + logicalRect.height > display.frame.height) {
      throw new RecApiError("invalid_args", "Rect target must be fully on the current main display");
    }
    return {
      logicalRect,
      pixelRect: displayLocalRectToPixels(logicalRect, display),
    };
  }

  const windowRect = windowRects.find((item) => Number(item.cgWindowId || 0) === target.cgWindowId);
  if (!windowRect) {
    throw new RecApiError("invalid_args", `Window not found: ${target.cgWindowId}`, 404);
  }
  if (windowRect.w <= 0 || windowRect.h <= 0) {
    throw new RecApiError("invalid_args", `Window has no visible bounds: ${target.cgWindowId}`);
  }

  const screenRect: RecRect = {
    x: windowRect.x,
    y: windowRect.y,
    width: windowRect.w,
    height: windowRect.h,
  };
  const bounds = displayBounds(display);
  if (!containsRect(bounds, screenRect)) {
    throw new RecApiError("invalid_args", `Window ${target.cgWindowId} must be fully on the current main display`);
  }

  const clipped = clipRect(screenRect, bounds);
  if (clipped.width <= 0 || clipped.height <= 0) {
    throw new RecApiError("invalid_args", `Window ${target.cgWindowId} is not visible on the current main display`);
  }

  const logicalRect: RecRect = {
    x: clipped.x - display.frame.x,
    y: clipped.y - display.frame.y,
    width: clipped.width,
    height: clipped.height,
  };
  return {
    logicalRect,
    pixelRect: displayLocalRectToPixels(logicalRect, display),
  };
}

async function cropFrameToPng(
  fullScreenshot: Uint8Array,
  cropPx: RecRect,
  frameSize: RecSize,
  runCmd: (args: string[]) => Promise<RecRunCmdResult>,
): Promise<string> {
  const fullPath = tempPath("full", "png");
  const croppedPath = tempPath("crop", "png");
  const sizedPath = tempPath("frame", "png");
  await Bun.write(fullPath, fullScreenshot);
  try {
    await runOrThrow(runCmd, [
      "sips",
      fullPath,
      "-c", String(cropPx.height), String(cropPx.width),
      "--cropOffset", String(cropPx.y), String(cropPx.x),
      "--out", croppedPath,
    ], "Failed to crop capture frame");

    if (cropPx.width === frameSize.width && cropPx.height === frameSize.height) {
      await Bun.write(sizedPath, Bun.file(croppedPath));
      return sizedPath;
    }

    await runOrThrow(runCmd, [
      "sips",
      croppedPath,
      "-z", String(frameSize.height), String(frameSize.width),
      "--out", sizedPath,
    ], "Failed to resize capture frame");
    return sizedPath;
  } finally {
    await cleanup([fullPath, croppedPath]);
  }
}

async function convertPngToStillFormat(
  pngPath: string,
  format: RecStillFormat,
  runCmd: (args: string[]) => Promise<RecRunCmdResult>,
): Promise<string> {
  if (format === "png") {
    return pngPath;
  }
  const outPath = tempPath("artifact", format === "jpeg" ? "jpg" : "heic");
  const args = ["sips", "-s", "format", format];
  if (format === "jpeg") {
    args.push("-s", "formatOptions", "85");
  }
  args.push(pngPath, "--out", outPath);
  await runOrThrow(runCmd, args, `Failed to transcode ${format}`);
  return outPath;
}

async function composeFilmstripPng(
  framePaths: string[],
  grid: { cols: number; rows: number },
  frameSize: RecSize,
  runCmd: (args: string[]) => Promise<RecRunCmdResult>,
): Promise<string> {
  const outPath = tempPath("filmstrip", "png");
  const script = `
import AppKit

let args = CommandLine.arguments
let outPath = args[1]
let cols = Int(args[2])!
let rows = Int(args[3])!
let frameWidth = Int(args[4])!
let frameHeight = Int(args[5])!
let framePaths = Array(args.dropFirst(6))

let canvasWidth = cols * frameWidth
let canvasHeight = rows * frameHeight
guard let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: canvasWidth,
    pixelsHigh: canvasHeight,
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0,
    bitsPerPixel: 0
) else {
    fputs("failed to allocate filmstrip bitmap\\n", stderr)
    exit(2)
}

guard let context = NSGraphicsContext(bitmapImageRep: rep) else {
    fputs("failed to create filmstrip graphics context\\n", stderr)
    exit(3)
}

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = context
NSColor.clear.set()
NSRect(x: 0, y: 0, width: canvasWidth, height: canvasHeight).fill()

for (index, path) in framePaths.enumerated() {
    guard let frame = NSImage(contentsOfFile: path) else {
        fputs("failed to load frame: \\(path)\\n", stderr)
        exit(4)
    }
    let col = index % cols
    let row = index / cols
    let rect = NSRect(
        x: col * frameWidth,
        y: (rows - row - 1) * frameHeight,
        width: frameWidth,
        height: frameHeight
    )
    frame.draw(in: rect, from: NSRect(origin: .zero, size: frame.size), operation: .copy, fraction: 1.0)
}

NSGraphicsContext.restoreGraphicsState()

guard let png = rep.representation(using: .png, properties: [:]) else {
    fputs("failed to encode filmstrip png\\n", stderr)
    exit(5)
}

do {
    try png.write(to: URL(fileURLWithPath: outPath))
} catch {
    fputs("failed to write filmstrip png: \\(error)\\n", stderr)
    exit(6)
}
`;
  await runOrThrow(runCmd, [
    "swift",
    "-e",
    script,
    outPath,
    String(grid.cols),
    String(grid.rows),
    String(frameSize.width),
    String(frameSize.height),
    ...framePaths,
  ], "Failed to compose filmstrip");
  return outPath;
}

async function readArtifact(path: string): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(path).arrayBuffer());
}

async function renderImageCapture(request: RecImageRequest, deps: RecRuntimeDeps): Promise<CaptureArtifact> {
  const display = getMainDisplay(deps.getDisplays());
  const resolved = resolveCaptureRect(request.target, display, deps.getWindowRects());
  const outputSize = frameOutputSize(request.frameSize, resolved.pixelRect);
  const screenshot = deps.screenshot("png");
  if (!screenshot) {
    throw new Error("Failed to capture screenshot");
  }

  const runCmd = getRunCmd(deps);
  const framePng = await cropFrameToPng(screenshot, resolved.pixelRect, outputSize, runCmd);
  let finalPath: string | undefined;
  try {
    finalPath = await convertPngToStillFormat(framePng, request.format, runCmd);
    return {
      bytes: await readArtifact(finalPath),
      contentType: stillContentType(request.format),
      format: request.format,
    };
  } finally {
    await cleanup([framePng, finalPath || ""]);
  }
}

export async function renderRecImage(request: RecImageRequest, deps: RecRuntimeDeps): Promise<CaptureArtifact> {
  return renderImageCapture(request, deps);
}

export async function renderRecFilmstrip(request: RecFilmstripRequest, deps: RecRuntimeDeps): Promise<CaptureArtifact> {
  const offsets = buildFilmstripOffsetsMs(request);
  const framePaths: string[] = [];
  const runCmd = getRunCmd(deps);
  const sleep = getSleep(deps);
  const now = getNow(deps);
  let outputFrameSize: RecSize | undefined;
  const startedAt = now();

  try {
    for (let index = 0; index < offsets.length; index++) {
      const delayMs = offsets[index]! - (now() - startedAt);
      if (delayMs > 0) {
        await sleep(delayMs);
      }
      const display = getMainDisplay(deps.getDisplays());
      const resolved = resolveCaptureRect(request.target, display, deps.getWindowRects());
      const screenshot = deps.screenshot("png");
      if (!screenshot) {
        throw new Error("Failed to capture screenshot");
      }
      outputFrameSize = outputFrameSize ?? frameOutputSize(request.frameSize, resolved.pixelRect);
      framePaths.push(await cropFrameToPng(screenshot, resolved.pixelRect, outputFrameSize, runCmd));
    }

    if (!outputFrameSize) {
      throw new Error("Filmstrip capture produced no frames");
    }

    const sheetPng = await composeFilmstripPng(framePaths, request.grid, outputFrameSize, runCmd);
    let finalPath: string | undefined;
    try {
      finalPath = await convertPngToStillFormat(sheetPng, request.format, runCmd);
      return {
        bytes: await readArtifact(finalPath),
        contentType: stillContentType(request.format),
        format: request.format,
      };
    } finally {
      await cleanup([sheetPng, finalPath || ""]);
    }
  } finally {
    await cleanup(framePaths);
  }
}

function runtimeErrorResponse(error: unknown): Response {
  if (error instanceof RecApiError) {
    return new Response(error.message, { status: error.status, headers: CORS_HEADERS });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new Response(message, { status: 502, headers: CORS_HEADERS });
}

export async function handleRecRoute(req: Request, url: URL, deps: RecRuntimeDeps): Promise<Response | null> {
  if (req.method === "OPTIONS" && (url.pathname === "/api/rec/image" || url.pathname === "/api/rec/filmstrip" || url.pathname === "/api/rec/video")) {
    return new Response(null, {
      status: 204,
      headers: {
        ...CORS_HEADERS,
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      },
    });
  }

  if (req.method !== "POST") {
    return null;
  }

  try {
    if (url.pathname === "/api/rec/image") {
      const artifact = await renderRecImage(normalizeRecImageRequest(await req.json()), deps);
      return new Response(Buffer.from(artifact.bytes), {
        headers: {
          ...CORS_HEADERS,
          "cache-control": "no-cache",
          "content-type": artifact.contentType,
        },
      });
    }

    if (url.pathname === "/api/rec/filmstrip") {
      const artifact = await renderRecFilmstrip(normalizeRecFilmstripRequest(await req.json()), deps);
      return new Response(Buffer.from(artifact.bytes), {
        headers: {
          ...CORS_HEADERS,
          "cache-control": "no-cache",
          "content-type": artifact.contentType,
        },
      });
    }

    if (url.pathname === "/api/rec/video") {
      return new Response("gui rec video is not shipped yet; native recorder is not implemented", {
        status: 501,
        headers: CORS_HEADERS,
      });
    }
  } catch (error: unknown) {
    return runtimeErrorResponse(error);
  }

  return null;
}
