import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "fs";
import { fileURLToPath, pathToFileURL } from "url";
import type { AXQueryMatch, AXQueryScopeInput, AXTarget } from "./ax.js";
import { ACTOR_CLICK_PASSTHROUGH_DELAY_MS } from "../actors/protocol.js";
import { axTargetFromPoint } from "../a11y/ax-target.js";
import {
  VAT_A11Y_STDIN_AX_QUERY_ARG,
  VAT_A11Y_STDIN_AX_QUERY_PLAN_ARG,
  type VatA11YQueryPlan,
  type VatPolicyResponse,
  type VatMountResponse,
  type VatMountSummary,
  type VatUnmountResponse,
} from "../vat/types.js";
import {
  buildActorClickPassthroughRequest,
  buildActorMovePassthroughRequest,
  buildAXHighlightDrawScriptFromText,
  buildGfxArrowDrawScriptFromText,
  buildGfxOutlineDrawScriptFromText,
  buildGfxSpotlightDrawScriptFromText,
  buildGfxTextPlacementsFromText,
  buildGfxXrayDrawScriptFromText,
  DEFAULT_CA_HIGHLIGHT_TIMEOUT_MS,
  formatVatMountOutput,
  formatVatMountsOutput,
  formatVatPolicyOutput,
  formatVatQueryOutput,
  formatVatUnmountOutput,
  formatVatWatchEventText,
  extractVatOutputMode,
  resolveVatOutputTTY,
  emitPassthroughStdout,
  parseVatWatchArgs,
  parseVatWatchEventLine,
  queryVatTree,
  parseRecRectArgFromPayloadText,
  parseCGDragPoints,
  parseSingleCGWindowPayloadText,
  parseCGPointPassthroughInput,
  parseVatMountArgs,
  parseVatPolicyArgs,
  parseVatQueryArgs,
  parseVatUnmountArgs,
  resolveVatMountRequest,
  renderVatQueryResult,
  parseSingleAXTargetPassthroughInput,
  collectRegularWorkspaceAppPids,
  collectVisibleWorkspaceAppPids,
  extractAXQueryAppFilter,
  renderActorRunUsage,
  renderAXQueryMatches,
  resolveAXQueryAppFilterScope,
  resolveCommandAlias,
  resolveCRDTSubcommandAlias,
  summarizeVatWatchChanges,
  shouldEmitPassthroughStdout,
  formatVatMountError,
} from "./main.js";
import {
  buildCLICompositionPayloadFromAXQueryMatch,
  buildCLICompositionPayloadFromVatQueryResult,
  normalizeCLICompositionPayload,
  parseSingleCLICompositionPayload,
} from "./payload.js";
import { filterTree } from "./filter.js";
import { parseQuery } from "./query.js";
import { __setDaemonAuthSecretReaderForTests, resetDaemonAuthSecretCache, VatMountRequestError } from "./client.js";
import type { PlainNode } from "./types.js";

type TailVatWatchStream = (
  watchArgs: { query: string; once: boolean; filter?: Array<"added" | "removed" | "updated"> },
  tty: boolean,
  writer?: (chunk: string) => Promise<void>,
) => Promise<void>;

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

async function loadTailVatWatchStreamForTests(): Promise<TailVatWatchStream> {
  const sourceUrl = new URL("./main.ts", import.meta.url);
  const tempPath = fileURLToPath(
    new URL(`./.main-tail-watch-${Date.now()}-${Math.random().toString(16).slice(2)}.ts`, import.meta.url),
  );
  const source = await Bun.file(sourceUrl).text();
  await Bun.write(tempPath, `${source}\nexport { tailVatWatchStream };\n`);

  try {
    const imported = await import(`${pathToFileURL(tempPath).href}?t=${Date.now()}`) as {
      tailVatWatchStream: TailVatWatchStream;
    };
    return imported.tailVatWatchStream;
  } finally {
    rmSync(tempPath);
  }
}

async function withMockedFetchSequence<T>(
  responses: Response[],
  run: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  let index = 0;
  globalThis.fetch = (async () => {
    const response = responses[index] ?? new Response("unexpected fetch", { status: 500 });
    index += 1;
    return response;
  }) as typeof fetch;

  try {
    __setDaemonAuthSecretReaderForTests(async () => null);
    resetDaemonAuthSecretCache();
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

afterEach(() => {
  __setDaemonAuthSecretReaderForTests();
  resetDaemonAuthSecretCache();
});

describe("command alias resolution", () => {
  test("maps the top-level q alias to query", () => {
    expect(resolveCommandAlias("q")).toBe("query");
    expect(resolveCommandAlias("query")).toBe("query");
  });

  test("maps the crdt q alias to query", () => {
    expect(resolveCRDTSubcommandAlias("q")).toBe("query");
    expect(resolveCRDTSubcommandAlias("query")).toBe("query");
  });
});

describe("gui ax query scope helpers", () => {
  test("collects regular workspace apps by pid order", () => {
    expect(collectRegularWorkspaceAppPids([
      { pid: 11, regular: true },
      { pid: 22, regular: false },
      { pid: 33 },
      { pid: 11, regular: true },
      { pid: 0, regular: true },
    ])).toEqual([11, 33]);
  });

  test("collects only workspace apps with visible GUI windows", () => {
    const tree: PlainNode = {
      _tag: "Display",
      _children: [
        {
          _tag: "Application",
          title: "Finder",
          bundleId: "com.apple.finder",
          _children: [{ _tag: "Window", obscured: "0" }],
        },
        {
          _tag: "Application",
          title: "Terminal",
          bundleId: "com.apple.Terminal",
          _children: [{ _tag: "Window", obscured: "80" }, { _tag: "Window", obscured: "0" }],
        },
        {
          _tag: "Application",
          title: "Helper",
          bundleId: "com.example.Helper",
          _children: [],
        },
        {
          _tag: "Application",
          title: "Codex",
          bundleId: "com.example.codex",
          _children: [{ _tag: "Window", obscured: "0" }],
        },
      ],
    };

    const apps = [
      { pid: 11, bundleId: "com.apple.finder", name: "Finder", regular: true },
      { pid: 22, bundleId: "com.apple.Terminal", name: "Terminal", regular: true },
      { pid: 33, bundleId: "com.example.Helper", name: "Helper", regular: true },
      { pid: 44, bundleId: "com.example.codex", name: "Codex", regular: false },
    ];

    expect(collectVisibleWorkspaceAppPids(tree, apps)).toEqual([11, 22]);
  });

  test("rejects --gui and --visible together", () => {
    const args = ["--gui", "--visible", "Button"];

    expect(() => extractAXQueryAppFilter(args)).toThrow("Choose at most one of --gui or --visible.");
  });

  test("bare app-wide filters imply the all scope", () => {
    expect(resolveAXQueryAppFilterScope(undefined, "regular", false)).toEqual({ kind: "all" });
    expect(resolveAXQueryAppFilterScope(undefined, "visible", false)).toEqual({ kind: "all" });
  });

  test("allows app-wide filters with --all and rejects narrower scopes", () => {
    const allScope: AXQueryScopeInput = { kind: "all" };
    const focusedScope: AXQueryScopeInput = { kind: "focused" };

    expect(resolveAXQueryAppFilterScope(allScope, "regular", false)).toBe(allScope);
    expect(resolveAXQueryAppFilterScope(allScope, "visible", false)).toBe(allScope);
    expect(() => resolveAXQueryAppFilterScope(focusedScope, "regular", false))
      .toThrow("--gui cannot be combined with --focused, --pid, or --app.");
    expect(() => resolveAXQueryAppFilterScope(focusedScope, "visible", false))
      .toThrow("--visible cannot be combined with --focused, --pid, or --app.");
  });

  test("rejects app-wide filters for stdin-refined AX queries", () => {
    expect(() => resolveAXQueryAppFilterScope(undefined, "regular", true))
      .toThrow("--gui cannot be combined with stdin-refined AX queries.");
    expect(() => resolveAXQueryAppFilterScope(undefined, "visible", true))
      .toThrow("--visible cannot be combined with stdin-refined AX queries.");
  });
});

describe("vat mount argument parsing", () => {
  test("requires an absolute mount path and a driver", () => {
    expect(() => parseVatMountArgs([])).toThrow("gui vat mount requires a path and a driver");
    expect(() => parseVatMountArgs(["demo", "fixed"])).toThrow("gui vat mount path must start with /");
  });

  test("splits the mount path, driver, and driver args", () => {
    expect(parseVatMountArgs(["/demo", "fixed", "hello", "world"])).toEqual({
      path: "/demo",
      driver: "fixed",
      args: ["hello", "world"],
    });
  });
});

describe("vat output mode flag parsing", () => {
  test("accepts --json or --text as explicit output overrides", () => {
    expect(extractVatOutputMode(["--json"])).toBe("json");
    expect(extractVatOutputMode(["--text"])).toBe("text");
  });

  test("rejects conflicting output overrides", () => {
    expect(() => extractVatOutputMode(["--json", "--text"])).toThrow("Choose at most one of --json or --text.");
  });

  test("leaves literal output-looking tokens alone once the vat subcommand starts", () => {
    const mountArgs = ["mount", "/demo", "fixed", "--json"];
    const queryArgs = ["query", "--text", "Application", "{", "Window", "}"];

    expect(extractVatOutputMode(mountArgs)).toBeUndefined();
    expect(mountArgs).toEqual(["mount", "/demo", "fixed", "--json"]);

    expect(extractVatOutputMode(queryArgs)).toBeUndefined();
    expect(queryArgs).toEqual(["query", "--text", "Application", "{", "Window", "}"]);
  });

  test("resolves text output regardless of stdout tty when forced", () => {
    expect(resolveVatOutputTTY("text", false)).toBe(true);
    expect(resolveVatOutputTTY("json", true)).toBe(false);
    expect(resolveVatOutputTTY(undefined, true)).toBe(true);
    expect(resolveVatOutputTTY(undefined, false)).toBe(false);
  });
});

describe("vat mount stdin handling", () => {
  test("leaves non-stdin mounts untouched", () => {
    const mountArgs = { path: "/demo", driver: "fixed", args: ["hello"] };
    expect(resolveVatMountRequest(mountArgs, '{"ignored":true}')).toEqual(mountArgs);
  });

  test("rewrites a11y stdin mounts into serialized AX query payload args", () => {
    const match = {
      type: "ax.query-match" as const,
      pid: 321,
      node: {
        _tag: "Application",
        title: "Terminal",
        _children: [
          {
            _tag: "Window",
            title: "Shell",
            _children: [{ _tag: "Button", title: "Run" }],
          },
        ],
      },
    };
    const payload = JSON.stringify([match]);

    const mountArgs = resolveVatMountRequest({ path: "/Terminal", driver: "a11y", args: ["-"] }, payload);

    expect(mountArgs).toEqual({
      path: "/Terminal",
      driver: "a11y",
      args: [VAT_A11Y_STDIN_AX_QUERY_ARG, JSON.stringify(match)],
    });
  });

  test("prefers AX query plan metadata for a11y stdin mounts", () => {
    const vatQueryPlan: VatA11YQueryPlan = {
      type: "vat.a11y-query-plan",
      query: "@#Terminal{**[**]}",
      cardinality: "all",
      scope: { kind: "app", app: "Terminal" },
    };
    const payload = JSON.stringify([
      {
        type: "ax.query-match",
        pid: 321,
        node: { _tag: "Application", title: "Terminal" },
        vatQueryPlan,
      },
    ]);

    expect(resolveVatMountRequest({ path: "/Terminal", driver: "a11y", args: ["-"] }, payload)).toEqual({
      path: "/Terminal",
      driver: "a11y",
      args: [VAT_A11Y_STDIN_AX_QUERY_PLAN_ARG, JSON.stringify(vatQueryPlan)],
    });
  });

  test("accepts canonical AX query payloads for a11y stdin mounts", () => {
    const match = {
      type: "ax.query-match" as const,
      pid: 321,
      node: {
        _tag: "Application",
        title: "Terminal",
      },
    };
    const canonical = JSON.stringify(buildCLICompositionPayloadFromAXQueryMatch(match, "ax.query"));

    expect(resolveVatMountRequest({ path: "/Terminal", driver: "a11y", args: ["-"] }, canonical)).toEqual({
      path: "/Terminal",
      driver: "a11y",
      args: [VAT_A11Y_STDIN_AX_QUERY_ARG, JSON.stringify(match)],
    });
  });

  test("extracts vat query plans from canonical AX query payloads", () => {
    const vatQueryPlan: VatA11YQueryPlan = {
      type: "vat.a11y-query-plan",
      query: "@#Codex{**[**]}",
      cardinality: "all",
      scope: { kind: "app", app: "Codex" },
    };
    const canonical = JSON.stringify(buildCLICompositionPayloadFromAXQueryMatch({
      type: "ax.query-match",
      pid: 321,
      node: { _tag: "Application", title: "Codex" },
    }, "ax.query", vatQueryPlan));

    expect(resolveVatMountRequest({ path: "/Codex", driver: "a11y", args: ["-"] }, canonical)).toEqual({
      path: "/Codex",
      driver: "a11y",
      args: [VAT_A11Y_STDIN_AX_QUERY_PLAN_ARG, JSON.stringify(vatQueryPlan)],
    });
  });

  test("rejects canonical payloads without AX query matches for a11y mounts", () => {
    const tree: PlainNode = {
      _tag: "VATRoot",
      _children: [{ _tag: "Application", title: "Codex" }],
    };
    const payload = formatVatQueryOutput(tree, "Application", false);

    expect(() => resolveVatMountRequest({ path: "/Codex", driver: "a11y", args: ["-"] }, payload))
      .toThrow("gui vat mount stdin payload[0] is missing an AX query match");
  });
});

describe("vat query argument parsing", () => {
  test("requires a query string", () => {
    expect(() => parseVatQueryArgs([])).toThrow("gui vat query requires a query");
  });

  test("joins the query arguments into one GUIML query", () => {
    expect(parseVatQueryArgs(["Application", "{", "Window", "}"])).toBe("Application { Window }");
  });
});

describe("vat watch argument parsing", () => {
  test("requires a query string", () => {
    expect(() => parseVatWatchArgs([])).toThrow("gui vat query requires a query");
  });

  test("parses --once and comma-separated change filters", () => {
    expect(parseVatWatchArgs(["--once", "--filter", "updated,removed", "Window", "{", "Button", "}"])).toEqual({
      query: "Window { Button }",
      once: true,
      filter: ["updated", "removed"],
    });
  });

  test("rejects invalid filter kinds", () => {
    expect(() => parseVatWatchArgs(["--filter", "bogus", "Window"])).toThrow(
      "gui vat watch --filter kinds must be added, removed, or updated",
    );
  });
});

describe("vat policy argument parsing", () => {
  test("parses always, disabled, and auto policies", () => {
    expect(parseVatPolicyArgs(["/demo", "always"])).toEqual({
      path: "/demo",
      mountPolicy: { kind: "always" },
    });
    expect(parseVatPolicyArgs(["/demo", "disabled"])).toEqual({
      path: "/demo",
      mountPolicy: { kind: "disabled" },
    });
    expect(parseVatPolicyArgs(["/demo", "auto", "never"])).toEqual({
      path: "/demo",
      mountPolicy: { kind: "auto", unmountTimeout: { kind: "never" } },
    });
    expect(parseVatPolicyArgs(["/demo", "auto", "30"])).toEqual({
      path: "/demo",
      mountPolicy: { kind: "auto", unmountTimeout: { kind: "seconds", seconds: 30 } },
    });
  });
});

describe("vat query rendering", () => {
  function makeVatForest(width: number, depth: number): PlainNode {
    const makeBranch = (tag: string, remainingDepth: number): PlainNode => {
      if (remainingDepth === 0) {
        return { _tag: tag };
      }
      return {
        _tag: tag,
        _children: Array.from({ length: width }, (_, index) => makeBranch(`${tag}-${remainingDepth}-${index}`, remainingDepth - 1)),
      };
    };

    return {
      _tag: "VATRoot",
      _children: Array.from({ length: width }, (_, index) => makeBranch(`Mount${index}`, depth)),
    };
  }

  test("queries a cached VAT root without extra plumbing", () => {
    const tree: PlainNode = {
      _tag: "VATRoot",
      _children: [
        {
          _tag: "demo",
          _children: [
            { _tag: "Window", _children: [{ _tag: "Button", _text: "Save" }] },
          ],
        },
        {
          _tag: "other",
          _children: [
            { _tag: "Window", _children: [{ _tag: "Button", _text: "Cancel" }] },
          ],
        },
      ],
    };

    expect(renderVatQueryResult(tree, "Window { Button }")).toContain("Window");
    expect(renderVatQueryResult(tree, "Window { Button }")).toContain("Button");
    expect(renderVatQueryResult(tree, "*")).toBe("<VATRoot />");
  });

  test("broad wildcard queries over a cached VAT forest stay bounded", () => {
    const tree = makeVatForest(8, 3);
    const start = performance.now();
    const rendered = formatVatQueryOutput(tree, "*", true);
    const elapsed = performance.now() - start;

    expect(rendered).toBe("<VATRoot />");
    expect(elapsed).toBeLessThan(1000);
  });

  test("TTY output renders GUIML while pipe output stays JSON", () => {
    const tree: PlainNode = {
      _tag: "VATRoot",
      _children: [
        {
          _tag: "demo",
          _children: [
            { _tag: "Window", _children: [{ _tag: "Button", _text: "Save" }] },
          ],
        },
      ],
    };

    const tty = formatVatQueryOutput(tree, "Window { Button }", true);
    const pipe = JSON.parse(formatVatQueryOutput(tree, "Window { Button }", false)) as unknown;
    const vatResult = queryVatTree(tree, "Window { Button }");

    expect(tty).toContain("Window");
    expect(tty).toContain("Button");
    expect(pipe).toHaveProperty("type", "gui.payload");
    expect(pipe).toHaveProperty("version", 1);
    expect(pipe).toHaveProperty("source", "vat.query");
    expect(pipe).toHaveProperty("query", "Window { Button }");
    expect(pipe).toHaveProperty("tree");
    expect((pipe as { tree: unknown }).tree).toEqual(tree);
    expect(pipe).toHaveProperty("nodes");
    expect((pipe as { nodes: unknown }).nodes).toEqual(vatResult.nodes);
    expect(pipe).toHaveProperty("matchCount", vatResult.matchCount);
    expect(pipe).toHaveProperty("target", null);
    expect(pipe).toHaveProperty("cursor", null);
    expect(pipe).toHaveProperty("axQueryMatch", null);
    expect(pipe).toHaveProperty("issues");
    expect((pipe as { issues: unknown }).issues).toEqual([]);
    expect((pipe as { node?: unknown }).node).not.toBeNull();
  });

  test("rejects pretty-printed canonical payloads with structural errors using the structural error", () => {
    const payload = JSON.stringify({
      type: "gui.payload",
      version: 1,
      source: "vat.query",
      query: "Application",
      tree: null,
      nodes: null,
      matchCount: null,
      node: null,
      target: null,
      cursor: { nope: true },
      axQueryMatch: null,
      bounds: null,
      point: null,
      issues: [],
    }, null, 2);

    expect(() => parseSingleCLICompositionPayload(payload, "stdin"))
      .toThrow("Invalid stdin payload.cursor");
  });

  test("rejects unsupported canonical payload versions explicitly", () => {
    expect(() => normalizeCLICompositionPayload({
      type: "gui.payload",
      version: 999,
      source: "vat.query",
      query: null,
      tree: null,
      nodes: null,
      matchCount: null,
      node: null,
      target: null,
      cursor: null,
      axQueryMatch: null,
      bounds: null,
      point: null,
      issues: [],
    }, "stdin payload")).toThrow("Invalid stdin payload.version: expected 1, received 999");
  });

  test("accepts canonical payloads with leading terminal control noise", () => {
    const payload = `\u0004\b\b${JSON.stringify({
      type: "gui.payload",
      version: 1,
      source: "vat.query",
      query: "Codex/*//Button#Commit { Image }",
      tree: null,
      nodes: null,
      matchCount: 1,
      node: { _tag: "Image", _frame: "(903,39,18,18)" },
      target: null,
      cursor: null,
      axQueryMatch: null,
      bounds: { x: 903, y: 39, width: 18, height: 18 },
      point: { x: 912, y: 48 },
      issues: [],
    })}`;

    expect(parseSingleCLICompositionPayload(payload, "stdin")).toMatchObject({
      source: "vat.query",
      bounds: { x: 903, y: 39, width: 18, height: 18 },
    });
  });
});

describe("vat watch rendering", () => {
  test("parses ndjson watch payloads and renders a compact text summary", () => {
    const line = JSON.stringify({
      ...buildCLICompositionPayloadFromVatQueryResult(
        "Window { Button }",
        {
          _tag: "VATRoot",
          _children: [
            {
              _tag: "demo",
              _children: [
                { _tag: "Window", _children: [{ _tag: "Button", _text: "Save" }] },
              ],
            },
          ],
        },
        [
          {
            _tag: "demo",
            _children: [
              { _tag: "Window", _children: [{ _tag: "Button", _text: "Save" }] },
            ],
          },
        ],
        1,
      ),
      source: "vat.watch",
      changes: [
        {
          kind: "updated",
          index: 0,
          previous: { _tag: "demo", _children: [{ _tag: "Window", title: "Old" }] },
          current: { _tag: "demo", _children: [{ _tag: "Window", title: "New" }] },
        },
      ],
      changeSummary: { added: 0, removed: 0, updated: 1, total: 1 },
    });

    const event = parseVatWatchEventLine(line);
    expect(event.payload.source).toBe("vat.watch");
    expect(event.summary).toEqual({ added: 0, removed: 0, updated: 1, total: 1 });
    expect(event.changes[0]).toMatchObject({ kind: "updated", index: 0 });
    expect(formatVatWatchEventText(event)).toContain("changes: 1 updated");
    expect(formatVatWatchEventText(event)).toContain("Window");
    expect(formatVatWatchEventText(event)).toContain("Button");
  });

  test("summarizes change counts when the payload omits a summary", () => {
    expect(summarizeVatWatchChanges([
      { kind: "added", index: 0, previous: null, current: { _tag: "A" } },
      { kind: "updated", index: 1, previous: { _tag: "B" }, current: { _tag: "C" } },
    ])).toEqual({ added: 1, removed: 0, updated: 1, total: 2 });
  });
});

describe("vat watch stream framing", () => {
  test("joins split NDJSON across reads before emitting", async () => {
    const tailVatWatchStream = await loadTailVatWatchStreamForTests();
    const outputs: string[] = [];
    const line = JSON.stringify({ source: "vat.watch", seq: 1 });

    await withMockedFetchSequence(
      [new Response(streamFromChunks([line.slice(0, 12), `${line.slice(12)}\n`]))],
      async () => {
        await tailVatWatchStream(
          { query: "Window", once: true },
          false,
          async (chunk) => {
            outputs.push(chunk);
          },
        );
      },
    );

    expect(outputs).toEqual([`${line}\n`]);
  });

  test("emits multiple events from one chunk then fails hard on stream close", async () => {
    const tailVatWatchStream = await loadTailVatWatchStreamForTests();
    const outputs: string[] = [];
    const first = JSON.stringify({ source: "vat.watch", seq: 1 });
    const second = JSON.stringify({ source: "vat.watch", seq: 2 });

    await withMockedFetchSequence(
      [new Response(streamFromChunks([`${first}\n${second}\n`]))],
      async () => {
        await expect(
          tailVatWatchStream(
            { query: "Window", once: false },
            false,
            async (chunk) => {
              outputs.push(chunk);
            },
          ),
        ).rejects.toThrow("vat watch stream ended unexpectedly");
      },
    );

    expect(outputs).toEqual([`${first}\n`, `${second}\n`]);
  });

  test("fails immediately when opening the watch stream returns an error", async () => {
    const tailVatWatchStream = await loadTailVatWatchStreamForTests();
    const outputs: string[] = [];

    await withMockedFetchSequence(
      [
        new Response(JSON.stringify({ error: "boom" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
      ],
      async () => {
        await expect(
          tailVatWatchStream(
            { query: "Window", once: false },
            false,
            async (chunk) => {
              outputs.push(chunk);
            },
          ),
        ).rejects.toThrow("/api/vat/watch failed (500): boom");
      },
    );

    expect(outputs).toEqual([]);
  });

  test("flushes a trailing partial line when the stream closes", async () => {
    const tailVatWatchStream = await loadTailVatWatchStreamForTests();
    const outputs: string[] = [];
    const line = JSON.stringify({ source: "vat.watch", seq: 3 });

    await withMockedFetchSequence(
      [new Response(streamFromChunks([line]))],
      async () => {
        await tailVatWatchStream(
          { query: "Window", once: true },
          false,
          async (chunk) => {
            outputs.push(chunk);
          },
        );
      },
    );

    expect(outputs).toEqual([`${line}\n`]);
  });
});

describe("vat unmount argument parsing", () => {
  test("requires an absolute mount path", () => {
    expect(() => parseVatUnmountArgs([])).toThrow("gui vat unmount requires a path");
    expect(() => parseVatUnmountArgs(["demo"])).toThrow("gui vat unmount path must start with /");
  });

  test("returns the mount path", () => {
    expect(parseVatUnmountArgs(["/demo"])).toBe("/demo");
  });
});

describe("vat mount error formatting", () => {
  test("keeps daemon/runtime errors out of usage output", () => {
    const error = new VatMountRequestError(503, "daemon unavailable");
    expect(formatVatMountError(error)).toEqual({ kind: "runtime", message: "/api/vat/mount failed (503): daemon unavailable" });
  });

  test("maps parse errors to usage output", () => {
    expect(formatVatMountError(new Error("gui vat mount path must start with /"))).toEqual({
      kind: "usage",
      message: "gui vat mount path must start with /",
    });
  });
});

describe("vat command output formatting", () => {
  test("mount output is readable on TTY and JSON on pipes", () => {
    const payload: VatMountResponse = {
      ok: true,
      mount: {
        path: "/demo",
        driver: "fixed",
        args: ["hello"],
        mountPolicy: { kind: "always" },
        active: true,
        activeSince: 123,
      },
      activeMount: {
        path: "/demo",
        driver: "fixed",
        args: ["hello"],
        mountPolicy: { kind: "always" },
        active: true,
        activeSince: 123,
        tree: {
          _tag: "demo",
          _children: [
            { _tag: "VATValue", _text: "hello" },
          ],
        },
      },
      tree: {
        _tag: "demo",
        _children: [
          { _tag: "VATValue", _text: "hello" },
        ],
      },
    };

    expect(formatVatMountOutput(payload, true)).toContain("Mounted /demo [fixed]");
    expect(formatVatMountOutput(payload, true)).toContain("<demo>");
    expect(JSON.parse(formatVatMountOutput(payload, false))).toEqual(payload);
  });

  test("mounts output is readable on TTY and JSON on pipes", () => {
    const payload: VatMountSummary[] = [
      {
        path: "/demo",
        driver: "a11y",
        args: ["Application { Window }", "--scope", "focused"],
        mountPolicy: { kind: "auto", unmountTimeout: { kind: "seconds", seconds: 30 } },
        active: false,
        activeSince: null,
      },
    ];

    const ttyOutput = formatVatMountsOutput(payload, true);

    expect(ttyOutput).toContain("PATH");
    expect(ttyOutput).toContain("DRIVER");
    expect(ttyOutput).toContain("POLICY");
    expect(ttyOutput).toContain("ACTIVE");
    expect(ttyOutput).toContain("/demo");
    expect(ttyOutput).toContain("a11y");
    expect(ttyOutput).toContain("auto 30");
    expect(ttyOutput).toContain("\"Application { Window }\" --scope focused");
    expect(JSON.parse(formatVatMountsOutput(payload, false))).toEqual(payload);
  });

  test("mounts output collapses a11y query plan transport args on TTY", () => {
    const vatQueryPlan: VatA11YQueryPlan = {
      type: "vat.a11y-query-plan",
      query: "@#Terminal{**[**]} --app Terminal",
      cardinality: "all",
      scope: { kind: "app", app: "Terminal" },
    };
    const payload = JSON.stringify([
      {
        type: "ax.query-match",
        pid: 321,
        node: { _tag: "Application", title: "Terminal" },
        vatQueryPlan,
      },
    ]);
    const mountArgs = resolveVatMountRequest({ path: "/Terminal", driver: "a11y", args: ["-"] }, payload);
    const mounts: VatMountSummary[] = [
      {
        path: "/Terminal",
        driver: "a11y",
        args: mountArgs.args,
        mountPolicy: { kind: "auto", unmountTimeout: { kind: "seconds", seconds: 30 } },
        active: false,
        activeSince: null,
      },
    ];

    const ttyOutput = formatVatMountsOutput(mounts, true);

    expect(ttyOutput).toContain('a11y query "@#Terminal{**[**]} --app Terminal" app=Terminal');
    expect(ttyOutput).not.toContain(VAT_A11Y_STDIN_AX_QUERY_PLAN_ARG);
    expect(ttyOutput).not.toContain(JSON.stringify(vatQueryPlan));
    expect(JSON.parse(formatVatMountsOutput(mounts, false))).toEqual(mounts);
  });

  test("mounts output collapses generic a11y stdin transport args on TTY", () => {
    const payload = JSON.stringify([
      {
        type: "ax.query-match",
        pid: 321,
        node: { _tag: "Application", title: "Terminal" },
      },
    ]);
    const mountArgs = resolveVatMountRequest({ path: "/Terminal", driver: "a11y", args: ["-"] }, payload);
    const mounts: VatMountSummary[] = [
      {
        path: "/Terminal",
        driver: "a11y",
        args: mountArgs.args,
        mountPolicy: { kind: "auto", unmountTimeout: { kind: "seconds", seconds: 30 } },
        active: false,
        activeSince: null,
      },
    ];

    const ttyOutput = formatVatMountsOutput(mounts, true);

    expect(ttyOutput).toContain("a11y stdin");
    expect(ttyOutput).not.toContain(VAT_A11Y_STDIN_AX_QUERY_ARG);
    expect(ttyOutput).not.toContain(payload);
    expect(JSON.parse(formatVatMountsOutput(mounts, false))).toEqual(mounts);
  });

  test("mounts output keeps literal transport-looking args for non-a11y mounts", () => {
    const vatQueryPlan: VatA11YQueryPlan = {
      type: "vat.a11y-query-plan",
      query: "@#Terminal{**[**]} --app Terminal",
      cardinality: "all",
      scope: { kind: "app", app: "Terminal" },
    };
    const payload = JSON.stringify(vatQueryPlan);
    const mounts: VatMountSummary[] = [
      {
        path: "/demo",
        driver: "fixed",
        args: [VAT_A11Y_STDIN_AX_QUERY_PLAN_ARG, payload],
        mountPolicy: { kind: "always" },
        active: false,
        activeSince: null,
      },
    ];

    const ttyOutput = formatVatMountsOutput(mounts, true);

    expect(ttyOutput).toContain(VAT_A11Y_STDIN_AX_QUERY_PLAN_ARG);
    expect(ttyOutput).toContain(JSON.stringify(payload));
    expect(ttyOutput).not.toContain('a11y query "@#Terminal{**[**]} --app Terminal" app=Terminal');
    expect(JSON.parse(formatVatMountsOutput(mounts, false))).toEqual(mounts);
  });

  test("vat mount args preserve literal --json and --text tokens when they are payload data", () => {
    const mountArgs = parseVatMountArgs(["/demo", "fixed", "--json", "--text"]);
    expect(mountArgs).toEqual({
      path: "/demo",
      driver: "fixed",
      args: ["--json", "--text"],
    });
  });

  test("vat query text preserves literal --json tokens when they are part of the query", () => {
    expect(parseVatQueryArgs(["--json", "Application", "{", "Window", "}"])).toBe("--json Application { Window }");
  });

  test("unmount output is readable on TTY and JSON on pipes", () => {
    const payload: VatUnmountResponse = {
      ok: true,
      unmounted: {
        path: "/demo",
        driver: "fixed",
        args: [],
        mountPolicy: { kind: "always" },
        active: true,
        activeSince: 123,
      },
      activeMount: {
        path: "/demo",
        driver: "fixed",
        args: [],
        mountPolicy: { kind: "always" },
        active: true,
        activeSince: 123,
        tree: { _tag: "demo" },
      },
    };

    expect(formatVatUnmountOutput(payload, true)).toContain("Unmounted /demo [fixed]");
    expect(JSON.parse(formatVatUnmountOutput(payload, false))).toEqual(payload);
  });

  test("policy output is readable on TTY and JSON on pipes", () => {
    const payload: VatPolicyResponse = {
      ok: true,
      mount: {
        path: "/demo",
        driver: "fixed",
        args: [],
        mountPolicy: { kind: "auto", unmountTimeout: { kind: "seconds", seconds: 30 } },
        active: false,
        activeSince: null,
      },
      activeMount: null,
    };

    expect(formatVatPolicyOutput(payload, true)).toContain("Updated /demo policy=auto 30 active=no");
    expect(JSON.parse(formatVatPolicyOutput(payload, false))).toEqual(payload);
  });
});

describe("actor run usage rendering", () => {
  test("substitutes the provided partial actor name into canonical actor run usage", () => {
    const usage = renderActorRunUsage("p");
    expect(usage).toContain("gui actor run p.move");
    expect(usage).toContain("gui actor run p.click");
    expect(usage).not.toContain("gui actor run <name>.move");
  });
});

describe("ca highlight AX bridge", () => {
  const target: AXTarget = {
    type: "ax.target",
    pid: 4321,
    point: { x: 140, y: 120 },
    bounds: { x: 100, y: 100, width: 80, height: 40 },
    role: "AXButton",
    title: "Save",
    label: null,
    identifier: "save-button",
  };

  test("builds a draw script from a piped AX query match", () => {
    const match: AXQueryMatch = {
      type: "ax.query-match",
      pid: 4321,
      node: { _tag: "AXButton", _id: "Save" },
      target,
    };

    expect(buildAXHighlightDrawScriptFromText(JSON.stringify(match))).toEqual({
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

  test("rejects AX target payloads without usable bounds", () => {
    const targetWithoutBounds: AXTarget = {
      ...target,
      bounds: undefined,
    };

    expect(() => buildAXHighlightDrawScriptFromText(JSON.stringify(targetWithoutBounds)))
      .toThrow('gui ca highlight - AXButton "Save" is missing bounds/frame coordinates');
  });

  test("builds a draw script from a piped VAT query payload", () => {
    const tree: PlainNode = {
      _tag: "VATRoot",
      _children: [
        {
          _tag: "Application",
          title: "Terminal",
          frame: { x: 40, y: 50, width: 600, height: 300 },
        },
      ],
    };

    expect(buildAXHighlightDrawScriptFromText(formatVatQueryOutput(tree, "Application", false))).toEqual({
      coordinateSpace: "screen",
      timeout: DEFAULT_CA_HIGHLIGHT_TIMEOUT_MS,
      items: [
        {
          kind: "rect",
          rect: { x: 40, y: 50, width: 600, height: 300 },
        },
      ],
    });
  });

  test("fans out VAT highlights over every framed descendant in traversal order", () => {
    const tree: PlainNode = {
      _tag: "VATRoot",
      _children: [
        {
          _tag: "Application",
          title: "Terminal",
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

    expect(buildAXHighlightDrawScriptFromText(formatVatQueryOutput(tree, "Window[frame]", false))).toEqual({
      coordinateSpace: "screen",
      timeout: DEFAULT_CA_HIGHLIGHT_TIMEOUT_MS,
      items: [
        {
          kind: "rect",
          rect: { x: 40, y: 50, width: 300, height: 200 },
        },
        {
          kind: "rect",
          rect: { x: 400, y: 50, width: 320, height: 220 },
        },
      ],
    });
  });

  test("picks a nested bounds-bearing VAT descendant as the primary node", () => {
    const tree: PlainNode = {
      _tag: "VATRoot",
      _children: [
        {
          _tag: "Application",
          _children: [
            {
              _tag: "Window",
              _children: [
                {
                  _tag: "Button",
                  title: "Save",
                  frame: { x: 40, y: 50, width: 600, height: 300 },
                },
              ],
            },
          ],
        },
      ],
    };
    const payload = buildCLICompositionPayloadFromVatQueryResult("Application", tree, [tree._children![0]], 1);

    expect(payload.node).toEqual({
      _tag: "Button",
      title: "Save",
      frame: { x: 40, y: 50, width: 600, height: 300 },
    });
    expect(buildAXHighlightDrawScriptFromText(JSON.stringify(payload))).toEqual({
      coordinateSpace: "screen",
      timeout: DEFAULT_CA_HIGHLIGHT_TIMEOUT_MS,
      items: [
        {
          kind: "rect",
          rect: { x: 40, y: 50, width: 600, height: 300 },
        },
      ],
    });
  });

  test("prefers a framed VAT descendant over a labeled ancestor without bounds", () => {
    const tree: PlainNode = {
      _tag: "VATRoot",
      _children: [
        {
          _tag: "Codex",
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

    const query = "Codex/*//@@Button#Commit";
    const { nodes, matchCount } = filterTree(tree, parseQuery(query));
    const payload = buildCLICompositionPayloadFromVatQueryResult(query, tree, nodes, matchCount);

    expect(payload.node).toEqual({
      _tag: "Button",
      _displayName: "Commit",
      _frame: { x: 894, y: 34, width: 31, height: 28 },
    });
    expect(payload.bounds).toEqual({ x: 894, y: 34, width: 31, height: 28 });
    expect(buildAXHighlightDrawScriptFromText(JSON.stringify(payload))).toEqual({
      coordinateSpace: "screen",
      timeout: DEFAULT_CA_HIGHLIGHT_TIMEOUT_MS,
      items: [
        {
          kind: "rect",
          rect: { x: 220, y: 24, width: 900, height: 720 },
        },
        {
          kind: "rect",
          rect: { x: 894, y: 34, width: 31, height: 28 },
        },
      ],
    });
  });

  test("deduplicates duplicate VAT descendant frames", () => {
    const tree: PlainNode = {
      _tag: "VATRoot",
      _children: [
        {
          _tag: "Application",
          title: "Terminal",
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

    expect(buildAXHighlightDrawScriptFromText(formatVatQueryOutput(tree, "Window[frame]", false))).toEqual({
      coordinateSpace: "screen",
      timeout: DEFAULT_CA_HIGHLIGHT_TIMEOUT_MS,
      items: [
        {
          kind: "rect",
          rect: { x: 40, y: 50, width: 300, height: 200 },
        },
      ],
    });
  });

  test("keeps AX payloads on the single-rect path", () => {
    expect(buildAXHighlightDrawScriptFromText(JSON.stringify(target))).toEqual({
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

  test("builds gfx outline draw scripts from AX payloads", () => {
    expect(buildGfxOutlineDrawScriptFromText(JSON.stringify(target))).toEqual({
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

  test("builds gfx xray draw scripts from VAT fan-out payloads", () => {
    const tree: PlainNode = {
      _tag: "VATRoot",
      _children: [
        {
          _tag: "Application",
          _children: [
            {
              _tag: "Window",
              frame: { x: 40, y: 50, width: 300, height: 200 },
            },
            {
              _tag: "Window",
              frame: { x: 400, y: 50, width: 320, height: 220 },
            },
          ],
        },
      ],
    };

    expect(buildGfxXrayDrawScriptFromText(formatVatQueryOutput(tree, "Window[frame]", false))).toEqual({
      coordinateSpace: "screen",
      timeout: DEFAULT_CA_HIGHLIGHT_TIMEOUT_MS,
      items: [
        {
          kind: "xray",
          rect: { x: 40, y: 50, width: 300, height: 200 },
          direction: "leftToRight",
          animation: { durMs: 650, ease: "easeInOut" },
        },
        {
          kind: "xray",
          rect: { x: 400, y: 50, width: 320, height: 220 },
          direction: "leftToRight",
          animation: { durMs: 650, ease: "easeInOut" },
        },
      ],
    });
  });

  test("builds gfx spotlight draw scripts with spotlight styling", () => {
    const script = buildGfxSpotlightDrawScriptFromText(JSON.stringify(target));

    expect(script.coordinateSpace).toBe("screen");
    expect(script.timeout).toBe(DEFAULT_CA_HIGHLIGHT_TIMEOUT_MS);
    expect(script.items).toEqual([
      {
        kind: "rect",
        rect: { x: 100, y: 100, width: 80, height: 40 },
        style: {
          stroke: "#FFD54F",
          fill: "#FFD54F33",
          lineWidth: 3,
          cornerRadius: 14,
          opacity: 1,
        },
      },
    ]);
  });

  test("builds gfx arrow draw scripts with one shaft and two head lines per rect", () => {
    const tree: PlainNode = {
      _tag: "VATRoot",
      _children: [
        {
          _tag: "Application",
          _children: [
            {
              _tag: "Window",
              frame: { x: 40, y: 50, width: 300, height: 200 },
            },
            {
              _tag: "Window",
              frame: { x: 400, y: 50, width: 320, height: 220 },
            },
          ],
        },
      ],
    };

    const script = buildGfxArrowDrawScriptFromText(formatVatQueryOutput(tree, "Window[frame]", false));

    expect(script.coordinateSpace).toBe("screen");
    expect(script.timeout).toBe(DEFAULT_CA_HIGHLIGHT_TIMEOUT_MS);
    expect(script.items).toHaveLength(6);
    expect(script.items.every((item) => item.kind === "line")).toBe(true);
  });

  test("builds gfx text placements at the center of every resolved rect", () => {
    const tree: PlainNode = {
      _tag: "VATRoot",
      _children: [
        {
          _tag: "Application",
          _children: [
            {
              _tag: "Window",
              frame: { x: 40, y: 50, width: 300, height: 200 },
            },
            {
              _tag: "Window",
              frame: { x: 400, y: 50, width: 320, height: 220 },
            },
          ],
        },
      ],
    };

    expect(buildGfxTextPlacementsFromText(formatVatQueryOutput(tree, "Window[frame]", false), "Review this")).toEqual([
      {
        point: { x: 190, y: 150 },
        text: "Review this",
      },
      {
        point: { x: 560, y: 160 },
        text: "Review this",
      },
    ]);
  });

  test("rejects empty gfx text payloads", () => {
    expect(() => buildGfxTextPlacementsFromText(JSON.stringify(target), "   "))
      .toThrow("gui gfx text - text must be non-empty");
  });

  test("rejects VAT query payloads without bounds/frame coordinates", () => {
    const tree: PlainNode = {
      _tag: "VATRoot",
      _children: [
        {
          _tag: "Application",
          title: "Terminal",
        },
      ],
    };

    expect(() => buildAXHighlightDrawScriptFromText(formatVatQueryOutput(tree, "Application", false)))
      .toThrow('gui ca highlight - Application "Terminal" is missing bounds/frame coordinates');
  });

  test("preserves the original stdin payload for passthrough stages", () => {
    const raw = `${JSON.stringify(target)}\n`;

    expect(parseSingleAXTargetPassthroughInput(raw, "actor run click")).toEqual({
      raw,
      target,
    });
  });

  test("preserves cursor payloads as target-bearing stdin", () => {
    const raw = `${JSON.stringify({
      type: "ax.cursor",
      target,
      selection: { location: 2, length: 0 },
    })}\n`;

    expect(parseSingleAXTargetPassthroughInput(raw, "actor run move")).toEqual({
      raw,
      target,
    });
  });

  test("builds actor click passthrough requests from stdin targets", () => {
    const request = buildActorClickPassthroughRequest(["-", "--button", "right", "--timeout", "500"], target);

    expect(request).toEqual({
      timeoutMs: 500,
      action: {
        kind: "click",
        button: "right",
        at: { x: 140, y: 120 },
      },
    });
  });

  test("builds actor move passthrough requests from stdin targets", () => {
    const request = buildActorMovePassthroughRequest(["-", "--style", "slow", "--timeout", "750"], target);

    expect(request).toEqual({
      timeoutMs: 750,
      action: {
        kind: "move",
        style: "slow",
        to: { x: 140, y: 120 },
      },
    });
  });

  test("extracts cg passthrough coordinates from AX target input", () => {
    expect(parseCGPointPassthroughInput(JSON.stringify(target), "cg move")).toEqual({ x: 140, y: 120 });
  });

  test("extracts rec rect arguments from a bounds-bearing AX payload", () => {
    expect(parseRecRectArgFromPayloadText(JSON.stringify(target), "rec image"))
      .toBe("100,100,80,40");
  });

  test("rejects rec payloads without usable bounds", () => {
    expect(() => parseRecRectArgFromPayloadText(JSON.stringify({
      ...target,
      bounds: undefined,
    }), "rec image")).toThrow('gui rec image AXButton "Save" has no usable bounds');
  });

  test("builds a shared AX target payload from a raw point", () => {
    const targetFromPoint = axTargetFromPoint(4321, { x: 512, y: 384 });

    expect(targetFromPoint).toEqual({
      type: "ax.target",
      pid: 4321,
      point: { x: 512, y: 384 },
      role: "CGCursor",
      title: null,
      label: null,
      identifier: null,
    });
    expect(parseCGPointPassthroughInput(JSON.stringify(targetFromPoint), "cg click")).toEqual({ x: 512, y: 384 });
  });

  test("parses cg drag mixed literal and stdin payload endpoints", () => {
    const otherTarget: AXTarget = {
      ...target,
      point: { x: 900, y: 480 },
      role: "AXGroup",
    };

    expect(
      parseCGDragPoints(["-", JSON.stringify(otherTarget)], "cg drag", `${JSON.stringify(target)}\n`),
    ).toEqual({
      from: { x: 140, y: 120 },
      to: { x: 900, y: 480 },
    });
  });

  test("parses cg drag sequential stdin placeholders as back-to-back ndjson", () => {
    const secondTarget: AXTarget = {
      ...target,
      point: { x: 640, y: 360 },
      role: "AXSlider",
    };

    expect(
      parseCGDragPoints(["-", "-"], "cg drag", `${JSON.stringify(target)}\n${JSON.stringify(secondTarget)}\n`),
    ).toEqual({
      from: { x: 140, y: 120 },
      to: { x: 640, y: 360 },
    });
  });

  test("rejects cg drag stdin placeholder count mismatches", () => {
    expect(() => parseCGDragPoints(["-", "-"], "cg drag", `${JSON.stringify(target)}\n`))
      .toThrow("gui cg drag expected 2 AX target-bearing payloads on stdin for 2 `-` placeholders, received 1");
  });

  test("extracts a cgWindowId from a single CG window payload", () => {
    expect(parseSingleCGWindowPayloadText(JSON.stringify({
      pid: 123,
      cgWindowId: 13801,
      x: 100,
      y: 120,
      w: 800,
      h: 600,
      owner: "TextEdit",
    }), "window focus")).toBe(13801);
  });

  test("extracts a cgWindowId from a single-element CG window array payload", () => {
    expect(parseSingleCGWindowPayloadText(JSON.stringify([{
      pid: 123,
      cgWindowId: 13801,
      x: 100,
      y: 120,
      w: 800,
      h: 600,
      owner: "TextEdit",
    }]), "window focus")).toBe(13801);
  });

  test("rejects CG window payload arrays with multiple records", () => {
    expect(() => parseSingleCGWindowPayloadText(JSON.stringify([
      { cgWindowId: 1 },
      { cgWindowId: 2 },
    ]), "window focus")).toThrow("gui window focus expected exactly one JSON CG window payload on stdin, received 2");
  });

  test("rejects CG window payloads without a usable cgWindowId", () => {
    expect(() => parseSingleCGWindowPayloadText(JSON.stringify({
      pid: 123,
      x: 100,
      y: 120,
      w: 800,
      h: 600,
    }), "window focus")).toThrow("gui window focus payload has no usable cgWindowId");
  });

  test("uses a click passthrough delay tied to the visual click duration", () => {
    expect(ACTOR_CLICK_PASSTHROUGH_DELAY_MS).toBe(130);
  });

  test("suppresses passthrough stdout when the destination is a tty", () => {
    expect(shouldEmitPassthroughStdout(true)).toBe(false);
    expect(shouldEmitPassthroughStdout(false)).toBe(true);
    expect(shouldEmitPassthroughStdout(undefined)).toBe(true);
  });

  test("emits passthrough stdout for non-tty consumers", () => {
    const chunks: string[] = [];
    emitPassthroughStdout(`${JSON.stringify(target)}\n`, false, chunk => chunks.push(chunk));
    expect(chunks).toEqual([`${JSON.stringify(target)}\n`]);
  });

  test("does not emit passthrough stdout for tty consumers", () => {
    const chunks: string[] = [];
    emitPassthroughStdout(`${JSON.stringify(target)}\n`, true, chunk => chunks.push(chunk));
    expect(chunks).toEqual([]);
  });
});

describe("ax query rendering", () => {
  test("emits canonical gui.payload envelopes for JSON pipes", async () => {
    const lines: string[] = [];
    await renderAXQueryMatches([
      {
        type: "ax.query-match",
        pid: 4321,
        node: { _tag: "AXApplication", title: "Codex" },
      },
    ], "all", "json", {
      type: "vat.a11y-query-plan",
      query: "@#Codex{**[**]}",
      cardinality: "all",
      scope: { kind: "app", app: "Codex" },
    }, async (chunk: string) => {
      lines.push(chunk);
    });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual([
      {
        type: "gui.payload",
        version: 1,
        source: "ax.query",
        query: null,
        tree: null,
        nodes: [{ _tag: "AXApplication", title: "Codex" }],
        matchCount: 1,
        node: { _tag: "AXApplication", title: "Codex" },
        target: null,
        cursor: null,
        axQueryMatch: {
          type: "ax.query-match",
          pid: 4321,
          node: { _tag: "AXApplication", title: "Codex" },
        },
        vatQueryPlan: {
          type: "vat.a11y-query-plan",
          query: "@#Codex{**[**]}",
          cardinality: "all",
          scope: { kind: "app", app: "Codex" },
        },
        bounds: null,
        point: null,
        issues: [],
      },
    ]);
  });

  test("awaits the JSON writer for non-tty output", async () => {
    let resolved = false;
    let seen = "";
    await renderAXQueryMatches([
      {
        type: "ax.query-match",
        pid: 4321,
        node: { _tag: "AXApplication", title: "Codex" },
      },
    ], "first", "json", undefined, (chunk: string) => new Promise<void>((resolve) => {
      seen = chunk;
      setTimeout(() => {
        resolved = true;
        resolve();
      }, 0);
    }));

    expect(resolved).toBe(true);
    expect(JSON.parse(seen)).toEqual({
      type: "gui.payload",
      version: 1,
      source: "ax.query",
      query: null,
      tree: null,
      nodes: [{ _tag: "AXApplication", title: "Codex" }],
      matchCount: 1,
      node: { _tag: "AXApplication", title: "Codex" },
      target: null,
      cursor: null,
      axQueryMatch: {
        type: "ax.query-match",
        pid: 4321,
        node: { _tag: "AXApplication", title: "Codex" },
      },
      vatQueryPlan: null,
      bounds: null,
      point: null,
      issues: [],
    });
  });
});
