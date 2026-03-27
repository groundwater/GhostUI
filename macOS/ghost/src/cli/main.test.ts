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
  buildGfxMarkerDrawScriptFromRect,
  buildGfxMarkerDrawScriptFromText,
  buildGfxScanOverlayRequestFromText,
  buildGfxSpotlightDrawScriptFromText,
  buildGfxXrayDrawScriptFromText,
  DEFAULT_CA_HIGHLIGHT_TIMEOUT_MS,
  DEFAULT_GFX_ARROW_COLOR,
  DEFAULT_GFX_ARROW_DURATION_MS,
  DEFAULT_GFX_ARROW_LENGTH,
  DEFAULT_GFX_ARROW_SIZE,
  DEFAULT_GFX_ARROW_TARGET,
  DEFAULT_GFX_OUTLINE_COLOR,
  DEFAULT_GFX_OUTLINE_FILL,
  DEFAULT_GFX_OUTLINE_SIZE,
  DEFAULT_GFX_MARKER_COLOR,
  DEFAULT_GFX_MARKER_DURATION_MS,
  DEFAULT_GFX_MARKER_PADDING,
  DEFAULT_GFX_MARKER_ROUGHNESS,
  DEFAULT_GFX_MARKER_SIZE,
  DEFAULT_GFX_SCAN_DURATION_MS,
  DEFAULT_GFX_XRAY_DURATION_MS,
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
  dispatchIntentTargetAction,
  renderActorRunUsage,
  renderAXQueryMatches,
  resolveAXQueryAppFilterScope,
  resolveCommandAlias,
  summarizeVatWatchChanges,
  shouldEmitPassthroughStdout,
  formatVatMountError,
  parseGfxArrowOptions,
  parseGfxDuration,
  parseGfxOutlineOptions,
  parseGfxScanOptions,
  parseGfxSpotlightOptions,
  parseGfxMarkerOptions,
  parseActorKillTargetsFromText,
  parseKeyboardInputSpec,
  resolveActorRunInvocation,
} from "./main.js";
import { waitForDrawOverlayAttachment } from "./draw-stream.js";
import {
  buildCLICompositionPayloadFromAXQueryMatch,
  buildCLICompositionPayloadFromVatQueryResult,
  normalizeCLICompositionPayload,
  readFirstJSONFrame,
  readJSONFrames,
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
  }) as unknown as typeof fetch;

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

});

describe("keyboard input parsing", () => {
  test("parses combo shortcuts into keys and modifiers", () => {
    expect(parseKeyboardInputSpec("cmd+shift+p")).toEqual({
      keys: ["p"],
      modifiers: ["cmd", "shift"],
    });
  });

  test("parses named keys and single characters without modifiers", () => {
    expect(parseKeyboardInputSpec("return")).toEqual({ keys: ["return"] });
    expect(parseKeyboardInputSpec("x")).toEqual({ keys: ["x"] });
  });

  test("treats longer freeform input as text", () => {
    expect(parseKeyboardInputSpec("Hello World")).toEqual({ keys: [], text: "Hello World" });
  });

  test("rejects modifier-only combos", () => {
    expect(() => parseKeyboardInputSpec("cmd+shift")).toThrow("No key specified in combo (only modifiers found)");
  });
});

describe("intent action routing", () => {
  const target: AXTarget = {
    type: "ax.target",
    pid: 4321,
    point: { x: 640, y: 360 },
    bounds: { x: 600, y: 320, width: 80, height: 40 },
    role: "AXButton",
    title: "Save",
    label: null,
    identifier: "save-button",
  };

  test("routes semantic press actions through /api/action", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/api/raw/ws/apps")) {
        return new Response(JSON.stringify([{ pid: 4321, bundleId: "com.example.SaveApp", name: "SaveApp" }]), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/api/action")) {
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("unexpected fetch", { status: 500 });
    }) as unknown as typeof fetch;

    try {
      __setDaemonAuthSecretReaderForTests(async () => null);
      resetDaemonAuthSecretCache();
      expect(await dispatchIntentTargetAction(target, "press")).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      __setDaemonAuthSecretReaderForTests();
      resetDaemonAuthSecretCache();
    }

    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toBe("http://localhost:7861/api/action");
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      app: "com.example.SaveApp",
      type: "Button",
      id: "save-button",
      action: "press",
      axRole: "AXButton",
      x: 640,
      y: 360,
    });
  });

  test("includes scroll deltas in semantic scroll actions", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/api/raw/ws/apps")) {
        return new Response(JSON.stringify([{ pid: 4321, bundleId: "com.example.SaveApp", name: "SaveApp" }]), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/api/action")) {
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("unexpected fetch", { status: 500 });
    }) as unknown as typeof fetch;

    try {
      __setDaemonAuthSecretReaderForTests(async () => null);
      resetDaemonAuthSecretCache();
      expect(await dispatchIntentTargetAction(target, "scroll", { dx: 0, dy: -240 })).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      __setDaemonAuthSecretReaderForTests();
      resetDaemonAuthSecretCache();
    }

    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      app: "com.example.SaveApp",
      type: "Button",
      id: "save-button",
      action: "scroll",
      dx: 0,
      dy: -240,
      axRole: "AXButton",
      x: 640,
      y: 360,
    });
  });

  test("returns false when no mounted workspace app can own the target", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify([]), {
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

    try {
      __setDaemonAuthSecretReaderForTests(async () => null);
      resetDaemonAuthSecretCache();
      expect(await dispatchIntentTargetAction(target, "type", { value: "Ada" })).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
      __setDaemonAuthSecretReaderForTests();
      resetDaemonAuthSecretCache();
    }
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

  test("backfills rect unions from legacy VAT payload nodes", () => {
    const payload = parseSingleCLICompositionPayload(JSON.stringify({
      type: "gui.payload",
      version: 1,
      source: "vat.query",
      query: "Window[frame]",
      tree: null,
      nodes: [
        {
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
        },
      ],
      matchCount: 2,
      node: null,
      target: null,
      cursor: null,
      axQueryMatch: null,
      vatQueryPlan: null,
      bounds: null,
      point: null,
      issues: [],
    }), "stdin");

    expect(payload.rectUnion).toEqual([
      { x: 40, y: 50, width: 300, height: 200 },
      { x: 400, y: 50, width: 320, height: 220 },
    ]);
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
    expect(usage).toContain("gui actor run p.rect");
    expect(usage).toContain("gui actor run p.circ");
    expect(usage).toContain("gui actor run p.on");
    expect(usage).toContain("gui actor run p.off");
    expect(usage).toContain("gui actor run p.color");
    expect(usage).toContain("gui actor run p.draw");
    expect(usage).toContain("gui actor run p.text");
    expect(usage).toContain("gui actor run p.clear");
    expect(usage).not.toContain("gui actor run <name>.move");
  });

  test("keeps bare canvas actor names from being reinterpreted as name.action tokens", async () => {
    await expect(resolveActorRunInvocation("test.canvas", [], "canvas")).resolves.toEqual({
      name: "test.canvas",
    });
    await expect(resolveActorRunInvocation("test.canvas", [], undefined)).resolves.toEqual({
      name: "test.canvas",
    });
    await expect(resolveActorRunInvocation("test.canvas.draw", ["-"], undefined)).resolves.toEqual({
      name: "test.canvas",
      actionName: "draw",
    });
  });

  test("parses dotted actor/action names even when the base actor has not been listed yet", async () => {
    await expect(resolveActorRunInvocation("main.clear", [], undefined)).resolves.toEqual({
      name: "main",
      actionName: "clear",
    });
    await expect(resolveActorRunInvocation("main.rect", ["-"], undefined)).resolves.toEqual({
      name: "main",
      actionName: "rect",
    });
    await expect(resolveActorRunInvocation("main.draw", ["circ", "-"], undefined)).resolves.toEqual({
      name: "main",
      actionName: "draw",
    });
  });

  test("parses actor kill targets from actor-list JSON and raw name lines", () => {
    expect(parseActorKillTargetsFromText(JSON.stringify({
      ok: true,
      actors: [
        { name: "pointer.main", type: "pointer" },
        { name: "spotlight.focus", type: "spotlight" },
      ],
    }, null, 2))).toEqual(["pointer.main", "spotlight.focus"]);

    expect(parseActorKillTargetsFromText("pointer.main\nspotlight.focus\n")).toEqual([
      "pointer.main",
      "spotlight.focus",
    ]);
  });

  test("renders canvas-specific actor run usage when the actor type is known", () => {
    const usage = renderActorRunUsage("canvas.notes", "canvas");
    expect(usage).toContain("gui actor run canvas.notes.draw <rect|circ|check|cross|underline> [--padding <pixels>] [--size <points>] [--color <css-color>] [--box <x y width height> | -]");
    expect(usage).toContain("gui actor run canvas.notes.text <Text> [--font <name>] [--size <pt>] [--color <css-color>] [--highlight <css-color|none>] [--box <x y width height> | -]");
    expect(usage).toContain("gui actor run canvas.notes.clear");
    expect(usage).not.toContain("gui actor run canvas.notes.move");
  });

  test("renders spotlight-specific actor run usage when the actor type is known", () => {
    const usage = renderActorRunUsage("spotlight.focus", "spotlight");
    expect(usage).toContain("gui actor run spotlight.focus.rect [--padding <pixels>] [--blur <pixels>] -");
    expect(usage).toContain("gui actor run spotlight.focus.circ [--padding <pixels>] [--blur <pixels>] -");
    expect(usage).toContain("gui actor run spotlight.focus.on [--transition fade|instant]");
    expect(usage).toContain("gui actor run spotlight.focus.off [--transition fade|instant]");
    expect(usage).toContain("gui actor run spotlight.focus.color <Color>");
    expect(usage).not.toContain("gui actor run spotlight.focus.draw");
  });
});

describe("gfx payload bridges", () => {
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

  test("uses only the framed VAT leaf for highlight and gfx outline payloads", () => {
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
          rect: { x: 894, y: 34, width: 31, height: 28 },
        },
      ],
    });
    expect(buildGfxOutlineDrawScriptFromText(JSON.stringify(payload))).toEqual({
      coordinateSpace: "screen",
      timeout: DEFAULT_CA_HIGHLIGHT_TIMEOUT_MS,
      items: [
        {
          kind: "rect",
          rect: { x: 894, y: 34, width: 31, height: 28 },
          style: {
            stroke: DEFAULT_GFX_OUTLINE_COLOR,
            fill: DEFAULT_GFX_OUTLINE_FILL,
            lineWidth: DEFAULT_GFX_OUTLINE_SIZE,
            cornerRadius: 8,
            opacity: 1,
          },
          from: undefined,
          animation: undefined,
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
          style: {
            stroke: DEFAULT_GFX_OUTLINE_COLOR,
            fill: DEFAULT_GFX_OUTLINE_FILL,
            lineWidth: DEFAULT_GFX_OUTLINE_SIZE,
            cornerRadius: 8,
            opacity: 1,
          },
          from: undefined,
          animation: undefined,
        },
      ],
    });
  });

  test("builds gfx outline draw scripts with explicit styling and fade transition", () => {
    expect(buildGfxOutlineDrawScriptFromText(JSON.stringify(target), {
      color: "#FF3B30",
      size: 4,
      fill: "rgba(255,59,48,0.2)",
      durationMs: 900,
      transition: "fade",
    })).toEqual({
      coordinateSpace: "screen",
      timeout: 900,
      items: [
        {
          kind: "rect",
          rect: { x: 100, y: 100, width: 80, height: 40 },
          style: {
            stroke: "#FF3B30",
            fill: "rgba(255,59,48,0.2)",
            lineWidth: 4,
            cornerRadius: 8,
            opacity: 1,
          },
          from: {
            rect: { x: 100, y: 100, width: 80, height: 40 },
            stroke: "#FF3B30",
            fill: "rgba(255,59,48,0.2)",
            lineWidth: 4,
            opacity: 0,
          },
          animation: {
            durMs: 900,
            ease: "easeInOut",
          },
        },
      ],
    });
  });

  test("builds gfx outline draw scripts from multiple AX query matches", () => {
    expect(buildGfxOutlineDrawScriptFromText(JSON.stringify([
      {
        type: "ax.query-match",
        pid: 4321,
        node: { _tag: "AXButton", _id: "Save", _frame: "(100,100,80,40)" },
        target,
      },
      {
        type: "ax.query-match",
        pid: 4321,
        node: { _tag: "AXButton", _id: "Cancel", _frame: "(240,120,60,30)" },
        target: {
          ...target,
          point: { x: 270, y: 135 },
          bounds: { x: 240, y: 120, width: 60, height: 30 },
          title: "Cancel",
          identifier: "cancel-button",
        },
      },
    ]))).toEqual({
      coordinateSpace: "screen",
      timeout: DEFAULT_CA_HIGHLIGHT_TIMEOUT_MS,
      items: [
        {
          kind: "rect",
          rect: { x: 100, y: 100, width: 80, height: 40 },
          style: {
            stroke: DEFAULT_GFX_OUTLINE_COLOR,
            fill: DEFAULT_GFX_OUTLINE_FILL,
            lineWidth: DEFAULT_GFX_OUTLINE_SIZE,
            cornerRadius: 8,
            opacity: 1,
          },
          from: undefined,
          animation: undefined,
        },
        {
          kind: "rect",
          rect: { x: 240, y: 120, width: 60, height: 30 },
          style: {
            stroke: DEFAULT_GFX_OUTLINE_COLOR,
            fill: DEFAULT_GFX_OUTLINE_FILL,
            lineWidth: DEFAULT_GFX_OUTLINE_SIZE,
            cornerRadius: 8,
            opacity: 1,
          },
          from: undefined,
          animation: undefined,
        },
      ],
    });
  });

  test("builds gfx outline draw scripts from rect-union-only payloads", () => {
    expect(buildGfxOutlineDrawScriptFromText(JSON.stringify({
      type: "gui.payload",
      version: 1,
      source: "ax.query-match",
      query: null,
      tree: null,
      nodes: null,
      matchCount: 2,
      node: null,
      target: null,
      cursor: null,
      axQueryMatch: null,
      vatQueryPlan: null,
      rectUnion: [
        { x: 100, y: 100, width: 80, height: 40 },
        { x: 240, y: 120, width: 60, height: 30 },
      ],
      bounds: { x: 100, y: 100, width: 80, height: 40 },
      point: { x: 140, y: 120 },
      issues: [],
    }))).toEqual({
      coordinateSpace: "screen",
      timeout: DEFAULT_CA_HIGHLIGHT_TIMEOUT_MS,
      items: [
        {
          kind: "rect",
          rect: { x: 100, y: 100, width: 80, height: 40 },
          style: {
            stroke: DEFAULT_GFX_OUTLINE_COLOR,
            fill: DEFAULT_GFX_OUTLINE_FILL,
            lineWidth: DEFAULT_GFX_OUTLINE_SIZE,
            cornerRadius: 8,
            opacity: 1,
          },
          from: undefined,
          animation: undefined,
        },
        {
          kind: "rect",
          rect: { x: 240, y: 120, width: 60, height: 30 },
          style: {
            stroke: DEFAULT_GFX_OUTLINE_COLOR,
            fill: DEFAULT_GFX_OUTLINE_FILL,
            lineWidth: DEFAULT_GFX_OUTLINE_SIZE,
            cornerRadius: 8,
            opacity: 1,
          },
          from: undefined,
          animation: undefined,
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
      items: [
        {
          kind: "xray",
          rect: { x: 40, y: 50, width: 300, height: 200 },
          direction: "leftToRight",
          animation: { durMs: DEFAULT_GFX_XRAY_DURATION_MS, ease: "easeInOut" },
        },
        {
          kind: "xray",
          rect: { x: 400, y: 50, width: 320, height: 220 },
          direction: "leftToRight",
          animation: { durMs: DEFAULT_GFX_XRAY_DURATION_MS, ease: "easeInOut" },
        },
      ],
    });
  });

  test("builds gfx spotlight draw scripts from the union of resolved rects", () => {
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

    const script = buildGfxSpotlightDrawScriptFromText(formatVatQueryOutput(tree, "Window[frame]", false));

    expect(script.coordinateSpace).toBe("screen");
    expect(script.timeout).toBe(DEFAULT_CA_HIGHLIGHT_TIMEOUT_MS);
    expect(script.items).toEqual([
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
  });

  test("builds gfx spotlight draw scripts with an explicit duration and color", () => {
    const script = buildGfxSpotlightDrawScriptFromText(JSON.stringify(target), {
      durationMs: 900,
      color: "rgba(255, 59, 48, 0.35)",
    });

    expect(script.timeout).toBe(900);
    expect(script.items).toEqual([
      {
        kind: "spotlight",
        rects: [
          { x: 100, y: 100, width: 80, height: 40 },
        ],
        style: {
          fill: "rgba(255, 59, 48, 0.35)",
          cornerRadius: 18,
          opacity: 1,
        },
        animation: {
          durMs: 200,
          ease: "easeInOut",
        },
      },
    ]);
  });

  test("parses gfx spotlight options and strips consumed flags", () => {
    const args = ["--color", "rgba(255, 59, 48, 0.35)", "--duration", "900", "-"];
    expect(parseGfxSpotlightOptions(args, "gfx spotlight")).toEqual({
      color: "rgba(255, 59, 48, 0.35)",
      durationMs: 900,
    });
    expect(args).toEqual(["-"]);
  });

  test("parses gfx outline options and strips consumed flags", () => {
    const args = ["--color", "#FF3B30", "--size", "5", "--transition", "pop", "--fill", "rgba(255,59,48,0.2)", "--duration", "850", "-"];
    expect(parseGfxOutlineOptions(args, "gfx outline")).toEqual({
      color: "#FF3B30",
      size: 5,
      fill: "rgba(255,59,48,0.2)",
      durationMs: 850,
      transition: "pop",
    });
    expect(args).toEqual(["-"]);
  });

  test("reads one gfx payload frame from stdin without waiting for EOF", async () => {
    const payloadLine = `${JSON.stringify(buildCLICompositionPayloadFromAXQueryMatch({
      type: "ax.query-match",
      pid: 42,
      node: { _tag: "AXButton", _id: "Save" },
      target,
    }))}\n`;

    const result = await Promise.race([
      readFirstJSONFrame(streamFromChunks([payloadLine], { closeWhenDone: false })),
      Bun.sleep(50).then(() => "__timeout__"),
    ]);

    expect(result).toBe(payloadLine.trimEnd());
    expect(parseSingleCLICompositionPayload(result, "gfx arrow")).toMatchObject({
      type: "gui.payload",
      source: "ax.query-match",
      target,
    });
  });

  test("reads pretty-printed gfx payload frames without waiting for EOF", async () => {
    const payload = buildCLICompositionPayloadFromAXQueryMatch({
      type: "ax.query-match",
      pid: 42,
      node: { _tag: "AXButton", _id: "Save" },
      target,
    });
    const prettyPrintedPayload = JSON.stringify(payload, null, 2);

    const result = await Promise.race([
      readFirstJSONFrame(streamFromChunks([
        prettyPrintedPayload.slice(0, 32),
        prettyPrintedPayload.slice(32),
      ], { closeWhenDone: false })),
      Bun.sleep(50).then(() => "__timeout__"),
    ]);

    expect(result).toBe(prettyPrintedPayload);
    expect(buildGfxOutlineDrawScriptFromText(result)).toMatchObject({
      coordinateSpace: "screen",
      timeout: DEFAULT_CA_HIGHLIGHT_TIMEOUT_MS,
    });
  });

  test("reads multiple NDJSON gfx payload frames from stdin in order", async () => {
    const payload = buildCLICompositionPayloadFromAXQueryMatch({
      type: "ax.query-match",
      pid: 42,
      node: { _tag: "AXButton", _id: "Save" },
      target,
    });
    const secondPayload = buildCLICompositionPayloadFromAXQueryMatch({
      type: "ax.query-match",
      pid: 42,
      node: { _tag: "AXButton", _id: "Cancel" },
      target: {
        ...target,
        bounds: { x: 240, y: 120, width: 60, height: 30 },
        point: { x: 270, y: 135 },
        title: "Cancel",
      },
    });

    const frames: string[] = [];
    for await (const frame of readJSONFrames(streamFromChunks([
      `${JSON.stringify(payload)}\n${JSON.stringify(secondPayload)}\n`,
    ], { closeWhenDone: false }))) {
      frames.push(frame);
      if (frames.length === 2) {
        break;
      }
    }

    expect(frames).toEqual([
      JSON.stringify(payload),
      JSON.stringify(secondPayload),
    ]);
  });

  test("delays gfx spotlight passthrough until the reveal duration elapses, even with a long timeout", async () => {
    const writes: string[] = [];
    const spotlightPayload = buildGfxSpotlightDrawScriptFromText(JSON.stringify(target), {
      durationMs: 6000,
    });
    expect(spotlightPayload.timeout).toBe(6000);
    const spotlightItem = spotlightPayload.items.find(item => item.kind === "spotlight");
    expect(spotlightItem).toBeDefined();
    expect(spotlightItem?.animation).toEqual({
      durMs: 200,
      ease: "easeInOut",
    });
    if (!spotlightItem?.animation) {
      throw new Error("spotlight animation is required");
    }
    spotlightItem.animation.durMs = 20;
    const revealDurationMs = spotlightItem.animation.durMs;

    const abortController = new AbortController();
    const promise = waitForDrawOverlayAttachment(new Response(streamFromChunks(["attached\n"]), {
      headers: { "content-type": "text/plain; charset=utf-8" },
    }), abortController.signal, {
      async onAttached() {
        await Bun.sleep(revealDurationMs);
        writes.push("payload");
      },
    });

    await Bun.sleep(5);
    expect(writes).toEqual([]);
    await Bun.sleep(revealDurationMs + 25);
    expect(writes).toEqual(["payload"]);
    abortController.abort();
    await promise;
  });

  test("builds gfx arrow draw scripts with animated red defaults", () => {
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
    expect(script.items[0]).toMatchObject({
      from: {
        line: {
          from: { x: 190 - DEFAULT_GFX_ARROW_LENGTH, y: 150 - DEFAULT_GFX_ARROW_LENGTH },
          to: { x: 190 - DEFAULT_GFX_ARROW_LENGTH, y: 150 - DEFAULT_GFX_ARROW_LENGTH },
        },
        stroke: DEFAULT_GFX_ARROW_COLOR,
        lineWidth: DEFAULT_GFX_ARROW_SIZE,
      },
      line: {
        from: { x: 190 - DEFAULT_GFX_ARROW_LENGTH, y: 150 - DEFAULT_GFX_ARROW_LENGTH },
        to: { x: 190, y: 150 },
      },
      style: {
        stroke: DEFAULT_GFX_ARROW_COLOR,
        lineWidth: DEFAULT_GFX_ARROW_SIZE,
        opacity: 1,
      },
      animation: {
        durMs: DEFAULT_GFX_ARROW_DURATION_MS,
        ease: "easeInOut",
      },
    });
  });

  test("builds gfx arrow draw scripts from the requested target anchor", () => {
    const script = buildGfxArrowDrawScriptFromText(JSON.stringify(target), {
      target: "bottomright",
    });

    expect(script.items[0]).toMatchObject({
      from: {
        line: {
          from: { x: 180 - DEFAULT_GFX_ARROW_LENGTH, y: 140 - DEFAULT_GFX_ARROW_LENGTH },
          to: { x: 180 - DEFAULT_GFX_ARROW_LENGTH, y: 140 - DEFAULT_GFX_ARROW_LENGTH },
        },
      },
      line: {
        from: { x: 180 - DEFAULT_GFX_ARROW_LENGTH, y: 140 - DEFAULT_GFX_ARROW_LENGTH },
        to: { x: 180, y: 140 },
      },
    });
  });

  test("builds gfx scan overlay requests without outline rects", () => {
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

    expect(buildGfxScanOverlayRequestFromText(formatVatQueryOutput(tree, "Window[frame]", false), 750)).toEqual({
      rects: [
        { x: 40, y: 50, width: 300, height: 200 },
        { x: 400, y: 50, width: 320, height: 220 },
      ],
      durationMs: 750,
      direction: "top-to-bottom",
    });
  });

  test("parses gfx duration and strips the flag pair", () => {
    const args = ["--duration", "900", "-"];
    expect(parseGfxDuration(args, "gfx xray", DEFAULT_GFX_XRAY_DURATION_MS)).toBe(900);
    expect(args).toEqual(["-"]);
  });

  test("parses gfx scan options and strips consumed flags", () => {
    const args = ["--duration", "900", "--direction", "left-to-right", "-"];
    expect(parseGfxScanOptions(args, "gfx scan")).toEqual({
      durationMs: 900,
      direction: "left-to-right",
    });
    expect(args).toEqual(["-"]);
  });

  test("parses gfx scan options in every cardinal direction", () => {
    expect(parseGfxScanOptions(["--direction", "top-to-bottom", "-"], "gfx scan")).toEqual({
      durationMs: DEFAULT_GFX_SCAN_DURATION_MS,
      direction: "top-to-bottom",
    });
    expect(parseGfxScanOptions(["--direction", "bottom-to-top", "-"], "gfx scan")).toEqual({
      durationMs: DEFAULT_GFX_SCAN_DURATION_MS,
      direction: "bottom-to-top",
    });
    expect(parseGfxScanOptions(["--direction", "right-to-left", "-"], "gfx scan")).toEqual({
      durationMs: DEFAULT_GFX_SCAN_DURATION_MS,
      direction: "right-to-left",
    });
  });

  test("parses gfx arrow options, including --target and --from overriding the start point", () => {
    const args = ["--color", "#00FF00", "--size", "9", "--length", "180", "--duration", "700", "--target", "left", "--from", "12", "34", "-"];
    expect(parseGfxArrowOptions(args, "gfx arrow")).toEqual({
      color: "#00FF00",
      size: 9,
      length: 180,
      durationMs: 700,
      target: "left",
      from: { x: 12, y: 34 },
    });
    expect(args).toEqual(["-"]);
  });

  test("parses gfx arrow options with css colors", () => {
    const args = ["--color", "rgba(255, 59, 48, 0.9)", "-"];
    expect(parseGfxArrowOptions(args, "gfx arrow")).toEqual({
      color: "rgba(255, 59, 48, 0.9)",
      size: DEFAULT_GFX_ARROW_SIZE,
      length: DEFAULT_GFX_ARROW_LENGTH,
      durationMs: DEFAULT_GFX_ARROW_DURATION_MS,
      target: DEFAULT_GFX_ARROW_TARGET,
      from: undefined,
    });
    expect(args).toEqual(["-"]);
  });

  test("parses gfx marker options and strips consumed flags", () => {
    const args = ["--padding", "8", "--size", "4", "--color", "#ff00ff", "--duration", "420", "--roughness", "0.3", "-"];
    expect(parseGfxMarkerOptions(args, "gfx draw")).toEqual({
      color: "#ff00ff",
      size: 4,
      padding: 8,
      durationMs: 420,
      roughness: 0.3,
    });
    expect(args).toEqual(["-"]);
  });

  test("parses gfx arrow options with center target by default", () => {
    const args = ["-"];
    expect(parseGfxArrowOptions(args, "gfx arrow")).toEqual({
      color: DEFAULT_GFX_ARROW_COLOR,
      size: DEFAULT_GFX_ARROW_SIZE,
      length: DEFAULT_GFX_ARROW_LENGTH,
      durationMs: DEFAULT_GFX_ARROW_DURATION_MS,
      target: DEFAULT_GFX_ARROW_TARGET,
      from: undefined,
    });
  });

  test("builds gfx arrow draw scripts from an explicit origin", () => {
    const script = buildGfxArrowDrawScriptFromText(JSON.stringify(target), {
      from: { x: 12, y: 34 },
      color: "#00FF00",
      size: 9,
      length: 180,
      durationMs: 700,
      target: "top",
    });

    expect(script.items[0]).toMatchObject({
      from: {
        line: {
          from: { x: 12, y: 34 },
          to: { x: 12, y: 34 },
        },
      },
      line: {
        from: { x: 12, y: 34 },
        to: { x: 140, y: 100 },
      },
      style: {
        stroke: "#00FF00",
        lineWidth: 9,
        opacity: 1,
      },
      animation: {
        durMs: 700,
        ease: "easeInOut",
      },
    });
  });

  test("builds marker draw scripts from a literal box", () => {
    const script = buildGfxMarkerDrawScriptFromRect(
      { x: 100, y: 120, width: 240, height: 180 },
      "check",
      {
        color: "rgba(255, 59, 48, 0.9)",
        size: 5,
        padding: 8,
        durationMs: 320,
        roughness: 0.35,
      },
    );

    expect(script).toEqual({
      coordinateSpace: "screen",
      timeout: 320,
      items: [
        {
          kind: "marker",
          shape: "check",
          rect: { x: 100, y: 120, width: 240, height: 180 },
          style: {
            color: "rgba(255, 59, 48, 0.9)",
            size: 5,
            padding: 8,
            roughness: 0.35,
          },
          animation: {
            durMs: 320,
            ease: "easeInOut",
          },
        },
      ],
    });
  });

  test("builds marker draw scripts from stdin payloads", () => {
    const script = buildGfxMarkerDrawScriptFromText(JSON.stringify(target), "underline", {
      color: DEFAULT_GFX_MARKER_COLOR,
      size: DEFAULT_GFX_MARKER_SIZE,
      padding: DEFAULT_GFX_MARKER_PADDING,
      durationMs: DEFAULT_GFX_MARKER_DURATION_MS,
      roughness: DEFAULT_GFX_MARKER_ROUGHNESS,
    });

    expect(script.items).toEqual([
      {
        kind: "marker",
        shape: "underline",
        rect: { x: 100, y: 100, width: 80, height: 40 },
        style: {
          color: DEFAULT_GFX_MARKER_COLOR,
          size: DEFAULT_GFX_MARKER_SIZE,
          padding: DEFAULT_GFX_MARKER_PADDING,
          roughness: DEFAULT_GFX_MARKER_ROUGHNESS,
        },
        animation: {
          durMs: DEFAULT_GFX_MARKER_DURATION_MS,
          ease: "easeInOut",
        },
      },
    ]);
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
        rectUnion: null,
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
      rectUnion: null,
      bounds: null,
      point: null,
      issues: [],
    });
  });
});
