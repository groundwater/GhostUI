import { describe, expect, test } from "bun:test";
import { findWindowFocusMatch, resolveWindowFocusMatch, type FocusableWindowNode } from "./window-targeting";

describe("findWindowFocusMatch", () => {
  test("prefers exact windowNumber match over title/frame heuristics", () => {
    const tree: FocusableWindowNode = {
      role: "AXApplication",
      children: [
        {
          role: "AXWindow",
          title: "Terminal",
          windowNumber: 101,
          frame: { x: 100, y: 100, width: 800, height: 600 },
        },
        {
          role: "AXWindow",
          title: "Terminal",
          windowNumber: 202,
          frame: { x: 102, y: 100, width: 800, height: 600 },
        },
      ],
    };

    const resolved = resolveWindowFocusMatch(tree, {
      cgWindowId: 202,
      title: "Terminal",
      x: 100,
      y: 100,
      w: 800,
      h: 600,
    });

    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.match.node.windowNumber).toBe(202);
      expect(resolved.match.path).toEqual([1]);
    }
  });

  test("falls back to heuristic matching when windowNumber is unavailable", () => {
    const tree: FocusableWindowNode = {
      role: "AXApplication",
      children: [
        {
          role: "AXWindow",
          title: "Left",
          frame: { x: 100, y: 100, width: 800, height: 600 },
        },
        {
          role: "AXWindow",
          title: "Right",
          frame: { x: 1200, y: 100, width: 800, height: 600 },
        },
      ],
    };

    const match = findWindowFocusMatch(tree, {
      cgWindowId: 999,
      title: "Right",
      x: 1200,
      y: 100,
      w: 800,
      h: 600,
    });

    expect(match?.path).toEqual([1]);
  });

  test("refuses to guess when multiple windows share the same heuristic identity", () => {
    const tree: FocusableWindowNode = {
      role: "AXApplication",
      children: [
        {
          role: "AXWindow",
          title: "Terminal",
          frame: { x: 100, y: 100, width: 800, height: 600 },
        },
        {
          role: "AXWindow",
          title: "Terminal",
          frame: { x: 100.4, y: 100.2, width: 800.2, height: 600.1 },
        },
      ],
    };

    const resolved = resolveWindowFocusMatch(tree, {
      cgWindowId: 999,
      title: "Terminal",
      x: 100,
      y: 100,
      w: 800,
      h: 600,
    });

    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.error).toContain("Ambiguous AX window identity");
    }
  });

  test("strict resolver can match by unique frame when target title is missing", () => {
    const tree: FocusableWindowNode = {
      role: "AXApplication",
      children: [
        {
          role: "AXWindow",
          title: "bender — -zsh — 80×24",
          frame: { x: 98, y: 135, width: 751, height: 581 },
        },
        {
          role: "AXWindow",
          title: "bender — -zsh — 80×24",
          frame: { x: 689, y: 147, width: 679, height: 581 },
        },
      ],
    };

    const resolved = resolveWindowFocusMatch(tree, {
      cgWindowId: 12366,
      x: 689,
      y: 147,
      w: 679,
      h: 581,
      title: "",
    });

    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.match.path).toEqual([1]);
    }
  });
});
