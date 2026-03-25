import { describe, expect, test } from "bun:test";
import * as Y from "./lib/yjs";
import { populateFromDescriptor, type NodeDescriptor } from "../crdt/schema.js";
import {
  collectWindowDocPaths,
  createWindowDocRegistry,
  findFocusedWindowDocPath,
  windowDocPath,
} from "./window-doc-registry";

class FakeController {
  disposeCount = 0;

  reconnectNow(): void {}

  sendBinary(): boolean {
    return true;
  }

  dispose(): void {
    this.disposeCount += 1;
  }
}

function buildDisplay(children: NodeDescriptor[]): Y.Doc {
  const doc = new Y.Doc();
  populateFromDescriptor(doc.getMap("root"), {
    type: "Display",
    id: "Display::0",
    children,
  });
  return doc;
}

describe("window doc registry helpers", () => {
  test("collects focused and ordered window doc paths from the root display", () => {
    const doc = buildDisplay([
      {
        type: "Application",
        id: "app:com.apple.Terminal",
        attrs: { bundleId: "com.apple.Terminal", title: "Terminal" },
        children: [
          { type: "Window", id: "Window:Terminal:0", attrs: { doc: "/windows/1", z: 1 } },
          { type: "Window", id: "Window:Prefs:1", attrs: { doc: "/windows/2", focused: "true", z: 0 } },
        ],
      },
    ]);

    const root = doc.getMap("root");

    expect(collectWindowDocPaths(root)).toEqual(["/windows/1", "/windows/2"]);
    expect(findFocusedWindowDocPath(root)).toBe("/windows/2");
    expect(windowDocPath(7)).toBe("/windows/7");
  });

  test("activating a window doc preserves the last render when it becomes cached", () => {
    const controllers: FakeController[] = [];
    const registry = createWindowDocRegistry({
      connect: () => {
        const controller = new FakeController();
        controllers.push(controller);
        return controller;
      },
    });

    registry.activate("/windows/1");
    const first = registry.getEntry("/windows/1");
    expect(first?.source).toBe("live");
    expect(first?.controller).toBeTruthy();

    registry.activate("/windows/2");
    const second = registry.getEntry("/windows/2");
    expect(second?.source).toBe("live");
    expect(first?.source).toBe("cached");
    expect(first?.controller).toBeNull();
    expect(controllers[0].disposeCount).toBe(1);

    registry.pruneVisible(["/windows/2"]);
    expect(registry.getEntry("/windows/1")).toBeUndefined();
    expect(registry.getEntry("/windows/2")).toBeTruthy();

    registry.destroy();
  });
});
