import { describe, expect, test } from "bun:test";
import {
  expectCanonicalPayloadShape,
  normalizeOutput,
  resolveLiveEnabled,
  runBundledLiteralCommand,
  runBundledShellPipeline,
} from "./pipeline.live-fixtures.js";

type ProducerCase = {
  label: string;
  args: string[];
};

const testIfLive = resolveLiveEnabled() ? test : test.skip;

const producers: ProducerCase[] = [
  { label: "json-first", args: ["ax", "query", "--focused", "--json", "--first", "Window"] },
  { label: "ndjson-first", args: ["ax", "query", "--focused", "--ndjson", "--first", "Window"] },
];

describe("CLI pipeline live helper AX stdin consumers", () => {
  for (const producer of producers) {
    testIfLive(`${producer.label} -> ax focus-window`, async () => {
      const result = await runBundledShellPipeline([producer.args, ["ax", "focus-window"]]);

      expect(result.exitCode).toBe(0);
      expectCanonicalPayloadShape(JSON.parse(result.stdout));
      expect(normalizeOutput(result.stderr)).toContain("focused containing window");
    });
  }
});

describe("CLI pipeline live helper CG/window flows", () => {
  const windowAtCases: Array<{ label: string; args: string[] }> = [
    { label: "default", args: ["cg", "window-at", "-"] },
    { label: "layer-1000", args: ["cg", "window-at", "-", "--layer", "1000"] },
  ];

  for (const testCase of windowAtCases) {
    testIfLive(`cg mousepos -> ${testCase.label} window-at`, async () => {
      const result = await runBundledShellPipeline([["cg", "mousepos"], testCase.args]);

      expect(result.exitCode).toBe(0);
      expect(normalizeOutput(result.stderr)).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        cgWindowId: expect.any(Number),
        owner: expect.any(String),
      });
    });
  }
});

describe("CLI pipeline live helper failure contracts", () => {
  const failureCases: Array<{
    label: string;
    args: string[];
    stdinText: string;
    stderrIncludes: string;
  }> = [
    {
      label: "gfx outline rejects invalid stdin payload",
      args: ["gfx", "outline", "-"],
      stdinText: "{}",
      stderrIncludes: "Invalid stdin payload",
    },
    {
      label: "gfx spotlight rejects invalid stdin payload",
      args: ["gfx", "spotlight", "-", "--duration", "50"],
      stdinText: "{}",
      stderrIncludes: "Invalid stdin payload",
    },
    {
      label: "window focus rejects payloads without cgWindowId",
      args: ["window", "focus", "-"],
      stdinText: "{\"pid\":123,\"x\":0,\"y\":0,\"w\":10,\"h\":10}",
      stderrIncludes: "gui window focus payload has no usable cgWindowId",
    },
    {
      label: "window focus rejects multiple payload records",
      args: ["window", "focus", "-"],
      stdinText: "[{\"cgWindowId\":1},{\"cgWindowId\":2}]",
      stderrIncludes: "gui window focus expected exactly one JSON CG window payload on stdin, received 2",
    },
    {
      label: "window focus rejects non-json stdin",
      args: ["window", "focus", "-"],
      stdinText: "not-json",
      stderrIncludes: "gui window focus expected a JSON CG window payload",
    },
    {
      label: "ax focus rejects empty stdin",
      args: ["ax", "focus", "-"],
      stdinText: "",
      stderrIncludes: "gui ax focus received no AX target-bearing payload on stdin",
    },
    {
      label: "ax focus-window rejects empty stdin",
      args: ["ax", "focus-window", "-"],
      stdinText: "",
      stderrIncludes: "gui ax focus-window expected a JSON CLI composition payload",
    },
    {
      label: "gfx arrow rejects invalid stdin payload",
      args: ["gfx", "arrow", "-", "--target", "top"],
      stdinText: "{}",
      stderrIncludes: "Invalid stdin payload",
    },
  ];

  for (const failureCase of failureCases) {
    testIfLive(failureCase.label, async () => {
      const result = await runBundledLiteralCommand(failureCase.args, failureCase.stdinText);

      expect(result.exitCode).toBe(1);
      expect(normalizeOutput(result.stdout)).toBe("");
      expect(normalizeOutput(result.stderr)).toContain(failureCase.stderrIncludes);
    });
  }
});
