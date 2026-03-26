import { fileURLToPath } from "url";
import { serializeAXQueryMatches } from "../a11y/ax-query.js";
import type { AXNode } from "./ax.js";
import {
  buildCLICompositionPayloadFromAXQueryMatch,
  buildCLICompositionPayloadFromVatQueryResult,
  type CLICompositionPayload,
} from "./payload.js";
import type { AXCursor, AXTarget } from "./ax.js";
import type { PlainNode } from "./types.js";

export type FramingMode = "compact" | "pretty" | "ndjson";
export type AXPayloadMode = "direct" | "nested" | "missing-bounds";
export type VATPayloadMode = "single" | "multi" | "nested" | "duplicate";

export const MAIN_MODULE_PATH = fileURLToPath(new URL("./main.ts", import.meta.url));
export const PAYLOAD_MODULE_PATH = fileURLToPath(new URL("./payload.ts", import.meta.url));
export const CLI_TEST_SKIP_OVERLAY_ENV = "GHOSTUI_TEST_SKIP_OVERLAY";

export interface SpawnedProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SpawnedPipelineResult extends SpawnedProcessResult {
  producerExitCode: number;
  producerStderr: string;
}

export interface PipelineTextFixture {
  framing: FramingMode;
  text: string;
}

export function normalizeOutput(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

export function makeAXTargetPayload(overrides: Partial<AXTarget> = {}): AXTarget {
  return {
    type: "ax.target",
    pid: 42,
    role: "AXButton",
    title: "Save",
    bounds: { x: 100, y: 100, width: 80, height: 40 },
    point: { x: 140, y: 120 },
    ...overrides,
  };
}

export function makeAXCursorPayload(overrides: Partial<AXCursor> = {}): AXCursor {
  return {
    type: "ax.cursor",
    target: makeAXTargetPayload(),
    selection: { location: 2, length: 0 },
    ...overrides,
  };
}

export function makeCGWindowPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pid: 123,
    cgWindowId: 13801,
    x: 100,
    y: 120,
    w: 800,
    h: 600,
    owner: "TextEdit",
    ...overrides,
  };
}

function makeAXTree(mode: Exclude<AXPayloadMode, "missing-bounds">): { tree: AXNode; query: string } {
  switch (mode) {
    case "direct":
      return {
        query: "Button[title=Save]",
        tree: {
          role: "AXWindow",
          title: "Settings",
          children: [
            {
              role: "AXButton",
              title: "Save",
              frame: { x: 100, y: 100, width: 80, height: 40 },
              actions: ["AXPress"],
            },
            {
              role: "AXButton",
              title: "Cancel",
              frame: { x: 240, y: 100, width: 90, height: 40 },
              actions: ["AXPress"],
            },
          ],
        },
      };
    case "nested":
      return {
        query: "Button[title=Save]",
        tree: {
          role: "AXWindow",
          title: "Settings",
          children: [
            {
              role: "AXGroup",
              children: [
                {
                  role: "AXButton",
                  title: "Save",
                  frame: { x: 100, y: 100, width: 80, height: 40 },
                  actions: ["AXPress"],
                },
                {
                  role: "AXButton",
                  title: "Cancel",
                  frame: { x: 240, y: 100, width: 90, height: 40 },
                  actions: ["AXPress"],
                },
              ],
            },
          ],
        },
      };
  }
}

export function makeAXPayload(mode: AXPayloadMode): { payload: CLICompositionPayload; expectedRects: number } {
  if (mode === "missing-bounds") {
    return {
      payload: {
        type: "gui.payload",
        version: 1,
        source: "ax.query",
        query: null,
        tree: null,
        nodes: [{ _tag: "AXButton", _id: "Save" }],
        matchCount: 1,
        node: { _tag: "AXButton", _id: "Save" },
        target: makeAXTargetPayload({ bounds: undefined }),
        cursor: null,
        axQueryMatch: {
          type: "ax.query-match",
          pid: 42,
          node: { _tag: "AXButton", _id: "Save" },
          target: makeAXTargetPayload({ bounds: undefined }),
        },
        vatQueryPlan: null,
        rectUnion: null,
        bounds: null,
        point: { x: 140, y: 120 },
        issues: [],
      },
      expectedRects: 0,
    };
  }

  const { tree, query } = makeAXTree(mode);
  const [match] = serializeAXQueryMatches([{ pid: 42, tree }], query, "first");
  return {
    payload: buildCLICompositionPayloadFromAXQueryMatch(match, "ax.query"),
    expectedRects: 1,
  };
}

function makeVatFixture(mode: VATPayloadMode): { query: string; tree: PlainNode; nodes: PlainNode[]; matchCount: number; expectedRects: number } {
  switch (mode) {
    case "single": {
      const tree: PlainNode = {
        _tag: "VATRoot",
        _children: [
          {
            _tag: "Application",
            _children: [
              {
                _tag: "Window",
                title: "One",
                frame: { x: 40, y: 50, width: 300, height: 200 },
              },
            ],
          },
        ],
      };
      const nodes = tree._children?.[0]?._children ?? [];
      return { query: "Window[frame]", tree, nodes, matchCount: nodes.length, expectedRects: 1 };
    }
    case "multi": {
      const tree: PlainNode = {
        _tag: "VATRoot",
        _children: [
          {
            _tag: "Application",
            _children: [
              {
                _tag: "Window",
                title: "One",
                frame: { x: 40, y: 50, width: 300, height: 200 },
              },
              {
                _tag: "Window",
                title: "Two",
                frame: { x: 400, y: 50, width: 320, height: 220 },
              },
            ],
          },
        ],
      };
      const nodes = tree._children?.[0]?._children ?? [];
      return { query: "Window[frame]", tree, nodes, matchCount: nodes.length, expectedRects: 2 };
    }
    case "nested": {
      const tree: PlainNode = {
        _tag: "VATRoot",
        _children: [
          {
            _tag: "Application",
            _children: [
              {
                _tag: "Window",
                title: "Codex",
                frame: { x: 220, y: 24, width: 900, height: 720 },
                _children: [
                  {
                    _tag: "Button",
                    label: "Commit",
                    frame: { x: 894, y: 34, width: 31, height: 28 },
                  },
                ],
              },
            ],
          },
        ],
      };
      const nodes = tree._children?.[0]?._children ?? [];
      return { query: "Window[frame]", tree, nodes, matchCount: nodes.length, expectedRects: 2 };
    }
    case "duplicate": {
      const tree: PlainNode = {
        _tag: "VATRoot",
        _children: [
          {
            _tag: "Application",
            _children: [
              {
                _tag: "Window",
                title: "One",
                frame: { x: 40, y: 50, width: 300, height: 200 },
              },
              {
                _tag: "WindowGroup",
                _children: [
                  {
                    _tag: "Window",
                    title: "One duplicate",
                    frame: { x: 40, y: 50, width: 300, height: 200 },
                  },
                ],
              },
            ],
          },
        ],
      };
      const nodes = [tree._children?.[0]].filter(Boolean) as PlainNode[];
      return { query: "Application", tree, nodes, matchCount: nodes.length, expectedRects: 1 };
    }
  }
}

export function makeVatPayload(mode: VATPayloadMode): { payload: CLICompositionPayload; expectedRects: number } {
  const { query, tree, nodes, matchCount, expectedRects } = makeVatFixture(mode);
  return {
    payload: buildCLICompositionPayloadFromVatQueryResult(query, tree, nodes, matchCount),
    expectedRects,
  };
}

export function formatPayloadText(payload: CLICompositionPayload, framing: FramingMode): PipelineTextFixture {
  const compact = JSON.stringify(payload);
  switch (framing) {
    case "compact":
      return { framing, text: compact };
    case "pretty":
      return { framing, text: JSON.stringify(payload, null, 2) };
    case "ndjson":
      return { framing, text: `${compact}\n${compact}\n` };
  }
}

export async function runProducerConsumer(
  producerText: string,
  consumerScript: string,
  consumerArgs: string[] = [],
  consumerEnv: Record<string, string | undefined> = {},
): Promise<SpawnedPipelineResult> {
  const producer = Bun.spawn({
    cmd: [
      "bun",
      "-e",
      "process.stdout.write(process.env.PIPELINE_INPUT ?? '');",
    ],
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PIPELINE_INPUT: producerText,
    },
  });

  const consumer = Bun.spawn({
    cmd: ["bun", "-e", consumerScript, ...consumerArgs],
    stdin: producer.stdout,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ...consumerEnv,
    },
  });

  const [producerStderr, producerExitCode, stdout, stderr, exitCode] = await Promise.all([
    new Response(producer.stderr).text(),
    producer.exited,
    new Response(consumer.stdout).text(),
    new Response(consumer.stderr).text(),
    consumer.exited,
  ]);

  return {
    producerExitCode,
    producerStderr,
    exitCode,
    stdout,
    stderr,
  };
}

export async function runMainCLI(
  producerText: string,
  cliArgs: string[],
  extraEnv: Record<string, string | undefined> = {},
): Promise<SpawnedPipelineResult> {
  const producer = Bun.spawn({
    cmd: [
      "bun",
      "-e",
      "process.stdout.write(process.env.PIPELINE_INPUT ?? '');",
    ],
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PIPELINE_INPUT: producerText,
    },
  });

  const consumer = Bun.spawn({
    cmd: ["bun", MAIN_MODULE_PATH, ...cliArgs],
    stdin: producer.stdout,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ...extraEnv,
    },
  });

  const [producerStderr, producerExitCode, stdout, stderr, exitCode] = await Promise.all([
    new Response(producer.stderr).text(),
    producer.exited,
    new Response(consumer.stdout).text(),
    new Response(consumer.stderr).text(),
    consumer.exited,
  ]);

  return {
    producerExitCode,
    producerStderr,
    exitCode,
    stdout,
    stderr,
  };
}

export function parseJSON<T>(text: string): T {
  return JSON.parse(text) as T;
}

export function countDrawItemsOfKind(result: unknown, kind: string): number {
  if (!result || typeof result !== "object") return 0;
  const items = (result as { items?: Array<{ kind?: string }> }).items;
  if (!Array.isArray(items)) return 0;
  return items.filter(item => item.kind === kind).length;
}
