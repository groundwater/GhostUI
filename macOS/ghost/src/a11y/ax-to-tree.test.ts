/**
 * Unit tests for axToTree and collectSemanticChildren — the a11y → CRDT pipeline.
 * Uses hand-crafted AXNode fixtures (no app boot required).
 */
import { describe, test, expect } from "bun:test";
import type { AXNode } from "../apps/types.js";
import {
  axToTree,
  collectSemanticChildren,
  isMenuSeparator,
  ROLE_TO_TAG,
  SUBROLE_TO_TAG,
  SEMANTIC_TAGS,
} from "./ax-tree.js";

/** Helper to create an AXNode concisely. */
function ax(role: string, props?: Partial<AXNode>, children?: AXNode[]): AXNode {
  return { role, ...props, children } as AXNode;
}

// ─── Role mapping ─────────────────────────────────────────────────

describe("axToTree — role mapping", () => {
  test("AXButton → Button", () => {
    const node = axToTree(ax("AXButton", { title: "Save" }));
    expect(node.tag).toBe("Button");
  });

  test("AXWindow → Window", () => {
    const node = axToTree(ax("AXWindow", { title: "Main" }));
    expect(node.tag).toBe("Window");
  });

  test("AXTextField → TextField", () => {
    const node = axToTree(ax("AXTextField", { placeholder: "Search" }));
    expect(node.tag).toBe("TextField");
  });

  test("unknown role strips AX prefix", () => {
    const node = axToTree(ax("AXFooBarWidget"));
    expect(node.tag).toBe("FooBarWidget");
  });

  test("all ROLE_TO_TAG entries produce the expected tag", () => {
    for (const [axRole, expectedTag] of Object.entries(ROLE_TO_TAG)) {
      const node = axToTree(ax(axRole));
      expect(node.tag).toBe(expectedTag);
    }
  });
});

// ─── Subrole mapping ──────────────────────────────────────────────

describe("axToTree — subrole mapping", () => {
  test("AXSearchField subrole on AXTextField → SearchField", () => {
    const node = axToTree(ax("AXTextField", { subrole: "AXSearchField", placeholder: "Search" }));
    expect(node.tag).toBe("SearchField");
  });

  test("AXSearchField subrole on AXButton stays Button (toggle button)", () => {
    const node = axToTree(ax("AXButton", { subrole: "AXSearchField", title: "Search" }));
    expect(node.tag).toBe("Button");
  });
});

// ─── Menu separators ──────────────────────────────────────────────

describe("isMenuSeparator", () => {
  test("AXSeparatorMenuItem subrole", () => {
    expect(isMenuSeparator(ax("AXMenuItem", { subrole: "AXSeparatorMenuItem" }))).toBe(true);
  });

  test("tiny height + no title", () => {
    expect(isMenuSeparator(ax("AXMenuItem", { frame: { x: 0, y: 0, width: 200, height: 5 } }))).toBe(true);
  });

  test("normal MenuItem is not a separator", () => {
    expect(isMenuSeparator(ax("AXMenuItem", { title: "Copy" }))).toBe(false);
  });

  test("non-MenuItem role is never a separator", () => {
    expect(isMenuSeparator(ax("AXButton", { subrole: "AXSeparatorMenuItem" }))).toBe(false);
  });

  test("separator MenuItem maps to Separator tag in axToTree", () => {
    const node = axToTree(ax("AXMenuItem", { subrole: "AXSeparatorMenuItem" }));
    expect(node.tag).toBe("Separator");
  });
});

// ─── Capabilities → props ─────────────────────────────────────────

describe("axToTree — capabilities", () => {
  test("selected", () => {
    const node = axToTree(ax("AXButton", { title: "A", capabilities: { selected: true } }));
    expect(node.props.selected).toBe("true");
  });

  test("checked", () => {
    const node = axToTree(ax("AXCheckBox", { title: "Opt", capabilities: { checked: true } }));
    expect(node.props.checked).toBe("true");
  });

  test("expanded", () => {
    const node = axToTree(ax("AXDisclosureTriangle", { title: "D", capabilities: { expanded: true } }));
    expect(node.props.expanded).toBe("true");
  });

  test("focused", () => {
    const node = axToTree(ax("AXTextField", { value: "hi", capabilities: { focused: true } }));
    expect(node.props.focused).toBe("true");
  });

  test("enabled=false", () => {
    const node = axToTree(ax("AXButton", { title: "Disabled", capabilities: { enabled: false } }));
    expect(node.props.enabled).toBe("false");
  });

  test("canScroll with scrollAxis", () => {
    const node = axToTree(ax("AXScrollArea", { capabilities: { canScroll: true, scrollAxis: "v" } }));
    expect(node.props.scroll).toBe("v");
  });

  test("scrollV and scrollH", () => {
    const node = axToTree(ax("AXScrollArea", { capabilities: { canScroll: true, scrollValueV: 0.5, scrollValueH: 0.3 } }));
    expect(node.props.scrollV).toBe("0.5");
    expect(node.props.scrollH).toBe("0.3");
  });
});

// ─── ID generation ────────────────────────────────────────────────

describe("axToTree — ID generation", () => {
  test("Tag:Title:Index format", () => {
    const node = axToTree(ax("AXButton", { title: "Save" }), 2);
    expect(node.id).toBe("Button:Save:2");
  });

  test("fallback chain: label", () => {
    const node = axToTree(ax("AXButton", { label: "Close" }));
    expect(node.id).toBe("Button:Close:0");
  });

  test("fallback chain: value", () => {
    const node = axToTree(ax("AXStaticText", { value: "Hello" }));
    expect(node.id).toBe("StaticText:Hello:0");
  });

  test("fallback chain: identifier (stable)", () => {
    const node = axToTree(ax("AXButton", { identifier: "myBtn" }));
    expect(node.id).toBe("Button:myBtn:0");
  });

  test("fallback chain: placeholder", () => {
    const node = axToTree(ax("AXTextField", { placeholder: "Type here" }));
    expect(node.id).toBe("TextField:Type here:0");
  });

  test("auto-generated _NS: identifier is skipped", () => {
    const node = axToTree(ax("AXButton", { identifier: "_NS:42" }));
    expect(node.id).toBe("Button::0");
  });

  test("empty title produces Tag::Index", () => {
    const node = axToTree(ax("AXButton"), 3);
    expect(node.id).toBe("Button::3");
  });
});

// ─── Non-semantic collapsing ──────────────────────────────────────

describe("collectSemanticChildren — non-semantic collapsing", () => {
  test("AXGroup promotes its children", () => {
    const children = collectSemanticChildren([
      ax("AXGroup", {}, [
        ax("AXButton", { title: "A" }),
        ax("AXButton", { title: "B" }),
      ]),
    ]);
    expect(children.length).toBe(2);
    expect(children[0].tag).toBe("Button");
    expect(children[1].tag).toBe("Button");
  });

  test("nested groups flatten", () => {
    const children = collectSemanticChildren([
      ax("AXGroup", {}, [
        ax("AXGroup", {}, [
          ax("AXButton", { title: "Deep" }),
        ]),
      ]),
    ]);
    expect(children.length).toBe(1);
    expect(children[0].tag).toBe("Button");
    expect(children[0].props.title).toBe("Deep");
  });

  test("sibling indices are recomputed after promotion", () => {
    const children = collectSemanticChildren([
      ax("AXButton", { title: "First" }),
      ax("AXGroup", {}, [
        ax("AXButton", { title: "Promoted" }),
      ]),
    ]);
    expect(children.length).toBe(2);
    // First button keeps its index
    expect(children[0].id).toContain(":0");
    // Promoted button gets recomputed index
    expect(children[1].id).toContain(":1");
  });
});

// ─── Sibling consistency ──────────────────────────────────────────

describe("collectSemanticChildren — sibling consistency", () => {
  test("StaticText promoted to Button in List parent when Buttons are majority", () => {
    const children = collectSemanticChildren([
      ax("AXButton", { title: "Result 1" }),
      ax("AXButton", { title: "Result 2" }),
      ax("AXStaticText", { value: "Result 3" }),
    ], "List");
    // All should be Button
    expect(children.every(c => c.tag === "Button")).toBe(true);
  });

  test("StaticText NOT promoted when there are no Buttons", () => {
    const children = collectSemanticChildren([
      ax("AXStaticText", { value: "Text 1" }),
      ax("AXStaticText", { value: "Text 2" }),
    ], "List");
    expect(children.every(c => c.tag === "StaticText")).toBe(true);
  });

  test("StaticText NOT promoted outside list-like parents", () => {
    const children = collectSemanticChildren([
      ax("AXButton", { title: "Btn" }),
      ax("AXStaticText", { value: "Txt" }),
    ], "Toolbar");
    expect(children[0].tag).toBe("Button");
    expect(children[1].tag).toBe("StaticText");
  });
});

// ─── Empty MenuBar filtering (#149) ──────────────────────────────

describe("collectSemanticChildren — empty MenuBar filtering", () => {
  test("empty MenuBar is filtered out", () => {
    const children = collectSemanticChildren([
      ax("AXMenuBar"), // no children
      ax("AXButton", { title: "Action" }),
    ]);
    expect(children.length).toBe(1);
    expect(children[0].tag).toBe("Button");
  });

  test("non-empty MenuBar is preserved", () => {
    const children = collectSemanticChildren([
      ax("AXMenuBar", {}, [
        ax("AXMenuBarItem", { title: "File" }),
      ]),
    ]);
    expect(children.length).toBe(1);
    expect(children[0].tag).toBe("MenuBar");
  });
});

// ─── ScrollArea More sentinel ─────────────────────────────────────

describe("axToTree — ScrollArea More sentinel", () => {
  test("truncated vertical scroll appends More child", () => {
    const node = axToTree(ax("AXScrollArea", {
      capabilities: { canScroll: true, scrollValueV: 0.5 },
    }));
    expect(node.children).toBeDefined();
    const more = node.children!.find(c => c.tag === "More");
    expect(more).toBeDefined();
    expect(more!.props.direction).toBe("down");
  });

  test("fully scrolled does not append More", () => {
    const node = axToTree(ax("AXScrollArea", {
      capabilities: { canScroll: true, scrollValueV: 1.0 },
    }));
    const more = node.children?.find(c => c.tag === "More");
    expect(more).toBeUndefined();
  });

  test("truncated horizontal scroll appends More with direction right", () => {
    const node = axToTree(ax("AXScrollArea", {
      capabilities: { canScroll: true, scrollValueH: 0.3 },
    }));
    const more = node.children!.find(c => c.tag === "More");
    expect(more).toBeDefined();
    expect(more!.props.direction).toBe("right");
  });
});

// ─── MenuItem submenu detection ───────────────────────────────────

describe("axToTree — MenuItem submenu detection", () => {
  test("hasSubmenu=true when Menu child present", () => {
    const node = axToTree(ax("AXMenuItem", { title: "Recent" }, [
      ax("AXMenu", {}, [
        ax("AXMenuItem", { title: "File1.txt" }),
      ]),
    ]));
    expect(node.tag).toBe("MenuItem");
    expect(node.props.hasSubmenu).toBe("true");
  });

  test("no hasSubmenu when no Menu child", () => {
    const node = axToTree(ax("AXMenuItem", { title: "Copy" }));
    expect(node.props.hasSubmenu).toBeUndefined();
  });
});

// ─── Frame storage ────────────────────────────────────────────────

describe("axToTree — frame", () => {
  test("frame is stored as rounded tuple string", () => {
    const node = axToTree(ax("AXButton", {
      title: "X",
      frame: { x: 10.7, y: 20.3, width: 100.5, height: 50.9 },
    }));
    expect(node.props.frame).toBe("(11,20,101,51)");
  });
});

// ─── StaticText → Button promotion (ButtonCellTitle) ──────────────

describe("axToTree — StaticText with ButtonCellTitle", () => {
  test("maps to Button tag", () => {
    const node = axToTree(ax("AXStaticText", { identifier: "ButtonCellTitle", value: "Remove" }));
    expect(node.tag).toBe("Button");
  });
});
