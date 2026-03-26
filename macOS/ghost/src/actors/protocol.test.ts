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
  });

  test("rejects bad inputs with typed actor errors", () => {
    expect(() => parseActorRunCLIArgs("scroll", ["--dx", "0"])).toThrow(ActorApiError);
    expect(() => normalizeActorSpawnRequest({ type: "bogus", name: "pointer" })).toThrow(ActorApiError);
    expect(() => normalizeActorRunRequest({ kind: "teleport" })).toThrow(ActorApiError);
  });
});
