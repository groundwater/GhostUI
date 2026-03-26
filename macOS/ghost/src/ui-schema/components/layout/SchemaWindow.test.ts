import { describe, expect, test } from "bun:test";
import * as Y from "../../lib/yjs";
import {
  computeWindowZIndex,
  emitRootWindowDragCommand,
  emitRootWindowFocusCommand,
  isWindowFront,
  resolveWindowRenderPosition,
} from "./SchemaWindow";
import { findDesiredWindowDocPath, windowDocPath } from "../../window-doc-registry";
import { focusedLeaseTarget, positionLeaseTarget, readWindowLeaseState } from "../../../window-state";

describe("emitRootWindowFocusCommand", () => {
  function appendWindow(root: Y.Map<unknown>, values: { cgWindowId: number; x?: number; y?: number; z: number; focused: boolean }): void {
    const children = root.get("_children") as Y.Array<Y.Map<unknown>> | undefined ?? new Y.Array<Y.Map<unknown>>();
    if (!root.get("_children")) root.set("_children", children);
    const window = new Y.Map<unknown>();
    window.set("type", "Window");
    window.set("cgWindowId", values.cgWindowId);
    window.set("doc", windowDocPath(values.cgWindowId));
    window.set("x", values.x ?? 0);
    window.set("y", values.y ?? 0);
    window.set("z", values.z);
    window.set("focused", values.focused ? "true" : "false");
    children.push([window]);
  }

  function findWindow(root: Y.Map<unknown>, cgWindowId: number): Y.Map<unknown> {
    const children = root.get("_children") as Y.Array<Y.Map<unknown>>;
    for (let i = 0; i < children.length; i++) {
      const child = children.get(i);
      if (Number(child.get("cgWindowId")) === cgWindowId) return child;
    }
    throw new Error(`missing window ${cgWindowId}`);
  }

  test("records a focus lease without mutating observed window fields", () => {
    const doc = new Y.Doc();
    const root = doc.getMap("root");
    appendWindow(root, { cgWindowId: 101, z: 1, focused: false });
    appendWindow(root, { cgWindowId: 102, z: 0, focused: true });

    expect(emitRootWindowFocusCommand(doc, 101)).toBe(true);
    expect(findWindow(root, 101).get("z")).toBe(1);
    expect(findWindow(root, 101).get("focused")).toBe("false");
    expect(findWindow(root, 102).get("z")).toBe(0);
    expect(findWindow(root, 102).get("focused")).toBe("true");
    expect(root.get("windowLeases")).toEqual(expect.objectContaining({
      focus: expect.objectContaining({
        kind: "focus",
        cgWindowId: 101,
        source: "webui",
      }),
    }));
  });

  test("window z index is derived from native z order", () => {
    expect(computeWindowZIndex(4)).toBe("99996");
  });

  test("front state comes from focused or z=0", () => {
    expect(isWindowFront(true, 5)).toBe(true);
    expect(isWindowFront(false, 0)).toBe(true);
    expect(isWindowFront(false, 5)).toBe(false);
    expect(isWindowFront(false, 5, true)).toBe(true);
  });

  test("leased focus bumps the z-index before native catches up", () => {
    expect(computeWindowZIndex(4, true)).toBe("200000");
  });

  test("records a position lease without mutating observed coordinates", () => {
    const doc = new Y.Doc();
    const root = doc.getMap("root");
    appendWindow(root, { cgWindowId: 101, x: 10, y: 20, z: 0, focused: true });

    expect(emitRootWindowDragCommand(doc, {
      cgWindowId: 101,
      targetX: 320,
      targetY: 240,
    })).toBe(true);
    expect(findWindow(root, 101).get("x")).toBe(10);
    expect(findWindow(root, 101).get("y")).toBe(20);
    expect(root.get("windowLeases")).toEqual(expect.objectContaining({
      positions: expect.objectContaining({
        "101": expect.objectContaining({
          kind: "position",
          cgWindowId: 101,
          targetX: 320,
          targetY: 240,
          phase: "gesture",
        }),
      }),
    }));
  });

  test("projects leased coordinates for local window rendering", () => {
    const doc = new Y.Doc();
    const root = doc.getMap("root");
    appendWindow(root, { cgWindowId: 101, x: 10, y: 20, z: 0, focused: true });

    expect(emitRootWindowDragCommand(doc, {
      cgWindowId: 101,
      targetX: 320,
      targetY: 240,
    })).toBe(true);

    expect(resolveWindowRenderPosition(10, 20, 101, readWindowLeaseState(root))).toEqual({
      x: 320,
      y: 240,
      positionLease: {
        x: 320,
        y: 240,
        phase: "gesture",
      },
    });
  });

  test("desired active doc prefers leased focus over observed focus", () => {
    const doc = new Y.Doc();
    const root = doc.getMap("root");
    appendWindow(root, { cgWindowId: 101, z: 0, focused: true });
    appendWindow(root, { cgWindowId: 102, z: 1, focused: false });
    root.set("windowLeases", {
      focus: {
        kind: "focus",
        cgWindowId: 102,
        frontBundleId: "com.apple.Terminal",
        startedAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      },
    });

    expect(findDesiredWindowDocPath(root)).toBe("/windows/102");
  });

  test("lease helpers expose desired targets without touching observed fields", () => {
    const doc = new Y.Doc();
    const root = doc.getMap("root");
    appendWindow(root, { cgWindowId: 101, x: 10, y: 20, z: 1, focused: false });
    appendWindow(root, { cgWindowId: 102, x: 30, y: 40, z: 0, focused: true });

    expect(emitRootWindowFocusCommand(doc, 102)).toBe(true);
    expect(emitRootWindowDragCommand(doc, {
      cgWindowId: 101,
      targetX: 320,
      targetY: 240,
      phase: "settling",
    })).toBe(true);

    const leases = readWindowLeaseState(root);
    expect(focusedLeaseTarget(leases)).toBe(102);
    expect(positionLeaseTarget(leases, 101)).toEqual({
      x: 320,
      y: 240,
      phase: "settling",
    });
    expect(findWindow(root, 101).get("x")).toBe(10);
    expect(findWindow(root, 101).get("y")).toBe(20);
    expect(findWindow(root, 102).get("focused")).toBe("true");
  });

  test("position leases do not override the active doc path", () => {
    const doc = new Y.Doc();
    const root = doc.getMap("root");
    appendWindow(root, { cgWindowId: 101, z: 0, focused: true });
    appendWindow(root, { cgWindowId: 102, z: 1, focused: false });
    root.set("windowLeases", {
      positions: {
        "102": {
          kind: "position",
          cgWindowId: 102,
          targetX: 320,
          targetY: 240,
          phase: "settling",
          startedAt: 1,
          updatedAt: 1,
          expiresAt: 2,
        },
      },
    });

    expect(findDesiredWindowDocPath(root)).toBe("/windows/101");
  });

  test("marks the final drag write as settling when requested", () => {
    const doc = new Y.Doc();
    const root = doc.getMap("root");
    appendWindow(root, { cgWindowId: 101, x: 10, y: 20, z: 0, focused: true });

    expect(emitRootWindowDragCommand(doc, {
      cgWindowId: 101,
      targetX: 321,
      targetY: 241,
      phase: "settling",
    })).toBe(true);

    expect(root.get("windowLeases")).toEqual(expect.objectContaining({
      positions: expect.objectContaining({
        "101": expect.objectContaining({
          phase: "settling",
        }),
      }),
    }));
  });
});
