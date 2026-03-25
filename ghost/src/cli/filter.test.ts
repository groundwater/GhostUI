import { describe, test, expect } from "bun:test";
import { findMatchedNodeWithContext, materializeSelectedMatches, selectForestMatchesWithCardinality } from "./filter.js";
import { parseQuery } from "./query.js";
import { toGUIML } from "./guiml.js";
import type { PlainNode } from "./types.js";

type TruncatedNode = PlainNode & { _truncatedCount?: number };

/**
 * Regression test for #76: scoped queries like `Outline:0 { TextField:0 }`
 * must resolve to the TextField *inside* the Outline, not the first global
 * TextField (e.g. a search field earlier in the tree).
 */
describe("findMatchedNodeWithContext — scoped query resolution (#76)", () => {
  // Build a tree that mirrors a generic Finder-like app layout:
  //   Root
  //   └── Application (com.apple.finder)
  //       └── Window
  //           ├── Toolbar
  //           │   └── TextField (search field) — id: "TextField::0"
  //           └── Outline
  //               └── Cell
  //                   └── TextField (reminder title) — id: "TextField::1"
  const tree: PlainNode = {
    _tag: "Root",
    _children: [
      {
        _tag: "Application",
        _id: "app:com.apple.finder",
        bundleId: "com.apple.finder",
        title: "Finder",
        _children: [
          {
            _tag: "Window",
            _id: "Window:Finder:0",
            title: "Finder",
            _children: [
              {
                _tag: "Toolbar",
                _id: "Toolbar::0",
                _children: [
                  {
                    _tag: "TextField",
                    _id: "TextField::0",
                  },
                ],
              },
              {
                _tag: "Outline",
                _id: "Outline::0",
                _children: [
                  {
                    _tag: "Cell",
                    _id: "Cell:Incomplete:0",
                    title: "Incomplete",
                    _children: [
                      {
                        _tag: "TextField",
                        _id: "TextField::1",
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  test("Outline:0 { TextField:0 } targets the TextField inside the Outline, not the search field", () => {
    const queries = parseQuery("Outline:0 { TextField:0 }");
    const result = findMatchedNodeWithContext(tree, queries);
    expect(result).not.toBeNull();
    expect(result!.node._id).toBe("TextField::1");
    expect(result!.node._tag).toBe("TextField");
  });

  test("unscoped TextField:0 targets the first global TextField (search field)", () => {
    const queries = parseQuery("TextField:0");
    const result = findMatchedNodeWithContext(tree, queries);
    expect(result).not.toBeNull();
    expect(result!.node._id).toBe("TextField::0");
  });

  test("unscoped TextField:1 targets the second global TextField (reminder field)", () => {
    const queries = parseQuery("TextField:1");
    const result = findMatchedNodeWithContext(tree, queries);
    expect(result).not.toBeNull();
    expect(result!.node._id).toBe("TextField::1");
  });

  test("Cell#Incomplete { TextField:0 } targets the TextField inside the Cell", () => {
    const queries = parseQuery("Cell#Incomplete { TextField:0 }");
    const result = findMatchedNodeWithContext(tree, queries);
    expect(result).not.toBeNull();
    expect(result!.node._id).toBe("TextField::1");
  });

  test("bundleId is resolved from the ancestor path", () => {
    const queries = parseQuery("Outline:0 { TextField:0 }");
    const result = findMatchedNodeWithContext(tree, queries);
    expect(result).not.toBeNull();
    expect(result!.bundleId).toBe("com.apple.finder");
  });

  test("deeply nested scoped query resolves correctly", () => {
    const queries = parseQuery("Window { Outline:0 { Cell#Incomplete { TextField:0 } } }");
    const result = findMatchedNodeWithContext(tree, queries);
    expect(result).not.toBeNull();
    expect(result!.node._id).toBe("TextField::1");
    expect(result!.bundleId).toBe("com.apple.finder");
  });
});

/**
 * Regression test for #166: identifiers with spaces must work with
 * both double-quoted and single-quoted syntax.
 */
describe("findMatchedNodeWithContext — quoted identifiers with spaces (#166)", () => {
  const tree: PlainNode = {
    _tag: "Root",
    _children: [
      {
        _tag: "Application",
        _id: "app:com.apple.finder",
        bundleId: "com.apple.finder",
        _children: [
          {
            _tag: "Window",
            _id: "Window:Finder:0",
            _children: [
              {
                _tag: "Sidebar",
                _id: "Sidebar::0",
                _children: [
                  { _tag: "ListItem", _id: "ListItem:iCloud Drive:0", title: "iCloud Drive" },
                  { _tag: "ListItem", _id: "ListItem:Desktop:1", title: "Desktop" },
                  { _tag: "ListItem", _id: "ListItem:My Shared Files:2", title: "My Shared Files" },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  test('double-quoted id: ListItem#"iCloud Drive"', () => {
    const queries = parseQuery('ListItem#"iCloud Drive"');
    expect(queries).toEqual([{ tag: "ListItem", id: "iCloud Drive" }]);
    const result = findMatchedNodeWithContext(tree, queries);
    expect(result).not.toBeNull();
    expect(result!.node._id).toBe("ListItem:iCloud Drive:0");
  });

  test("single-quoted id: ListItem#'iCloud Drive'", () => {
    const queries = parseQuery("ListItem#'iCloud Drive'");
    expect(queries).toEqual([{ tag: "ListItem", id: "iCloud Drive" }]);
    const result = findMatchedNodeWithContext(tree, queries);
    expect(result).not.toBeNull();
    expect(result!.node._id).toBe("ListItem:iCloud Drive:0");
  });

  test('double-quoted id with index: ListItem#"iCloud Drive":0', () => {
    const queries = parseQuery('ListItem#"iCloud Drive":0');
    expect(queries).toEqual([{ tag: "ListItem", id: "iCloud Drive", index: 0 }]);
    const result = findMatchedNodeWithContext(tree, queries);
    expect(result).not.toBeNull();
    expect(result!.node._id).toBe("ListItem:iCloud Drive:0");
  });

  test("single-quoted id with index: ListItem#'iCloud Drive':0", () => {
    const queries = parseQuery("ListItem#'iCloud Drive':0");
    expect(queries).toEqual([{ tag: "ListItem", id: "iCloud Drive", index: 0 }]);
    const result = findMatchedNodeWithContext(tree, queries);
    expect(result).not.toBeNull();
    expect(result!.node._id).toBe("ListItem:iCloud Drive:0");
  });

  test('multi-word id: ListItem#"My Shared Files"', () => {
    const queries = parseQuery('ListItem#"My Shared Files"');
    expect(queries).toEqual([{ tag: "ListItem", id: "My Shared Files" }]);
    const result = findMatchedNodeWithContext(tree, queries);
    expect(result).not.toBeNull();
    expect(result!.node._id).toBe("ListItem:My Shared Files:2");
  });

  test("simple id without spaces still works", () => {
    const queries = parseQuery("ListItem#Desktop");
    expect(queries).toEqual([{ tag: "ListItem", id: "Desktop" }]);
    const result = findMatchedNodeWithContext(tree, queries);
    expect(result).not.toBeNull();
    expect(result!.node._id).toBe("ListItem:Desktop:1");
  });

  test("scoped quoted id: Sidebar { ListItem#'iCloud Drive' }", () => {
    const queries = parseQuery("Sidebar { ListItem#'iCloud Drive' }");
    const result = findMatchedNodeWithContext(tree, queries);
    expect(result).not.toBeNull();
    expect(result!.node._id).toBe("ListItem:iCloud Drive:0");
  });
});

// ─── bfsFirst ─────────────────────────────────────────────────────

import { bfsFirst, filterTree, collectObscuredApps } from "./filter.js";

describe("bfsFirst", () => {
  test("truncation at N nodes", () => {
    const tree: PlainNode = {
      _tag: "Window",
      _children: [
        { _tag: "Button", _id: "Button:A:0" },
        { _tag: "Button", _id: "Button:B:1" },
        { _tag: "Button", _id: "Button:C:2" },
      ],
    };
    const result = bfsFirst([tree], 2);
    // Should keep Window + 1 button (BFS order: Window first, then children)
    expect(result.length).toBe(1);
    const win = result[0];
    // Window is kept, but only 1 child fits (2 total: Window + Button:A)
    const keptChildren = win._children!.filter(c => c._tag !== "_truncated");
    expect(keptChildren.length).toBe(1);
    expect(keptChildren[0]._id).toBe("Button:A:0");
    // Should have a truncation marker
    const truncated = win._children!.find(c => c._tag === "_truncated");
    expect(truncated).toBeDefined();
  });

  test("correct BFS order", () => {
    const tree: PlainNode = {
      _tag: "Root",
      _children: [
        {
          _tag: "A",
          _children: [{ _tag: "A1" }, { _tag: "A2" }],
        },
        {
          _tag: "B",
          _children: [{ _tag: "B1" }],
        },
      ],
    };
    // BFS: Root, A, B, A1, A2, B1
    const result = bfsFirst([tree], 4);
    // Should keep Root, A, B, A1 (4 nodes)
    const root = result[0];
    expect(root._children!.length).toBe(2); // A, B both kept
    const a = root._children![0];
    // A has 1 kept child + truncation marker
    const aKept = a._children!.filter(c => c._tag !== "_truncated");
    expect(aKept.length).toBe(1);
    expect(aKept[0]._tag).toBe("A1");
  });

  test("marker with dropped count", () => {
    const tree: PlainNode = {
      _tag: "List",
      _children: [
        { _tag: "Item" },
        { _tag: "Item" },
        { _tag: "Item" },
      ],
    };
    const result = bfsFirst([tree], 2);
    const list = result[0];
    const marker = list._children!.find(c => c._tag === "_truncated");
    expect(marker).toBeDefined();
    expect((marker as TruncatedNode)._truncatedCount).toBe(2);
  });
});

// ─── Wildcard queries ─────────────────────────────────────────────

describe("filterTree — wildcard queries", () => {
  const tree: PlainNode = {
    _tag: "Root",
    _children: [
      {
        _tag: "Application",
        _id: "app:com.test",
        bundleId: "com.test",
        _children: [
          {
            _tag: "Window",
            _id: "Window:Main:0",
            title: "Main",
            _children: [
              { _tag: "Button", _id: "Button:Save:0", title: "Save" },
              { _tag: "TextField", _id: "TextField::0", placeholder: "Search" },
            ],
          },
        ],
      },
    ],
  };

  test("** returns full subtree", () => {
    const queries = parseQuery("**");
    const result = filterTree(tree, queries);
    expect(result.matchCount).toBe(1);
  });

  test("* matches any tag", () => {
    const queries = parseQuery("*");
    const result = filterTree(tree, queries);
    // * matches Root (the first/only root node)
    expect(result.matchCount).toBe(1);
  });

  test("Window // * returns all descendants, not just immediate children", () => {
    const nestedTree: PlainNode = {
      _tag: "Root",
      _children: [
        {
          _tag: "Application",
          _id: "app:com.test",
          _children: [
            {
              _tag: "Window",
              _id: "Window:Main:0",
              _children: [
                {
                  _tag: "Toolbar",
                  _id: "Toolbar::0",
                  _children: [
                    { _tag: "Button", _id: "Button:Save:0", title: "Save" },
                  ],
                },
                { _tag: "Group", _id: "Group::0" },
              ],
            },
          ],
        },
      ],
    };

    const result = filterTree(nestedTree, parseQuery("Window // *"));
    const guiml = toGUIML(result.nodes);

    expect(result.matchCount).toBe(1);
    expect(guiml).toContain("<Toolbar#0>");
    expect(guiml).toContain("<Button#Save />");
    expect(guiml).toContain("<Group#0 />");
  });

  test("Window { * } (brace syntax) behaves identically to Window // *", () => {
    const nestedTree: PlainNode = {
      _tag: "Root",
      _children: [
        {
          _tag: "Application",
          _id: "app:com.test",
          _children: [
            {
              _tag: "Window",
              _id: "Window:Main:0",
              _children: [
                {
                  _tag: "Toolbar",
                  _id: "Toolbar::0",
                  _children: [
                    { _tag: "Button", _id: "Button:Save:0", title: "Save" },
                  ],
                },
                { _tag: "Group", _id: "Group::0" },
              ],
            },
          ],
        },
      ],
    };

    const result = filterTree(nestedTree, parseQuery("Window { * }"));
    const guiml = toGUIML(result.nodes);

    expect(result.matchCount).toBe(1);
    expect(guiml).toContain("<Toolbar#0>");
    expect(guiml).toContain("<Button#Save />");
    expect(guiml).toContain("<Group#0 />");
  });

  test("Window / * (direct-child operator) still returns only immediate children", () => {
    const nestedTree: PlainNode = {
      _tag: "Root",
      _children: [
        {
          _tag: "Application",
          _id: "app:com.test",
          _children: [
            {
              _tag: "Window",
              _id: "Window:Main:0",
              _children: [
                {
                  _tag: "Toolbar",
                  _id: "Toolbar::0",
                  _children: [
                    { _tag: "Button", _id: "Button:Save:0", title: "Save" },
                  ],
                },
                { _tag: "Group", _id: "Group::0" },
              ],
            },
          ],
        },
      ],
    };

    const result = filterTree(nestedTree, parseQuery("Window / *"));
    const guiml = toGUIML(result.nodes);

    // Toolbar and Group are direct children — returned as leaves (no subtree expansion)
    expect(guiml).toContain("<Toolbar#0 />");
    expect(guiml).toContain("<Group#0 />");
    // Button is a grandchild — must NOT appear under direct-child semantics
    expect(guiml).not.toContain("<Button#Save />");
  });
});

describe("materializeSelectedMatches", () => {
  const windowTree: PlainNode = {
    _tag: "Window",
    _id: "Window:Editor:0",
    title: "Editor",
    frame: { x: 20, y: 40, width: 1000, height: 700 },
    _children: [
      {
        _tag: "Button",
        _id: "Button:Run:0",
        title: "Run",
        frame: { x: 100, y: 120, width: 80, height: 28 },
      },
    ],
  };

  test("preserves container attrs for full introspection queries", () => {
    const selection = selectForestMatchesWithCardinality([windowTree], parseQuery("Window[**] { Button }"), "all");
    const [window] = materializeSelectedMatches(selection.matches);

    expect(window.frame).toEqual({ x: 20, y: 40, width: 1000, height: 700 });
    expect(window.title).toBe("Editor");
    expect(window._children?.[0]?._frame).toEqual({ x: 100, y: 120, width: 80, height: 28 });
  });

  test("still strips container attrs for partial introspection queries", () => {
    const selection = selectForestMatchesWithCardinality([windowTree], parseQuery("Window[*] { Button }"), "all");
    const [window] = materializeSelectedMatches(selection.matches);

    expect(window.frame).toBeUndefined();
    expect(window._frame).toBe(true);
    expect(window.title).toBeUndefined();
    expect(window._children?.[0]?._frame).toEqual({ x: 100, y: 120, width: 80, height: 28 });
  });

  test("preserves nested full-introspection child queries without call-site overrides", () => {
    const appTree: PlainNode = {
      _tag: "Application",
      _id: "app:com.example.Codex",
      title: "Codex",
      frame: { x: 10, y: 20, width: 1200, height: 800 },
      _children: [windowTree],
    };

    const selection = selectForestMatchesWithCardinality([appTree], parseQuery("Application#Codex { **[**] }"), "all");
    const [app] = materializeSelectedMatches(selection.matches);
    const window = app._children?.[0];

    expect(window?.frame).toEqual({ x: 20, y: 40, width: 1000, height: 700 });
    expect(window?.title).toBe("Editor");
    expect(window?._children?.[0]?.frame).toEqual({ x: 100, y: 120, width: 80, height: 28 });
  });
});

describe("filterTree — full introspection preservation", () => {
  const tree: PlainNode = {
    _tag: "VATRoot",
    _children: [
      {
        _tag: "Codex",
        _children: [
          {
            _tag: "Window",
            _id: "Window:Editor:0",
            title: "Editor",
            frame: "(20,40,1000,700)",
            _children: [
              {
                _tag: "Button",
                _id: "Button:Run:0",
                title: "Run",
                frame: "(100,120,80,28)",
              },
            ],
          },
        ],
      },
    ],
  };

  function selectedWindow(node: PlainNode): PlainNode | undefined {
    return node._children?.[0]?._children?.[0];
  }

  test("Codex/Window[**] keeps container attrs on the queried VAT subtree", () => {
    const result = filterTree(tree, parseQuery("Codex/Window[**]"));
    const window = selectedWindow(result.nodes[0]!);

    expect(result.matchCount).toBe(1);
    expect(window?.frame).toBe("(20,40,1000,700)");
    expect(window?.title).toBe("Editor");
    expect(window?._children).toBeUndefined();
  });

  test("Codex/Window[*] { Button } still strips container attrs on container windows", () => {
    const result = filterTree(tree, parseQuery("Codex/Window[*] { Button }"));
    const window = selectedWindow(result.nodes[0]!);

    expect(result.matchCount).toBe(1);
    expect(window?.frame).toBeUndefined();
    expect(window?._frame).toBe(true);
    expect(window?.title).toBeUndefined();
    expect(window?._children?.[0]?._frame).toBe("(100,120,80,28)");
  });
});

// ─── Predicate filtering ─────────────────────────────────────────

describe("filterTree — predicate filtering", () => {
  const tree: PlainNode = {
    _tag: "Root",
    _children: [
      {
        _tag: "Application",
        _id: "app:com.test",
        _children: [
          {
            _tag: "Window",
            _id: "Window::0",
            _children: [
              { _tag: "Button", _id: "Button:Save:0", title: "Save", enabled: "true" },
              { _tag: "Button", _id: "Button:Delete:1", title: "Delete", enabled: "false" },
              { _tag: "TextField", _id: "TextField::0", value: "hello world" },
            ],
          },
        ],
      },
    ],
  };

  test("[attr=value] exact match", () => {
    const queries = parseQuery('Button[title=Save]');
    const result = filterTree(tree, queries);
    expect(result.matchCount).toBe(1);
  });

  test("[attr!=value] not equal", () => {
    const queries = parseQuery('Button[title!=Save]');
    const result = filterTree(tree, queries);
    expect(result.matchCount).toBe(1);
  });

  test("[attr~=value] contains", () => {
    const queries = parseQuery('TextField[value~=world]');
    const result = filterTree(tree, queries);
    expect(result.matchCount).toBe(1);
  });

  test("[attr] existence", () => {
    const queries = parseQuery('**[title]');
    const result = filterTree(tree, queries);
    // Button:Save, Button:Delete both have title
    expect(result.matchCount).toBeGreaterThanOrEqual(2);
  });

  test("[title,*] keeps named attrs first, then the remaining attrs", () => {
    const hybridTree: PlainNode = {
      _tag: "Root",
      _children: [
        {
          _tag: "Button",
          _id: "Button:Save:0",
          title: "Save",
          subrole: "AXDefaultButton",
          value: "primary",
        },
      ],
    };

    const result = filterTree(hybridTree, parseQuery("Button[title,*]"));
    expect(result.matchCount).toBe(1);
    expect(result.nodes[0]).toEqual({
      _tag: "Root",
      _children: [{
        _tag: "Button",
        _id: "Button:Save:0",
        _displayName: "Save",
        title: "Save",
        subrole: true,
        value: true,
        _projectedAttrs: ["title", "subrole", "value"],
      }],
    });
    expect(toGUIML(result.nodes)).toContain('<Button#Save title="Save" subrole value />');
  });

  test("[title *] remains invalid and does not match", () => {
    const hybridTree: PlainNode = {
      _tag: "Root",
      _children: [
        {
          _tag: "Button",
          _id: "Button:Save:0",
          title: "Save",
          subrole: "AXDefaultButton",
        },
      ],
    };

    const result = filterTree(hybridTree, parseQuery("Button[title *]"));
    expect(result.matchCount).toBe(0);
    expect(result.nodes).toEqual([]);
  });

  test("deep wildcard predicate does not leak non-matching descendants", () => {
    const tree: PlainNode = {
      _tag: "Root",
      _children: [
        {
          _tag: "Application",
          _id: "app:com.test",
          _children: [
            {
              _tag: "AXWindow",
              _id: "AXWindow:Main:0",
              _children: [
                {
                  _tag: "AXRuler",
                  _id: "AXRuler:0",
                  actions: "AXPress",
                  _children: [
                    { _tag: "AXRulerMarker", _id: "AXRulerMarker:0", actions: "AXDelete", value: "0" },
                    { _tag: "AXRulerMarker", _id: "AXRulerMarker:1", actions: "AXDelete", value: "1" },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const result = filterTree(tree, parseQuery('**[actions=AXPress]'));
    const guiml = toGUIML(result.nodes);

    expect(result.matchCount).toBe(1);
    expect(guiml).toContain('<AXRuler#0 actions="AXPress" />');
    expect(guiml).not.toContain("AXRulerMarker");
    expect(guiml).not.toContain("AXDelete");
  });
});

// ─── nth-child slicing ────────────────────────────────────────────

describe("filterTree — nth-child slicing", () => {
  const tree: PlainNode = {
    _tag: "Root",
    _children: [
      {
        _tag: "Application",
        _id: "app:com.test",
        _children: [
          {
            _tag: "Window",
            _id: "Window::0",
            _children: [
              { _tag: "Button", _id: "Button:A:0", title: "A" },
              { _tag: "Button", _id: "Button:B:1", title: "B" },
              { _tag: "Button", _id: "Button:C:2", title: "C" },
            ],
          },
        ],
      },
    ],
  };

  test(":0 gets first match", () => {
    const queries = parseQuery("Button:0");
    const result = filterTree(tree, queries);
    expect(result.matchCount).toBe(1);
  });

  test(":1:3 gets range", () => {
    const queries = parseQuery("Button:1:3");
    const result = filterTree(tree, queries);
    expect(result.matchCount).toBe(2);
  });

  test("out-of-range returns empty", () => {
    const queries = parseQuery("Button:10");
    const result = filterTree(tree, queries);
    expect(result.matchCount).toBe(0);
  });
});

// ─── Window visibility ───────────────────────────────────────────

describe("filterTree — window visibility", () => {
  test("visual-only windows: queries return no inner matches", () => {
    const tree: PlainNode = {
      _tag: "Root",
      _children: [
        {
          _tag: "Application",
          _id: "app:com.test",
          _children: [
            {
              _tag: "Window",
              _id: "Window:Main:0",
              visualOnly: "true",
              _children: [
                { _tag: "Button", _id: "Button:A:0", title: "A" },
              ],
            },
          ],
        },
      ],
    };
    const queries = parseQuery("Button");
    const result = filterTree(tree, queries);
    expect(result.matchCount).toBe(0);
  });

  test("child queries keep collapsed windows single-wrapped and preserve z once", () => {
    const tree: PlainNode = {
      _tag: "Root",
      _children: [
        {
          _tag: "Application",
          _id: "app:com.apple.Terminal",
          _children: [
            {
              _tag: "Window",
              _id: "Window::0",
              z: "0",
              visualOnly: "true",
              _children: [
                { _tag: "Button", _id: "Button:A:0", title: "A" },
              ],
            },
            {
              _tag: "Window",
              _id: "Window::1",
              z: "1",
              obscured: "80",
              _children: [
                { _tag: "Button", _id: "Button:B:0", title: "B" },
              ],
            },
          ],
        },
      ],
    };

    const { nodes, matchCount } = filterTree(tree, parseQuery("Application#com.apple.Terminal{*[z]{*}}"));
    const guiml = toGUIML(nodes);

    expect(matchCount).toBe(1);
    expect(guiml).toContain('<Window#0 z="0">');
    expect(guiml).toContain("{... deflated}");
    expect(guiml).toContain('<Window#1 z="1">');
    expect(guiml).toContain("{... obscured 80%}");
    expect((guiml.match(/<Window#0 z="0">/g) ?? []).length).toBe(1);
    expect((guiml.match(/<Window#1 z="1">/g) ?? []).length).toBe(1);
    expect(guiml).not.toContain("<Window#0 z=\"0\">\n  <Window#0 z=\"0\">");
    expect(guiml).not.toContain("<Window#1 z=\"1\">\n  <Window#1 z=\"1\">");
  });

  test("obscured >= 50: queries don't descend", () => {
    const tree: PlainNode = {
      _tag: "Root",
      _children: [
        {
          _tag: "Application",
          _id: "app:com.test",
          _children: [
            {
              _tag: "Window",
              _id: "Window:Main:0",
              obscured: "75",
              _children: [
                { _tag: "Button", _id: "Button:A:0", title: "A" },
              ],
            },
          ],
        },
      ],
    };
    const queries = parseQuery("Button");
    const result = filterTree(tree, queries);
    expect(result.matchCount).toBe(0);
  });

  test("obscured with modal is NOT suppressed (#124)", () => {
    const tree: PlainNode = {
      _tag: "Root",
      _children: [
        {
          _tag: "Application",
          _id: "app:com.test",
          _children: [
            {
              _tag: "Window",
              _id: "Window:Main:0",
              obscured: "80",
              _children: [
                { _tag: "Button", _id: "Button:A:0", title: "A" },
                {
                  _tag: "Sheet",
                  _id: "Sheet::0",
                  _children: [
                    { _tag: "Button", _id: "Button:Confirm:0", title: "Confirm" },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    // The Sheet should be queryable even though window is obscured
    const queries = parseQuery("Sheet");
    const result = filterTree(tree, queries);
    expect(result.matchCount).toBe(1);
  });

  test("attr-only child queries do not inject collapsed blocked-window stubs", () => {
    const tree: PlainNode = {
      _tag: "Root",
      _children: [
        {
          _tag: "Application",
          _id: "app:com.test",
          title: "Test App",
          _children: [
            {
              _tag: "Window",
              _id: "Window:Front:0",
              title: "Front",
              z: "0",
              _children: [],
            },
            {
              _tag: "Window",
              _id: "Window:Hidden:1",
              title: "Hidden",
              z: "1",
              obscured: "100",
              _children: [
                { _tag: "Button", _id: "Button:A:0", title: "A" },
              ],
            },
            {
              _tag: "Window",
              _id: "Window:Background:2",
              title: "Background",
              z: "2",
              visualOnly: "true",
              _children: [
                { _tag: "Button", _id: "Button:B:0", title: "B" },
              ],
            },
          ],
        },
      ],
    };

    const { nodes, matchCount } = filterTree(tree, parseQuery("Application{*[z]}"));
    const guiml = toGUIML(nodes);

    expect(matchCount).toBe(1);
    expect(guiml).toContain('<Window#Front z="0" />');
    expect(guiml).toContain('<Window#Hidden z="1" />');
    expect(guiml).toContain('<Window#Background z="2" />');
    expect(guiml).not.toContain("{... obscured");
    expect(guiml).not.toContain("{... deflated}");
  });

  test("expanded child queries preserve projected attrs on container windows", () => {
    const tree: PlainNode = {
      _tag: "Root",
      _children: [
        {
          _tag: "Application",
          _id: "app:com.test",
          title: "Test App",
          _children: [
            {
              _tag: "Window",
              _id: "Window:Front:0",
              title: "Front",
              z: "0",
              _children: [
                { _tag: "Button", _id: "Button:A:0", title: "A" },
              ],
            },
            {
              _tag: "Window",
              _id: "Window:Stub:1",
              title: "Stub",
              z: "1",
              visualOnly: "true",
              _children: [
                { _tag: "Button", _id: "Button:B:0", title: "B" },
              ],
            },
          ],
        },
      ],
    };

    const { nodes } = filterTree(tree, parseQuery("Application{*[z]{*}}"));
    const guiml = toGUIML(nodes);

    expect(guiml).toContain('<Window#Front z="0">');
    expect(guiml).toContain('<Window#Stub z="1">');
    expect(guiml).toContain("{... deflated}");
  });
});

// ─── Modal-aware filtering ────────────────────────────────────────

describe("filterTree — modal-aware filtering", () => {
  test("blocked siblings excluded from search", () => {
    const tree: PlainNode = {
      _tag: "Root",
      _children: [
        {
          _tag: "Application",
          _id: "app:com.test",
          _children: [
            {
              _tag: "Window",
              _id: "Window::0",
              _children: [
                { _tag: "Button", _id: "Button:Behind:0", title: "Behind" },
                {
                  _tag: "Sheet",
                  _id: "Sheet::0",
                  _children: [
                    { _tag: "Button", _id: "Button:SheetBtn:0", title: "SheetBtn" },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    // Only Sheet's button should be found, not the blocked one
    const queries = parseQuery("Button");
    const result = filterTree(tree, queries);
    expect(result.matchCount).toBe(1);
  });
});

// ─── collectObscuredApps ──────────────────────────────────────────

describe("collectObscuredApps", () => {
  test("finds apps with obscured windows", () => {
    const tree: PlainNode = {
      _tag: "Display",
      _children: [
        {
          _tag: "Application",
          _id: "app:com.apple.finder",
          title: "Finder",
          _children: [
            { _tag: "Window", _id: "Window:Docs:0", obscured: "80" },
            { _tag: "Window", _id: "Window:Downloads:1" },
          ],
        },
      ],
    };
    const apps = collectObscuredApps(tree);
    expect(apps.length).toBe(1);
    expect(apps[0].appName).toBe("Finder");
    expect(apps[0].bundleId).toBe("com.apple.finder");
    expect(apps[0].obscuredCount).toBe(1);
  });
});

// ─── @ rename syntax ─────────────────────────────────────────────

describe("parseQuery — @ rename syntax", () => {
  test("foo@bar parses tag rename", () => {
    const q = parseQuery("Window@AXWindow");
    expect(q).toEqual([{ tag: "AXWindow", as: "Window" }]);
  });

  test("foo@bar#id parses tag rename with id", () => {
    const q = parseQuery("App@Application#Terminal");
    expect(q).toEqual([{ tag: "Application", as: "App", id: "Terminal" }]);
  });

  test("foo@bar:0 parses tag rename with index", () => {
    const q = parseQuery("Win@Window:0");
    expect(q).toEqual([{ tag: "Window", as: "Win", index: 0 }]);
  });

  test("[x@y] parses attr rename", () => {
    const q = parseQuery("Button[label@title]");
    expect(q).toEqual([{
      tag: "Button",
      predicates: [{ attr: "title", as: "label", op: "exists" }],
    }]);
  });

  test("[x@y=val] parses attr rename with value filter", () => {
    const q = parseQuery("Button[lang@language=shell]");
    expect(q).toEqual([{
      tag: "Button",
      predicates: [{ attr: "language", as: "lang", op: "=", value: "shell" }],
    }]);
  });

  test("[@y] is suppress (existing behavior)", () => {
    const q = parseQuery("Button[@enabled]");
    expect(q).toEqual([{
      tag: "Button",
      predicates: [{ attr: "enabled", op: "exists", suppress: true }],
    }]);
  });

  test("[@y=val] is suppress with value filter", () => {
    const q = parseQuery("Button[@enabled=true]");
    expect(q).toEqual([{
      tag: "Button",
      predicates: [{ attr: "enabled", op: "=", value: "true", suppress: true }],
    }]);
  });

  test("mixed rename and plain predicates", () => {
    const q = parseQuery("Tab@AXRadioButton[label@title,active@value]");
    expect(q).toEqual([{
      tag: "AXRadioButton",
      as: "Tab",
      predicates: [
        { attr: "title", as: "label", op: "exists" },
        { attr: "value", as: "active", op: "exists" },
      ],
    }]);
  });
});

describe("filterTree — transparent scoped queries", () => {
  test("@Application { AXWindow } omits the Application wrapper", () => {
    const tree: PlainNode = {
      _tag: "Root",
      _children: [
        {
          _tag: "Application",
          _id: "app:com.test",
          title: "Test App",
          _children: [
            {
              _tag: "AXWindow",
              _id: "AXWindow:Main:0",
              title: "Main",
              _children: [
                { _tag: "AXButton", _id: "AXButton:OK:0", title: "OK" },
              ],
            },
          ],
        },
      ],
    };

    const queries = parseQuery("@Application { AXWindow }");
    const result = filterTree(tree, queries);
    const guiml = toGUIML(result.nodes);

    expect(result.matchCount).toBe(1);
    expect(guiml).not.toContain("<Application");
    expect(guiml).toContain("<AXWindow");
  });

  test("Application { @AXWindow { AXButton } } keeps Application but omits AXWindow", () => {
    const tree: PlainNode = {
      _tag: "Root",
      _children: [
        {
          _tag: "Application",
          _id: "app:com.test",
          title: "Test App",
          _children: [
            {
              _tag: "AXWindow",
              _id: "AXWindow:Main:0",
              title: "Main",
              _children: [
                { _tag: "AXButton", _id: "AXButton:OK:0", title: "OK" },
              ],
            },
          ],
        },
      ],
    };

    const queries = parseQuery("Application { @AXWindow { AXButton } }");
    const result = filterTree(tree, queries);
    const guiml = toGUIML(result.nodes);

    expect(result.matchCount).toBe(1);
    expect(guiml).toContain("<Application");
    expect(guiml).toContain("<AXButton#OK");
    expect(guiml).not.toContain("<AXWindow");
  });

  test("transparent scope emits nothing when child queries do not match", () => {
    const tree: PlainNode = {
      _tag: "Root",
      _children: [
        {
          _tag: "Application",
          _id: "app:com.test",
          _children: [
            {
              _tag: "AXWindow",
              _id: "AXWindow:Main:0",
              _children: [
                { _tag: "AXButton", _id: "AXButton:Cancel:0", title: "Cancel" },
              ],
            },
          ],
        },
      ],
    };

    const queries = parseQuery("@Application { AXCheckbox }");
    const result = filterTree(tree, queries);

    expect(result.matchCount).toBe(0);
    expect(result.nodes).toEqual([]);
  });

  test("multiple matches under a transparent scope do not reintroduce the wrapper", () => {
    const tree: PlainNode = {
      _tag: "Root",
      _children: [
        {
          _tag: "Application",
          _id: "app:com.test",
          title: "Test App",
          _children: [
            {
              _tag: "AXWindow",
              _id: "AXWindow:One:0",
              title: "One",
              _children: [
                { _tag: "AXButton", _id: "AXButton:OK:0", title: "OK" },
              ],
            },
            {
              _tag: "AXWindow",
              _id: "AXWindow:Two:1",
              title: "Two",
              _children: [
                { _tag: "AXButton", _id: "AXButton:Apply:0", title: "Apply" },
              ],
            },
          ],
        },
      ],
    };

    const queries = parseQuery("@Application { @AXWindow { AXButton } }");
    const result = filterTree(tree, queries);
    const guiml = toGUIML(result.nodes);

    expect(result.matchCount).toBe(2);
    expect((guiml.match(/<AXButton/g) || []).length).toBe(2);
    expect(guiml).not.toContain("<Application");
    expect(guiml).not.toContain("<AXWindow");
  });

  test("@@Application { AXWindow } omits the Application wrapper and all parents above it", () => {
    const tree: PlainNode = {
      _tag: "Root",
      _children: [
        {
          _tag: "Workspace",
          _id: "Workspace::0",
          _children: [
            {
              _tag: "Application",
              _id: "app:com.test",
              title: "Test App",
              _children: [
                {
                  _tag: "AXWindow",
                  _id: "AXWindow:Main:0",
                  title: "Main",
                },
              ],
            },
          ],
        },
      ],
    };

    const queries = parseQuery("@@Application { AXWindow }");
    const result = filterTree(tree, queries);
    const guiml = toGUIML(result.nodes);

    expect(result.matchCount).toBe(1);
    expect(guiml).toContain("<AXWindow#Main");
    expect(guiml).not.toContain("<Application");
    expect(guiml).not.toContain("<Workspace");
    expect(guiml).not.toContain("<Root");
  });

  test("@@Application preserves descendant hierarchy inside the matched application", () => {
    const tree: PlainNode = {
      _tag: "Root",
      _children: [
        {
          _tag: "Workspace",
          _id: "Workspace::0",
          _children: [
            {
              _tag: "Application",
              _id: "app:com.test",
              title: "Test App",
              _children: [
                {
                  _tag: "AXWindow",
                  _id: "AXWindow:Main:0",
                  title: "Main",
                  _children: [
                    { _tag: "AXButton", _id: "AXButton:OK:0", title: "OK" },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const queries = parseQuery("@@Application { AXWindow { AXButton } }");
    const result = filterTree(tree, queries);
    const guiml = toGUIML(result.nodes);

    expect(result.matchCount).toBe(1);
    expect(guiml).toContain("<AXWindow#Main");
    expect(guiml).toContain("<AXButton#OK");
    expect(guiml).not.toContain("<Application");
    expect(guiml).not.toContain("<Workspace");
    expect(guiml).not.toContain("<Root");
  });

  test("@@** { Button } prints matched descendants without hierarchy", () => {
    const tree: PlainNode = {
      _tag: "Root",
      _children: [
        {
          _tag: "Application",
          _id: "app:com.test",
          title: "Test App",
          _children: [
            {
              _tag: "AXWindow",
              _id: "AXWindow:Main:0",
              title: "Main",
              _children: [
                { _tag: "AXButton", _id: "AXButton:OK:0", title: "OK" },
              ],
            },
          ],
        },
      ],
    };

    const queries = parseQuery("@@{ Button }");
    const result = filterTree(tree, queries);
    const guiml = toGUIML(result.nodes);

    expect(result.matchCount).toBe(1);
    expect(guiml).toContain("<AXButton#OK");
    expect(guiml).not.toContain("<Application");
    expect(guiml).not.toContain("<AXWindow");
    expect(guiml).not.toContain("<Root");
  });

  test("nested @@ / Button searches from the current scope root", () => {
    const tree: PlainNode = {
      _tag: "Root",
      _children: [
        {
          _tag: "Application",
          _id: "app:com.test",
          _children: [
            {
              _tag: "Window",
              _id: "Window:Main:0",
              title: "Main",
              _children: [
                {
                  _tag: "Toolbar",
                  _id: "Toolbar::0",
                  _children: [
                    { _tag: "Button", _id: "Button:Save:0", title: "Save" },
                  ],
                },
                { _tag: "Button", _id: "Button:Close:0", title: "Close" },
              ],
            },
          ],
        },
      ],
    };

    const queries = parseQuery("Application { Window { @@ / Button } }");
    const result = filterTree(tree, queries);
    const guiml = toGUIML(result.nodes);

    expect(result.matchCount).toBe(1);
    expect(guiml).toContain("<Button#Close");
    expect(guiml).not.toContain("Save");
    expect(guiml).not.toContain("<Toolbar");
  });
});

describe("filterTree — @ rename in output", () => {
  const tree: PlainNode = {
    _tag: "Root",
    _children: [
      {
        _tag: "Application",
        _id: "app:com.test",
        _children: [
          {
            _tag: "AXWindow",
            _id: "AXWindow:Main:0",
            title: "Main",
            _children: [
              { _tag: "AXButton", _id: "AXButton:Save:0", title: "Save", enabled: "true" },
              { _tag: "AXRadioButton", _id: "AXRadioButton:Tab1:0", title: "Tab1", value: "1" },
            ],
          },
        ],
      },
    ],
  };

  test("tag rename: Window@AXWindow renames _tag in output", () => {
    const queries = parseQuery("Window@AXWindow");
    const result = filterTree(tree, queries);
    expect(result.matchCount).toBe(1);
    // Find the deepest node — the wrapper chain will have ancestors
    function findTag(node: PlainNode, tag: string): PlainNode | undefined {
      if (node._tag === tag) return node;
      for (const c of node._children || []) {
        const found = findTag(c, tag);
        if (found) return found;
      }
    }
    const win = findTag(result.nodes[0], "Window");
    expect(win).toBeDefined();
    expect(win!._tag).toBe("Window");
  });

  test("attr rename: [label@title] renames attr key in output", () => {
    const queries = parseQuery("AXButton[label@title]");
    const result = filterTree(tree, queries);
    expect(result.matchCount).toBe(1);
    function findTag(node: PlainNode, tag: string): PlainNode | undefined {
      if (node._tag === tag) return node;
      for (const c of node._children || []) {
        const found = findTag(c, tag);
        if (found) return found;
      }
    }
    const btn = findTag(result.nodes[0], "AXButton");
    expect(btn).toBeDefined();
    expect(btn!.label).toBe("Save");     // renamed from title
    expect(btn!.title).toBeUndefined();  // original name not present
  });

  test("combined tag + attr rename", () => {
    const queries = parseQuery("Tab@AXRadioButton[label@title,active@value]");
    const result = filterTree(tree, queries);
    expect(result.matchCount).toBe(1);
    function findTag(node: PlainNode, tag: string): PlainNode | undefined {
      if (node._tag === tag) return node;
      for (const c of node._children || []) {
        const found = findTag(c, tag);
        if (found) return found;
      }
    }
    const tab = findTag(result.nodes[0], "Tab");
    expect(tab).toBeDefined();
    expect(tab!._tag).toBe("Tab");
    expect(tab!.label).toBe("Tab1");
    expect(tab!.active).toBe("1");
    expect(tab!.title).toBeUndefined();
    expect(tab!.value).toBeUndefined();
  });

  test("tag rename with child queries", () => {
    const queries = parseQuery("Window@AXWindow { Button@AXButton[label@title] }");
    const result = filterTree(tree, queries);
    expect(result.matchCount).toBe(1);
    function findTag(node: PlainNode, tag: string): PlainNode | undefined {
      if (node._tag === tag) return node;
      for (const c of node._children || []) {
        const found = findTag(c, tag);
        if (found) return found;
      }
    }
    const win = findTag(result.nodes[0], "Window");
    expect(win).toBeDefined();
    const btn = findTag(win!, "Button");
    expect(btn).toBeDefined();
    expect(btn!.label).toBe("Save");
  });
});

// ─── Direct child (>) operator ────────────────────────────────────

describe("filterTree — direct child operator", () => {
  // Tree structure:
  //   Root
  //   └── Application
  //       └── Window
  //           ├── Toolbar        (direct child of Window)
  //           │   └── Button#Save (direct child of Toolbar, NOT of Window)
  //           └── Button#Close   (direct child of Window)
  const tree: PlainNode = {
    _tag: "Root",
    _children: [
      {
        _tag: "Application",
        _id: "app:com.test",
        _children: [
          {
            _tag: "Window",
            _id: "Window:Main:0",
            title: "Main",
            _children: [
              {
                _tag: "Toolbar",
                _id: "Toolbar::0",
                _children: [
                  { _tag: "Button", _id: "Button:Save:0", title: "Save" },
                ],
              },
              { _tag: "Button", _id: "Button:Close:0", title: "Close" },
            ],
          },
        ],
      },
    ],
  };

  test("Window / Button matches only direct child Button, not nested", () => {
    const queries = parseQuery("Window / Button");
    const result = filterTree(tree, queries);
    const guiml = toGUIML(result.nodes);
    expect(guiml).toContain("Close");
    expect(guiml).not.toContain("Save");
  });

  test("Window { Button } matches all Buttons (any depth)", () => {
    const queries = parseQuery("Window { Button }");
    const result = filterTree(tree, queries);
    const guiml = toGUIML(result.nodes);
    expect(guiml).toContain("Save");
    expect(guiml).toContain("Close");
  });

  test("Window // Button is equivalent to Window { Button }", () => {
    const queries = parseQuery("Window // Button");
    const result = filterTree(tree, queries);
    const guiml = toGUIML(result.nodes);
    expect(guiml).toContain("Save");
    expect(guiml).toContain("Close");
  });

  test("Window / Toolbar / Button matches nested direct chain", () => {
    const queries = parseQuery("Window / Toolbar / Button");
    const result = filterTree(tree, queries);
    const guiml = toGUIML(result.nodes);
    expect(guiml).toContain("Save");
    expect(guiml).not.toContain("Close");
  });

  test("mixed: Window / Toolbar // Button", () => {
    const queries = parseQuery("Window / Toolbar // Button");
    const result = filterTree(tree, queries);
    const guiml = toGUIML(result.nodes);
    expect(guiml).toContain("Save");
    expect(guiml).not.toContain("Close");
  });

  test("Window / * matches all direct children of Window", () => {
    const queries = parseQuery("Window / *");
    const result = filterTree(tree, queries);
    const guiml = toGUIML(result.nodes);
    // Toolbar and Button#Close are direct children
    expect(guiml).toContain("Toolbar");
    expect(guiml).toContain("Close");
  });
});
