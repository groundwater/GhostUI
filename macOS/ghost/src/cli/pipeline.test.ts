import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { serializeAXQueryMatches } from "../a11y/ax-query.js";
import type { AXNode } from "./ax.js";
import {
  buildGfxArrowDrawScriptFromText,
  buildGfxOutlineDrawScriptFromText,
  buildGfxScanOverlayRequestFromText,
  buildGfxSpotlightDrawScriptFromText,
  buildGfxXrayDrawScriptFromText,
  DEFAULT_CA_HIGHLIGHT_TIMEOUT_MS,
} from "./main.js";
import {
  buildCLICompositionPayloadFromAXQueryMatch,
  buildCLICompositionPayloadFromVatQueryResult,
  readFirstJSONFrame,
  splitCLICompositionPayload,
} from "./payload.js";
import type { PlainNode } from "./types.js";

function streamFromChunks(
  chunks: string[],
  options: { closeWhenDone?: boolean } = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      if (options.closeWhenDone !== false) {
        controller.close();
      }
    },
  });
}

function normalizeOutput(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

async function withTempScripts<T>(
  files: Record<string, string>,
  run: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "ghostui-cli-pipeline-"));
  try {
    await Promise.all(
      Object.entries(files).map(([name, content]) => Bun.write(join(dir, name), content)),
    );
    return await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("CLI pipeline contracts", () => {
  test("serializes AX query matches into outline-ready payloads", () => {
    const tree: AXNode = {
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
          ],
        },
      ],
    };

    const [match] = serializeAXQueryMatches([{ pid: 42, tree }], "Button[title=Save]", "first");
    expect(match).toBeDefined();

    const payload = buildCLICompositionPayloadFromAXQueryMatch(match, "ax.query");
    const script = buildGfxOutlineDrawScriptFromText(JSON.stringify(payload));

    expect(payload.source).toBe("ax.query");
    expect(payload.target?.role).toBe("AXButton");
    expect(script).toMatchObject({
      coordinateSpace: "screen",
      timeout: DEFAULT_CA_HIGHLIGHT_TIMEOUT_MS,
      items: [
        {
          kind: "rect",
          rect: { x: 100, y: 100, width: 80, height: 40 },
        },
      ],
    });
  });

  test("fans multiple serialized AX query payloads into one outline script", () => {
    const tree: AXNode = {
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
    };

    const matches = serializeAXQueryMatches([{ pid: 42, tree }], "Button", "each");
    const payloadText = JSON.stringify(matches.map((match) =>
      buildCLICompositionPayloadFromAXQueryMatch(match, "ax.query")
    ));
    const script = buildGfxOutlineDrawScriptFromText(payloadText);

    expect(script).toMatchObject({
      coordinateSpace: "screen",
      timeout: DEFAULT_CA_HIGHLIGHT_TIMEOUT_MS,
      items: [
        {
          kind: "rect",
          rect: { x: 100, y: 100, width: 80, height: 40 },
        },
        {
          kind: "rect",
          rect: { x: 240, y: 100, width: 90, height: 40 },
        },
      ],
    });
  });

  test("consumes the first serialized AX frame from NDJSON without waiting for EOF", async () => {
    const tree: AXNode = {
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
    };

    const matches = serializeAXQueryMatches([{ pid: 42, tree }], "Button", "each");
    expect(matches).toHaveLength(2);

    const payloads = matches.map((match) => JSON.stringify(buildCLICompositionPayloadFromAXQueryMatch(match, "ax.query")));
    const result = await Promise.race([
      readFirstJSONFrame(streamFromChunks([`${payloads[0]}\n${payloads[1]}\n`], { closeWhenDone: false })),
      Bun.sleep(50).then(() => "__timeout__"),
    ]);

    expect(result).toBe(payloads[0]);
    expect(buildGfxOutlineDrawScriptFromText(result)).toMatchObject({
      items: [
        {
          kind: "rect",
          rect: { x: 100, y: 100, width: 80, height: 40 },
        },
      ],
    });
  });

  test("accepts pretty-printed serialized AX payloads across chunk boundaries", async () => {
    const tree: AXNode = {
      role: "AXWindow",
      title: "Settings",
      children: [
        {
          role: "AXButton",
          title: "Save",
          frame: { x: 100, y: 100, width: 80, height: 40 },
          actions: ["AXPress"],
        },
      ],
    };

    const [match] = serializeAXQueryMatches([{ pid: 42, tree }], "Button[title=Save]", "first");
    const pretty = JSON.stringify(buildCLICompositionPayloadFromAXQueryMatch(match, "ax.query"), null, 2);

    const result = await Promise.race([
      readFirstJSONFrame(streamFromChunks([pretty.slice(0, 24), pretty.slice(24)], { closeWhenDone: false })),
      Bun.sleep(50).then(() => "__timeout__"),
    ]);

    expect(result).toBe(pretty);
    expect(buildGfxOutlineDrawScriptFromText(result).items).toHaveLength(1);
  });

  test("fans VAT query payloads into spotlight, xray, scan, and arrow consumers", () => {
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
    const payloadText = JSON.stringify(
      buildCLICompositionPayloadFromVatQueryResult("Window[frame]", tree, nodes, nodes.length),
    );

    const spotlight = buildGfxSpotlightDrawScriptFromText(payloadText);
    const xray = buildGfxXrayDrawScriptFromText(payloadText);
    const scan = buildGfxScanOverlayRequestFromText(payloadText, 750);
    const arrow = buildGfxArrowDrawScriptFromText(payloadText);

    expect(spotlight.items).toEqual([
      {
        kind: "spotlight",
        rects: [
          { x: 40, y: 50, width: 300, height: 200 },
          { x: 400, y: 50, width: 320, height: 220 },
        ],
        style: {
          fill: "rgba(0,0,0,.5)",
          cornerRadius: 18,
          opacity: 1,
        },
        animation: {
          durMs: 200,
          ease: "easeInOut",
        },
      },
    ]);
    expect(xray.items).toHaveLength(2);
    expect(scan).toEqual({
      rects: [
        { x: 40, y: 50, width: 300, height: 200 },
        { x: 400, y: 50, width: 320, height: 220 },
      ],
      durationMs: 750,
      direction: "top-to-bottom",
    });
    expect(buildGfxScanOverlayRequestFromText(payloadText, {
      durationMs: 750,
      direction: "right-to-left",
    })).toEqual({
      rects: [
        { x: 40, y: 50, width: 300, height: 200 },
        { x: 400, y: 50, width: 320, height: 220 },
      ],
      durationMs: 750,
      direction: "right-to-left",
    });
    expect(arrow.items).toHaveLength(6);
  });

  test("splits a multi-node VAT payload into per-node NDJSON frames in scanline order", () => {
    const tree: PlainNode = {
      _tag: "VATRoot",
      _children: [
        {
          _tag: "Application",
          _children: [
            {
              _tag: "Window",
              title: "Bottom",
              frame: { x: 50, y: 400, width: 300, height: 200 },
            },
            {
              _tag: "Window",
              title: "Top",
              frame: { x: 100, y: 30, width: 280, height: 180 },
            },
            {
              _tag: "Window",
              title: "Middle",
              frame: { x: 200, y: 200, width: 320, height: 220 },
            },
          ],
        },
      ],
    };
    const nodes = tree._children?.[0]?._children ?? [];
    const payload = buildCLICompositionPayloadFromVatQueryResult("Window[frame]", tree, nodes, nodes.length);

    // Verify the batch payload has all 3 nodes
    expect(payload.nodes).toHaveLength(3);
    expect(payload.matchCount).toBe(3);

    // Split into single-node frames
    const frames = splitCLICompositionPayload(payload);

    expect(frames).toHaveLength(3);

    // Each frame must be a complete single-node payload
    for (const frame of frames) {
      expect(frame.type).toBe("gui.payload");
      expect(frame.version).toBe(1);
      expect(frame.nodes).toHaveLength(1);
      expect(frame.matchCount).toBe(1);
      expect(frame.bounds).not.toBeNull();
      expect(frame.point).not.toBeNull();
    }

    // Frames preserve original node order (caller sorts by rect for scanline)
    expect((frames[0].node as PlainNode & Record<string, unknown>).title).toBe("Bottom");
    expect((frames[1].node as PlainNode & Record<string, unknown>).title).toBe("Top");
    expect((frames[2].node as PlainNode & Record<string, unknown>).title).toBe("Middle");

    // Each frame carries correct per-node bounds
    expect(frames[0].bounds).toEqual({ x: 50, y: 400, width: 300, height: 200 });
    expect(frames[1].bounds).toEqual({ x: 100, y: 30, width: 280, height: 180 });
    expect(frames[2].bounds).toEqual({ x: 200, y: 200, width: 320, height: 220 });

    // buildGfxScanOverlayRequestFromText re-extracts per-node rects
    const scanText = frames.map(f => JSON.stringify(f)).join("\n");
    const scan = buildGfxScanOverlayRequestFromText(scanText, 500);
    expect(scan.rects).toHaveLength(3);
    expect(scan.durationMs).toBe(500);
  });

  test("single-node payload passes through splitCLICompositionPayload unchanged", () => {
    const tree: PlainNode = {
      _tag: "VATRoot",
      _children: [
        {
          _tag: "Application",
          _children: [
            {
              _tag: "Window",
              title: "Only",
              frame: { x: 10, y: 20, width: 100, height: 50 },
            },
          ],
        },
      ],
    };
    const nodes = tree._children?.[0]?._children ?? [];
    const payload = buildCLICompositionPayloadFromVatQueryResult("Window[frame]", tree, nodes, 1);
    const frames = splitCLICompositionPayload(payload);

    expect(frames).toHaveLength(1);
    expect(frames[0]).toBe(payload);
  });

  test("fails cleanly when a serialized AX payload does not resolve bounds", () => {
    const tree: AXNode = {
      role: "AXWindow",
      title: "Settings",
      children: [
        {
          role: "AXButton",
          title: "Save",
          actions: ["AXPress"],
        },
      ],
    };

    const [match] = serializeAXQueryMatches([{ pid: 42, tree }], "Button[title=Save]", "first");
    const payloadText = JSON.stringify(buildCLICompositionPayloadFromAXQueryMatch(match, "ax.query"));

    expect(() => buildGfxOutlineDrawScriptFromText(payloadText))
      .toThrow('gui gfx outline - AXButton "Save" is missing bounds/frame coordinates');
  });
});

describe("CLI pipeline process smoke", () => {
  test("reads the first payload frame across a real process pipe", async () => {
    const producerPayloads = [
      {
        type: "gui.payload",
        version: 1,
        source: "fixture",
        query: null,
        tree: null,
        nodes: null,
        matchCount: 1,
        node: null,
        target: {
          type: "ax.target",
          version: 1,
          pid: 42,
          role: "AXButton",
          title: "Save",
          frame: { x: 100, y: 100, width: 80, height: 40 },
          point: { x: 140, y: 120 },
        },
        cursor: null,
        axQueryMatch: null,
        vatQueryPlan: null,
        bounds: { x: 100, y: 100, width: 80, height: 40 },
        point: { x: 140, y: 120 },
        issues: [],
      },
      {
        type: "gui.payload",
        version: 1,
        source: "fixture",
        query: null,
        tree: null,
        nodes: null,
        matchCount: 1,
        node: null,
        target: {
          type: "ax.target",
          version: 1,
          pid: 42,
          role: "AXButton",
          title: "Cancel",
          frame: { x: 240, y: 100, width: 90, height: 40 },
          point: { x: 285, y: 120 },
        },
        cursor: null,
        axQueryMatch: null,
        vatQueryPlan: null,
        bounds: { x: 240, y: 100, width: 90, height: 40 },
        point: { x: 285, y: 120 },
        issues: [],
      },
    ];
    await withTempScripts(
      {
        "producer.ts": [
          `const payloads = ${JSON.stringify(producerPayloads, null, 2)};`,
          'process.stdout.write(payloads.map((payload) => JSON.stringify(payload)).join("\\n"));',
        ].join("\n"),
        "consumer.ts": [
          `import { readFirstJSONFrame } from ${JSON.stringify(join(process.cwd(), "src/cli/payload.ts"))};`,
          `import { buildGfxOutlineDrawScriptFromText } from ${JSON.stringify(join(process.cwd(), "src/cli/main.ts"))};`,
          'const frame = await readFirstJSONFrame(Bun.stdin.stream());',
          'process.stdout.write(JSON.stringify(buildGfxOutlineDrawScriptFromText(frame)));',
        ].join("\n"),
      },
      async (dir) => {
        const producer = Bun.spawn({
          cmd: ["bun", join(dir, "producer.ts")],
          cwd: process.cwd(),
          stdout: "pipe",
          stderr: "pipe",
          env: process.env,
        });
        const consumer = Bun.spawn({
          cmd: ["bun", join(dir, "consumer.ts")],
          cwd: process.cwd(),
          stdin: producer.stdout,
          stdout: "pipe",
          stderr: "pipe",
          env: process.env,
        });

        const [producerStderr, producerExitCode, stdout, stderr, exitCode] = await Promise.all([
          new Response(producer.stderr).text(),
          producer.exited,
          new Response(consumer.stdout).text(),
          new Response(consumer.stderr).text(),
          consumer.exited,
        ]);

        expect(producerExitCode).toBe(0);
        expect(exitCode).toBe(0);
        expect(normalizeOutput(producerStderr)).toBe("");
        expect(normalizeOutput(stderr)).toBe("");
        expect(JSON.parse(stdout)).toMatchObject({
          coordinateSpace: "screen",
          timeout: DEFAULT_CA_HIGHLIGHT_TIMEOUT_MS,
          items: [
            {
              kind: "rect",
              rect: { x: 100, y: 100, width: 80, height: 40 },
            },
          ],
        });
      },
    );
  });
});
