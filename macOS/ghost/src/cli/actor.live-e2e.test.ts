import { describe, expect, test } from "bun:test";
import {
  buildFocusedWindowProducerArgs,
  expectCanonicalPayloadShape,
  normalizeOutput,
  resolveLiveEnabled,
  runBundledLiteralCommand,
  runBundledPipeline,
} from "./pipeline.live-fixtures.js";

const testIfLive = resolveLiveEnabled() ? test : test.skip;

function parseJSON<T>(text: string): T {
  return JSON.parse(text) as T;
}

function makeActorName(prefix: string): string {
  return `${prefix}.${Date.now()}.${Math.floor(Math.random() * 1_000_000)}`;
}

async function spawnActor(type: "pointer" | "canvas", name: string) {
  const result = await runBundledLiteralCommand(["actor", "spawn", type, name, "--duration-scale", "0.01"], "");
  expect(result.exitCode).toBe(0);
  expect(normalizeOutput(result.stderr)).toBe("");
  return parseJSON<{ ok: true; name: string; type: "pointer" | "canvas"; durationScale: number }>(result.stdout);
}

async function killActor(name: string) {
  const result = await runBundledLiteralCommand(["actor", "kill", name], "");
  if (result.exitCode !== 0) {
    return null;
  }
  expect(normalizeOutput(result.stderr)).toBe("");
  return parseJSON<{ ok: true; name: string; killed: true }>(result.stdout);
}

async function runCompletedLiteralAction(name: string, ...args: string[]) {
  const result = await runBundledLiteralCommand(["actor", "run", `${name}.${args[0]}`, ...args.slice(1)], "");
  expect(result.exitCode).toBe(0);
  expect(normalizeOutput(result.stderr)).toBe("");
  return parseJSON<{ ok: true; name: string; completed: true }>(result.stdout);
}

function expectCompleted(name: string, payload: unknown) {
  expect(payload).toEqual({
    ok: true,
    name,
    completed: true,
  });
}

function expectSuccessfulPipeline(result: {
  producerExitCode: number;
  producerStderr: string;
  exitCode: number;
  stderr: string;
}) {
  expect(result.producerExitCode).toBe(0);
  expect(result.exitCode).toBe(0);
  expect(normalizeOutput(result.producerStderr)).toBe("");
  expect(normalizeOutput(result.stderr)).toBe("");
}

describe("CLI actor live e2e", () => {
  testIfLive("pointer actor supports live spawn, list, dismiss, and kill", async () => {
    const name = makeActorName("pointer.live");

    try {
      expect(await spawnActor("pointer", name)).toEqual({
        ok: true,
        name,
        type: "pointer",
        durationScale: 0.01,
      });

      const listResult = await runBundledLiteralCommand(["actor", "list"], "");
      expect(listResult.exitCode).toBe(0);
      expect(normalizeOutput(listResult.stderr)).toBe("");
      expect(parseJSON<{ ok: true; actors: Array<{ name: string; type: string }> }>(listResult.stdout)).toMatchObject({
        ok: true,
        actors: expect.arrayContaining([{ name, type: "pointer" }]),
      });

      const dismissResult = await runBundledLiteralCommand(["actor", "run", `${name}.dismiss`], "");
      expect(dismissResult.exitCode).toBe(0);
      expect(normalizeOutput(dismissResult.stderr)).toBe("");
      expect(parseJSON<{ ok: true; name: string; completed: true }>(dismissResult.stdout)).toEqual({
        ok: true,
        name,
        completed: true,
      });
    } finally {
      const killed = await killActor(name);
      if (killed) {
        expect(killed).toEqual({ ok: true, name, killed: true });
      }
    }
  }, 60000);

  testIfLive("pointer actor supports literal move/click/drag/scroll/think/narrate permutations", async () => {
    const name = makeActorName("pointer.live.literal");

    try {
      expect(await spawnActor("pointer", name)).toEqual({
        ok: true,
        name,
        type: "pointer",
        durationScale: 0.01,
      });

      expectCompleted(name, await runCompletedLiteralAction(name, "move", "--to", "200", "200", "--style", "fast"));
      expectCompleted(name, await runCompletedLiteralAction(name, "move", "--to", "240", "240", "--style", "slow"));
      expectCompleted(name, await runCompletedLiteralAction(name, "click", "--at", "240", "240"));
      expectCompleted(name, await runCompletedLiteralAction(name, "click", "--button", "middle", "--at", "240", "240"));
      expectCompleted(name, await runCompletedLiteralAction(name, "drag", "--to", "280", "280"));
      expectCompleted(name, await runCompletedLiteralAction(name, "scroll", "--dx", "0", "--dy", "60"));
      expectCompleted(name, await runCompletedLiteralAction(name, "scroll", "--dx", "-25", "--dy", "15"));
      expectCompleted(name, await runCompletedLiteralAction(name, "think", "--for", "0"));
      expectCompleted(name, await runCompletedLiteralAction(name, "think", "--for", "15"));
      expectCompleted(name, await runCompletedLiteralAction(name, "narrate", "--text", "short live line"));
      expectCompleted(name, await runCompletedLiteralAction(name, "narrate", "--text", "a slightly longer live narration sentence"));
    } finally {
      const killed = await killActor(name);
      if (killed) {
        expect(killed).toEqual({ ok: true, name, killed: true });
      }
    }
  }, 60000);

  testIfLive("pointer actor preserves live AX payloads through stdin move and click", async () => {
    const name = makeActorName("pointer.live.stdin");

    try {
      await spawnActor("pointer", name);

      const moveResult = await runBundledPipeline(
        buildFocusedWindowProducerArgs("json", "first", "Window[frame]"),
        ["actor", "run", `${name}.move`, "-"],
      );
      expectSuccessfulPipeline(moveResult);
      const movePayload = parseJSON(moveResult.stdout);
      expectCanonicalPayloadShape(movePayload);
      expect(movePayload).toMatchObject({
        matchCount: 1,
        target: {
          role: "AXWindow",
        },
      });

      const clickResult = await runBundledPipeline(
        buildFocusedWindowProducerArgs("ndjson", "first", "Window[frame]"),
        ["actor", "run", `${name}.click`, "-"],
      );
      expectSuccessfulPipeline(clickResult);
      const clickPayload = parseJSON(clickResult.stdout);
      expectCanonicalPayloadShape(clickPayload);
      expect(clickPayload).toMatchObject({
        matchCount: 1,
        target: {
          role: "AXWindow",
        },
      });
    } finally {
      await killActor(name);
    }
  }, 60000);

  testIfLive("canvas actor supports literal draw/text/clear permutations and kill", async () => {
    const name = makeActorName("canvas.live.literal");

    try {
      expect(await spawnActor("canvas", name)).toEqual({
        ok: true,
        name,
        type: "canvas",
        durationScale: 0.01,
      });

      expectCompleted(name, await runCompletedLiteralAction(name, "draw", "rect", "--box", "100", "100", "120", "80"));
      expectCompleted(name, await runCompletedLiteralAction(
        name,
        "draw",
        "underline",
        "--box",
        "130",
        "130",
        "160",
        "36",
        "--padding",
        "4",
        "--size",
        "6",
        "--color",
        "rgba(255,0,0,0.8)",
      ));
      expectCompleted(name, await runCompletedLiteralAction(
        name,
        "text",
        "Hello",
        "literal",
        "--box",
        "140",
        "140",
        "160",
        "50",
        "--font",
        "Helvetica",
        "--size",
        "18",
        "--color",
        "#00FF00",
        "--highlight",
        "none",
      ));
      expectCompleted(name, await runCompletedLiteralAction(
        name,
        "text",
        "Highlighted",
        "literal",
        "--box",
        "160",
        "210",
        "180",
        "60",
        "--font",
        "Menlo",
        "--size",
        "16",
        "--color",
        "#FFFFFF",
        "--highlight",
        "rgba(0,0,255,0.35)",
      ));
      expectCompleted(name, await runCompletedLiteralAction(name, "clear"));
    } finally {
      const killed = await killActor(name);
      if (killed) {
        expect(killed).toEqual({ ok: true, name, killed: true });
      }
    }
  }, 60000);

  testIfLive("canvas actor supports stdin draw/text permutations through the bundled pipeline", async () => {
    const name = makeActorName("canvas.live.stdin");

    try {
      await spawnActor("canvas", name);

      const drawResult = await runBundledPipeline(
        buildFocusedWindowProducerArgs("json", "first", "Window[frame]"),
        ["actor", "run", `${name}.draw`, "check", "-"],
      );
      expectSuccessfulPipeline(drawResult);
      expectCompleted(name, parseJSON(drawResult.stdout));

      const secondDrawResult = await runBundledPipeline(
        buildFocusedWindowProducerArgs("ndjson", "first", "Window[frame]"),
        ["actor", "run", `${name}.draw`, "underline", "-", "--padding", "3", "--size", "5"],
      );
      expectSuccessfulPipeline(secondDrawResult);
      expectCompleted(name, parseJSON(secondDrawResult.stdout));

      const textResult = await runBundledPipeline(
        buildFocusedWindowProducerArgs("ndjson", "first", "Window[frame]"),
        ["actor", "run", `${name}.text`, "Hello", "stdin", "-"],
      );
      expectSuccessfulPipeline(textResult);
      expectCompleted(name, parseJSON(textResult.stdout));
    } finally {
      const killed = await killActor(name);
      if (killed) {
        expect(killed).toEqual({ ok: true, name, killed: true });
      }
    }
  }, 60000);
});
