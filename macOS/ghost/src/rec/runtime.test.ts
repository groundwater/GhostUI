import { describe, expect, test } from "bun:test";
import type { DisplayInfo, NativeAXWindowRect } from "../a11y/native-ax.js";
import { buildFilmstripOffsetsMs } from "./protocol.js";
import { getMainDisplay, handleRecRoute, renderRecFilmstrip, renderRecImage, resolveCaptureRect } from "./runtime.js";

const ONE_BY_ONE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO9lW1cAAAAASUVORK5CYII=",
  "base64",
);

const mainDisplay: DisplayInfo = {
  id: 1,
  name: "Built-in Retina Display",
  main: true,
  frame: { x: 0, y: 0, width: 1, height: 1 },
  visibleFrame: { x: 0, y: 0, width: 1, height: 1 },
  scale: 1,
  physicalSize: { width: 345, height: 223 },
  rotation: 0,
};

async function imageDimensions(bytes: Uint8Array): Promise<{ width: number; height: number }> {
  const path = `/tmp/ghost-rec-test-${Date.now()}-${Math.random().toString(16).slice(2)}.png`;
  await Bun.write(path, bytes);
  try {
    const proc = Bun.spawn(["sips", "-g", "pixelWidth", "-g", "pixelHeight", path], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    const width = Number(stdout.match(/pixelWidth:\s*(\d+)/)?.[1] || "0");
    const height = Number(stdout.match(/pixelHeight:\s*(\d+)/)?.[1] || "0");
    return { width, height };
  } finally {
    await Bun.spawn(["rm", "-f", path]).exited;
  }
}

function makeDeps(overrides: Partial<{
  displays: DisplayInfo[];
  windows: NativeAXWindowRect[];
  screenshot: Uint8Array | null;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}> = {}) {
  return {
    getDisplays: () => overrides.displays ?? [mainDisplay],
    getWindowRects: () => overrides.windows ?? [],
    screenshot: () => overrides.screenshot ?? ONE_BY_ONE_PNG,
    sleep: overrides.sleep,
    now: overrides.now,
  };
}

describe("rec runtime helpers", () => {
  test("selects the main display when present", () => {
    expect(getMainDisplay([
      { ...mainDisplay, id: 2, main: false },
      mainDisplay,
    ])).toEqual(mainDisplay);
  });

  test("resolves rect targets in display-local coordinates", () => {
    const resolved = resolveCaptureRect({
      kind: "rect",
      rect: { x: 0, y: 0, width: 1, height: 1 },
    }, mainDisplay, []);

    expect(resolved.logicalRect).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(resolved.pixelRect).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  test("rejects rect targets outside the main display", () => {
    expect(() => resolveCaptureRect({
      kind: "rect",
      rect: { x: 1, y: 0, width: 1, height: 1 },
    }, mainDisplay, [])).toThrow("Rect target must be fully on the current main display");
  });

  test("resolves window targets using cgWindowId and display offsets", () => {
    const display: DisplayInfo = {
      ...mainDisplay,
      frame: { x: 100, y: 50, width: 1728, height: 1117 },
      visibleFrame: { x: 100, y: 50, width: 1728, height: 1117 },
      scale: 2,
    };
    const windows: NativeAXWindowRect[] = [{
      pid: 99,
      cgWindowId: 123,
      x: 140,
      y: 90,
      w: 500,
      h: 300,
      layer: 0,
      title: "Test Window",
    }];

    const resolved = resolveCaptureRect({ kind: "window", cgWindowId: 123 }, display, windows);
    expect(resolved.logicalRect).toEqual({ x: 40, y: 40, width: 500, height: 300 });
    expect(resolved.pixelRect).toEqual({ x: 80, y: 80, width: 1000, height: 600 });
  });

  test("rejects missing windows", () => {
    expect(() => resolveCaptureRect(
      { kind: "window", cgWindowId: 999 },
      mainDisplay,
      [],
    )).toThrow("Window not found: 999");
  });

  test("builds filmstrip offsets with anchored duration endpoints", () => {
    expect(buildFilmstripOffsetsMs({
      target: { kind: "rect", rect: { x: 0, y: 0, width: 1, height: 1 } },
      grid: { cols: 2, rows: 2 },
      timing: { kind: "duration", durationMs: 9000, frames: 4 },
      format: "png",
    })).toEqual([0, 3000, 6000, 9000]);
  });
});

describe("rec runtime capture", () => {
  test("renders image captures as png bytes", async () => {
    const artifact = await renderRecImage({
      target: { kind: "rect", rect: { x: 0, y: 0, width: 1, height: 1 } },
      format: "png",
    }, makeDeps());

    expect(artifact.contentType).toBe("image/png");
    const dims = await imageDimensions(artifact.bytes);
    expect(dims).toEqual({ width: 1, height: 1 });
  });

  test("renders filmstrips with expected grid dimensions", async () => {
    const artifact = await renderRecFilmstrip({
      target: { kind: "rect", rect: { x: 0, y: 0, width: 1, height: 1 } },
      grid: { cols: 2, rows: 1 },
      timing: { kind: "every", everyMs: 1 },
      frameSize: { width: 1, height: 1 },
      format: "png",
    }, makeDeps({
      sleep: async () => {},
      now: () => 0,
    }));

    expect(artifact.contentType).toBe("image/png");
    const dims = await imageDimensions(artifact.bytes);
    expect(dims).toEqual({ width: 2, height: 1 });
  });
});

describe("rec route handling", () => {
  test("serves image bytes from the rec image route", async () => {
    const response = await handleRecRoute(new Request("http://localhost:7861/api/rec/image", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        target: { kind: "rect", rect: { x: 0, y: 0, width: 1, height: 1 } },
      }),
    }), new URL("http://localhost:7861/api/rec/image"), makeDeps());

    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    expect(response!.headers.get("content-type")).toBe("image/png");
  });

  test("returns a 404 for missing windows", async () => {
    const response = await handleRecRoute(new Request("http://localhost:7861/api/rec/image", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        target: { kind: "window", cgWindowId: 999 },
      }),
    }), new URL("http://localhost:7861/api/rec/image"), makeDeps());

    expect(response).not.toBeNull();
    expect(response!.status).toBe(404);
    expect(await response!.text()).toContain("Window not found");
  });

  test("answers CORS preflight for rec routes", async () => {
    const response = await handleRecRoute(
      new Request("http://localhost:7861/api/rec/filmstrip", { method: "OPTIONS" }),
      new URL("http://localhost:7861/api/rec/filmstrip"),
      makeDeps(),
    );
    expect(response).not.toBeNull();
    expect(response!.status).toBe(204);
    expect(response!.headers.get("access-control-allow-methods")).toContain("POST");
  });
});
