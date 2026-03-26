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

function makeRuntime(posted: string[]): ActorRuntime {
  return new ActorRuntime({
    getDisplays: () => makeDisplays(),
    postOverlay: (_kind, payload) => {
      posted.push(payload);
    },
  });
}

describe("actor runtime", () => {
  test("spawns, lists, and kills actors", () => {
    const posted: string[] = [];
    const runtime = makeRuntime(posted);

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
    const runtime = makeRuntime(posted);
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
    const runtime = makeRuntime(posted);
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
    const runtime = makeRuntime([]);
    runtime.spawn({ type: "pointer", name: "pointer", durationScale: 1 });

    await expect(runtime.run("pointer", {
      action: {
        kind: "move",
        to: { x: 4000, y: 3000 },
        style: "purposeful",
      },
    })).rejects.toThrow(ActorApiError);
  });
});
