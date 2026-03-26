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

function makeRuntime(
  posted: string[],
  getMousePosition?: () => { x: number; y: number } | null,
): ActorRuntime {
  return new ActorRuntime({
    getDisplays: () => makeDisplays(),
    getMousePosition,
    postOverlay: (_kind, payload) => {
      posted.push(payload);
    },
  });
}

function makeRuntimeWithMouse(posted: string[], mousePosition: { x: number; y: number }): ActorRuntime {
  return makeRuntime(posted, () => mousePosition);
}

function parseMessages(posted: string[]): Array<Record<string, unknown>> {
  return posted.map((payload) => JSON.parse(payload) as Record<string, unknown>);
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

  test("retains spotlight geometry and animates successive rect/circ updates", async () => {
    const posted: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    const runtime = new ActorRuntime({
      getDisplays: () => makeDisplays(),
      getMousePosition: () => ({ x: 640, y: 360 }),
      postOverlay: (kind, payload) => {
        posted.push({ kind, payload: JSON.parse(payload) as Record<string, unknown> });
      },
    });

    expect(runtime.spawn({ type: "spotlight", name: "spotlight.focus", durationScale: 0.01 })).toEqual({
      ok: true,
      name: "spotlight.focus",
      type: "spotlight",
      durationScale: 0.01,
    });
    expect(posted).toHaveLength(0);

    await expect(runtime.run("spotlight.focus", {
      action: {
        kind: "rect",
        rects: [{ x: 100, y: 120, width: 240, height: 180 }],
        padding: 8,
        blur: 12,
        speed: 50,
      },
    })).resolves.toEqual({
      ok: true,
      name: "spotlight.focus",
      completed: true,
    });

    await expect(runtime.run("spotlight.focus", {
      action: {
        kind: "circ",
        rects: [{ x: 100, y: 120, width: 240, height: 180 }],
        padding: 8,
        blur: 18,
        speed: 50,
      },
    })).resolves.toEqual({
      ok: true,
      name: "spotlight.focus",
      completed: true,
    });

    await expect(runtime.run("spotlight.focus", {
      action: {
        kind: "rect",
        rects: [{ x: 200, y: 120, width: 240, height: 180 }],
        padding: 8,
        blur: 18,
        speed: 50,
      },
    })).resolves.toEqual({
      ok: true,
      name: "spotlight.focus",
      completed: true,
    });

    await expect(runtime.run("spotlight.focus", {
      action: { kind: "off", transition: "fade" },
    })).resolves.toEqual({
      ok: true,
      name: "spotlight.focus",
      completed: true,
    });

    await expect(runtime.run("spotlight.focus", {
      action: { kind: "on", transition: "instant" },
    })).resolves.toEqual({
      ok: true,
      name: "spotlight.focus",
      completed: true,
    });

    await expect(runtime.run("spotlight.focus", {
      action: { kind: "color", color: "rgba(0,0,0,0.35)" },
    })).resolves.toEqual({
      ok: true,
      name: "spotlight.focus",
      completed: true,
    });

    const drawCalls = posted.filter((entry) => entry.kind === "draw");
    expect(drawCalls).toHaveLength(6);
    const spotlightItems = drawCalls.map((entry) => (entry.payload.items as Array<Record<string, unknown>>)[0]!);
    expect(spotlightItems.map((item) => item.id)).toEqual([
      "spotlight.focus.spotlight",
      "spotlight.focus.spotlight",
      "spotlight.focus.spotlight",
      "spotlight.focus.spotlight",
      "spotlight.focus.spotlight",
      "spotlight.focus.spotlight",
    ]);
    expect(spotlightItems[0]).toMatchObject({
      kind: "spotlight",
      shape: "rect",
      rects: [{ x: 92, y: 112, width: 256, height: 196 }],
      style: {
        fill: "rgba(0,0,0,.5)",
        cornerRadius: 18,
        opacity: 1,
        blur: 12,
      },
      animation: { durMs: 2, ease: "easeInOut" },
    });
    expect(spotlightItems[1]).toMatchObject({
      kind: "spotlight",
      shape: "circ",
      rects: [{ x: 92, y: 112, width: 256, height: 196 }],
      style: {
        fill: "rgba(0,0,0,.5)",
        cornerRadius: 0,
        opacity: 1,
        blur: 18,
      },
      animation: { durMs: 2, ease: "easeInOut" },
    });
    expect(spotlightItems[2]).toMatchObject({
      kind: "spotlight",
      shape: "rect",
      rects: [{ x: 192, y: 112, width: 256, height: 196 }],
      style: {
        fill: "rgba(0,0,0,.5)",
        cornerRadius: 18,
        opacity: 1,
        blur: 18,
      },
      animation: { durMs: 40, ease: "easeInOut" },
    });
    expect(spotlightItems[3]).toMatchObject({
      kind: "spotlight",
      rects: [{ x: 192, y: 112, width: 256, height: 196 }],
      style: {
        fill: "rgba(0,0,0,.5)",
        cornerRadius: 18,
        opacity: 0,
        blur: 18,
      },
      animation: { durMs: 2, ease: "easeInOut" },
    });
    expect(spotlightItems[4]).toMatchObject({
      kind: "spotlight",
      shape: "rect",
      rects: [{ x: 192, y: 112, width: 256, height: 196 }],
      style: {
        fill: "rgba(0,0,0,.5)",
        cornerRadius: 18,
        opacity: 1,
        blur: 18,
      },
      animation: { durMs: 0, ease: "easeInOut" },
    });
    expect(spotlightItems[5]).toMatchObject({
      kind: "spotlight",
      shape: "rect",
      rects: [{ x: 192, y: 112, width: 256, height: 196 }],
      style: {
        fill: "rgba(0,0,0,0.35)",
        cornerRadius: 18,
        opacity: 1,
        blur: 18,
      },
      animation: { durMs: 2, ease: "easeInOut" },
    });

    expect(() => runtime.kill("spotlight.focus")).not.toThrow();
    expect(posted.at(-1)).toMatchObject({
      kind: "draw",
      payload: {
        coordinateSpace: "screen",
        items: [
          {
            id: "spotlight.focus.spotlight",
            kind: "spotlight",
            remove: true,
          },
        ],
      },
    });
  });

  test("uses display scale when spotlight speed crosses mixed-scale displays", async () => {
    const posted: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    const runtime = new ActorRuntime({
      getDisplays: () => [
        {
          id: 1,
          name: "Main",
          main: true,
          frame: { x: 0, y: 0, width: 1440, height: 900 },
          visibleFrame: { x: 0, y: 25, width: 1440, height: 875 },
          scale: 1,
          physicalSize: { width: 1440, height: 900 },
          rotation: 0,
        },
        {
          id: 2,
          name: "Sidecar",
          main: false,
          frame: { x: 1440, y: 0, width: 1280, height: 800 },
          visibleFrame: { x: 1440, y: 25, width: 1280, height: 775 },
          scale: 2,
          physicalSize: { width: 2560, height: 1600 },
          rotation: 0,
        },
      ],
      getMousePosition: () => ({ x: 640, y: 360 }),
      postOverlay: (kind, payload) => {
        posted.push({ kind, payload: JSON.parse(payload) as Record<string, unknown> });
      },
    });

    expect(runtime.spawn({ type: "spotlight", name: "spotlight.mixed", durationScale: 0.01 })).toEqual({
      ok: true,
      name: "spotlight.mixed",
      type: "spotlight",
      durationScale: 0.01,
    });

    await expect(runtime.run("spotlight.mixed", {
      action: {
        kind: "rect",
        rects: [{ x: 1370, y: 120, width: 20, height: 20 }],
        padding: 0,
        blur: 0,
        speed: 100,
      },
    })).resolves.toEqual({
      ok: true,
      name: "spotlight.mixed",
      completed: true,
    });

    await expect(runtime.run("spotlight.mixed", {
      action: {
        kind: "rect",
        rects: [{ x: 1450, y: 120, width: 20, height: 20 }],
        padding: 0,
        blur: 0,
        speed: 100,
      },
    })).resolves.toEqual({
      ok: true,
      name: "spotlight.mixed",
      completed: true,
    });

    const drawCalls = posted.filter((entry) => entry.kind === "draw");
    expect(drawCalls).toHaveLength(2);
    expect(drawCalls[0]).toMatchObject({
      payload: {
        items: [
          {
            animation: { durMs: 2, ease: "easeInOut" },
          },
        ],
      },
    });
    expect(drawCalls[1]).toMatchObject({
      payload: {
        items: [
          {
            animation: { durMs: 12, ease: "easeInOut" },
          },
        ],
      },
    });
  });

  test("rejects duplicate actor names and sorts mixed actor lists by name", () => {
    const runtime = makeRuntimeWithMouse([], { x: 640, y: 360 });

    expect(runtime.spawn({ type: "pointer", name: "pointer.zed", durationScale: 1 })).toEqual({
      ok: true,
      name: "pointer.zed",
      type: "pointer",
      durationScale: 1,
    });
    expect(runtime.spawn({ type: "canvas", name: "canvas.alpha", durationScale: 1 })).toEqual({
      ok: true,
      name: "canvas.alpha",
      type: "canvas",
      durationScale: 1,
    });
    expect(runtime.spawn({ type: "pointer", name: "pointer.beta", durationScale: 1 })).toEqual({
      ok: true,
      name: "pointer.beta",
      type: "pointer",
      durationScale: 1,
    });

    expect(() => runtime.spawn({ type: "canvas", name: "pointer.zed", durationScale: 1 })).toThrow(
      "Actor 'pointer.zed' already exists",
    );

    expect(runtime.list()).toEqual({
      ok: true,
      actors: [
        { name: "canvas.alpha", type: "canvas" },
        { name: "pointer.beta", type: "pointer" },
        { name: "pointer.zed", type: "pointer" },
      ],
    });
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

  test("uses the expected move durations for each pointer style", async () => {
    const destination = { x: 920, y: 550 };
    const expectations = [
      { style: "fast", durationMs: 160 },
      { style: "purposeful", durationMs: 258 },
      { style: "slow", durationMs: 443 },
      { style: "wandering", durationMs: 559 },
    ] as const;

    for (const expectation of expectations) {
      const posted: string[] = [];
      const runtime = makeRuntimeWithMouse(posted, { x: 640, y: 360 });
      runtime.spawn({ type: "pointer", name: `pointer.${expectation.style}`, durationScale: 1 });

      await expect(runtime.run(`pointer.${expectation.style}`, {
        action: {
          kind: "move",
          to: destination,
          style: expectation.style,
        },
      })).resolves.toEqual({
        ok: true,
        name: `pointer.${expectation.style}`,
        completed: true,
      });

      const messages = parseMessages(posted);
      expect(messages[1]).toMatchObject({
        op: "move",
        name: `pointer.${expectation.style}`,
        to: destination,
        style: expectation.style,
        durationMs: expectation.durationMs,
      });
    }
  });

  test("shows dismissed pointers before clicking at a new point", async () => {
    const posted: string[] = [];
    const runtime = makeRuntimeWithMouse(posted, { x: 640, y: 360 });
    runtime.spawn({ type: "pointer", name: "pointer", durationScale: 0 });

    await expect(runtime.run("pointer", {
      action: { kind: "dismiss" },
    })).resolves.toEqual({
      ok: true,
      name: "pointer",
      completed: true,
    });

    await expect(runtime.run("pointer", {
      action: {
        kind: "click",
        button: "right",
        at: { x: 820, y: 410 },
      },
    })).resolves.toEqual({
      ok: true,
      name: "pointer",
      completed: true,
    });

    const messages = posted.map((payload) => JSON.parse(payload) as Record<string, unknown>);
    expect(messages.map((message) => message.op)).toEqual(["spawn", "dismiss", "show", "move", "click"]);
    expect(messages[2]).toMatchObject({
      op: "show",
      name: "pointer",
      position: { x: 720, y: 450 },
    });
    expect(messages[3]).toMatchObject({
      op: "move",
      name: "pointer",
      to: { x: 820, y: 410 },
      style: "fast",
    });
    expect(messages[4]).toMatchObject({
      op: "click",
      name: "pointer",
      button: "right",
    });
  });

  test("preserves dragged pointer position across dismiss and show", async () => {
    const posted: string[] = [];
    const runtime = makeRuntimeWithMouse(posted, { x: 640, y: 360 });
    runtime.spawn({ type: "pointer", name: "pointer", durationScale: 0 });

    await expect(runtime.run("pointer", {
      action: {
        kind: "drag",
        to: { x: 1680, y: 320 },
      },
    })).resolves.toEqual({
      ok: true,
      name: "pointer",
      completed: true,
    });

    await expect(runtime.run("pointer", {
      action: { kind: "dismiss" },
    })).resolves.toEqual({
      ok: true,
      name: "pointer",
      completed: true,
    });

    await expect(runtime.run("pointer", {
      action: {
        kind: "click",
        button: "left",
      },
    })).resolves.toEqual({
      ok: true,
      name: "pointer",
      completed: true,
    });

    const messages = posted.map((payload) => JSON.parse(payload) as Record<string, unknown>);
    expect(messages.map((message) => message.op)).toEqual(["spawn", "drag", "dismiss", "show", "click"]);
    expect(messages[1]).toMatchObject({
      op: "drag",
      name: "pointer",
      to: { x: 1680, y: 320 },
    });
    expect(messages[3]).toMatchObject({
      op: "show",
      name: "pointer",
      position: { x: 1680, y: 320 },
    });
  });

  test("clicks at the current pointer position when no target is provided", async () => {
    const posted: string[] = [];
    const runtime = makeRuntimeWithMouse(posted, { x: 640, y: 360 });
    runtime.spawn({ type: "pointer", name: "pointer", durationScale: 0 });

    await expect(runtime.run("pointer", {
      action: {
        kind: "move",
        to: { x: 1680, y: 320 },
        style: "purposeful",
      },
    })).resolves.toEqual({
      ok: true,
      name: "pointer",
      completed: true,
    });

    await expect(runtime.run("pointer", {
      action: {
        kind: "click",
        button: "middle",
      },
    })).resolves.toEqual({
      ok: true,
      name: "pointer",
      completed: true,
    });

    const messages = parseMessages(posted);
    expect(messages.map((message) => message.op)).toEqual(["spawn", "move", "click"]);
    expect(messages[2]).toMatchObject({
      op: "click",
      name: "pointer",
      button: "middle",
    });
  });

  test("runs successful pointer scroll variants", async () => {
    const posted: string[] = [];
    const runtime = makeRuntimeWithMouse(posted, { x: 640, y: 360 });
    runtime.spawn({ type: "pointer", name: "pointer", durationScale: 0 });

    for (const action of [
      { dx: 120, dy: 0 },
      { dx: 0, dy: -200 },
      { dx: -40, dy: 75 },
    ]) {
      await expect(runtime.run("pointer", {
        action: {
          kind: "scroll",
          ...action,
        },
      })).resolves.toEqual({
        ok: true,
        name: "pointer",
        completed: true,
      });
    }

    const messages = parseMessages(posted);
    expect(messages.map((message) => message.op)).toEqual(["spawn", "scroll", "scroll", "scroll"]);
    expect(messages[1]).toMatchObject({ op: "scroll", dx: 120, dy: 0, durationMs: 0 });
    expect(messages[2]).toMatchObject({ op: "scroll", dx: 0, dy: -200, durationMs: 0 });
    expect(messages[3]).toMatchObject({ op: "scroll", dx: -40, dy: 75, durationMs: 0 });
  });

  test("emits think start and stop around successful think runs", async () => {
    const posted: string[] = [];
    const runtime = makeRuntimeWithMouse(posted, { x: 640, y: 360 });
    runtime.spawn({ type: "pointer", name: "pointer", durationScale: 0 });

    await expect(runtime.run("pointer", {
      action: {
        kind: "think",
        forMs: 25,
      },
    })).resolves.toEqual({
      ok: true,
      name: "pointer",
      completed: true,
    });

    const messages = parseMessages(posted);
    expect(messages.map((message) => message.op)).toEqual(["spawn", "thinkStart", "thinkStop"]);
    expect(messages[1]).toMatchObject({ op: "thinkStart", name: "pointer", durationMs: 0 });
    expect(messages[2]).toMatchObject({ op: "thinkStop", name: "pointer", durationMs: 0 });
  });

  test("cancels timed-out think runs", async () => {
    const posted: string[] = [];
    const runtime = makeRuntimeWithMouse(posted, { x: 640, y: 360 });
    runtime.spawn({ type: "pointer", name: "pointer", durationScale: 1 });

    await expect(runtime.run("pointer", {
      action: {
        kind: "think",
        forMs: 200,
      },
      timeoutMs: 10,
    })).rejects.toMatchObject({
      code: "timeout",
      message: "Actor run timed out for 'pointer'",
    });

    const messages = parseMessages(posted);
    expect(messages.map((message) => message.op)).toEqual(["spawn", "thinkStart", "cancel"]);
  });

  test("computes narrate duration from text length", async () => {
    const posted: string[] = [];
    const runtime = makeRuntimeWithMouse(posted, { x: 640, y: 360 });
    runtime.spawn({ type: "pointer", name: "pointer", durationScale: 0.01 });

    await expect(runtime.run("pointer", {
      action: {
        kind: "narrate",
        text: "Hi",
      },
    })).resolves.toEqual({
      ok: true,
      name: "pointer",
      completed: true,
    });

    await expect(runtime.run("pointer", {
      action: {
        kind: "narrate",
        text: "This is a longer runtime narration payload for the actor overlay.",
      },
    })).resolves.toEqual({
      ok: true,
      name: "pointer",
      completed: true,
    });

    const messages = parseMessages(posted);
    expect(messages.map((message) => message.op)).toEqual(["spawn", "narrate", "narrate"]);
    expect(messages[1]).toMatchObject({ op: "narrate", text: "Hi", durationMs: 12 });
    expect(messages[2]).toMatchObject({
      op: "narrate",
      text: "This is a longer runtime narration payload for the actor overlay.",
      durationMs: 32,
    });
  });

  test("treats repeated dismiss calls as a no-op when the pointer is already hidden", async () => {
    const posted: string[] = [];
    const runtime = makeRuntimeWithMouse(posted, { x: 640, y: 360 });
    runtime.spawn({ type: "pointer", name: "pointer", durationScale: 0 });

    await expect(runtime.run("pointer", {
      action: { kind: "dismiss" },
    })).resolves.toEqual({
      ok: true,
      name: "pointer",
      completed: true,
    });

    await expect(runtime.run("pointer", {
      action: { kind: "dismiss" },
    })).resolves.toEqual({
      ok: true,
      name: "pointer",
      completed: true,
    });

    expect(parseMessages(posted).map((message) => message.op)).toEqual(["spawn", "dismiss"]);
  });

  test("rejects out-of-bounds drag targets and cancels timed-out drags", async () => {
    const posted: string[] = [];
    const runtime = makeRuntimeWithMouse(posted, { x: 640, y: 360 });
    runtime.spawn({ type: "pointer", name: "pointer", durationScale: 1 });

    await expect(runtime.run("pointer", {
      action: {
        kind: "drag",
        to: { x: 4000, y: 3000 },
      },
    })).rejects.toMatchObject({ code: "invalid_args" });

    await expect(runtime.run("pointer", {
      action: {
        kind: "drag",
        to: { x: 1680, y: 320 },
      },
      timeoutMs: 10,
    })).rejects.toMatchObject({ code: "timeout" });

    const messages = parseMessages(posted);
    expect(messages.map((message) => message.op)).toEqual(["spawn", "drag", "cancel"]);
  });

  test("kills active pointer runs and surfaces the cancellation", async () => {
    const posted: string[] = [];
    const runtime = makeRuntimeWithMouse(posted, { x: 640, y: 360 });
    runtime.spawn({ type: "pointer", name: "pointer", durationScale: 1 });

    const run = runtime.run("pointer", {
      action: {
        kind: "think",
        forMs: 250,
      },
    });

    await Bun.sleep(10);

    expect(runtime.kill("pointer")).toEqual({
      ok: true,
      name: "pointer",
      killed: true,
    });
    await expect(run).rejects.toMatchObject({
      code: "run_canceled",
      message: "Run canceled for actor 'pointer'",
    });

    expect(parseMessages(posted).map((message) => message.op)).toEqual(["spawn", "thinkStart", "kill"]);
  });

  test("rejects invalid pointer scroll and narrate requests", async () => {
    const runtime = makeRuntimeWithMouse([], { x: 640, y: 360 });
    runtime.spawn({ type: "pointer", name: "pointer", durationScale: 0 });

    await expect(runtime.run("pointer", {
      action: {
        kind: "scroll",
        dx: 0,
        dy: 0,
      },
    })).rejects.toMatchObject({
      code: "invalid_args",
      message: "scroll requires a non-zero --dx or --dy",
    });

    await expect(runtime.run("pointer", {
      action: {
        kind: "narrate",
        text: "   ",
      },
    })).rejects.toMatchObject({
      code: "invalid_args",
      message: "narrate text must be non-empty",
    });
  });

  test("rejects pointer actions on canvas actors and canvas actions on pointer actors", async () => {
    const runtime = makeRuntimeWithMouse([], { x: 640, y: 360 });
    runtime.spawn({ type: "pointer", name: "pointer", durationScale: 1 });
    runtime.spawn({ type: "canvas", name: "canvas", durationScale: 1 });

    await expect(runtime.run("canvas", {
      action: {
        kind: "move",
        to: { x: 800, y: 400 },
        style: "fast",
      },
    })).rejects.toMatchObject({
      code: "unknown_action",
      message: "Unknown action: move",
    });

    await expect(runtime.run("pointer", {
      action: {
        kind: "draw",
        shape: "check",
        style: { color: "#FF3B30", size: 4, padding: 8 },
      },
    })).rejects.toMatchObject({
      code: "unknown_action",
      message: "Unknown action: draw",
    });
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

  test("updates the canvas actor position from the current mouse for text without a box", async () => {
    const posted: string[] = [];
    const mousePosition = { x: 640, y: 360 };
    const runtime = makeRuntimeWithMouse(posted, mousePosition);

    runtime.spawn({ type: "canvas", name: "canvas.follow", durationScale: 1 });
    mousePosition.x = 910;
    mousePosition.y = 615;

    await expect(runtime.run("canvas.follow", {
      action: {
        kind: "text",
        text: "Working set",
        style: {
          font: "SF Pro Text",
          size: 36,
          color: "#FF3B30",
        },
      },
    })).resolves.toEqual({
      ok: true,
      name: "canvas.follow",
      completed: true,
    });

    const messages = parseMessages(posted);
    expect(messages[1]).toMatchObject({
      op: "text",
      type: "canvas",
      name: "canvas.follow",
      position: { x: 910, y: 615 },
      text: "Working set",
    });
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

  test("falls back to the primary display center for canvas and resets draw ids after clear", async () => {
    const posted: string[] = [];
    const runtime = makeRuntime(posted, () => null);

    expect(runtime.spawn({ type: "canvas", name: "canvas.fallback", durationScale: 1 })).toEqual({
      ok: true,
      name: "canvas.fallback",
      type: "canvas",
      durationScale: 1,
    });

    await expect(runtime.run("canvas.fallback", {
      action: {
        kind: "draw",
        shape: "check",
        style: {
          color: "#FF3B30",
          size: 4,
          padding: 8,
        },
      },
    })).resolves.toEqual({
      ok: true,
      name: "canvas.fallback",
      completed: true,
    });

    await expect(runtime.run("canvas.fallback", {
      action: { kind: "clear" },
    })).resolves.toEqual({
      ok: true,
      name: "canvas.fallback",
      completed: true,
    });

    await expect(runtime.run("canvas.fallback", {
      action: {
        kind: "draw",
        shape: "check",
        style: {
          color: "#FF3B30",
          size: 4,
          padding: 8,
        },
      },
    })).resolves.toEqual({
      ok: true,
      name: "canvas.fallback",
      completed: true,
    });

    const messages = posted.map((payload) => JSON.parse(payload) as Record<string, unknown>);
    expect(messages[0]).toEqual({
      op: "spawn",
      name: "canvas.fallback",
      type: "canvas",
      position: { x: 720, y: 450 },
    });
    expect(messages[1]).toMatchObject({
      op: "draw",
      type: "canvas",
      name: "canvas.fallback",
      id: "canvas.fallback.draw.0",
      position: { x: 720, y: 450 },
      box: { x: 672, y: 402, width: 96, height: 96 },
    });
    expect(messages[2]).toEqual({
      op: "clear",
      type: "canvas",
      name: "canvas.fallback",
    });
    expect(messages[3]).toMatchObject({
      op: "draw",
      type: "canvas",
      name: "canvas.fallback",
      id: "canvas.fallback.draw.0",
      position: { x: 720, y: 450 },
      box: { x: 672, y: 402, width: 96, height: 96 },
    });
  });

  test("clears empty and text-only canvas state without breaking future ids", async () => {
    const posted: string[] = [];
    const mousePosition = { x: 640, y: 360 };
    const runtime = makeRuntimeWithMouse(posted, mousePosition);

    runtime.spawn({ type: "canvas", name: "canvas.clear", durationScale: 1 });

    await expect(runtime.run("canvas.clear", {
      action: { kind: "clear" },
    })).resolves.toEqual({
      ok: true,
      name: "canvas.clear",
      completed: true,
    });

    mousePosition.x = 900;
    mousePosition.y = 500;
    await expect(runtime.run("canvas.clear", {
      action: {
        kind: "text",
        text: "Stage one",
        style: {
          font: "SF Pro Text",
          size: 32,
          color: "#FF3B30",
        },
      },
    })).resolves.toEqual({
      ok: true,
      name: "canvas.clear",
      completed: true,
    });

    await expect(runtime.run("canvas.clear", {
      action: { kind: "clear" },
    })).resolves.toEqual({
      ok: true,
      name: "canvas.clear",
      completed: true,
    });

    mousePosition.x = 960;
    mousePosition.y = 540;
    await expect(runtime.run("canvas.clear", {
      action: {
        kind: "text",
        text: "Stage two",
        style: {
          font: "SF Pro Text",
          size: 32,
          color: "#FF3B30",
        },
      },
    })).resolves.toEqual({
      ok: true,
      name: "canvas.clear",
      completed: true,
    });

    const messages = parseMessages(posted);
    expect(messages.map((message) => message.op)).toEqual(["spawn", "clear", "text", "clear", "text"]);
    expect(messages[2]).toMatchObject({
      op: "text",
      type: "canvas",
      name: "canvas.clear",
      id: "canvas.clear.text.0",
      position: { x: 900, y: 500 },
    });
    expect(messages[4]).toMatchObject({
      op: "text",
      type: "canvas",
      name: "canvas.clear",
      id: "canvas.clear.text.0",
      position: { x: 960, y: 540 },
    });
  });
});
