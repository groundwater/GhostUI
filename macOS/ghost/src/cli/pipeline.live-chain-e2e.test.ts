import { describe, expect, test } from "bun:test";
import {
  expectCanonicalPayloadShape,
  normalizeOutput,
  resolveLiveEnabled,
  runBundledShellPipeline,
} from "./pipeline.live-fixtures.js";

type ProducerCase = {
  label: string;
  args: string[];
};

type ChainCase = {
  label: string;
  stages: string[][];
  stderrIncludes?: string[];
  stdoutMode: "payload" | "empty";
};

const testIfLive = resolveLiveEnabled() ? test : test.skip;

const producers: ProducerCase[] = [
  { label: "json-first", args: ["ax", "query", "--focused", "--json", "--first", "Window"] },
  { label: "ndjson-first", args: ["ax", "query", "--focused", "--ndjson", "--first", "Window"] },
];

const chains: ChainCase[] = [
  { label: "outline-to-xray", stages: [["gfx", "outline", "-"], ["gfx", "xray", "-"]], stdoutMode: "payload" },
  { label: "outline-to-spotlight", stages: [["gfx", "outline", "-"], ["gfx", "spotlight", "-", "--duration", "50"]], stdoutMode: "payload" },
  { label: "outline-to-arrow", stages: [["gfx", "outline", "-"], ["gfx", "arrow", "-", "--target", "top"]], stdoutMode: "payload" },
  { label: "outline-to-scan", stages: [["gfx", "outline", "-"], ["gfx", "scan", "-", "--duration", "80"]], stdoutMode: "payload" },
  { label: "xray-to-arrow", stages: [["gfx", "xray", "-", "--duration", "80"], ["gfx", "arrow", "-", "--target", "left"]], stdoutMode: "payload" },
  { label: "highlight-to-xray", stages: [["ca", "highlight", "-", "--timeout", "75"], ["gfx", "xray", "-", "--duration", "80"]], stdoutMode: "payload" },
  { label: "highlight-to-arrow", stages: [["ca", "highlight", "-", "--timeout", "75"], ["gfx", "arrow", "-", "--target", "bottom"]], stdoutMode: "payload" },
  { label: "spotlight-to-scan", stages: [["gfx", "spotlight", "-", "--duration", "50"], ["gfx", "scan", "-", "--duration", "80"]], stdoutMode: "payload" },
  {
    label: "focus-window-to-outline",
    stages: [["ax", "focus-window"], ["gfx", "outline", "-"]],
    stderrIncludes: ["focused containing window"],
    stdoutMode: "payload",
  },
  {
    label: "focus-window-to-xray",
    stages: [["ax", "focus-window"], ["gfx", "xray", "-", "--duration", "80"]],
    stderrIncludes: ["focused containing window"],
    stdoutMode: "payload",
  },
];

describe("CLI pipeline live helper chain matrix", () => {
  for (const producer of producers) {
    for (const chain of chains) {
      testIfLive(`${producer.label} -> ${chain.label}`, async () => {
        const result = await runBundledShellPipeline([producer.args, ...chain.stages]);
        const stderr = normalizeOutput(result.stderr);

        expect(result.exitCode).toBe(0);
        if (chain.stderrIncludes) {
          for (const fragment of chain.stderrIncludes) {
            expect(stderr).toContain(fragment);
          }
        } else {
          expect(stderr).toBe("");
        }
        if (chain.stdoutMode === "payload") {
          expectCanonicalPayloadShape(JSON.parse(result.stdout));
        } else {
          expect(normalizeOutput(result.stdout)).toBe("");
        }
      });
    }
  }
});
