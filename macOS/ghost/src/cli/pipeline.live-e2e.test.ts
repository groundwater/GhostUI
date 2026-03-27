import { describe, expect, test } from "bun:test";
import {
  buildFocusedWindowProducerArgs,
  expectCanonicalPayloadShape,
  normalizeOutput,
  resolveLiveEnabled,
  runBundledPipeline,
} from "./pipeline.live-fixtures.js";

const testIfLive = resolveLiveEnabled() ? test : test.skip;

describe("CLI pipeline live helper smoke", () => {
  testIfLive("runs a live gui ax query to gfx outline smoke against the local daemon", async () => {
    const result = await runBundledPipeline(
      buildFocusedWindowProducerArgs("json", "first"),
      ["gfx", "outline", "-"],
    );

    expect(result.producerExitCode).toBe(0);
    expect(result.exitCode).toBe(0);
    expect(normalizeOutput(result.producerStderr)).toBe("");
    expect(normalizeOutput(result.stderr)).toBe("");
    const payload = JSON.parse(result.stdout);
    expectCanonicalPayloadShape(payload);
    expect(payload).toMatchObject({
      matchCount: 1,
      target: {
        role: "AXWindow",
      },
    });
  }, 60000);
});
