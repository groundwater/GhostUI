/**
 * Unit tests for toGUIML — CRDT → GUIML rendering.
 * Uses inline PlainNode fixtures — no app boot required.
 */
import { describe, test, expect } from "bun:test";
import { toGUIML } from "./guiml.js";
import type { PlainNode } from "./types.js";

/** Helper to create a PlainNode concisely. */
function node(tag: string, props?: Record<string, unknown>, children?: PlainNode[]): PlainNode {
  return { _tag: tag, ...props, _children: children } as PlainNode;
}

// ─── Basic rendering ──────────────────────────────────────────────

describe("toGUIML — basic rendering", () => {
  test("self-closing leaf", () => {
    const out = toGUIML([node("Button", { _id: "Button:Save:0", title: "Save" })]);
    expect(out).toBe('<Button#Save title="Save" />');
  });

  test("open/close with children", () => {
    const out = toGUIML([
      node("Window", { _id: "Window:Main:0", title: "Main" }, [
        node("Button", { _id: "Button:OK:0", title: "OK" }),
      ]),
    ]);
    expect(out).toContain("<Window#Main");
    expect(out).toContain("</Window>");
    expect(out).toContain('<Button#OK title="OK" />');
  });

  test("2-space indentation", () => {
    const out = toGUIML([
      node("Window", { _id: "Window:Main:0" }, [
        node("Button", { _id: "Button:A:0" }),
      ]),
    ]);
    const lines = out.split("\n");
    expect(lines[1]).toMatch(/^  </);
  });
});

// ─── ID suffix collapsing ─────────────────────────────────────────

describe("toGUIML — ID suffix collapsing", () => {
  test("Tag:Title:Index → #Title", () => {
    const out = toGUIML([node("Button", { _id: "Button:Save:0" })]);
    expect(out).toContain("Button#Save");
  });

  test("Tag::Index → #Index (no title)", () => {
    const out = toGUIML([node("Button", { _id: "Button::3" })]);
    expect(out).toContain("Button#3");
  });

  test("Tag-N → #N", () => {
    const out = toGUIML([node("Button", { _id: "Button-36" })]);
    // 36 is numeric, so it should try bestDisplayName, but with no attrs, stays numeric
    expect(out).toContain("Button#36");
  });

  test("app:bundleId → #bundleId", () => {
    const out = toGUIML([node("Application", { _id: "app:com.apple.finder", title: "Finder" })]);
    // Bundle ID is not numeric, so bestDisplayName doesn't replace it
    // The raw id suffix is #com.apple.finder
    expect(out).toContain("Application#com.apple.finder");
  });

  test("numeric ID replaced by display name", () => {
    const out = toGUIML([node("Button", { _id: "Button::0", title: "Cancel" })]);
    expect(out).toContain("Button#Cancel");
  });

  test("special chars in ID are quoted", () => {
    const out = toGUIML([node("ListItem", { _id: "ListItem:iCloud Drive:0" })]);
    expect(out).toContain('#"iCloud Drive"');
  });
});

// ─── Boolean states ───────────────────────────────────────────────

describe("toGUIML — boolean states", () => {
  test("checked as bare attr", () => {
    const out = toGUIML([node("CheckBox", { _id: "CheckBox:Opt:0", checked: "true" })]);
    expect(out).toMatch(/\bchecked\b/);
    expect(out).not.toContain("checked=");
  });

  test("selected as bare attr", () => {
    const out = toGUIML([node("Tab", { _id: "Tab:Home:0", selected: true })]);
    expect(out).toMatch(/\bselected\b/);
  });

  test("expanded as bare attr", () => {
    const out = toGUIML([node("TreeItem", { _id: "TreeItem:Docs:0", expanded: "true" })]);
    expect(out).toMatch(/\bexpanded\b/);
  });

  test("focused as bare attr", () => {
    const out = toGUIML([node("TextField", { _id: "TextField:Search:0", focused: true })]);
    expect(out).toMatch(/\bfocused\b/);
  });

  test("false boolean values are omitted", () => {
    const out = toGUIML([node("CheckBox", { _id: "CheckBox:Opt:0", checked: "false" })]);
    expect(out).not.toContain("checked");
  });
});

// ─── enabled ──────────────────────────────────────────────────────

describe("toGUIML — enabled attr", () => {
  test("enabled=false shown", () => {
    const out = toGUIML([node("Button", { _id: "Button:Save:0", enabled: "false" })]);
    expect(out).toContain('enabled="false"');
  });

  test("enabled=true omitted", () => {
    const out = toGUIML([node("Button", { _id: "Button:Save:0", enabled: "true" })]);
    expect(out).not.toContain("enabled");
  });
});

// ─── Window states ────────────────────────────────────────────────

describe("toGUIML — window states", () => {
  test("visual-only window → {... deflated} placeholder", () => {
    const out = toGUIML([
      node("Window", { _id: "Window:Main:0", visualOnly: "true" }, [
        node("Button", { _id: "Button:A:0" }),
      ]),
    ]);
    expect(out).toContain("{... deflated}");
    expect(out).not.toContain("Button#A");
  });

  test("obscured >= 50 → {... obscured N%} placeholder", () => {
    const out = toGUIML([
      node("Window", { _id: "Window:Main:0", obscured: 75 }, [
        node("Button", { _id: "Button:A:0" }),
      ]),
    ]);
    expect(out).toContain("{... obscured 75%}");
    expect(out).not.toContain("Button#A");
  });

  test("obscured < 50 → renders normally (children visible)", () => {
    const out = toGUIML([
      node("Window", { _id: "Window:Main:0", obscured: 30 }, [
        node("Button", { _id: "Button:A:0" }),
      ]),
    ]);
    // obscured attr still appears, but children are NOT collapsed
    expect(out).toContain("Button#A");
    expect(out).not.toContain("{... obscured");
  });

  test("Sheet/Dialog/Popover → {... blocked by Sheet}", () => {
    const out = toGUIML([
      node("Window", { _id: "Window:Main:0" }, [
        node("Button", { _id: "Button:OK:0" }),
        node("Sheet", { _id: "Sheet::0" }, [
          node("Button", { _id: "Button:Cancel:0" }),
        ]),
      ]),
    ]);
    expect(out).toContain("{... blocked by Sheet}");
    // The Sheet itself should still render
    expect(out).toContain("Sheet");
  });
});

// ─── Truncation markers ──────────────────────────────────────────

describe("toGUIML — truncation markers", () => {
  test("count variant", () => {
    const out = toGUIML([
      { _tag: "_truncated", _truncatedCount: 5 } as PlainNode,
    ]);
    expect(out).toBe("{... 5 more}");
  });

  test("label variant", () => {
    const out = toGUIML([
      { _tag: "_truncated", _truncatedLabel: "obscured 80%" } as PlainNode,
    ]);
    expect(out).toBe("{... obscured 80%}");
  });
});

// ─── SKIP_KEYS ────────────────────────────────────────────────────

describe("toGUIML — SKIP_KEYS", () => {
  test("_tag, _id, x, y, w, h not rendered as attrs", () => {
    const out = toGUIML([
      node("Window", { _id: "Window:Main:0", x: "10", y: "20", w: "800", h: "600", title: "Main" }),
    ]);
    expect(out).not.toContain('x="10"');
    expect(out).not.toContain('y="20"');
    expect(out).not.toContain('w="800"');
    expect(out).not.toContain('h="600"');
    expect(out).toContain("Window#Main");
  });
});

// ─── String quoting ───────────────────────────────────────────────

describe("toGUIML — string quoting", () => {
  test("entity escaping for &, <, >", () => {
    const out = toGUIML([node("Button", { _id: "Button:X:0", title: "A & B" })]);
    expect(out).toContain("&amp;");
  });

  test("simple alphanumeric values are quoted plainly", () => {
    const out = toGUIML([node("Button", { _id: "Button:X:0", title: "Save" })]);
    expect(out).toContain('title="Save"');
  });
});
