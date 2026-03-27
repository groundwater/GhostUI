import { describe, test, expect } from "bun:test";
import { axClickTarget, axEventMatchesFilter, axFocus, axFocusWindowTarget, axHoverTarget, axPerform, axPerformTarget, axPressTarget, axSelectCursor, axType, axTypeCursor, axTypeTarget, extractAXQueryScope, fetchAXActionsTarget, fetchAXCursor, fetchAXQueryMatches, fetchAXQueryTargets, formatAXMatches, formatAXNode, formatAXQueryGuiml, formatAXQueryGuimlAcrossTrees, formatAXTargets, parseAXScopePayload, parseAXTargetPayload, parseAXTargetStream, resolveAXQueryApp, renderAXQueryGuimlForScope, type AXCursor, type AXNode, type AXQueryMatch, type AXTarget } from "./ax.js";
import { selectAXQueryMatches } from "../a11y/ax-target.js";
import { serializeAXQueryMatches } from "../a11y/ax-query.js";
import { matchTree } from "./filter.js";
import { parseQuery } from "./query.js";
import { axNodeAccessor } from "./accessor.js";
import { resetDaemonAuthSecretCache, type RawWorkspaceApp } from "./client.js";

/** Helper: run a query string against an AX tree */
function queryAX(tree: AXNode, q: string) {
  return matchTree(tree, parseQuery(q), axNodeAccessor);
}

function mockFetch(responseBody: unknown, status = 200) {
  const originalFetch = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const normalizedInit = init
      ? { ...init, headers: Object.fromEntries(new Headers(init.headers).entries()) }
      : init;
    calls.push({ url: typeof input === "string" ? input : input.toString(), init: normalizedInit });
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}

function mockTextFetch(body: string, status = 200, contentType = "text/html; charset=utf-8") {
  const originalFetch = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const normalizedInit = init
      ? { ...init, headers: Object.fromEntries(new Headers(init.headers).entries()) }
      : init;
    calls.push({ url: typeof input === "string" ? input : input.toString(), init: normalizedInit });
    return new Response(body, {
      status,
      headers: { "content-type": contentType },
    });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}

describe("AX daemon auth", () => {
  test("includes a bearer token on AX requests when the secret is available", async () => {
    const previous = process.env.GHOSTUI_AUTH_SECRET;
    process.env.GHOSTUI_AUTH_SECRET = "ax-secret";
    resetDaemonAuthSecretCache();
    const { calls, restore } = mockFetch({ role: "AXApplication", title: "Terminal" });
    try {
      await fetchAXCursor().catch(() => undefined);
      expect(calls[0].init?.headers).toEqual({ authorization: "Bearer ax-secret" });
    } finally {
      if (previous === undefined) delete process.env.GHOSTUI_AUTH_SECRET;
      else process.env.GHOSTUI_AUTH_SECRET = previous;
      resetDaemonAuthSecretCache();
      restore();
    }
  });
});

describe("matchTree with axNodeAccessor", () => {
  const tree: AXNode = {
    role: "AXWindow",
    title: "Test Window",
    children: [
      {
        role: "AXGroup",
        children: [
          { role: "AXButton", title: "Save" },
          { role: "AXButton", title: "Cancel" },
          { role: "AXTextField", label: "Name", value: "" },
        ],
      },
      {
        role: "AXToolbar",
        children: [
          { role: "AXButton", title: "Back" },
          { role: "AXButton", title: "Save" },
        ],
      },
    ],
  };
  const textTree: AXNode = {
    role: "AXWindow",
    title: "Editor",
    children: [
      { role: "AXTextField", label: "Name", value: "" },
      { role: "AXTextArea", value: "notes" },
      { role: "AXSearchField", placeholder: "Search" },
      { role: "AXComboBox", value: "Choice" },
      { role: "AXStaticText", value: "Read only" },
    ],
  };

  test("find all buttons by short name", () => {
    const matches = queryAX(tree, "Button");
    expect(matches.length).toBe(4);
  });

  test("AX-prefixed tag matches the same nodes as the short name", () => {
    expect(queryAX(tree, "AXButton").length).toBe(4);
    expect(queryAX(tree, "AXWindow").length).toBe(1);
  });

  test("find by tag index", () => {
    const matches = queryAX(tree, "Button:0");
    expect(matches.length).toBe(1);
    expect(matches[0].node.title).toBe("Save");
  });

  test("find by #id (title match)", () => {
    const matches = queryAX(tree, "Button#Cancel");
    expect(matches.length).toBe(1);
    expect(matches[0].node.title).toBe("Cancel");
  });

  test("nth selector (third button)", () => {
    const matches = queryAX(tree, "Button:2");
    expect(matches.length).toBe(1);
    expect(matches[0].node.title).toBe("Back");
  });

  test("nth out of range returns empty", () => {
    const matches = queryAX(tree, "Button:99");
    expect(matches.length).toBe(0);
  });

  test("predicate match", () => {
    const matches = queryAX(tree, "Button[title=Save]");
    expect(matches.length).toBe(2);
  });

  test("predicate substring match", () => {
    const matches = queryAX(tree, "Button[title~=ave]");
    expect(matches.length).toBe(2);
  });

  test("scoped query: Window { Button }", () => {
    const matches = queryAX(tree, "Window { Button }");
    expect(matches.length).toBe(4);
  });

  test("scoped query: Toolbar { Button }", () => {
    const matches = queryAX(tree, "Toolbar { Button }");
    expect(matches.length).toBe(2);
  });

  test("path tracking", () => {
    const matches = queryAX(tree, "Button#Back");
    expect(matches.length).toBe(1);
    const pathRoles = matches[0].path.map(n => n.role);
    expect(pathRoles).toEqual(["AXWindow", "AXToolbar"]);
  });

  test("wildcard tag", () => {
    const matches = queryAX(tree, "*");
    // * matches the root
    expect(matches.length).toBe(1);
    expect(matches[0].node.role).toBe("AXWindow");
  });

  test("Window // * returns all descendants in AX trees", () => {
    const matches = queryAX(tree, "Window // *");
    expect(matches.length).toBe(7);
    expect(matches.map(match => match.node.role)).toEqual([
      "AXGroup",
      "AXButton",
      "AXButton",
      "AXTextField",
      "AXToolbar",
      "AXButton",
      "AXButton",
    ]);
  });

  test("Window { * } (brace syntax) returns all descendants, same as // *", () => {
    const matches = queryAX(tree, "Window { * }");
    expect(matches.length).toBe(7);
    expect(matches.map(m => m.node.role)).toEqual([
      "AXGroup",
      "AXButton",
      "AXButton",
      "AXTextField",
      "AXToolbar",
      "AXButton",
      "AXButton",
    ]);
  });

  test("Window / * (direct child) returns only immediate children", () => {
    const matches = queryAX(tree, "Window / *");
    expect(matches.length).toBe(2);
    expect(matches.map(m => m.node.role)).toEqual(["AXGroup", "AXToolbar"]);
  });

  test("TextField by tag", () => {
    const matches = queryAX(tree, "TextField");
    expect(matches.length).toBe(1);
    expect(matches[0].node.label).toBe("Name");
  });

  test("Text alias matches text-bearing controls", () => {
    const matches = queryAX(textTree, "Text");
    expect(matches.map(m => m.node.role)).toEqual([
      "AXTextField",
      "AXTextArea",
      "AXSearchField",
      "AXComboBox",
    ]);
  });

  test("Input is no longer a text-control alias", () => {
    expect(queryAX(textTree, "Input")).toHaveLength(0);
  });

  test("Window by tag", () => {
    const matches = queryAX(tree, "Window");
    expect(matches.length).toBe(1);
    expect(matches[0].node.title).toBe("Test Window");
  });

  test("AX-prefixed application tag matches AXApplication nodes", () => {
    const appTree: AXNode = {
      role: "AXApplication",
      title: "Terminal",
      children: [{ role: "AXWindow", title: "Main" }],
    };
    expect(queryAX(appTree, "Application").length).toBe(1);
    expect(queryAX(appTree, "AXApplication").length).toBe(1);
  });
});

describe("formatAXNode", () => {
  test("leaf node", () => {
    const result = formatAXNode({ role: "AXButton", title: "OK" });
    expect(result).toBe(`<AXButton title="OK" />`);
  });

  test("node with children", () => {
    const result = formatAXNode({
      role: "AXGroup",
      children: [
        { role: "AXButton", title: "A" },
      ],
    });
    expect(result).toContain("<AXGroup>");
    expect(result).toContain(`  <AXButton title="A" />`);
    expect(result).toContain("</AXGroup>");
  });

  test("node with frame", () => {
    const result = formatAXNode({ role: "AXButton", title: "X", frame: { x: 10, y: 20, width: 100, height: 30 } });
    expect(result).toContain("frame=(10,20,100,30)");
  });

  test("disabled node", () => {
    const result = formatAXNode({ role: "AXButton", title: "Nope", enabled: false });
    expect(result).toContain("disabled");
  });
});

describe("axEventMatchesFilter", () => {
  test("empty filter matches everything", () => {
    expect(axEventMatchesFilter({ pid: 123, bundleId: "com.apple.foo" }, {})).toBe(true);
    expect(axEventMatchesFilter({}, {})).toBe(true);
  });

  test("pid filter matches exact pid", () => {
    expect(axEventMatchesFilter({ pid: 123 }, { pid: 123 })).toBe(true);
    expect(axEventMatchesFilter({ pid: 456 }, { pid: 123 })).toBe(false);
  });

  test("bundle filter matches exact bundleId", () => {
    expect(axEventMatchesFilter({ bundleId: "com.apple.finder" }, { bundle: "com.apple.finder" })).toBe(true);
    expect(axEventMatchesFilter({ bundleId: "com.apple.safari" }, { bundle: "com.apple.finder" })).toBe(false);
  });

  test("combined pid and bundle filter requires both to match", () => {
    const filter = { pid: 123, bundle: "com.apple.finder" };
    expect(axEventMatchesFilter({ pid: 123, bundleId: "com.apple.finder" }, filter)).toBe(true);
    expect(axEventMatchesFilter({ pid: 123, bundleId: "com.apple.safari" }, filter)).toBe(false);
    expect(axEventMatchesFilter({ pid: 456, bundleId: "com.apple.finder" }, filter)).toBe(false);
    expect(axEventMatchesFilter({ pid: 456, bundleId: "com.apple.safari" }, filter)).toBe(false);
  });

  test("pid filter rejects event with undefined pid", () => {
    expect(axEventMatchesFilter({ bundleId: "com.apple.finder" }, { pid: 123 })).toBe(false);
  });

  test("bundle filter rejects event with undefined bundleId", () => {
    expect(axEventMatchesFilter({ pid: 123 }, { bundle: "com.apple.finder" })).toBe(false);
  });
});

describe("formatAXMatches", () => {
  test("formats a raw match with no path cleanly", () => {
    const result = formatAXMatches([
      { node: { role: "AXButton", title: "OK" }, path: [] },
    ]);
    expect(result).toBe(`[0] <AXButton title="OK" />`);
  });

  test("includes path roles without extra separators", () => {
    const result = formatAXMatches([
      {
        node: { role: "AXButton", title: "Save" },
        path: [{ role: "AXWindow" }, { role: "AXToolbar" }],
      },
    ]);
    expect(result).toBe(`[0] AXWindow > AXToolbar > <AXButton title="Save" />`);
  });
});

describe("formatAXQueryGuiml", () => {
  test("supports [*] introspection in GUIML output", () => {
    const tree: AXNode = { role: "AXButton", title: "Save" };
    const result = formatAXQueryGuiml(tree, "Button[*]", "all");
    expect(result).toBe("<AXButton#Save title />");
  });

  test("supports [**] introspection in GUIML output", () => {
    const tree: AXNode = { role: "AXButton", title: "Save" };
    const result = formatAXQueryGuiml(tree, "Button[**]", "all");
    expect(result).toBe('<AXButton#Save title="Save" />');
  });
});

describe("AX target actions", () => {
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

  test("axPressTarget posts semantic press requests", async () => {
    const { calls, restore } = mockFetch({ ok: true });
    try {
      await axPressTarget(target);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("http://localhost:7861/api/ax/action");
      expect(calls[0].init?.method).toBe("POST");
      expect(JSON.parse(String(calls[0].init?.body))).toEqual({
        method: "press",
        target,
      });
    } finally {
      restore();
    }
  });
});

describe("formatAXQueryGuiml", () => {
  const tree = {
    role: "AXApplication",
    children: [
      {
        role: "AXWindow",
        children: [
          {
            role: "AXSplitGroup",
            children: [
              {
                role: "AXScrollArea",
                children: [
                  { role: "AXButton", title: "First", frame: { x: 887, y: 79, width: 18, height: 18 } },
                  { role: "AXButton", title: "Second", frame: { x: 907, y: 79, width: 18, height: 18 } },
                ],
              },
            ],
          },
        ],
      },
    ],
  } satisfies AXNode;

  test("first renders only the first matched GUIML subtree", () => {
    const result = formatAXQueryGuiml(tree, "Button", "first");

    expect(result).toContain("<AXApplication");
    expect(result).toContain("First");
    expect(result).not.toContain("Second");
    expect(result).not.toContain("[0] ");
    expect(result).not.toContain("point=(");
  });

  test("only rejects multiple matches", () => {
    expect(() => formatAXQueryGuiml(tree, "Button", "only")).toThrow("Expected exactly one AX match, got 2. Candidates:");
  });

  test("all renders one merged GUIML tree for all matches", () => {
    const result = formatAXQueryGuiml(tree, "Button", "all");

    expect(result).toContain("First");
    expect(result).toContain("Second");
    expect((result.match(/<AXApplication/g) || []).length).toBe(1);
    expect(result).not.toContain("\n\n<AXApplication");
  });

  test("each renders one GUIML tree per match", () => {
    const result = formatAXQueryGuiml(tree, "Button", "each");

    expect(result).toContain("First");
    expect(result).toContain("Second");
    expect((result.match(/<AXApplication/g) || []).length).toBe(2);
    expect(result).toContain("\n\n<AXApplication");
  });

  test("all preserves duplicate unlabeled sibling leaves", () => {
    const duplicateTree = {
      role: "AXApplication",
      children: [
        {
          role: "AXWindow",
          children: [
            {
              role: "AXButton",
              frame: { x: 10, y: 10, width: 20, height: 20 },
            },
            {
              role: "AXButton",
              frame: { x: 40, y: 10, width: 20, height: 20 },
            },
          ],
        },
      ],
    } satisfies AXNode;

    const result = formatAXQueryGuiml(duplicateTree, "Button", "all");

    expect((result.match(/<AXButton/g) || []).length).toBe(2);
    expect(result).not.toContain("\n\n<AXApplication");
  });

  test("@@ unroots matches from their parents", () => {
    const result = formatAXQueryGuiml(tree, "@@Button", "each");

    expect(result).toContain("<AXButton#First />");
    expect(result).toContain("<AXButton#Second />");
    expect(result).not.toContain("<AXApplication");
    expect(result).not.toContain("<AXWindow");
    expect(result).not.toContain("<AXSplitGroup");
    expect(result).toContain("\n\n<AXButton#Second />");
  });

  test("leaf query output does not leak matched node descendants", () => {
    const nestedTree = {
      role: "AXApplication",
      children: [
        {
          role: "AXWindow",
          children: [
            {
              role: "AXButton",
              title: "Parent",
              children: [
                {
                  role: "AXGroup",
                  children: [
                    { role: "AXImage", title: "Decorative child" },
                  ],
                },
              ],
            },
          ],
        },
      ],
    } satisfies AXNode;

    const result = formatAXQueryGuiml(nestedTree, "Button", "each");

    expect(result).toContain("<AXButton#Parent />");
    expect(result).not.toContain("AXGroup");
    expect(result).not.toContain("AXImage");
  });

  test("merges matches across multiple application trees", () => {
    const otherTree = {
      role: "AXApplication",
      title: "Finder",
      children: [
        {
          role: "AXWindow",
          children: [
            { role: "AXButton", title: "Finder Button", frame: { x: 100, y: 50, width: 20, height: 20 } },
          ],
        },
      ],
    } satisfies AXNode;

    const result = formatAXQueryGuimlAcrossTrees([tree, otherTree], "Button", "each");

    expect(result).toContain("First");
    expect(result).toContain("Second");
    expect(result).toContain("Finder Button");
  });
});

describe("AX query shared selection semantics", () => {
  const tree = {
    role: "AXApplication",
    title: "Terminal",
    children: [
      {
        role: "AXWindow",
        title: "Main",
        children: [
          {
            role: "AXButton",
            title: "Parent",
            frame: { x: 10, y: 10, width: 20, height: 20 },
            children: [{ role: "AXImage", title: "Icon" }],
          },
          {
            role: "AXButton",
            title: "Second",
            frame: { x: 40, y: 10, width: 20, height: 20 },
          },
        ],
      },
    ],
  } satisfies AXNode;

  test("@@ only changes GUIML ancestry, not JSON match count", () => {
    const rooted = serializeAXQueryMatches([{ pid: 321, tree }], "Button", "each");
    const unrooted = serializeAXQueryMatches([{ pid: 321, tree }], "@@Button", "each");

    expect(rooted).toHaveLength(2);
    expect(unrooted).toHaveLength(2);
    expect(rooted[0].node._tag).toBe("AXButton");
    expect(unrooted[0].node._tag).toBe("AXButton");
  });

  test("serialized JSON matches preserve canonical leaf shaping", () => {
    const matches = serializeAXQueryMatches([{ pid: 321, tree }], "Button", "each");

    expect(matches[0].node._tag).toBe("AXButton");
    expect(matches[0].node._children).toBeUndefined();
    expect(matches[0].target?.role).toBe("AXButton");
  });

  test("serialized JSON matches support [*] introspection", () => {
    const matches = serializeAXQueryMatches([{ pid: 321, tree }], "Button[*]", "each");

    expect(matches).toHaveLength(2);
    expect(matches[0].node).toEqual(expect.objectContaining({ _tag: "AXButton", _id: "Parent", title: true }));
    expect(matches[1].node).toEqual(expect.objectContaining({ _tag: "AXButton", _id: "Second", title: true }));
    expect(matches[0].target?.role).toBe("AXButton");
    expect(matches[1].target?.role).toBe("AXButton");
  });

  test("serialized JSON matches support hybrid [title,*] projection", () => {
    const matches = serializeAXQueryMatches([{ pid: 321, tree }], "Button[title,*]", "each");

    expect(matches).toHaveLength(2);
    expect(matches[0].node).toEqual(expect.objectContaining({
      _tag: "AXButton",
      _id: "Parent",
      title: "Parent",
      frame: true,
    }));
    expect(Object.keys(matches[0].node)).toEqual([
      "_tag",
      "_id",
      "_frame",
      "_displayName",
      "title",
      "_projectedAttrs",
      "frame",
    ]);
    expect(matches[0].target?.role).toBe("AXButton");
  });

  test("serialized JSON matches support [**] introspection", () => {
    const matches = serializeAXQueryMatches([{ pid: 321, tree }], "Button[**]", "each");

    expect(matches).toHaveLength(2);
    expect(matches[0].node).toEqual(expect.objectContaining({ _tag: "AXButton", _id: "Parent", title: "Parent" }));
    expect(matches[1].node).toEqual(expect.objectContaining({ _tag: "AXButton", _id: "Second", title: "Second" }));
    expect(matches[0].target?.role).toBe("AXButton");
    expect(matches[1].target?.role).toBe("AXButton");
  });

  test("serialized transparent queries keep every emitted rootless node", () => {
    const tree = {
      role: "AXApplication",
      title: "TextEdit",
      children: [
        {
          role: "AXWindow",
          title: "Main",
          children: [
            { role: "AXRadioButton", title: "Left", subrole: "AXSegment", actions: ["AXPress"], frame: { x: 10, y: 10, width: 20, height: 20 } },
            { role: "AXRadioButton", title: "Center", subrole: "AXSegment", actions: ["AXPress"], frame: { x: 40, y: 10, width: 20, height: 20 } },
          ],
        },
      ],
    } satisfies AXNode;

    const matches = serializeAXQueryMatches([{ pid: 321, tree }], "@@Window { @@RadioButton[subrole,actions] }", "each");

    expect(matches).toHaveLength(2);
    expect(matches.map(({ node }) => node._tag)).toEqual(["AXRadioButton", "AXRadioButton"]);
    expect(matches.map(({ target }) => target?.role)).toEqual(["AXRadioButton", "AXRadioButton"]);
  });

  test("serialized JSON matches accept both prefixed and unprefixed tags", () => {
    expect(serializeAXQueryMatches([{ pid: 321, tree }], "Application", "first")).toHaveLength(1);
    expect(serializeAXQueryMatches([{ pid: 321, tree }], "AXApplication", "first")).toHaveLength(1);
  });

  test("structured JSON targets the actionable leaf rather than the wrapper root", () => {
    const structuredTree = {
      role: "AXApplication",
      title: "Terminal",
      children: [
        {
          role: "AXWindow",
          title: "Main",
          children: [
            {
              role: "AXButton",
              title: "Save",
              frame: { x: 10, y: 10, width: 20, height: 20 },
            },
          ],
        },
      ],
    } satisfies AXNode;

    const matches = serializeAXQueryMatches([{ pid: 321, tree: structuredTree }], "Window { Button#Save }", "each");

    expect(matches).toHaveLength(1);
    expect(matches[0].node._tag).toBe("AXWindow");
    expect(matches[0].target?.role).toBe("AXButton");
    expect(matches[0].target?.title).toBe("Save");
  });

  test("deeply nested structured JSON still targets the actionable leaf", () => {
    const deepTree = {
      role: "AXApplication",
      title: "Terminal",
      children: [
        {
          role: "AXWindow",
          title: "Main",
          children: [
            {
              role: "AXGroup",
              children: [
                {
                  role: "AXButton",
                  title: "Save",
                  frame: { x: 20, y: 20, width: 20, height: 20 },
                },
              ],
            },
          ],
        },
      ],
    } satisfies AXNode;

    const matches = serializeAXQueryMatches([{ pid: 321, tree: deepTree }], "Application { Window { Group { Button#Save } } }", "each");

    expect(matches).toHaveLength(1);
    expect(matches[0].node._tag).toBe("AXApplication");
    expect(matches[0].target?.role).toBe("AXButton");
    expect(matches[0].target?.title).toBe("Save");
  });
});

describe("AX query scope parsing", () => {
  test("requires exactly one scope selector", () => {
    expect(() => extractAXQueryScope(["Button"])).toThrow([
      "Choose exactly one scope selector:",
      "  --gui",
      "  --visible",
      "  --focused",
      "  --pid <pid>",
      "  --app <bundle|name>",
      "  --all",
    ].join("\n"));
    expect(() => extractAXQueryScope(["--focused", "--pid", "123", "Button"])).toThrow([
      "Choose exactly one scope selector:",
      "  --gui",
      "  --visible",
      "  --focused",
      "  --pid <pid>",
      "  --app <bundle|name>",
      "  --all",
    ].join("\n"));
  });

  test("extracts app scope and leaves the query intact", () => {
    const args = ["--app", "Terminal", "Window", "{", "Button", "}"];

    const scope = extractAXQueryScope(args);

    expect(scope).toEqual({ kind: "app", app: "Terminal" });
    expect(args).toEqual(["Window", "{", "Button", "}"]);
  });

  test("extracts all scope and leaves the query intact", () => {
    const args = ["--all", "Button"];

    const scope = extractAXQueryScope(args);

    expect(scope).toEqual({ kind: "all" });
    expect(args).toEqual(["Button"]);
  });
});

describe("AX query app resolution", () => {
  const apps: RawWorkspaceApp[] = [
    { pid: 101, bundleId: "com.apple.Terminal", name: "Terminal" },
    { pid: 202, bundleId: "com.apple.finder", name: "Finder" },
    { pid: 303, bundleId: "com.microsoft.VSCode", name: "Visual Studio Code" },
  ];

  test("matches exact bundle id before name", () => {
    expect(resolveAXQueryApp(apps, "com.apple.Terminal").pid).toBe(101);
  });

  test("matches exact name case-insensitively", () => {
    expect(resolveAXQueryApp(apps, "finder").pid).toBe(202);
  });

  test("matches a unique substring", () => {
    expect(resolveAXQueryApp(apps, "VSCode").pid).toBe(303);
  });

  test("rejects ambiguous matches", () => {
    expect(() => resolveAXQueryApp(apps, "com.apple")).toThrow("matched multiple apps");
  });
});

describe("AX query focused scope", () => {
  test("resolves through the native frontmost pid endpoint", async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push(url);
      if (url.includes("/api/raw/ax/frontmost-pid")) {
        return new Response("321", {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/api/ax/snapshot") && url.includes("pid=321")) {
        return new Response(JSON.stringify({
          role: "AXApplication",
          title: "Terminal",
          children: [{ role: "AXWindow", title: "Main" }],
        }), {
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;

    try {
      const guiml = await renderAXQueryGuimlForScope({ kind: "focused" }, "Application", "first");
      expect(guiml).toContain("<AXApplication");
      expect(calls).toContain("http://localhost:7861/api/raw/ax/frontmost-pid");
      expect(calls).toContain("http://localhost:7861/api/ax/snapshot?depth=1000&pid=321");
      expect(calls.some((url) => url.includes("/api/raw/ws/frontmost"))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("AX target formatting and parsing", () => {
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

  test("formatAXTargets renders readable target output", () => {
    const result = formatAXTargets([target]);
    expect(result).toContain("AXButton");
    expect(result).toContain("pid=4321");
    expect(result).toContain("point=(140,120)");
    expect(result).toContain('title="Save"');
  });

  test("parseAXTargetStream accepts NDJSON payloads", () => {
    const parsed = parseAXTargetStream(`${JSON.stringify(target)}\n${JSON.stringify({ ...target, point: { x: 141, y: 121 } })}\n`);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].pid).toBe(4321);
    expect(parsed[1].point.x).toBe(141);
  });

  test("parseAXTargetStream extracts nested targets from AX query matches", () => {
    const match: AXQueryMatch = {
      type: "ax.query-match",
      pid: 4321,
      node: { _tag: "AXButton", _id: "Save" },
      target,
    };

    const parsed = parseAXTargetStream(JSON.stringify(match));

    expect(parsed).toEqual([target]);
  });

  test("parseAXTargetPayload accepts raw target JSON", () => {
    expect(parseAXTargetPayload(JSON.stringify(target), "ax click")).toEqual(target);
  });

  test("parseAXTargetPayload accepts serialized AX query matches", () => {
    const match: AXQueryMatch = {
      type: "ax.query-match",
      pid: 4321,
      node: { _tag: "AXButton", _id: "Save" },
      target,
    };

    expect(parseAXTargetPayload(JSON.stringify(match), "ax click")).toEqual(target);
  });

  test("parseAXScopePayload unwraps ax.cursor payloads into pid and target", () => {
    const cursor: AXCursor = {
      type: "ax.cursor",
      target,
      selection: { location: 4, length: 0 },
    };

    expect(parseAXScopePayload(JSON.stringify(cursor), "ax query")).toEqual({
      kind: "cursor",
      cursor,
      pid: 4321,
      target,
    });
  });
});

describe("AX mutator requests", () => {
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

  const match: AXQueryMatch = {
    type: "ax.query-match",
    pid: 4321,
    node: { _tag: "AXButton", _id: "Save" },
    target,
  };

  test("fetchAXQueryMatches posts to the server-side resolver", async () => {
    const { calls, restore } = mockFetch([match]);
    try {
      const result = await fetchAXQueryMatches("Button#Save", { kind: "pid", pid: 4321 });
      expect(result).toEqual([match]);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("http://localhost:7861/api/ax/query");
      expect(calls[0].init?.method).toBe("POST");
      expect(calls[0].init?.body).toBe(JSON.stringify({ query: "Button#Save", pid: 4321 }));
    } finally {
      restore();
    }
  });

  test("fetchAXQueryMatches posts cardinality to the server-side resolver", async () => {
    const { calls, restore } = mockFetch([match]);
    try {
      const result = await fetchAXQueryMatches("Button#Save", { kind: "pid", pid: 4321 }, "first");
      expect(result).toEqual([match]);
      expect(calls).toHaveLength(1);
      expect(JSON.parse(String(calls[0].init?.body))).toEqual({ query: "Button#Save", pid: 4321, cardinality: "first" });
    } finally {
      restore();
    }
  });

  test("fetchAXQueryMatches posts all-scope queries to the server-side resolver", async () => {
    const { calls, restore } = mockFetch([match]);
    try {
      const result = await fetchAXQueryMatches("Button", { kind: "all" }, "each");
      expect(result).toEqual([match]);
      expect(calls).toHaveLength(1);
      expect(JSON.parse(String(calls[0].init?.body))).toEqual({ query: "Button", all: true, cardinality: "each" });
    } finally {
      restore();
    }
  });

  test("fetchAXQueryMatches posts explicit merged cardinality to the server-side resolver", async () => {
    const { calls, restore } = mockFetch([match]);
    try {
      const result = await fetchAXQueryMatches("Button", { kind: "all" }, "all");
      expect(result).toEqual([match]);
      expect(calls).toHaveLength(1);
      expect(JSON.parse(String(calls[0].init?.body))).toEqual({ query: "Button", all: true, cardinality: "all" });
    } finally {
      restore();
    }
  });

  test("fetchAXQueryMatches sends introspection queries to the server-side resolver unchanged", async () => {
    const { calls, restore } = mockFetch([match]);
    try {
      const result = await fetchAXQueryMatches("Button[**]", { kind: "pid", pid: 4321 }, "each");
      expect(result).toEqual([match]);
      expect(calls).toHaveLength(1);
      expect(JSON.parse(String(calls[0].init?.body))).toEqual({ query: "Button[**]", pid: 4321, cardinality: "each" });
    } finally {
      restore();
    }
  });

  test("fetchAXQueryMatches rejects stale HTML responses with a useful error", async () => {
    const { restore } = mockTextFetch("<!doctype html><html><body>fallback</body></html>", 404);
    try {
      await expect(fetchAXQueryMatches("Button", { kind: "focused" })).rejects.toThrow("AX query failed (404)");
      await expect(fetchAXQueryMatches("Button", { kind: "focused" })).rejects.toThrow("HTML fallback page");
    } finally {
      restore();
    }
  });

  test("fetchAXQueryTargets still extracts targets from serialized matches", async () => {
    const { restore } = mockFetch([match]);
    try {
      expect(await fetchAXQueryTargets("Button#Save", { kind: "pid", pid: 4321 })).toEqual([target]);
    } finally {
      restore();
    }
  });

  test("selectAXQueryMatches applies cardinality before target materialization", () => {
    const first = { role: "AXButton", frame: { x: 0, y: 0, width: 10, height: 10 } };
    const second = { role: "AXStaticText" };

    expect(selectAXQueryMatches([first, second], "first")).toEqual([first]);
    expect(() => selectAXQueryMatches([first, second], "only")).toThrow("Expected exactly one AX match, got 2");
    expect(selectAXQueryMatches([first, second], "all")).toEqual([first, second]);
    expect(selectAXQueryMatches([], "first")).toEqual([]);
  });

  test("axType targets an explicit pid when provided", async () => {
    const { calls, restore } = mockFetch({ ok: true });
    try {
      await axType("Ada", "Name", "AXTextField", undefined, 4321);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("http://localhost:7861/api/ax/action");
      expect(calls[0].init?.method).toBe("POST");
      expect(calls[0].init?.body).toBe(JSON.stringify({
        method: "type",
        value: "Ada",
        label: "Name",
        role: "AXTextField",
        nth: undefined,
        parent: undefined,
        target: "pid:4321",
      }));
    } finally {
      restore();
    }
  });

  test("axPerform posts pid to the dedicated route", async () => {
    const { calls, restore } = mockFetch({ ok: true });
    try {
      await axPerform("AXPress", "Save", "AXButton", undefined, 4321);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("http://localhost:7861/api/ax/perform");
      expect(calls[0].init?.method).toBe("POST");
      expect(calls[0].init?.body).toBe(JSON.stringify({
        action: "AXPress",
        label: "Save",
        role: "AXButton",
        pid: 4321,
      }));
    } finally {
      restore();
    }
  });

  test("axFocus posts pid to the dedicated route", async () => {
    const { calls, restore } = mockFetch({ ok: true });
    try {
      await axFocus("Search", "AXTextField", undefined, 4321);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("http://localhost:7861/api/ax/focus");
      expect(calls[0].init?.method).toBe("POST");
      expect(calls[0].init?.body).toBe(JSON.stringify({
        label: "Search",
        role: "AXTextField",
        pid: 4321,
      }));
    } finally {
      restore();
    }
  });

  test("target-based AX actions post structured targets", async () => {
    const { calls, restore } = mockFetch({ ok: true });
    try {
      await axClickTarget(target);
      await axHoverTarget(target);
      await axTypeTarget("Ada", target);
      await axTypeCursor("Grace", {
        type: "ax.cursor",
        target,
        selection: { location: 3, length: 1 },
      });
      await axPerformTarget("AXPress", target);
      expect(calls).toHaveLength(5);
      expect(calls[0].url).toBe("http://localhost:7861/api/ax/action");
      expect(calls[0].init?.body).toBe(JSON.stringify({
        method: "click",
        target,
      }));
      expect(calls[1].url).toBe("http://localhost:7861/api/ax/action");
      expect(calls[1].init?.body).toBe(JSON.stringify({
        method: "hover",
        target,
      }));
      expect(calls[2].url).toBe("http://localhost:7861/api/ax/action");
      expect(calls[2].init?.body).toBe(JSON.stringify({
        method: "type",
        value: "Ada",
        target,
      }));
      expect(calls[3].url).toBe("http://localhost:7861/api/ax/action");
      expect(calls[3].init?.body).toBe(JSON.stringify({
        method: "type",
        value: "Grace",
        target: {
          type: "ax.cursor",
          target,
          selection: { location: 3, length: 1 },
        },
      }));
      expect(calls[4].url).toBe("http://localhost:7861/api/ax/perform");
      expect(calls[4].init?.body).toBe(JSON.stringify({
        action: "AXPress",
        target,
      }));
    } finally {
      restore();
    }
  });

  test("target-based AX actions reject stale HTML fallback responses with a useful error", async () => {
    const { restore } = mockTextFetch("<!doctype html><html><body>fallback</body></html>", 500);
    try {
      await expect(axTypeTarget("Ada", target)).rejects.toThrow("AX action failed (500)");
      await expect(axTypeTarget("Ada", target)).rejects.toThrow("HTML fallback page");
    } finally {
      restore();
    }
  });

  test("fetchAXActionsTarget posts structured targets to the actions route", async () => {
    const { calls, restore } = mockFetch(["AXPress", "AXShowMenu"]);
    try {
      const result = await fetchAXActionsTarget(target);
      expect(result).toEqual(["AXPress", "AXShowMenu"]);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("http://localhost:7861/api/ax/actions");
      expect(calls[0].init?.method).toBe("POST");
      expect(calls[0].init?.body).toBe(JSON.stringify({ target }));
    } finally {
      restore();
    }
  });

  test("fetchAXCursor reads the cursor payload from the daemon", async () => {
    const cursor: AXCursor = {
      type: "ax.cursor",
      target,
      selection: { location: 8, length: 0 },
    };
    const { calls, restore } = mockFetch(cursor);
    try {
      expect(await fetchAXCursor()).toEqual(cursor);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("http://localhost:7861/api/ax/cursor");
    } finally {
      restore();
    }
  });

  test("axFocusWindowTarget posts a focus-window action for an AX target payload", async () => {
    const { calls, restore } = mockFetch({ ok: true });
    try {
      await axFocusWindowTarget(target);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("http://localhost:7861/api/ax/focus-window");
      expect(calls[0].init?.method).toBe("POST");
      expect(calls[0].init?.body).toBe(JSON.stringify({
        target,
      }));
    } finally {
      restore();
    }
  });

  test("axSelectCursor posts a selection-only action for a cursor payload", async () => {
    const cursor: AXCursor = {
      type: "ax.cursor",
      target,
      selection: { location: 3, length: 1 },
    };
    const { calls, restore } = mockFetch({ ok: true });
    try {
      await axSelectCursor(cursor);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("http://localhost:7861/api/ax/action");
      expect(calls[0].init?.method).toBe("POST");
      expect(calls[0].init?.body).toBe(JSON.stringify({
        method: "select",
        target: cursor,
      }));
    } finally {
      restore();
    }
  });

  test("fetchAXCursor rejects stale HTML responses with a useful error", async () => {
    const { restore } = mockTextFetch("<!doctype html><html><body>stale app</body></html>");
    try {
      await expect(fetchAXCursor()).rejects.toThrow("AX cursor returned non-JSON response");
      await expect(fetchAXCursor()).rejects.toThrow("stale");
    } finally {
      restore();
    }
  });

  test("axFocus rejects stale HTML fallback responses with a useful error", async () => {
    const { restore } = mockTextFetch("<!doctype html><html><body>fallback</body></html>", 500);
    try {
      await expect(axFocus("Search", "AXTextField", undefined, 4321)).rejects.toThrow("AX focus failed (500)");
      await expect(axFocus("Search", "AXTextField", undefined, 4321)).rejects.toThrow("HTML fallback page");
    } finally {
      restore();
    }
  });

  test("axPerform rejects stale HTML fallback responses with a useful error", async () => {
    const { restore } = mockTextFetch("<!doctype html><html><body>fallback</body></html>", 500);
    try {
      await expect(axPerform("AXPress", "Save", "AXButton", undefined, 4321)).rejects.toThrow("AX perform failed (500)");
      await expect(axPerform("AXPress", "Save", "AXButton", undefined, 4321)).rejects.toThrow("HTML fallback page");
    } finally {
      restore();
    }
  });
});
