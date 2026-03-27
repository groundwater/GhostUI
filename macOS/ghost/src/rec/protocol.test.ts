import { describe, expect, test } from "bun:test";
import {
  RecApiError,
  buildFilmstripOffsetsMs,
  normalizeRecFilmstripRequest,
  normalizeRecImageRequest,
  parseRecDurationMs,
  parseRecFilmstripCLIArgs,
  parseRecImageCLIArgs,
} from "./protocol.js";

describe("rec protocol parsing", () => {
  test("parses image CLI args for a rect target", () => {
    const parsed = parseRecImageCLIArgs([
      "--rect", "100,120,1440,900",
      "--frame-size", "1280x800",
      "--format", "heic",
      "--out", "shot.heic",
    ]);

    expect(parsed.outPath).toBe("shot.heic");
    expect(parsed.request).toEqual({
      target: {
        kind: "rect",
        rect: { x: 100, y: 120, width: 1440, height: 900 },
      },
      frameSize: { width: 1280, height: 800 },
      format: "heic",
    });
  });

  test("rejects image CLI args when both rect and window are provided", () => {
    expect(() => parseRecImageCLIArgs([
      "--rect", "0,0,100,100",
      "--window", "123",
    ])).toThrow("exactly one of --rect or --window is required");
  });

  test("parses filmstrip CLI args with --every timing", () => {
    const parsed = parseRecFilmstripCLIArgs([
      "--window", "13801",
      "--grid", "3x3",
      "--every", "5s",
      "--frame-size", "320x200",
      "--out", "strip.png",
    ]);

    expect(parsed.outPath).toBe("strip.png");
    expect(parsed.request).toEqual({
      target: { kind: "window", cgWindowId: 13801 },
      grid: { cols: 3, rows: 3 },
      timing: { kind: "every", everyMs: 5000 },
      frameSize: { width: 320, height: 200 },
      format: "png",
    });
  });

  test("parses filmstrip CLI args with duration and frames", () => {
    const parsed = parseRecFilmstripCLIArgs([
      "--rect", "40,60,1200,800",
      "--grid", "4x2",
      "--duration", "40s",
      "--frames", "8",
      "--format", "jpeg",
    ]);

    expect(parsed.request.timing).toEqual({
      kind: "duration",
      durationMs: 40_000,
      frames: 8,
    });
    expect(parsed.request.format).toBe("jpeg");
  });

  test("rejects filmstrip duration when frames do not match the grid cell count", () => {
    expect(() => parseRecFilmstripCLIArgs([
      "--rect", "0,0,400,300",
      "--grid", "2x2",
      "--duration", "10s",
      "--frames", "3",
    ])).toThrow("--frames must equal grid cell count (4)");
  });

  test("requires a duration suffix", () => {
    expect(() => parseRecDurationMs("5", "--every")).toThrow("must use a duration");
  });

  test("builds offsets for every timing", () => {
    const offsets = buildFilmstripOffsetsMs({
      target: { kind: "rect", rect: { x: 0, y: 0, width: 100, height: 80 } },
      grid: { cols: 2, rows: 2 },
      timing: { kind: "every", everyMs: 5000 },
      format: "png",
    });

    expect(offsets).toEqual([0, 5000, 10000, 15000]);
  });

  test("builds offsets for duration timing including the final frame at t=duration", () => {
    const offsets = buildFilmstripOffsetsMs({
      target: { kind: "rect", rect: { x: 0, y: 0, width: 100, height: 80 } },
      grid: { cols: 4, rows: 2 },
      timing: { kind: "duration", durationMs: 40_000, frames: 8 },
      format: "png",
    });

    expect(offsets[0]).toBe(0);
    expect(offsets[offsets.length - 1]).toBe(40_000);
    expect(offsets).toHaveLength(8);
  });

  test("normalizes image request bodies", () => {
    expect(normalizeRecImageRequest({
      target: { kind: "window", cgWindowId: 42 },
      frameSize: { width: 1280, height: 720 },
      format: "jpeg",
    })).toEqual({
      target: { kind: "window", cgWindowId: 42 },
      frameSize: { width: 1280, height: 720 },
      format: "jpeg",
    });
  });

  test("normalizes filmstrip request bodies and enforces frame count", () => {
    expect(() => normalizeRecFilmstripRequest({
      target: { kind: "window", cgWindowId: 42 },
      grid: { cols: 2, rows: 2 },
      timing: { kind: "duration", durationMs: 10_000, frames: 3 },
    })).toThrow("timing.frames must equal grid cell count (4)");
  });

  test("uses a not implemented error for video", () => {
    const error = new RecApiError("not_implemented", "not shipped");
    expect(error.status).toBe(501);
  });
});
