import { describe, expect, test } from "bun:test";
import {
  buildFocusedWindowProducerArgs,
  expectCanonicalPayloadShape,
  normalizeOutput,
  resolveLiveEnabled,
  runBundledPipeline,
  type LiveProducerMode,
} from "./pipeline.live-fixtures.js";

type LiveGfxCommand = "ca-highlight" | "gfx-outline" | "gfx-xray" | "gfx-spotlight" | "gfx-arrow" | "gfx-scan";

type LiveGfxCase = {
  name: string;
  producerArgs: string[];
  consumerArgs: string[];
};

const testIfLive = resolveLiveEnabled() ? test : test.skip;

function parsePayload(text: string): unknown {
  return JSON.parse(text);
}

function makeCasesForCommand(
  command: LiveGfxCommand,
  consumerVariants: Array<{ label: string; args: string[] }>,
  options: { supportsEach?: boolean } = {},
  query = "Window",
): LiveGfxCase[] {
  const modes: LiveProducerMode[] = ["json", "ndjson"];
  return modes.flatMap((mode) => {
    const producerVariants =
    (
      mode === "json"
        ? [
          { name: "first-window", cardinality: "first" as const, query },
          { name: "first-window-frame", cardinality: "first" as const, query: "Window[frame]" },
        ]
        : [
          { name: "first-window", cardinality: "first" as const, query },
          { name: "first-window-frame", cardinality: "first" as const, query: "Window[frame]" },
          ...(options.supportsEach ? [{ name: "each-window", cardinality: "each" as const, query }] : []),
        ]
    );
    return producerVariants.flatMap((variant) =>
      consumerVariants.map((consumer) => ({
        name: `${command} ${variant.name} over ${mode} (${consumer.label})`,
        producerArgs: buildFocusedWindowProducerArgs(mode, variant.cardinality, variant.query),
        consumerArgs: consumer.args,
      })),
    );
  });
}

const liveGfxCases: LiveGfxCase[] = [
  ...makeCasesForCommand("ca-highlight", [
    { label: "default", args: ["ca", "highlight", "--timeout", "50", "-"] },
    { label: "timeout", args: ["ca", "highlight", "--timeout", "75", "-"] },
  ]),
  ...makeCasesForCommand("gfx-outline", [
    { label: "default", args: ["gfx", "outline", "-"] },
  ], { supportsEach: true }),
  ...makeCasesForCommand("gfx-xray", [
    { label: "default", args: ["gfx", "xray", "--duration", "50", "-"] },
    { label: "duration", args: ["gfx", "xray", "--duration", "75", "-"] },
  ], { supportsEach: true }),
  ...makeCasesForCommand("gfx-spotlight", [
    { label: "default", args: ["gfx", "spotlight", "--duration", "50", "-"] },
    { label: "color-red", args: ["gfx", "spotlight", "--duration", "75", "--color", "rgba(255,0,0,0.25)", "-"] },
    { label: "color-blue", args: ["gfx", "spotlight", "--duration", "100", "--color", "rgba(0,128,255,0.25)", "-"] },
  ], { supportsEach: true }),
  ...makeCasesForCommand("gfx-arrow", [
    { label: "center", args: ["gfx", "arrow", "--target", "center", "-"] },
    { label: "top", args: ["gfx", "arrow", "--target", "top", "--duration", "50", "-"] },
    { label: "bottom", args: ["gfx", "arrow", "--target", "bottom", "--duration", "75", "-"] },
    { label: "left", args: ["gfx", "arrow", "--target", "left", "--duration", "100", "-"] },
  ], { supportsEach: true }),
  ...makeCasesForCommand("gfx-scan", [
    { label: "default", args: ["gfx", "scan", "--duration", "50", "-"] },
    { label: "duration", args: ["gfx", "scan", "--duration", "75", "-"] },
  ], { supportsEach: true }),
];

describe("CLI pipeline live gfx matrix", () => {
  for (const liveCase of liveGfxCases) {
    testIfLive(liveCase.name, async () => {
      const result = await runBundledPipeline(liveCase.producerArgs, liveCase.consumerArgs);

      expect(result.producerExitCode).toBe(0);
      expect(result.exitCode).toBe(0);
      expect(normalizeOutput(result.producerStderr)).toBe("");
      expect(normalizeOutput(result.stderr)).toBe("");

      const payload = parsePayload(result.stdout);
      expectCanonicalPayloadShape(payload);
      expect(payload).toMatchObject({
        matchCount: 1,
        target: {
          role: "AXWindow",
        },
      });
    }, 60000);
  }
});
