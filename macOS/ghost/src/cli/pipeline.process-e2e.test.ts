import { describe, expect, test } from "bun:test";
import {
  CLI_TEST_SKIP_OVERLAY_ENV,
  MAIN_MODULE_PATH,
  PAYLOAD_MODULE_PATH,
  formatPayloadText,
  makeAXCursorPayload,
  makeAXPayload,
  makeAXTargetPayload,
  makeCGWindowPayload,
  makeVatPayload,
  normalizeOutput,
  parseJSON,
  runMainCLI,
  runProducerConsumer,
  type FramingMode,
} from "./pipeline.fixtures.js";
import type { AXNode } from "./ax.js";

type GfxConsumer = "outline" | "xray" | "spotlight" | "arrow" | "scan";
type PassthroughStage = "ca-highlight" | "gfx-outline" | "gfx-xray" | "gfx-spotlight" | "gfx-arrow" | "gfx-scan";

const PARSER_CONSUMER_SCRIPT = `
import {
  buildActorClickPassthroughRequest,
  buildActorMovePassthroughRequest,
  parseCGPointPassthroughInput,
  parseCGDragPoints,
  parseRecRectArgFromPayloadText,
  parseSingleAXTargetPassthroughInput,
  parseSingleCGWindowPayloadText,
} from ${JSON.stringify(MAIN_MODULE_PATH)};

const mode = process.argv[1];
const input = await new Response(Bun.stdin.stream()).text();

try {
  let result;
  switch (mode) {
    case "point":
      result = parseCGPointPassthroughInput(input, process.argv[2]);
      break;
    case "rect":
      result = parseRecRectArgFromPayloadText(input, process.argv[2]);
      break;
    case "window":
      result = parseSingleCGWindowPayloadText(input, process.argv[2]);
      break;
    case "drag":
      result = parseCGDragPoints(JSON.parse(process.argv[2]), process.argv[3], input);
      break;
    case "actor-click":
      result = buildActorClickPassthroughRequest(
        JSON.parse(process.argv[2]),
        parseSingleAXTargetPassthroughInput(input, "actor run click").target,
      );
      break;
    case "actor-move":
      result = buildActorMovePassthroughRequest(
        JSON.parse(process.argv[2]),
        parseSingleAXTargetPassthroughInput(input, "actor run move").target,
      );
      break;
    case "ax-target":
      result = parseSingleAXTargetPassthroughInput(input, process.argv[2]);
      break;
    default:
      throw new Error(\`unknown parser mode \${mode}\`);
  }
  process.stdout.write(typeof result === "string" ? result : JSON.stringify(result));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
`;

const gfxConsumers: GfxConsumer[] = ["outline", "xray", "spotlight", "arrow", "scan"];
const passthroughStages: PassthroughStage[] = [
  "ca-highlight",
  "gfx-outline",
  "gfx-xray",
  "gfx-spotlight",
  "gfx-arrow",
  "gfx-scan",
];
const framings: FramingMode[] = ["compact", "pretty", "ndjson"];
const cliTestEnv = {
  [CLI_TEST_SKIP_OVERLAY_ENV]: "1",
};

const BUILD_AX_QUERY_PAYLOADS_SCRIPT = `
import { serializeAXQueryMatches } from ${JSON.stringify(new URL("../a11y/ax-query.ts", import.meta.url).pathname)};
import { buildCLICompositionPayloadFromAXQueryMatch } from ${JSON.stringify(PAYLOAD_MODULE_PATH)};

const tree = ${JSON.stringify({
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
} satisfies AXNode)};

const framing = process.argv[1];
const matches = serializeAXQueryMatches([{ pid: 42, tree }], "Button", "each");
const payloads = matches.map((match) => buildCLICompositionPayloadFromAXQueryMatch(match, "ax.query"));

switch (framing) {
  case "array":
    process.stdout.write(JSON.stringify(payloads));
    break;
  case "ndjson":
    process.stdout.write(payloads.map((payload) => JSON.stringify(payload)).join("\\n") + "\\n");
    break;
  default:
    throw new Error(\`unknown framing \${framing}\`);
}
`;

function expectedFirstFrameText(payload: unknown, framing: FramingMode): string {
  switch (framing) {
    case "compact":
      return JSON.stringify(payload);
    case "pretty":
      return JSON.stringify(payload, null, 2);
    case "ndjson":
      return JSON.stringify(payload);
  }
}

describe("CLI pipeline process e2e AX -> gfx matrix", () => {
  for (const consumer of gfxConsumers) {
    for (const mode of ["direct", "nested"] as const) {
      for (const framing of framings) {
        test(`${consumer} accepts ${mode} AX payload over ${framing} framing`, async () => {
          const { payload } = makeAXPayload(mode);
          const { text } = formatPayloadText(payload, framing);
          const result = await runMainCLI(text, ["gfx", consumer, "-"], cliTestEnv);

          expect(result.producerExitCode).toBe(0);
          expect(result.exitCode).toBe(0);
          expect(normalizeOutput(result.producerStderr)).toBe("");
          expect(normalizeOutput(result.stderr)).toBe("");
          expect(result.stdout).toBe(expectedFirstFrameText(payload, framing));
        });
      }
    }
  }

  for (const consumer of gfxConsumers) {
    for (const framing of framings) {
      test(`${consumer} rejects AX payloads with missing bounds over ${framing} framing`, async () => {
        const { payload } = makeAXPayload("missing-bounds");
        const { text } = formatPayloadText(payload, framing);
        const result = await runMainCLI(text, ["gfx", consumer, "-"], cliTestEnv);

        expect(result.producerExitCode).toBe(0);
        expect(result.exitCode).toBe(1);
        expect(normalizeOutput(result.producerStderr)).toBe("");
        expect(normalizeOutput(result.stderr)).toContain('AXButton "Save" is missing bounds/frame coordinates');
      });
    }
  }
});

describe("CLI pipeline process e2e AX multi-match -> gfx outline", () => {
  for (const framing of ["array", "ndjson"] as const) {
    test(`outline accepts AX multi-match payload streams over ${framing} framing`, async () => {
      const result = await runProducerConsumer(
        "",
        BUILD_AX_QUERY_PAYLOADS_SCRIPT,
        [framing],
        cliTestEnv,
      );

      const outlined = await runMainCLI(result.stdout, ["gfx", "outline", "-"], cliTestEnv);

      expect(result.producerExitCode).toBe(0);
      expect(result.exitCode).toBe(0);
      expect(normalizeOutput(result.producerStderr)).toBe("");
      expect(normalizeOutput(result.stderr)).toBe("");

      expect(outlined.producerExitCode).toBe(0);
      expect(outlined.exitCode).toBe(0);
      expect(normalizeOutput(outlined.producerStderr)).toBe("");
      expect(normalizeOutput(outlined.stderr)).toBe("");
      expect(normalizeOutput(outlined.stdout)).toBe(
        normalizeOutput(
          framing === "array"
            ? result.stdout
            : result.stdout.split("\n")[0] ?? "",
        ),
      );
    });
  }
});

describe("CLI pipeline process e2e VAT -> gfx matrix", () => {
  for (const consumer of gfxConsumers) {
    for (const mode of ["single", "multi", "nested", "duplicate"] as const) {
      for (const framing of framings) {
        test(`${consumer} accepts ${mode} VAT payloads over ${framing} framing`, async () => {
          const { payload } = makeVatPayload(mode);
          const { text } = formatPayloadText(payload, framing);
          const result = await runMainCLI(text, ["gfx", consumer, "-"], cliTestEnv);

          expect(result.producerExitCode).toBe(0);
          expect(result.exitCode).toBe(0);
          expect(normalizeOutput(result.producerStderr)).toBe("");
          expect(normalizeOutput(result.stderr)).toBe("");
          expect(result.stdout).toBe(expectedFirstFrameText(payload, framing));
        });
      }
    }
  }
});

describe("CLI pipeline process e2e passthrough preservation", () => {
  const passthroughPayloads = [
    { label: "ax-direct", payload: makeAXPayload("direct").payload },
    { label: "vat-multi", payload: makeVatPayload("multi").payload },
  ] as const;

  for (const stage of passthroughStages) {
    const stageFramings = stage === "ca-highlight"
      ? (["compact", "pretty"] as const)
      : framings;
    for (const framing of stageFramings) {
      for (const payloadCase of passthroughPayloads) {
        test(`${stage} preserves ${payloadCase.label} stdin over ${framing} framing`, async () => {
          const { text } = formatPayloadText(payloadCase.payload, framing);
          const cliArgs = (() => {
            switch (stage) {
              case "ca-highlight":
                return ["ca", "highlight", "-"];
              case "gfx-outline":
                return ["gfx", "outline", "-"];
              case "gfx-xray":
                return ["gfx", "xray", "-"];
              case "gfx-spotlight":
                return ["gfx", "spotlight", "-"];
              case "gfx-arrow":
                return ["gfx", "arrow", "-"];
              case "gfx-scan":
                return ["gfx", "scan", "-"];
            }
          })();
          const result = await runMainCLI(text, cliArgs, cliTestEnv);

          expect(result.producerExitCode).toBe(0);
          expect(result.exitCode).toBe(0);
          expect(normalizeOutput(result.producerStderr)).toBe("");
          expect(normalizeOutput(result.stderr)).toBe("");
          expect(result.stdout).toBe(expectedFirstFrameText(payloadCase.payload, framing));
        });
      }
    }
  }
});

describe("CLI pipeline process e2e parser and stdin contracts", () => {
  const targetPayload = makeAXTargetPayload();
  const cursorPayload = makeAXCursorPayload();
  const windowPayload = makeCGWindowPayload();

  const parserCases: Array<{
    name: string;
    mode: string;
    stdinText: string;
    args: string[];
    expectedStdout?: string;
    expectedStderr?: string;
    expectedExitCode: number;
  }> = [
    {
      name: "extracts cg move coordinates from an AX target payload",
      mode: "point",
      stdinText: JSON.stringify(targetPayload),
      args: ["cg move"],
      expectedStdout: JSON.stringify({ x: 140, y: 120 }),
      expectedExitCode: 0,
    },
    {
      name: "extracts cg click coordinates from an AX cursor payload",
      mode: "point",
      stdinText: JSON.stringify(cursorPayload),
      args: ["cg click"],
      expectedStdout: JSON.stringify({ x: 140, y: 120 }),
      expectedExitCode: 0,
    },
    {
      name: "extracts rec image rect arguments from a bounds-bearing payload",
      mode: "rect",
      stdinText: JSON.stringify(targetPayload),
      args: ["rec image"],
      expectedStdout: "100,100,80,40",
      expectedExitCode: 0,
    },
    {
      name: "rejects rec payloads without usable bounds",
      mode: "rect",
      stdinText: JSON.stringify(makeAXTargetPayload({ bounds: undefined })),
      args: ["rec image"],
      expectedStderr: 'gui rec image AXButton "Save" has no usable bounds',
      expectedExitCode: 1,
    },
    {
      name: "extracts a cgWindowId from a single CG window payload",
      mode: "window",
      stdinText: JSON.stringify(windowPayload),
      args: ["window focus"],
      expectedStdout: "13801",
      expectedExitCode: 0,
    },
    {
      name: "extracts a cgWindowId from a single-element CG window array payload",
      mode: "window",
      stdinText: JSON.stringify([windowPayload]),
      args: ["window focus"],
      expectedStdout: "13801",
      expectedExitCode: 0,
    },
    {
      name: "rejects CG window payload arrays with multiple records",
      mode: "window",
      stdinText: JSON.stringify([{ cgWindowId: 1 }, { cgWindowId: 2 }]),
      args: ["window focus"],
      expectedStderr: "gui window focus expected exactly one JSON CG window payload on stdin, received 2",
      expectedExitCode: 1,
    },
    {
      name: "rejects CG window payloads without a usable cgWindowId",
      mode: "window",
      stdinText: JSON.stringify({ pid: 123, x: 100, y: 120, w: 800, h: 600 }),
      args: ["window focus"],
      expectedStderr: "gui window focus payload has no usable cgWindowId",
      expectedExitCode: 1,
    },
    {
      name: "rejects non-JSON CG window payloads",
      mode: "window",
      stdinText: "not-json",
      args: ["window focus"],
      expectedStderr: "gui window focus expected a JSON CG window payload",
      expectedExitCode: 1,
    },
    {
      name: "parses cg drag mixed stdin and literal JSON endpoints",
      mode: "drag",
      stdinText: `${JSON.stringify(targetPayload)}\n`,
      args: [JSON.stringify(["-", JSON.stringify(makeAXTargetPayload({ point: { x: 900, y: 480 }, role: "AXGroup" }))]), "cg drag"],
      expectedStdout: JSON.stringify({ from: { x: 140, y: 120 }, to: { x: 900, y: 480 } }),
      expectedExitCode: 0,
    },
    {
      name: "parses cg drag sequential stdin placeholders as ndjson",
      mode: "drag",
      stdinText: `${JSON.stringify(targetPayload)}\n${JSON.stringify(makeAXTargetPayload({ point: { x: 640, y: 360 }, role: "AXSlider" }))}\n`,
      args: [JSON.stringify(["-", "-"]), "cg drag"],
      expectedStdout: JSON.stringify({ from: { x: 140, y: 120 }, to: { x: 640, y: 360 } }),
      expectedExitCode: 0,
    },
    {
      name: "parses cg drag literal coordinates without stdin payloads",
      mode: "drag",
      stdinText: "",
      args: [JSON.stringify(["12", "34", "56", "78"]), "cg drag"],
      expectedStdout: JSON.stringify({ from: { x: 12, y: 34 }, to: { x: 56, y: 78 } }),
      expectedExitCode: 0,
    },
    {
      name: "rejects cg drag stdin placeholder count mismatches",
      mode: "drag",
      stdinText: `${JSON.stringify(targetPayload)}\n`,
      args: [JSON.stringify(["-", "-"]), "cg drag"],
      expectedStderr: "gui cg drag expected 2 AX target-bearing payloads on stdin for 2 `-` placeholders, received 1",
      expectedExitCode: 1,
    },
    {
      name: "rejects cg drag endpoints with invalid literals",
      mode: "drag",
      stdinText: "",
      args: [JSON.stringify(["x", "y", "56", "78"]), "cg drag"],
      expectedStderr: "gui cg drag from endpoint must be <x> <y>, `-`, or a literal JSON AX target / AX query match payload",
      expectedExitCode: 1,
    },
    {
      name: "rejects cg drag with extra positional arguments",
      mode: "drag",
      stdinText: "",
      args: [JSON.stringify(["12", "34", "56", "78", "99"]), "cg drag"],
      expectedStderr: "gui cg drag received extra positional arguments after the to endpoint",
      expectedExitCode: 1,
    },
    {
      name: "builds actor click passthrough requests from stdin targets",
      mode: "actor-click",
      stdinText: JSON.stringify(targetPayload),
      args: [JSON.stringify(["-", "--button", "right", "--timeout", "500"])],
      expectedStdout: JSON.stringify({
        timeoutMs: 500,
        action: {
          kind: "click",
          button: "right",
          at: { x: 140, y: 120 },
        },
      }),
      expectedExitCode: 0,
    },
    {
      name: "rejects actor click stdin mode with multiple placeholders",
      mode: "actor-click",
      stdinText: JSON.stringify(targetPayload),
      args: [JSON.stringify(["-", "-"])],
      expectedStderr: "actor run click stdin mode requires exactly one `-` argument",
      expectedExitCode: 1,
    },
    {
      name: "rejects actor click stdin mode combined with --at",
      mode: "actor-click",
      stdinText: JSON.stringify(targetPayload),
      args: [JSON.stringify(["-", "--at", "10", "20"])],
      expectedStderr: "actor run click stdin mode cannot be combined with --at",
      expectedExitCode: 1,
    },
    {
      name: "builds actor move passthrough requests from stdin targets",
      mode: "actor-move",
      stdinText: JSON.stringify(targetPayload),
      args: [JSON.stringify(["-", "--style", "slow", "--timeout", "750"])],
      expectedStdout: JSON.stringify({
        timeoutMs: 750,
        action: {
          kind: "move",
          style: "slow",
          to: { x: 140, y: 120 },
        },
      }),
      expectedExitCode: 0,
    },
    {
      name: "rejects actor move stdin mode with multiple placeholders",
      mode: "actor-move",
      stdinText: JSON.stringify(targetPayload),
      args: [JSON.stringify(["-", "-"])],
      expectedStderr: "actor run move stdin mode requires exactly one `-` argument",
      expectedExitCode: 1,
    },
    {
      name: "rejects actor move stdin mode combined with --to",
      mode: "actor-move",
      stdinText: JSON.stringify(targetPayload),
      args: [JSON.stringify(["-", "--to", "10", "20"])],
      expectedStderr: "actor run move stdin mode cannot be combined with --to",
      expectedExitCode: 1,
    },
    {
      name: "preserves AX cursor payloads as target-bearing stdin",
      mode: "ax-target",
      stdinText: `${JSON.stringify(cursorPayload)}\n`,
      args: ["actor run move"],
      expectedStdout: JSON.stringify({
        raw: `${JSON.stringify(cursorPayload)}\n`,
        target: targetPayload,
      }),
      expectedExitCode: 0,
    },
    {
      name: "rejects empty AX target-bearing stdin",
      mode: "ax-target",
      stdinText: "",
      args: ["actor run click"],
      expectedStderr: "gui actor run click received no AX target-bearing payload on stdin",
      expectedExitCode: 1,
    },
  ];

  for (const parserCase of parserCases) {
    test(parserCase.name, async () => {
      const result = await runProducerConsumer(
        parserCase.stdinText,
        PARSER_CONSUMER_SCRIPT,
        [parserCase.mode, ...parserCase.args],
      );

      expect(result.producerExitCode).toBe(0);
      expect(normalizeOutput(result.producerStderr)).toBe("");
      expect(result.exitCode).toBe(parserCase.expectedExitCode);
      if (parserCase.expectedStdout !== undefined) {
        if (parserCase.expectedStdout.startsWith("{") || parserCase.expectedStdout.startsWith("[")) {
          expect(parseJSON(result.stdout)).toEqual(parseJSON(parserCase.expectedStdout));
        } else {
          expect(result.stdout).toBe(parserCase.expectedStdout);
        }
      }
      if (parserCase.expectedStderr !== undefined) {
        expect(normalizeOutput(result.stderr)).toBe(parserCase.expectedStderr);
      } else {
        expect(normalizeOutput(result.stderr)).toBe("");
      }
    });
  }
});

describe("CLI pipeline process e2e actor command dispatch", () => {
  test("actor run pointer.click rejects stdin passthrough mixed with --at", async () => {
    const payload = makeAXTargetPayload();
    const result = await runMainCLI(
      JSON.stringify(payload),
      ["actor", "run", "pointer.main.click", "-", "--at", "30", "40"],
      cliTestEnv,
    );

    expect(result.producerExitCode).toBe(0);
    expect(result.exitCode).toBe(1);
    expect(normalizeOutput(result.producerStderr)).toBe("");
    expect(normalizeOutput(result.stdout)).toBe("");
    expect(normalizeOutput(result.stderr)).toBe("actor run click stdin mode cannot be combined with --at");
  });

  test("actor run pointer.scroll renders scroll usage for invalid numeric args", async () => {
    const result = await runMainCLI(
      "",
      ["actor", "run", "pointer.main.scroll", "--dx", "nope", "--dy", "12"],
      cliTestEnv,
    );

    expect(result.producerExitCode).toBe(0);
    expect(result.exitCode).toBe(1);
    expect(normalizeOutput(result.producerStderr)).toBe("");
    expect(normalizeOutput(result.stdout)).toBe("");
    expect(normalizeOutput(result.stderr)).toContain("gui actor run <name>.scroll --dx <n> --dy <n>");
    expect(normalizeOutput(result.stderr)).toContain("gui help actor run scroll");
  });

  test("actor run pointer.narrate renders narrate usage for empty text", async () => {
    const result = await runMainCLI(
      "",
      ["actor", "run", "pointer.main.narrate", "--text", ""],
      cliTestEnv,
    );

    expect(result.producerExitCode).toBe(0);
    expect(result.exitCode).toBe(1);
    expect(normalizeOutput(result.producerStderr)).toBe("");
    expect(normalizeOutput(result.stdout)).toBe("");
    expect(normalizeOutput(result.stderr)).toContain("gui actor run <name>.narrate --text");
    expect(normalizeOutput(result.stderr)).toContain("gui help actor run narrate");
  });

  test("actor run canvas.draw renders draw usage for invalid literal boxes", async () => {
    const result = await runMainCLI(
      "",
      ["actor", "run", "canvas.notes.draw", "check", "--box", "100", "120", "0", "180"],
      cliTestEnv,
    );

    expect(result.producerExitCode).toBe(0);
    expect(result.exitCode).toBe(1);
    expect(normalizeOutput(result.producerStderr)).toBe("");
    expect(normalizeOutput(result.stdout)).toBe("");
    expect(normalizeOutput(result.stderr)).toContain("gui actor run <name>.draw");
    expect(normalizeOutput(result.stderr)).toContain("gui help actor run draw");
  });

  test("actor run canvas.draw renders draw usage for stdin combined with --box", async () => {
    const payload = makeAXTargetPayload();
    const result = await runMainCLI(
      JSON.stringify(payload),
      ["actor", "run", "canvas.notes.draw", "check", "-", "--box", "100", "120", "240", "180"],
      cliTestEnv,
    );

    expect(result.producerExitCode).toBe(0);
    expect(result.exitCode).toBe(1);
    expect(normalizeOutput(result.producerStderr)).toBe("");
    expect(normalizeOutput(result.stdout)).toBe("");
    expect(normalizeOutput(result.stderr)).toContain("gui actor run <name>.draw");
    expect(normalizeOutput(result.stderr)).toContain("gui help actor run draw");
  });

  test("actor run canvas.text renders text usage for multi-bounds stdin payloads", async () => {
    const { payload } = makeVatPayload("multi");
    const result = await runMainCLI(
      JSON.stringify(payload),
      ["actor", "run", "canvas.notes.text", "Working", "set", "-"],
      cliTestEnv,
    );

    expect(result.producerExitCode).toBe(0);
    expect(result.exitCode).toBe(1);
    expect(normalizeOutput(result.producerStderr)).toBe("");
    expect(normalizeOutput(result.stdout)).toBe("");
    expect(normalizeOutput(result.stderr)).toContain("gui actor run <name>.text");
    expect(normalizeOutput(result.stderr)).toContain("gui help actor run text");
  });

  test("actor run canvas.text renders text usage for stdin combined with --box", async () => {
    const payload = makeAXTargetPayload();
    const result = await runMainCLI(
      JSON.stringify(payload),
      ["actor", "run", "canvas.notes.text", "Working", "set", "-", "--box", "100", "120", "240", "180"],
      cliTestEnv,
    );

    expect(result.producerExitCode).toBe(0);
    expect(result.exitCode).toBe(1);
    expect(normalizeOutput(result.producerStderr)).toBe("");
    expect(normalizeOutput(result.stdout)).toBe("");
    expect(normalizeOutput(result.stderr)).toContain("gui actor run <name>.text");
    expect(normalizeOutput(result.stderr)).toContain("gui help actor run text");
  });

  test("actor run unknown action falls back to generic actor usage", async () => {
    const result = await runMainCLI(
      "",
      ["actor", "run", "pointer.main.teleport"],
      cliTestEnv,
    );

    expect(result.producerExitCode).toBe(0);
    expect(result.exitCode).toBe(1);
    expect(normalizeOutput(result.producerStderr)).toBe("");
    expect(normalizeOutput(result.stdout)).toBe("");
    expect(normalizeOutput(result.stderr)).toContain("gui actor run pointer.main.teleport.move");
    expect(normalizeOutput(result.stderr)).toContain("gui help actor run");
  });
});
