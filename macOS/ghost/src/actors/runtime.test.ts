import { describe, expect, test } from "bun:test";
import type { DisplayInfo } from "../a11y/native-ax.js";
import { ActorApiError } from "./protocol.js";
import { ActorRuntime } from "./runtime.js";

function makeDisplays(): DisplayInfo[] {
  return [
    {
      id: 1,
      name: "Main",
      main: true,
      frame: { x: 0, y: 0, width: 1440, height: 900 },
      visibleFrame: { x: 0, y: 25, width: 1440, height: 875 },
      scale: 2,
      physicalSize: { width: 345, height: 223 },
      rotation: 0,
    },
    {
      id: 2,
      name: "Sidecar",
      main: false,
      frame: { x: 1440, y: 0, width: 1280, height: 800 },
      visibleFrame: { x: 1440, y: 25, width: 1280, height: 775 },
      scale: 2,
      physicalSize: { width: 300, height: 200 },
      rotation: 0,
    },
  ];
}

function makeRuntimeWithMouse(posted: string[], mousePosition: { x: number; y: number }): ActorRuntime {
  return new ActorRuntime({
    getDisplays: () => makeDisplays(),
    getMousePosition: () => mousePosition,
    postOverlay: (_kind, payload) => {
      posted.push(payload);
    },
  });
}

describe("actor runtime", () => {
  test("spawns, lists, and kills actors", () => {
    const posted: string[] = [];
    const runtime = makeRuntimeWithMouse(posted, { x: 640, y: 360 });

    expect(runtime.spawn({ type: "pointer", name: "pointer", durationScale: 1 })).toEqual({
      ok: true,
      name: "pointer",
      type: "pointer",
      durationScale: 1,
    });
    expect(runtime.list()).toEqual({
      ok: true,
      actors: [{ name: "pointer", type: "pointer" }],
    });
    expect(runtime.kill("pointer")).toEqual({
      ok: true,
      name: "pointer",
      killed: true,
    });
    expect(posted.map((payload) => JSON.parse(payload).op)).toEqual(["spawn", "kill"]);
  });

  test("supports deterministic zero-duration runs", async () => {
    const posted: string[] = [];
    const runtime = makeRuntimeWithMouse(posted, { x: 640, y: 360 });
    runtime.spawn({ type: "pointer", name: "pointer", durationScale: 0 });

    await expect(runtime.run("pointer", {
      action: {
        kind: "move",
        to: { x: 2200, y: 300 },
        style: "purposeful",
      },
    })).resolves.toEqual({
      ok: true,
      name: "pointer",
      completed: true,
    });

    expect(posted.map((payload) => JSON.parse(payload).op)).toEqual(["spawn", "move"]);
  });

  test("preempts older runs on the same actor", async () => {
    const posted: string[] = [];
    const runtime = makeRuntimeWithMouse(posted, { x: 640, y: 360 });
    runtime.spawn({ type: "pointer", name: "pointer", durationScale: 1 });

    const first = runtime.run("pointer", {
      action: {
        kind: "think",
        forMs: 100,
      },
    });

    await Bun.sleep(10);

    const second = runtime.run("pointer", {
      action: {
        kind: "dismiss",
      },
    });

    await expect(first).rejects.toMatchObject({ code: "run_preempted" });
    await expect(second).resolves.toEqual({
      ok: true,
      name: "pointer",
      completed: true,
    });
  });

  test("rejects coordinates outside the connected displays", async () => {
    const runtime = makeRuntimeWithMouse([], { x: 640, y: 360 });
    runtime.spawn({ type: "pointer", name: "pointer", durationScale: 1 });

    await expect(runtime.run("pointer", {
      action: {
        kind: "move",
        to: { x: 4000, y: 3000 },
        style: "purposeful",
      },
    })).rejects.toThrow(ActorApiError);
  });

  test("spawns and retains canvas items until clear or kill", async () => {
    const posted: string[] = [];
    const mousePosition = { x: 640, y: 360 };
    const runtime = makeRuntimeWithMouse(posted, mousePosition);

    expect(runtime.spawn({ type: "canvas", name: "canvas.notes", durationScale: 1 })).toEqual({
      ok: true,
      name: "canvas.notes",
      type: "canvas",
      durationScale: 1,
    });

    mousePosition.x = 800;
    mousePosition.y = 520;
    await expect(runtime.run("canvas.notes", {
      action: {
        kind: "draw",
        shape: "check",
        style: {
          color: "rgba(255,59,48,0.9)",
          size: 4,
          padding: 8,
        },
      },
      timeoutMs: 1,
    })).resolves.toEqual({
      ok: true,
      name: "canvas.notes",
      completed: true,
    });

    mousePosition.x = 910;
    mousePosition.y = 615;
    await expect(runtime.run("canvas.notes", {
      action: {
        kind: "text",
        text: "Working set",
        style: {
          font: "SF Pro Text",
          size: 36,
          color: "#FF3B30",
          highlight: "rgba(255,255,0,0.35)",
        },
      },
      timeoutMs: 1,
    })).resolves.toEqual({
      ok: true,
      name: "canvas.notes",
      completed: true,
    });

    await expect(runtime.run("canvas.notes", {
      action: { kind: "clear" },
      timeoutMs: 1,
    })).resolves.toEqual({
      ok: true,
      name: "canvas.notes",
      completed: true,
    });

    const messages = posted.map((payload) => JSON.parse(payload) as Record<string, unknown>);
    expect(messages[0]).toEqual({ op: "spawn", name: "canvas.notes", type: "canvas", position: { x: 640, y: 360 } });
    expect(messages[1]).toMatchObject({
      op: "draw",
      type: "canvas",
      name: "canvas.notes",
      id: "canvas.notes.draw.0",
      shape: "check",
      box: { x: 752, y: 472, width: 96, height: 96 },
      position: { x: 800, y: 520 },
      padding: 8,
      size: 4,
      color: "rgba(255,59,48,0.9)",
      opacity: 1,
    });
    expect(messages[2]).toMatchObject({
      op: "text",
      type: "canvas",
      name: "canvas.notes",
      id: "canvas.notes.text.1",
      position: { x: 910, y: 615 },
      text: "Working set",
      font: "SF Pro Text",
      size: 36,
      color: "#FF3B30",
      highlight: "rgba(255,255,0,0.35)",
    });
    expect(messages[3]).toEqual({ op: "clear", type: "canvas", name: "canvas.notes" });
    expect(messages.map((message) => message.op)).toEqual(["spawn", "draw", "text", "clear"]);

    expect(runtime.kill("canvas.notes")).toEqual({
      ok: true,
      name: "canvas.notes",
      killed: true,
    });
    expect(JSON.parse(posted.at(-1) as string)).toMatchObject({ op: "kill", name: "canvas.notes", type: "canvas" });
  });

  test("uses explicit boxes for canvas draw and text instead of the current mouse position", async () => {
    const posted: string[] = [];
    const mousePosition = { x: 640, y: 360 };
    const runtime = makeRuntimeWithMouse(posted, mousePosition);

    runtime.spawn({ type: "canvas", name: "canvas.boxed", durationScale: 1 });

    mousePosition.x = 1300;
    mousePosition.y = 720;
    await expect(runtime.run("canvas.boxed", {
      action: {
        kind: "draw",
        shape: "rect",
        style: {
          color: "#FF3B30",
          size: 5,
          padding: 12,
        },
        box: { x: 100, y: 120, width: 240, height: 180 },
      },
    })).resolves.toEqual({
      ok: true,
      name: "canvas.boxed",
      completed: true,
    });

    mousePosition.x = 50;
    mousePosition.y = 60;
    await expect(runtime.run("canvas.boxed", {
      action: {
        kind: "text",
        text: "Working set",
        style: {
          font: "SF Pro Text",
          size: 36,
          color: "#FF3B30",
        },
        box: { x: 100, y: 120, width: 240, height: 180 },
      },
    })).resolves.toEqual({
      ok: true,
      name: "canvas.boxed",
      completed: true,
    });

    const messages = posted.map((payload) => JSON.parse(payload) as Record<string, unknown>);
    expect(messages[1]).toMatchObject({
      op: "draw",
      type: "canvas",
      name: "canvas.boxed",
      box: { x: 100, y: 120, width: 240, height: 180 },
    });
    expect(messages[1]).not.toHaveProperty("position");
    expect(messages[2]).toMatchObject({
      op: "text",
      type: "canvas",
      name: "canvas.boxed",
      box: { x: 100, y: 120, width: 240, height: 180 },
    });
    expect(messages[2]).not.toHaveProperty("position");
  });

  test("fans out draw actions across multiple resolved boxes", async () => {
    const posted: string[] = [];
    const runtime = makeRuntimeWithMouse(posted, { x: 640, y: 360 });

    runtime.spawn({ type: "canvas", name: "canvas.multi", durationScale: 1 });

    await expect(runtime.run("canvas.multi", {
      action: {
        kind: "draw",
        shape: "circ",
        style: {
          color: "#FF3B30",
          size: 5,
          padding: 12,
        },
        boxes: [
          { x: 100, y: 120, width: 240, height: 180 },
          { x: 400, y: 420, width: 320, height: 200 },
        ],
      },
    })).resolves.toEqual({
      ok: true,
      name: "canvas.multi",
      completed: true,
    });

    const messages = posted.map((payload) => JSON.parse(payload) as Record<string, unknown>);
    expect(messages[1]).toMatchObject({
      op: "draw",
      type: "canvas",
      name: "canvas.multi",
      box: { x: 100, y: 120, width: 240, height: 180 },
    });
    expect(messages[2]).toMatchObject({
      op: "draw",
      type: "canvas",
      name: "canvas.multi",
      box: { x: 400, y: 420, width: 320, height: 200 },
    });
    expect(messages.map((message) => message.op)).toEqual(["spawn", "draw", "draw"]);
  });
});
