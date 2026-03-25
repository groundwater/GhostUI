import { describe, expect, test } from "bun:test";
import { DrawScriptValidationError, normalizeDrawScriptPayload, normalizeDrawScriptText, type DrawRectItem, type DrawLineItem } from "./draw.js";

describe("draw script normalization", () => {
  test("normalizes a minimal rect payload with default style", () => {
    const result = normalizeDrawScriptPayload({
      items: [
        {
          kind: "rect",
          rect: { x: 420, y: 240, width: 240, height: 140 },
        },
      ],
    });

    expect(result).toEqual({
      coordinateSpace: "screen",
      items: [
        {
          kind: "rect",
          remove: false,
          rect: { x: 420, y: 240, width: 240, height: 140 },
          style: {
            stroke: "#00E5FF",
            fill: "#00E5FF18",
            lineWidth: 2,
            cornerRadius: 8,
            opacity: 1,
          },
        },
      ],
    });
  });

  test("preserves an explicit rect style", () => {
    const result = normalizeDrawScriptPayload({
      coordinateSpace: "screen",
      items: [
        {
          kind: "rect",
          rect: { x: 10, y: 20, width: 30, height: 40 },
          style: {
            stroke: "#FFFFFF",
            fill: "#00000000",
            lineWidth: 3,
            cornerRadius: 0,
            opacity: 0.5,
          },
        },
      ],
    });

    expect((result.items[0] as DrawRectItem)?.style).toEqual({
      stroke: "#FFFFFF",
      fill: "#00000000",
      lineWidth: 3,
      cornerRadius: 0,
      opacity: 0.5,
    });
    expect(result.items[0]?.remove).toBe(false);
  });

  test("normalizes rect morph animation with defaults", () => {
    const result = normalizeDrawScriptPayload({
      items: [
        {
          kind: "rect",
          from: {
            rect: { x: 100, y: 100, width: 120, height: 80 },
          },
          rect: { x: 420, y: 240, width: 240, height: 140 },
        },
      ],
    });

    expect(result.items[0]).toEqual({
      kind: "rect",
      remove: false,
      from: {
        rect: { x: 100, y: 100, width: 120, height: 80 },
        cornerRadius: undefined,
      },
      rect: { x: 420, y: 240, width: 240, height: 140 },
      style: {
        stroke: "#00E5FF",
        fill: "#00E5FF18",
        lineWidth: 2,
        cornerRadius: 8,
        opacity: 1,
      },
      animation: {
        durMs: 250,
        ease: "easeInOut",
      },
    });
  });

  test("preserves explicit rect morph animation settings", () => {
    const result = normalizeDrawScriptPayload({
      items: [
        {
          kind: "rect",
          from: {
            rect: { x: 10, y: 20, width: 30, height: 40 },
            cornerRadius: 2,
          },
          rect: { x: 100, y: 200, width: 300, height: 400 },
          animation: {
            durMs: 600,
            ease: "easeOut",
          },
        },
      ],
    });

    expect((result.items[0] as DrawRectItem)?.from).toEqual({
      rect: { x: 10, y: 20, width: 30, height: 40 },
      cornerRadius: 2,
    });
    expect((result.items[0] as DrawRectItem)?.animation).toEqual({
      durMs: 600,
      ease: "easeOut",
    });
  });

  test("supports id-based updates", () => {
    const result = normalizeDrawScriptPayload({
      items: [
        {
          id: "box-1",
          kind: "rect",
          rect: { x: 100, y: 200, width: 300, height: 400 },
          animation: {
            durMs: 600,
            ease: "easeOut",
          },
        },
      ],
    });

    expect(result).toEqual({
      coordinateSpace: "screen",
      items: [
        {
          id: "box-1",
          kind: "rect",
          remove: false,
          rect: { x: 100, y: 200, width: 300, height: 400 },
          style: {
            stroke: "#00E5FF",
            fill: "#00E5FF18",
            lineWidth: 2,
            cornerRadius: 8,
            opacity: 1,
          },
          animation: {
            durMs: 600,
            ease: "easeOut",
          },
        },
      ],
    });
  });

  test("supports removing ids and empty payloads without treating empty payloads as a clear semantic", () => {
    const removeResult = normalizeDrawScriptPayload({
      items: [
        {
          id: "box-1",
          kind: "rect",
          remove: true,
        },
      ],
    });

    expect(removeResult).toEqual({
      coordinateSpace: "screen",
      items: [
        {
          id: "box-1",
          kind: "rect",
          remove: true,
          from: undefined,
          rect: undefined,
          style: undefined,
          animation: undefined,
        },
      ],
    });

    const clearResult = normalizeDrawScriptPayload({
      items: [],
    });

    expect(clearResult).toEqual({
      coordinateSpace: "screen",
      items: [],
    });
  });

  test("preserves an explicit top-level timeout", () => {
    const result = normalizeDrawScriptPayload({
      timeout: 1500,
      items: [
        {
          kind: "rect",
          rect: { x: 10, y: 20, width: 30, height: 40 },
        },
      ],
    });

    expect(result.timeout).toBe(1500);
  });

  test("rejects invalid payloads", () => {
    expect(() => normalizeDrawScriptPayload({})).toThrow("items must be an array");
    expect(() => normalizeDrawScriptPayload({
      items: [{ kind: "circle", rect: { x: 0, y: 0, width: 10, height: 10 } }],
    })).toThrow('items[0].kind must be "rect", "line", "xray", or "spotlight"');
    expect(() => normalizeDrawScriptPayload({
      items: [{ kind: "rect", rect: { x: 0, y: 0, width: 0, height: 10 } }],
    })).toThrow("items[0].rect.width must be greater than 0");
    expect(() => normalizeDrawScriptPayload({
      items: [{ kind: "rect", rect: { x: 0, y: 0, width: 10, height: 10 }, style: { stroke: "cyan" } }],
    })).toThrow("items[0].style.stroke must be a hex color");
    expect(() => normalizeDrawScriptPayload({
      items: [{ kind: "rect", rect: { x: 0, y: 0, width: 10, height: 10 }, animation: { durMs: 100 } }],
    })).toThrow("items[0].animation requires items[0].from or items[0].id");
    expect(() => normalizeDrawScriptPayload({
      items: [{ kind: "rect", from: { rect: { x: 0, y: 0, width: 10, height: 10 } }, rect: { x: 1, y: 1, width: 10, height: 10 }, animation: { ease: "bounce" } }],
    })).toThrow("items[0].animation.ease must be one of linear, easeIn, easeOut, easeInOut");
    expect(() => normalizeDrawScriptPayload({
      items: [{ kind: "rect", from: { rect: { x: 0, y: 0, width: 10, height: 10 }, cornerRadius: -1 }, rect: { x: 1, y: 1, width: 10, height: 10 } }],
    })).toThrow("items[0].from.cornerRadius must be greater than or equal to 0");
    expect(() => normalizeDrawScriptPayload({
      items: [{ kind: "rect", remove: true }],
    })).toThrow("items[0].remove requires items[0].id");
    expect(() => normalizeDrawScriptPayload({
      items: [{ id: "", kind: "rect", rect: { x: 0, y: 0, width: 10, height: 10 } }],
    })).toThrow("items[0].id must be a non-empty string");
    expect(() => normalizeDrawScriptPayload({
      items: [{ kind: "rect" }],
    })).toThrow("items[0].rect is required");
    expect(() => normalizeDrawScriptPayload({
      timeout: 0,
      items: [],
    })).toThrow("timeout must be greater than 0");
  });

  test("wraps parse failures as validation errors", () => {
    expect(() => normalizeDrawScriptText("{")).toThrow(DrawScriptValidationError);
    expect(() => normalizeDrawScriptText("")).toThrow("stdin payload is empty");
  });
});

describe("draw script spotlight normalization", () => {
  test("normalizes a minimal spotlight payload with dimmer defaults", () => {
    const result = normalizeDrawScriptPayload({
      items: [
        {
          kind: "spotlight",
          rects: [
            { x: 40, y: 50, width: 300, height: 200 },
            { x: 400, y: 50, width: 320, height: 220 },
          ],
        },
      ],
    });

    expect(result).toEqual({
      coordinateSpace: "screen",
      items: [
        {
          kind: "spotlight",
          remove: false,
          rects: [
            { x: 40, y: 50, width: 300, height: 200 },
            { x: 400, y: 50, width: 320, height: 220 },
          ],
          style: {
            fill: "#000000B8",
            cornerRadius: 18,
            opacity: 1,
          },
        },
      ],
    });
  });

  test("rejects invalid spotlight payloads", () => {
    expect(() => normalizeDrawScriptPayload({
      items: [{ kind: "spotlight" }],
    })).toThrow("items[0].rects is required");
    expect(() => normalizeDrawScriptPayload({
      items: [{ kind: "spotlight", rects: [{ x: 0, y: 0, width: 10, height: 10 }], style: { fill: "black" } }],
    })).toThrow("items[0].style.fill must be a hex color");
  });
});

describe("draw script line normalization", () => {
  test("normalizes a minimal line payload with default style", () => {
    const result = normalizeDrawScriptPayload({
      items: [
        {
          kind: "line",
          line: { from: { x: 0, y: 0 }, to: { x: 100, y: 200 } },
        },
      ],
    });

    expect(result).toEqual({
      coordinateSpace: "screen",
      items: [
        {
          kind: "line",
          remove: false,
          line: { from: { x: 0, y: 0 }, to: { x: 100, y: 200 } },
          style: {
            stroke: "#00E5FF",
            lineWidth: 2,
            opacity: 1,
          },
        },
      ],
    });
  });

  test("preserves explicit line style", () => {
    const result = normalizeDrawScriptPayload({
      items: [
        {
          kind: "line",
          line: { from: { x: 10, y: 20 }, to: { x: 30, y: 40 } },
          style: {
            stroke: "#FF0000",
            lineWidth: 4,
            opacity: 0.7,
          },
        },
      ],
    });

    expect((result.items[0] as DrawLineItem)?.style).toEqual({
      stroke: "#FF0000",
      lineWidth: 4,
      opacity: 0.7,
    });
  });

  test("injects default animation when from is present without animation", () => {
    const result = normalizeDrawScriptPayload({
      items: [
        {
          kind: "line",
          from: {
            line: { from: { x: 0, y: 0 }, to: { x: 10, y: 10 } },
          },
          line: { from: { x: 50, y: 50 }, to: { x: 150, y: 150 } },
        },
      ],
    });

    expect(result.items[0]).toEqual({
      kind: "line",
      remove: false,
      from: {
        line: { from: { x: 0, y: 0 }, to: { x: 10, y: 10 } },
      },
      line: { from: { x: 50, y: 50 }, to: { x: 150, y: 150 } },
      style: {
        stroke: "#00E5FF",
        lineWidth: 2,
        opacity: 1,
      },
      animation: {
        durMs: 250,
        ease: "easeInOut",
      },
    });
  });

  test("preserves explicit line animation settings and from styling", () => {
    const result = normalizeDrawScriptPayload({
      items: [
        {
          kind: "line",
          from: {
            line: { from: { x: 0, y: 0 }, to: { x: 10, y: 10 } },
            stroke: "#FF00FF",
            lineWidth: 6,
            opacity: 0.35,
          },
          line: { from: { x: 50, y: 50 }, to: { x: 150, y: 150 } },
          animation: { durMs: 500, ease: "linear" },
        },
      ],
    });

    expect((result.items[0] as DrawLineItem)?.from).toEqual({
      line: { from: { x: 0, y: 0 }, to: { x: 10, y: 10 } },
      stroke: "#FF00FF",
      lineWidth: 6,
      opacity: 0.35,
    });
    expect((result.items[0] as DrawLineItem)?.animation).toEqual({
      durMs: 500,
      ease: "linear",
    });
  });

  test("supports id-based line update", () => {
    const result = normalizeDrawScriptPayload({
      items: [
        {
          id: "line-1",
          kind: "line",
          line: { from: { x: 0, y: 0 }, to: { x: 200, y: 200 } },
          animation: { durMs: 300, ease: "easeOut" },
        },
      ],
    });

    expect(result).toEqual({
      coordinateSpace: "screen",
      items: [
        {
          id: "line-1",
          kind: "line",
          remove: false,
          line: { from: { x: 0, y: 0 }, to: { x: 200, y: 200 } },
          style: {
            stroke: "#00E5FF",
            lineWidth: 2,
            opacity: 1,
          },
          animation: { durMs: 300, ease: "easeOut" },
        },
      ],
    });
  });

  test("supports removing line ids", () => {
    const result = normalizeDrawScriptPayload({
      items: [
        {
          id: "line-1",
          kind: "line",
          remove: true,
        },
      ],
    });

    expect(result).toEqual({
      coordinateSpace: "screen",
      items: [
        {
          id: "line-1",
          kind: "line",
          remove: true,
          from: undefined,
          line: undefined,
          style: undefined,
          animation: undefined,
        },
      ],
    });
  });

  test("rejects invalid line payloads", () => {
    // missing line
    expect(() => normalizeDrawScriptPayload({
      items: [{ kind: "line" }],
    })).toThrow("items[0].line is required");

    // bad point coords
    expect(() => normalizeDrawScriptPayload({
      items: [{ kind: "line", line: { from: { x: NaN, y: 0 }, to: { x: 1, y: 1 } } }],
    })).toThrow("items[0].line.from.x must be a finite number");

    expect(() => normalizeDrawScriptPayload({
      items: [{ kind: "line", line: { from: { x: 0, y: 0 }, to: { x: Infinity, y: 1 } } }],
    })).toThrow("items[0].line.to.x must be a finite number");

    // bad stroke
    expect(() => normalizeDrawScriptPayload({
      items: [{ kind: "line", line: { from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }, style: { stroke: "red" } }],
    })).toThrow("items[0].style.stroke must be a hex color");
    expect(() => normalizeDrawScriptPayload({
      items: [{ kind: "line", from: { line: { from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }, stroke: "red" }, line: { from: { x: 2, y: 2 }, to: { x: 3, y: 3 } } }],
    })).toThrow("items[0].from.stroke must be a hex color");

    // bad lineWidth
    expect(() => normalizeDrawScriptPayload({
      items: [{ kind: "line", line: { from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }, style: { lineWidth: 0 } }],
    })).toThrow("items[0].style.lineWidth must be greater than 0");
    expect(() => normalizeDrawScriptPayload({
      items: [{ kind: "line", from: { line: { from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }, lineWidth: 0 }, line: { from: { x: 2, y: 2 }, to: { x: 3, y: 3 } } }],
    })).toThrow("items[0].from.lineWidth must be greater than 0");

    // bad opacity
    expect(() => normalizeDrawScriptPayload({
      items: [{ kind: "line", line: { from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }, style: { opacity: 1.5 } }],
    })).toThrow("items[0].style.opacity must be between 0 and 1");
    expect(() => normalizeDrawScriptPayload({
      items: [{ kind: "line", from: { line: { from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }, opacity: 1.5 }, line: { from: { x: 2, y: 2 }, to: { x: 3, y: 3 } } }],
    })).toThrow("items[0].from.opacity must be between 0 and 1");

    // animation without from/id
    expect(() => normalizeDrawScriptPayload({
      items: [{ kind: "line", line: { from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }, animation: { durMs: 100 } }],
    })).toThrow("items[0].animation requires items[0].from or items[0].id");

    // remove without id
    expect(() => normalizeDrawScriptPayload({
      items: [{ kind: "line", remove: true }],
    })).toThrow("items[0].remove requires items[0].id");
  });

  test("mixed payload with rect and line in the same script", () => {
    const result = normalizeDrawScriptPayload({
      items: [
        {
          id: "box-1",
          kind: "rect",
          rect: { x: 100, y: 100, width: 200, height: 150 },
        },
        {
          id: "line-1",
          kind: "line",
          line: { from: { x: 100, y: 175 }, to: { x: 400, y: 175 } },
        },
      ],
    });

    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.kind).toBe("rect");
    expect(result.items[1]?.kind).toBe("line");
    expect(result.items[0]?.id).toBe("box-1");
    expect(result.items[1]?.id).toBe("line-1");
  });
});

describe("draw script xray normalization", () => {
  test("normalizes a minimal xray payload with default animation", () => {
    const result = normalizeDrawScriptPayload({
      items: [
        {
          kind: "xray",
          rect: { x: 100, y: 100, width: 400, height: 300 },
        },
      ],
    });

    expect(result).toEqual({
      coordinateSpace: "screen",
      items: [
        {
          kind: "xray",
          remove: false,
          rect: { x: 100, y: 100, width: 400, height: 300 },
          direction: "leftToRight",
          animation: { durMs: 400, ease: "easeInOut" },
        },
      ],
    });
  });

  test("preserves explicit xray direction settings", () => {
    const result = normalizeDrawScriptPayload({
      items: [
        {
          kind: "xray",
          rect: { x: 50, y: 50, width: 200, height: 150 },
          direction: "bottomToTop",
        },
      ],
    });

    expect(result.items[0]).toEqual({
      kind: "xray",
      remove: false,
      rect: { x: 50, y: 50, width: 200, height: 150 },
      direction: "bottomToTop",
      animation: { durMs: 400, ease: "easeInOut" },
    });
  });

  test("preserves explicit xray animation settings", () => {
    const result = normalizeDrawScriptPayload({
      items: [
        {
          kind: "xray",
          rect: { x: 50, y: 50, width: 200, height: 150 },
          animation: { durMs: 800, ease: "linear" },
        },
      ],
    });

    expect(result.items[0]).toMatchObject({
      animation: {
        durMs: 800,
        ease: "linear",
      },
    });
  });

  test("supports id-based xray", () => {
    const result = normalizeDrawScriptPayload({
      items: [
        {
          id: "xray-1",
          kind: "xray",
          rect: { x: 200, y: 200, width: 600, height: 400 },
        },
      ],
    });

    expect(result.items[0]?.id).toBe("xray-1");
    expect(result.items[0]?.kind).toBe("xray");
  });

  test("supports removing xray ids", () => {
    const result = normalizeDrawScriptPayload({
      items: [
        {
          id: "xray-1",
          kind: "xray",
          remove: true,
        },
      ],
    });

    expect(result).toEqual({
      coordinateSpace: "screen",
      items: [
        {
          id: "xray-1",
          kind: "xray",
          remove: true,
          rect: undefined,
          animation: undefined,
        },
      ],
    });
  });

  test("rejects invalid xray payloads", () => {
    // missing rect
    expect(() => normalizeDrawScriptPayload({
      items: [{ kind: "xray" }],
    })).toThrow("items[0].rect is required");

    // bad rect
    expect(() => normalizeDrawScriptPayload({
      items: [{ kind: "xray", rect: { x: 0, y: 0, width: 0, height: 10 } }],
    })).toThrow("items[0].rect.width must be greater than 0");

    // remove without id
    expect(() => normalizeDrawScriptPayload({
      items: [{ kind: "xray", remove: true }],
    })).toThrow("items[0].remove requires items[0].id");

    // bad animation ease
    expect(() => normalizeDrawScriptPayload({
      items: [{ kind: "xray", rect: { x: 0, y: 0, width: 10, height: 10 }, animation: { ease: "bounce" } }],
    })).toThrow("items[0].animation.ease must be one of linear, easeIn, easeOut, easeInOut");

    expect(() => normalizeDrawScriptPayload({
      items: [{ kind: "xray", rect: { x: 0, y: 0, width: 10, height: 10 }, direction: "diagonal" }],
    })).toThrow("items[0].direction must be one of leftToRight, rightToLeft, topToBottom, bottomToTop");

    // unknown kind still rejected
    expect(() => normalizeDrawScriptPayload({
      items: [{ kind: "circle", rect: { x: 0, y: 0, width: 10, height: 10 } }],
    })).toThrow('items[0].kind must be "rect", "line", "xray", or "spotlight"');
  });

  test("mixed payload with rect, line, and xray", () => {
    const result = normalizeDrawScriptPayload({
      items: [
        {
          id: "box-1",
          kind: "rect",
          rect: { x: 100, y: 100, width: 200, height: 150 },
        },
        {
          id: "xray-1",
          kind: "xray",
          rect: { x: 100, y: 100, width: 400, height: 300 },
        },
        {
          id: "line-1",
          kind: "line",
          line: { from: { x: 0, y: 0 }, to: { x: 100, y: 100 } },
        },
      ],
    });

    expect(result.items).toHaveLength(3);
    expect(result.items[0]?.kind).toBe("rect");
    expect(result.items[1]?.kind).toBe("xray");
    expect(result.items[2]?.kind).toBe("line");
  });
});
