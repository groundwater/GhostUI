import { describe, expect, test } from "bun:test";
import {
  ACTOR_NAME_RE,
  ActorApiError,
  normalizeActorRunRequest,
  normalizeActorSpawnRequest,
  parseActorRunCLIArgs,
  parseActorSpawnCLIArgs,
} from "./protocol.js";

describe("actor protocol", () => {
  test("accepts the documented actor name grammar", () => {
    expect(ACTOR_NAME_RE.test("pointer")).toBe(true);
    expect(ACTOR_NAME_RE.test("pointer.main")).toBe(true);
    expect(ACTOR_NAME_RE.test("Pointer")).toBe(false);
    expect(ACTOR_NAME_RE.test(".pointer")).toBe(false);
  });

  test("parses CLI spawn and run arguments", () => {
    const stdinPayload = JSON.stringify({
      type: "gui.payload",
      version: 1,
      source: "vat.query",
      query: "Window[frame]",
      tree: null,
      nodes: null,
      matchCount: null,
      node: null,
      target: null,
      cursor: null,
      axQueryMatch: null,
      vatQueryPlan: null,
      bounds: { x: 100, y: 120, width: 240, height: 180 },
      point: { x: 220, y: 210 },
      issues: [],
    });
    const multiBoundsPayload = JSON.stringify({
      type: "gui.payload",
      version: 1,
      source: "vat.query",
      query: "Window[frame]",
      tree: null,
      nodes: [
        { _tag: "Window", frame: { x: 100, y: 120, width: 240, height: 180 }, _children: [] },
        { _tag: "Window", frame: { x: 400, y: 420, width: 320, height: 200 }, _children: [] },
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
    });
    const liveVatQueryPayload = JSON.stringify({
      type: "gui.payload",
      version: 1,
      source: "vat.query",
      query: "Window[frame]",
      tree: {
        _tag: "VATRoot",
        _children: [
          {
            _tag: "Codex",
            _children: [
              {
                _tag: "Window",
                _id: "Codex",
                title: "Codex",
                frame: "(494,25,1043,779)",
                _children: [
                  {
                    _tag: "Group",
                    frame: "(494,25,1043,779)",
                    _children: [],
                  },
                ],
              },
            ],
          },
        ],
      },
      nodes: [
        {
          _tag: "VATRoot",
          _children: [
            {
              _tag: "Codex",
              _children: [
                {
                  _tag: "Window",
                  _id: "Codex",
                  _frame: "(494,25,1043,779)",
                  frame: "(494,25,1043,779)",
                  _children: [],
                },
              ],
            },
          ],
        },
      ],
      matchCount: 1,
      node: {
        _tag: "Window",
        _id: "Codex",
        _frame: "(494,25,1043,779)",
        frame: "(494,25,1043,779)",
        _children: [],
      },
      target: null,
      cursor: null,
      axQueryMatch: null,
      vatQueryPlan: null,
      bounds: { x: 494, y: 25, width: 1043, height: 779 },
      point: { x: 1015.5, y: 414.5 },
      issues: [],
    });
    const nestedBoundsVatQueryPayload = JSON.stringify({
      type: "gui.payload",
      version: 1,
      source: "vat.query",
      query: "Codex//Text",
      tree: null,
      nodes: [
        {
          _tag: "VATRoot",
          _children: [
            {
              _tag: "Codex",
              _children: [
                {
                  _tag: "TextArea",
                  _frame: "(777,674,718,40)",
                  _children: [
                    {
                      _tag: "TextField",
                      _frame: "(942,804,7,0)",
                      _children: [],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      matchCount: 1,
      node: {
        _tag: "TextArea",
        _frame: "(777,674,718,40)",
        _children: [],
      },
      target: null,
      cursor: null,
      axQueryMatch: null,
      vatQueryPlan: null,
      bounds: { x: 777, y: 674, width: 718, height: 40 },
      point: { x: 1136, y: 694 },
      issues: [],
    });

    expect(parseActorSpawnCLIArgs(["pointer", "pointer.main", "--duration-scale", "0"])).toEqual({
      type: "pointer",
      name: "pointer.main",
      durationScale: 0,
    });
    expect(parseActorSpawnCLIArgs(["canvas", "canvas.notes"])).toEqual({
      type: "canvas",
      name: "canvas.notes",
      durationScale: 1,
    });
    expect(parseActorSpawnCLIArgs(["spotlight", "spotlight.focus"])).toEqual({
      type: "spotlight",
      name: "spotlight.focus",
      durationScale: 1,
    });

    expect(parseActorRunCLIArgs("move", ["--to", "840", "420", "--style", "wandering", "--timeout", "5000"])).toEqual({
      timeoutMs: 5000,
      action: {
        kind: "move",
        to: { x: 840, y: 420 },
        style: "wandering",
      },
    });

    expect(parseActorRunCLIArgs("click", ["--button", "right", "--at", "30", "40"])).toEqual({
      action: {
        kind: "click",
        button: "right",
        at: { x: 30, y: 40 },
      },
      timeoutMs: undefined,
    });

    expect(parseActorRunCLIArgs("drag", ["--to", "1680", "320"])).toEqual({
      action: {
        kind: "drag",
        to: { x: 1680, y: 320 },
      },
      timeoutMs: undefined,
    });

    expect(parseActorRunCLIArgs("scroll", ["--dx", "0", "--dy", "120"])).toEqual({
      action: {
        kind: "scroll",
        dx: 0,
        dy: 120,
      },
      timeoutMs: undefined,
    });

    expect(parseActorRunCLIArgs("think", ["--for", "25"])).toEqual({
      action: {
        kind: "think",
        forMs: 25,
      },
      timeoutMs: undefined,
    });

    expect(parseActorRunCLIArgs("narrate", ["--text", "Heads up"])).toEqual({
      action: {
        kind: "narrate",
        text: "Heads up",
      },
      timeoutMs: undefined,
    });

    expect(parseActorRunCLIArgs("rect", ["--padding", "8", "--blur", "12", "-"], stdinPayload)).toEqual({
      timeoutMs: undefined,
      action: {
        kind: "rect",
        rects: [{ x: 100, y: 120, width: 240, height: 180 }],
        padding: 8,
        blur: 12,
      },
    });

    expect(parseActorRunCLIArgs("rect", ["--padding", "8", "--blur", "12", "--speed", "240", "-"], stdinPayload)).toEqual({
      timeoutMs: undefined,
      action: {
        kind: "rect",
        rects: [{ x: 100, y: 120, width: 240, height: 180 }],
        padding: 8,
        blur: 12,
        speed: 240,
      },
    });

    expect(parseActorRunCLIArgs("circ", ["--padding", "4", "--blur", "18", "-"], stdinPayload)).toEqual({
      timeoutMs: undefined,
      action: {
        kind: "circ",
        rects: [{ x: 100, y: 120, width: 240, height: 180 }],
        padding: 4,
        blur: 18,
      },
    });

    expect(parseActorRunCLIArgs("circ", ["--padding", "4", "--blur", "18", "--speed", "180", "-"], stdinPayload)).toEqual({
      timeoutMs: undefined,
      action: {
        kind: "circ",
        rects: [{ x: 100, y: 120, width: 240, height: 180 }],
        padding: 4,
        blur: 18,
        speed: 180,
      },
    });

    expect(() => parseActorRunCLIArgs("rect", ["--speed", "0", "-"], stdinPayload)).toThrow("speed must be greater than 0");

    expect(parseActorRunCLIArgs("on", ["--transition", "instant"])).toEqual({
      timeoutMs: undefined,
      action: {
        kind: "on",
        transition: "instant",
      },
    });

    expect(parseActorRunCLIArgs("off", [])).toEqual({
      timeoutMs: undefined,
      action: {
        kind: "off",
        transition: "fade",
      },
    });

    expect(parseActorRunCLIArgs("color", ["rgba(0,0,0,0.35)"])).toEqual({
      timeoutMs: undefined,
      action: {
        kind: "color",
        color: "rgba(0,0,0,0.35)",
      },
    });

    expect(parseActorRunCLIArgs("dismiss", [])).toEqual({
      action: { kind: "dismiss" },
      timeoutMs: undefined,
    });

    expect(parseActorRunCLIArgs("draw", ["check", "--padding", "8", "--size", "4", "--color", "rgba(255,59,48,0.9)"])).toEqual({
      timeoutMs: undefined,
      action: {
        kind: "draw",
        shape: "check",
        style: {
          padding: 8,
          size: 4,
          color: "rgba(255,59,48,0.9)",
        },
      },
    });

    expect(parseActorRunCLIArgs("draw", ["check", "-", "--padding", "8", "--size", "4"], stdinPayload)).toEqual({
      timeoutMs: undefined,
      action: {
        kind: "draw",
        shape: "check",
        style: {
          padding: 8,
          size: 4,
          color: "#FF3B30",
        },
        box: { x: 100, y: 120, width: 240, height: 180 },
      },
    });

    expect(parseActorRunCLIArgs("draw", ["circ", "-"], liveVatQueryPayload)).toEqual({
      timeoutMs: undefined,
      action: {
        kind: "draw",
        shape: "circ",
        style: {
          padding: 10,
          size: 4,
          color: "#FF3B30",
        },
        box: { x: 494, y: 25, width: 1043, height: 779 },
      },
    });

    expect(parseActorRunCLIArgs("draw", ["check", "-"], multiBoundsPayload)).toEqual({
      timeoutMs: undefined,
      action: {
        kind: "draw",
        shape: "check",
        style: {
          padding: 10,
          size: 4,
          color: "#FF3B30",
        },
        boxes: [
          { x: 100, y: 120, width: 240, height: 180 },
          { x: 400, y: 420, width: 320, height: 200 },
        ],
      },
    });

    expect(parseActorRunCLIArgs("draw", ["check", "--box", "100", "120", "240", "180", "--padding", "8"])).toEqual({
      timeoutMs: undefined,
      action: {
        kind: "draw",
        shape: "check",
        style: {
          padding: 8,
          size: 4,
          color: "#FF3B30",
        },
        box: { x: 100, y: 120, width: 240, height: 180 },
      },
    });

    expect(parseActorRunCLIArgs("text", ["Working", "set", "--font", "SF Pro Text", "--size", "36", "--highlight", "none"])).toEqual({
      timeoutMs: undefined,
      action: {
        kind: "text",
        text: "Working set",
        style: {
          font: "SF Pro Text",
          size: 36,
          color: "#FF3B30",
          highlight: undefined,
        },
      },
    });

    expect(parseActorRunCLIArgs(
      "text",
      ["Working", "set", "--font", "SF Pro Text", "--size", "36", "--highlight", "none", "--box", "100", "120", "240", "180"],
    )).toEqual({
      timeoutMs: undefined,
      action: {
        kind: "text",
        text: "Working set",
        style: {
          font: "SF Pro Text",
          size: 36,
          color: "#FF3B30",
          highlight: undefined,
        },
        box: { x: 100, y: 120, width: 240, height: 180 },
      },
    });

    expect(parseActorRunCLIArgs("text", ["Working", "set", "-", "--font", "SF Pro Text"], stdinPayload)).toEqual({
      timeoutMs: undefined,
      action: {
        kind: "text",
        text: "Working set",
        style: {
          font: "SF Pro Text",
          size: 36,
          color: "#FF3B30",
          highlight: undefined,
        },
        box: { x: 100, y: 120, width: 240, height: 180 },
      },
    });

    expect(parseActorRunCLIArgs("text", ["Working", "set", "-"], nestedBoundsVatQueryPayload)).toEqual({
      timeoutMs: undefined,
      action: {
        kind: "text",
        text: "Working set",
        style: {
          font: "SF Pro Text",
          size: 36,
          color: "#FF3B30",
          highlight: undefined,
        },
        box: { x: 777, y: 674, width: 718, height: 40 },
      },
    });

    expect(() => parseActorRunCLIArgs("text", ["Working", "set", "-"], multiBoundsPayload)).toThrow(
      "actor run text stdin payload from vat.query resolved to 2 bounds; canvas text stdin mode supports exactly one resolved bounds rectangle",
    );
  });

  test("parses pointer defaults and canvas shape/style permutations", () => {
    expect(parseActorRunCLIArgs("move", ["--to", "12", "34"])).toEqual({
      timeoutMs: undefined,
      action: {
        kind: "move",
        to: { x: 12, y: 34 },
        style: "purposeful",
      },
    });

    expect(parseActorRunCLIArgs("click", [])).toEqual({
      timeoutMs: undefined,
      action: {
        kind: "click",
        button: "left",
        at: undefined,
      },
    });

    expect(parseActorRunCLIArgs("click", ["--button", "middle"])).toEqual({
      timeoutMs: undefined,
      action: {
        kind: "click",
        button: "middle",
        at: undefined,
      },
    });

    for (const shape of ["rect", "circ", "check", "cross", "underline"] as const) {
      expect(parseActorRunCLIArgs("draw", [shape, "--padding", "6", "--size", "5", "--color", "#00ff00"])).toEqual({
        timeoutMs: undefined,
        action: {
          kind: "draw",
          shape,
          style: {
            padding: 6,
            size: 5,
            color: "#00ff00",
          },
        },
      });
    }

    expect(parseActorRunCLIArgs("text", ["Hello", "--highlight", "#00ff00", "--color", "#ff0000"])).toEqual({
      timeoutMs: undefined,
      action: {
        kind: "text",
        text: "Hello",
        style: {
          font: "SF Pro Text",
          size: 36,
          color: "#ff0000",
          highlight: "#00ff00",
        },
      },
    });
  });

  test("normalizes JSON requests", () => {
    expect(normalizeActorSpawnRequest({ type: "pointer", name: "pointer" })).toEqual({
      type: "pointer",
      name: "pointer",
      durationScale: 1,
    });
    expect(normalizeActorSpawnRequest({ type: "canvas", name: "canvas.notes" })).toEqual({
      type: "canvas",
      name: "canvas.notes",
      durationScale: 1,
    });

    expect(normalizeActorRunRequest({ kind: "narrate", text: "hello", timeoutMs: 1500 })).toEqual({
      action: { kind: "narrate", text: "hello" },
      timeoutMs: 1500,
    });

    expect(normalizeActorRunRequest({ kind: "move", to: { x: 420, y: 240 } })).toEqual({
      action: {
        kind: "move",
        to: { x: 420, y: 240 },
        style: "purposeful",
      },
      timeoutMs: undefined,
    });

    expect(normalizeActorRunRequest({ kind: "click" })).toEqual({
      action: {
        kind: "click",
        button: "left",
        at: undefined,
      },
      timeoutMs: undefined,
    });

    expect(normalizeActorRunRequest({
      kind: "text",
      text: "Working set",
      style: { font: "SF Pro Text", size: 36, color: "#FF3B30", highlight: "none" },
    })).toEqual({
      action: {
        kind: "text",
        text: "Working set",
        style: {
          font: "SF Pro Text",
          size: 36,
          color: "#FF3B30",
          highlight: undefined,
        },
      },
      timeoutMs: undefined,
    });

    expect(normalizeActorRunRequest({
      kind: "text",
      text: "Ready",
      style: { highlight: "#00ff00", color: "#ff0000" },
    })).toEqual({
      action: {
        kind: "text",
        text: "Ready",
        style: {
          font: "SF Pro Text",
          size: 36,
          color: "#ff0000",
          highlight: "#00ff00",
        },
      },
      timeoutMs: undefined,
    });

    expect(normalizeActorRunRequest({
      kind: "rect",
      rects: [{ x: 100, y: 120, width: 240, height: 180 }],
      padding: 8,
      blur: 12,
    })).toEqual({
      action: {
        kind: "rect",
        rects: [{ x: 100, y: 120, width: 240, height: 180 }],
        padding: 8,
        blur: 12,
      },
      timeoutMs: undefined,
    });

    expect(normalizeActorRunRequest({
      kind: "rect",
      rects: [{ x: 100, y: 120, width: 240, height: 180 }],
      padding: 8,
      blur: 12,
      speed: 240,
    })).toEqual({
      action: {
        kind: "rect",
        rects: [{ x: 100, y: 120, width: 240, height: 180 }],
        padding: 8,
        blur: 12,
        speed: 240,
      },
      timeoutMs: undefined,
    });

    expect(normalizeActorRunRequest({
      kind: "circ",
      rects: [{ x: 494, y: 25, width: 1043, height: 779 }],
      padding: 4,
      blur: 18,
    })).toEqual({
      action: {
        kind: "circ",
        rects: [{ x: 494, y: 25, width: 1043, height: 779 }],
        padding: 4,
        blur: 18,
      },
      timeoutMs: undefined,
    });

    expect(normalizeActorRunRequest({
      kind: "circ",
      rects: [{ x: 494, y: 25, width: 1043, height: 779 }],
      padding: 4,
      blur: 18,
      speed: 180,
    })).toEqual({
      action: {
        kind: "circ",
        rects: [{ x: 494, y: 25, width: 1043, height: 779 }],
        padding: 4,
        blur: 18,
        speed: 180,
      },
      timeoutMs: undefined,
    });

    expect(normalizeActorRunRequest({
      kind: "on",
      transition: "instant",
    })).toEqual({
      action: {
        kind: "on",
        transition: "instant",
      },
      timeoutMs: undefined,
    });

    expect(normalizeActorRunRequest({
      kind: "off",
    })).toEqual({
      action: {
        kind: "off",
        transition: "fade",
      },
      timeoutMs: undefined,
    });

    expect(normalizeActorRunRequest({
      kind: "color",
      color: "rgba(0,0,0,0.35)",
    })).toEqual({
      action: {
        kind: "color",
        color: "rgba(0,0,0,0.35)",
      },
      timeoutMs: undefined,
    });

    expect(normalizeActorRunRequest({
      kind: "draw",
      shape: "check",
      boxes: [
        { x: 100, y: 120, width: 240, height: 180 },
        { x: 400, y: 420, width: 320, height: 200 },
      ],
    })).toEqual({
      action: {
        kind: "draw",
        shape: "check",
        style: {
          color: "#FF3B30",
          size: 4,
          padding: 0,
        },
        box: undefined,
        boxes: [
          { x: 100, y: 120, width: 240, height: 180 },
          { x: 400, y: 420, width: 320, height: 200 },
        ],
      },
      timeoutMs: undefined,
    });
  });

  test("rejects bad inputs with typed actor errors", () => {
    const stdinPayload = JSON.stringify({
      type: "gui.payload",
      version: 1,
      source: "vat.query",
      query: "Window[frame]",
      tree: null,
      nodes: null,
      matchCount: null,
      node: null,
      target: null,
      cursor: null,
      axQueryMatch: null,
      vatQueryPlan: null,
      bounds: null,
      rectUnion: null,
      point: null,
      issues: [],
    });
    expect(() => parseActorRunCLIArgs("scroll", ["--dx", "0"])).toThrow(ActorApiError);
    expect(() => parseActorRunCLIArgs("move", ["--to", "10", "20", "--style", "teleport"])).toThrow(
      "--style must be one of purposeful, fast, slow, wandering",
    );
    expect(() => parseActorRunCLIArgs("click", ["--button", "double"])).toThrow(
      "--button must be one of left, right, middle",
    );
    expect(() => parseActorRunCLIArgs("think", ["--for", "-1"])).toThrow(
      "--for must be greater than or equal to 0",
    );
    expect(() => parseActorRunCLIArgs("scroll", ["--dx", "NaN", "--dy", "12"])).toThrow(
      "--dx must be a finite number",
    );
    expect(() => parseActorRunCLIArgs("draw", ["check", "--box", "100", "120", "0", "180"])).toThrow(
      "--box requires finite x y width height with positive width and height",
    );
    expect(() => parseActorRunCLIArgs("rect", ["--padding", "8"], stdinPayload)).toThrow("rect requires -");
    expect(() => parseActorRunCLIArgs("circ", ["-", "--blur", "-1"], stdinPayload)).toThrow("--blur must be greater than or equal to 0");
    expect(() => parseActorRunCLIArgs("on", ["--transition", "later"])).toThrow("--transition must be one of fade, instant");
    expect(() => parseActorRunCLIArgs("color", [])).toThrow("color requires <Color>");
    expect(() => parseActorRunCLIArgs(
      "draw",
      ["check", "-", "--box", "100", "120", "240", "180"],
      JSON.stringify({
        type: "gui.payload",
        version: 1,
        source: "vat.query",
        query: "Window[frame]",
        tree: null,
        nodes: null,
        matchCount: null,
        node: null,
        target: null,
        cursor: null,
        axQueryMatch: null,
        vatQueryPlan: null,
        bounds: { x: 100, y: 120, width: 240, height: 180 },
        point: { x: 220, y: 210 },
        issues: [],
      }),
    )).toThrow("actor run draw stdin mode cannot be combined with --box");
    expect(() => parseActorRunCLIArgs(
      "draw",
      ["check", "-"],
      `${JSON.stringify({
        type: "gui.payload",
        version: 1,
        source: "vat.query",
        query: "Window[frame]",
        tree: null,
        nodes: null,
        matchCount: null,
        node: null,
        target: null,
        cursor: null,
        axQueryMatch: null,
        vatQueryPlan: null,
        bounds: { x: 100, y: 120, width: 240, height: 180 },
        point: { x: 220, y: 210 },
        issues: [],
      })}\n${JSON.stringify({
        type: "gui.payload",
        version: 1,
        source: "vat.query",
        query: "Window[frame]",
        tree: null,
        nodes: null,
        matchCount: null,
        node: null,
        target: null,
        cursor: null,
        axQueryMatch: null,
        vatQueryPlan: null,
        bounds: { x: 400, y: 420, width: 320, height: 200 },
        point: { x: 560, y: 520 },
        issues: [],
      })}\n`,
    )).toThrow("actor run draw stdin mode requires exactly one AX/VAT target-bearing payload");
    expect(() => parseActorRunCLIArgs("text", ["Working", "set", "-"], JSON.stringify({
      type: "gui.payload",
      version: 1,
      source: "vat.query",
      query: "Window[frame]",
      tree: null,
      nodes: [{ _tag: "Window", _children: [] }],
      matchCount: 1,
      node: null,
      target: null,
      cursor: null,
      axQueryMatch: null,
      vatQueryPlan: null,
      bounds: null,
      point: null,
      issues: [],
    }))).toThrow("actor run text Window is missing bounds/frame coordinates");
    expect(() => parseActorRunCLIArgs(
      "text",
      ["Working", "set", "-", "--box", "100", "120", "240", "180"],
      JSON.stringify({
        type: "gui.payload",
        version: 1,
        source: "vat.query",
        query: "Window[frame]",
        tree: null,
        nodes: null,
        matchCount: null,
        node: null,
        target: null,
        cursor: null,
        axQueryMatch: null,
        vatQueryPlan: null,
        bounds: { x: 100, y: 120, width: 240, height: 180 },
        point: { x: 220, y: 210 },
        issues: [],
      }),
    )).toThrow("actor run text stdin mode cannot be combined with --box");
    expect(() => normalizeActorSpawnRequest({ type: "bogus", name: "pointer" })).toThrow(ActorApiError);
    expect(() => normalizeActorRunRequest({ kind: "narrate", text: "   " })).toThrow(ActorApiError);
    expect(() => normalizeActorRunRequest({
      kind: "draw",
      shape: "check",
      box: { x: 100, y: 120, width: 0, height: 180 },
    })).toThrow(ActorApiError);
    expect(() => normalizeActorRunRequest({
      kind: "draw",
      shape: "rect",
      box: { x: 100, y: 120, width: 240, height: 180 },
      boxes: [{ x: 400, y: 420, width: 320, height: 200 }],
    })).toThrow("box and boxes cannot both be provided");
    expect(() => normalizeActorRunRequest({ kind: "teleport" })).toThrow(ActorApiError);
  });
});
