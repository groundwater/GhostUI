import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { syncMetadataDocs, pruneAppByBundleId } from "./refresher.js";
import { applyWindowFocus, applyWindowPosition } from "../window-state.js";

function makeStore() {
  const docs = new Map<string, Y.Doc>();
  return {
    get(path: string) {
      return docs.get(path);
    },
    getOrCreate(path: string) {
      let doc = docs.get(path);
      if (!doc) {
        doc = new Y.Doc();
        docs.set(path, doc);
      }
      return doc;
    },
    destroy(path: string) {
      const doc = docs.get(path);
      if (doc) doc.destroy();
      docs.delete(path);
    },
    paths() {
      return [...docs.keys()];
    },
  };
}

function rootChildren(doc: Y.Doc): Y.Array<Y.Map<unknown>> {
  return doc.getMap("root").get("_children") as Y.Array<Y.Map<unknown>>;
}

function findChildById(children: Y.Array<Y.Map<unknown>>, id: string): Y.Map<unknown> | undefined {
  for (let i = 0; i < children.length; i++) {
    const child = children.get(i);
    if (child.get("id") === id) return child;
  }
  return undefined;
}

function withScreen<T extends Record<string, unknown>>(value: T): T & { screenW: number; screenH: number } {
  return {
    screenW: 1489,
    screenH: 764,
    ...value,
  };
}

describe("window-only metadata sync", () => {
  test("keeps menu bars out of the live display doc", () => {
    const store = makeStore();
    syncMetadataDocs(store as never, "/display/0", withScreen({
      apps: [
        { pid: 10, bundleId: "com.apple.Terminal", name: "Terminal", regular: true },
      ],
      windowRects: [],
      frontPid: 10,
      frontBundleId: "com.apple.Terminal",
      frontName: "Terminal",
    }), { passKey: "menu-free" });

    const children = rootChildren(store.getOrCreate("/display/0"));
    expect(findChildById(children, "app:com.apple.Terminal")).toBeDefined();

    let hasMenuBar = false;
    for (let i = 0; i < children.length; i++) {
      if (children.get(i).get("type") === "MenuBar") {
        hasMenuBar = true;
        break;
      }
    }
    expect(hasMenuBar).toBe(false);
  });

  test("creates Application nodes for regular apps even without visible windows", () => {
    const store = makeStore();
    syncMetadataDocs(store as never, "/display/0", withScreen({
      apps: [
        { pid: 10, bundleId: "com.apple.Terminal", name: "Terminal", regular: true },
        { pid: 11, bundleId: "com.example.Helper", name: "Helper", regular: false },
      ],
      windowRects: [],
      frontPid: 10,
      frontBundleId: "com.apple.Terminal",
      frontName: "Terminal",
    }), { shellChildren: [] });

    const children = rootChildren(store.getOrCreate("/display/0"));
    expect(findChildById(children, "app:com.apple.Terminal")).toBeDefined();
    expect(findChildById(children, "app:com.example.Helper")).toBeUndefined();
  });

  test("creates per-window docs and root window refs keyed by cgWindowId", () => {
    const store = makeStore();
    syncMetadataDocs(store as never, "/display/0", withScreen({
      apps: [
        { pid: 10, bundleId: "com.apple.Terminal", name: "Terminal", regular: true },
      ],
      windowRects: [
        { pid: 10, cgWindowId: 101, bundleId: "com.apple.Terminal", x: 10, y: 20, w: 800, h: 600, title: "Main" },
      ],
      frontPid: 10,
      frontBundleId: "com.apple.Terminal",
      frontName: "Terminal",
    }), { shellChildren: [] });

    const displayDoc = store.getOrCreate("/display/0");
    expect(displayDoc.getMap("root").get("screenW")).toBe(1489);
    expect(displayDoc.getMap("root").get("screenH")).toBe(764);
    const app = findChildById(rootChildren(displayDoc), "app:com.apple.Terminal")!;
    const windows = app.get("_children") as Y.Array<Y.Map<unknown>>;
    expect(windows.length).toBe(1);
    expect(windows.get(0).get("doc")).toBe("/windows/101");
    expect(windows.get(0).get("cgWindowId")).toBe(101);
    expect(windows.get(0).get("focused")).toBe("true");

    const windowDoc = store.get("/windows/101");
    expect(windowDoc).toBeDefined();
    expect(windowDoc!.getMap("root").get("type")).toBe("Window");
    expect(windowDoc!.getMap("root").get("id")).toBe("Window:101");
  });

  test("keeps per-window docs metadata-only", () => {
    const store = makeStore();
    syncMetadataDocs(store as never, "/display/0", withScreen({
      apps: [
        { pid: 10, bundleId: "com.apple.finder", name: "Finder", regular: true },
      ],
      windowRects: [
        { pid: 10, cgWindowId: 101, bundleId: "com.apple.finder", x: 10, y: 20, w: 800, h: 600, title: "Finder" },
      ],
      frontPid: 10,
      frontBundleId: "com.apple.finder",
      frontName: "Finder",
    }), { shellChildren: [] });

    const windowDoc = store.get("/windows/101");
    expect(windowDoc).toBeDefined();
    const windowRoot = windowDoc!.getMap("root");
    expect(windowRoot.get("type")).toBe("Window");
    expect(windowRoot.get("_children")).toBeUndefined();
  });

  test("preserves active window leases across metadata refreshes until native catches up", () => {
    const store = makeStore();
    const expiresAt = Date.now() + 10_000;
    const metadata = {
      apps: [
        { pid: 10, bundleId: "com.apple.Terminal", name: "Terminal", regular: true },
      ],
      windowRects: [
        { pid: 10, cgWindowId: 101, bundleId: "com.apple.Terminal", x: 10, y: 20, w: 800, h: 600, title: "Main" },
      ],
      frontPid: 10,
      frontBundleId: "com.apple.Terminal",
      frontName: "Terminal",
    };

    syncMetadataDocs(store as never, "/display/0", withScreen(metadata), { shellChildren: [] });

    const windowDoc = store.get("/windows/101");
    expect(windowDoc).toBeDefined();
    const displayRoot = store.get("/display/0")!.getMap("root");
    displayRoot.set("windowLeases", {
      focus: {
        kind: "focus",
        leaseId: "webui:1",
        source: "webui",
        provenance: "local-authored",
        cgWindowId: 101,
        frontBundleId: "com.apple.Terminal",
        stack: { "101": { z: 0, focused: true } },
        startedAt: 123,
        updatedAt: 123,
        expiresAt,
      },
      positions: {
        "101": {
          kind: "position",
          leaseId: "webui:2",
          source: "webui",
          provenance: "local-authored",
          cgWindowId: 101,
          targetX: 320,
          targetY: 240,
          phase: "settling",
          startedAt: 123,
          updatedAt: 123,
          expiresAt,
        },
      },
    });

    syncMetadataDocs(store as never, "/display/0", withScreen({
      ...metadata,
      windowRects: [
        { pid: 10, cgWindowId: 101, bundleId: "com.apple.Terminal", x: 11, y: 20, w: 800, h: 600, title: "Main updated" },
      ],
    }), { shellChildren: [] });

    expect(displayRoot.get("windowLeases")).toEqual(expect.objectContaining({
      positions: expect.objectContaining({
        "101": expect.objectContaining({ targetX: 320, targetY: 240 }),
      }),
    }));
    expect(windowDoc!.getMap("root").get("title")).toBe("Main updated");
  });

  test("projects leased window coordinates into CRDT while a position lease is active", () => {
    const store = makeStore();
    const metadata = withScreen({
      apps: [
        { pid: 10, bundleId: "com.apple.Terminal", name: "Terminal", regular: true },
      ],
      windowRects: [
        { pid: 10, cgWindowId: 101, bundleId: "com.apple.Terminal", x: 10, y: 20, w: 800, h: 600, title: "Main" },
      ],
      frontPid: 10,
      frontBundleId: "com.apple.Terminal",
      frontName: "Terminal",
    });

    syncMetadataDocs(store as never, "/display/0", metadata, { shellChildren: [] });

    const displayRoot = store.get("/display/0")!.getMap("root");
    const now = Date.now();
    displayRoot.set("windowLeases", undefined);
    applyWindowPosition(displayRoot, 101, 320, 240, { now, source: "webui", phase: "settling" });

    syncMetadataDocs(store as never, "/display/0", metadata, { shellChildren: [] });

    const app = findChildById(rootChildren(store.get("/display/0")!), "app:com.apple.Terminal")!;
    const window = (app.get("_children") as Y.Array<Y.Map<unknown>>).get(0);
    const windowRoot = store.get("/windows/101")!.getMap("root");
    expect(window.get("x")).toBe(320);
    expect(window.get("y")).toBe(240);
    expect(windowRoot.get("x")).toBe(320);
    expect(windowRoot.get("y")).toBe(240);
    expect(displayRoot.get("windowLeases")).toEqual(expect.objectContaining({
      positions: expect.objectContaining({
        "101": expect.objectContaining({ targetX: 320, targetY: 240 }),
      }),
    }));
  });

  test("projects leased focus stack into CRDT while a focus lease is active", () => {
    const store = makeStore();
    const metadata = withScreen({
      apps: [
        { pid: 10, bundleId: "com.apple.Terminal", name: "Terminal", regular: true },
        { pid: 11, bundleId: "com.apple.TextEdit", name: "TextEdit", regular: true },
      ],
      windowRects: [
        { pid: 10, cgWindowId: 101, bundleId: "com.apple.Terminal", x: 10, y: 20, w: 800, h: 600, title: "Main" },
        { pid: 11, cgWindowId: 102, bundleId: "com.apple.TextEdit", x: 40, y: 50, w: 700, h: 500, title: "Doc" },
      ],
      frontPid: 10,
      frontBundleId: "com.apple.Terminal",
      frontName: "Terminal",
    });

    syncMetadataDocs(store as never, "/display/0", metadata, { shellChildren: [] });

    const displayRoot = store.get("/display/0")!.getMap("root");
    const now = Date.now();
    displayRoot.set("windowLeases", undefined);
    applyWindowFocus(displayRoot, 102, { now, source: "webui" });

    syncMetadataDocs(store as never, "/display/0", metadata, { shellChildren: [] });

    const displayDoc = store.get("/display/0")!;
    const terminalApp = findChildById(rootChildren(displayDoc), "app:com.apple.Terminal")!;
    const textEditApp = findChildById(rootChildren(displayDoc), "app:com.apple.TextEdit")!;
    const terminalWindow = (terminalApp.get("_children") as Y.Array<Y.Map<unknown>>).get(0);
    const textEditWindow = (textEditApp.get("_children") as Y.Array<Y.Map<unknown>>).get(0);
    expect(terminalWindow.get("focused")).toBe("false");
    expect(terminalWindow.get("z")).toBe(1);
    expect(textEditWindow.get("focused")).toBe("true");
    expect(textEditWindow.get("z")).toBe(0);
    expect(displayRoot.get("windowLeases")).toEqual(expect.objectContaining({
      focus: expect.objectContaining({ cgWindowId: 102 }),
    }));
  });

  test("projects the leased front app immediately while native focus catches up", () => {
    const store = makeStore();
    const metadata = withScreen({
      apps: [
        { pid: 10, bundleId: "com.apple.Terminal", name: "Terminal", regular: true },
        { pid: 11, bundleId: "com.apple.TextEdit", name: "TextEdit", regular: true },
      ],
      windowRects: [
        { pid: 10, cgWindowId: 101, bundleId: "com.apple.Terminal", x: 10, y: 20, w: 800, h: 600, title: "Main" },
        { pid: 11, cgWindowId: 102, bundleId: "com.apple.TextEdit", x: 40, y: 50, w: 700, h: 500, title: "Doc" },
      ],
      frontPid: 10,
      frontBundleId: "com.apple.Terminal",
      frontName: "Terminal",
    });

    syncMetadataDocs(store as never, "/display/0", metadata, { shellChildren: [] });

    const displayDoc = store.get("/display/0")!;
    const displayRoot = displayDoc.getMap("root");
    const now = Date.now();
    displayRoot.set("windowLeases", undefined);
    applyWindowFocus(displayRoot, 102, { now, source: "webui" });

    syncMetadataDocs(store as never, "/display/0", metadata, { shellChildren: [] });

    const terminalApp = findChildById(rootChildren(displayDoc), "app:com.apple.Terminal")!;
    const textEditApp = findChildById(rootChildren(displayDoc), "app:com.apple.TextEdit")!;
    expect(displayRoot.get("frontApp")).toBe("com.apple.TextEdit");
    expect(terminalApp.get("foreground")).toBe("false");
    expect(textEditApp.get("foreground")).toBe("true");
  });

  test("clears focus and position leases once native observations match", () => {
    const store = makeStore();
    const metadata = withScreen({
      apps: [
        { pid: 10, bundleId: "com.apple.Terminal", name: "Terminal", regular: true },
        { pid: 11, bundleId: "com.apple.TextEdit", name: "TextEdit", regular: true },
      ],
      windowRects: [
        { pid: 10, cgWindowId: 101, bundleId: "com.apple.Terminal", x: 10, y: 20, w: 800, h: 600, title: "Main" },
        { pid: 11, cgWindowId: 102, bundleId: "com.apple.TextEdit", x: 40, y: 50, w: 700, h: 500, title: "Doc" },
      ],
      frontPid: 10,
      frontBundleId: "com.apple.Terminal",
      frontName: "Terminal",
    });

    syncMetadataDocs(store as never, "/display/0", metadata, { shellChildren: [] });

    const displayRoot = store.get("/display/0")!.getMap("root");
    const now = Date.now();
    displayRoot.set("windowLeases", undefined);
    applyWindowFocus(displayRoot, 102, { now, source: "webui" });
    applyWindowPosition(displayRoot, 101, 320, 240, { now, source: "webui", phase: "settling" });

    syncMetadataDocs(store as never, "/display/0", withScreen({
      ...metadata,
      windowRects: [
        { pid: 11, cgWindowId: 102, bundleId: "com.apple.TextEdit", x: 40, y: 50, w: 700, h: 500, title: "Doc" },
        { pid: 10, cgWindowId: 101, bundleId: "com.apple.Terminal", x: 321, y: 239, w: 800, h: 600, title: "Main" },
      ],
      frontPid: 11,
      frontBundleId: "com.apple.TextEdit",
      frontName: "TextEdit",
    }), { shellChildren: [] });

    expect(displayRoot.get("windowLeases")).toBeUndefined();
  });

  test("retains focus lease while native focus has not caught up yet", () => {
    const store = makeStore();
    const metadata = withScreen({
      apps: [
        { pid: 10, bundleId: "com.apple.Terminal", name: "Terminal", regular: true },
        { pid: 11, bundleId: "com.apple.TextEdit", name: "TextEdit", regular: true },
      ],
      windowRects: [
        { pid: 10, cgWindowId: 101, bundleId: "com.apple.Terminal", x: 10, y: 20, w: 800, h: 600, title: "Main" },
        { pid: 11, cgWindowId: 102, bundleId: "com.apple.TextEdit", x: 40, y: 50, w: 700, h: 500, title: "Doc" },
      ],
      frontPid: 10,
      frontBundleId: "com.apple.Terminal",
      frontName: "Terminal",
    });

    syncMetadataDocs(store as never, "/display/0", metadata, { shellChildren: [] });

    // Apply a focus lease targeting Terminal (101)
    const displayRoot = store.get("/display/0")!.getMap("root");
    const now = Date.now();
    displayRoot.set("windowLeases", undefined);
    applyWindowFocus(displayRoot, 101, { now, source: "webui" });

    // Native focus moves to TextEdit (102) — a *different* window than the lease target
    syncMetadataDocs(store as never, "/display/0", withScreen({
      ...metadata,
      windowRects: [
        { pid: 11, cgWindowId: 102, bundleId: "com.apple.TextEdit", x: 40, y: 50, w: 700, h: 500, title: "Doc" },
        { pid: 10, cgWindowId: 101, bundleId: "com.apple.Terminal", x: 10, y: 20, w: 800, h: 600, title: "Main" },
      ],
      frontPid: 11,
      frontBundleId: "com.apple.TextEdit",
      frontName: "TextEdit",
    }), { shellChildren: [] });

    expect(displayRoot.get("windowLeases")).toEqual(expect.objectContaining({
      focus: expect.objectContaining({ cgWindowId: 101 }),
    }));
  });

  test("yields a stale focus lease once native focus clearly diverged", () => {
    const store = makeStore();
    const metadata = withScreen({
      apps: [
        { pid: 10, bundleId: "com.apple.Terminal", name: "Terminal", regular: true },
        { pid: 11, bundleId: "com.apple.TextEdit", name: "TextEdit", regular: true },
      ],
      windowRects: [
        { pid: 10, cgWindowId: 101, bundleId: "com.apple.Terminal", x: 10, y: 20, w: 800, h: 600, title: "Main" },
        { pid: 11, cgWindowId: 102, bundleId: "com.apple.TextEdit", x: 40, y: 50, w: 700, h: 500, title: "Doc" },
      ],
      frontPid: 10,
      frontBundleId: "com.apple.Terminal",
      frontName: "Terminal",
    });

    syncMetadataDocs(store as never, "/display/0", metadata, { shellChildren: [] });

    const displayRoot = store.get("/display/0")!.getMap("root");
    displayRoot.set("windowLeases", undefined);
    applyWindowFocus(displayRoot, 101, { now: Date.now() - 5_000, source: "webui" });

    const divergent = withScreen({
      ...metadata,
      windowRects: [
        { pid: 11, cgWindowId: 102, bundleId: "com.apple.TextEdit", x: 40, y: 50, w: 700, h: 500, title: "Doc" },
        { pid: 10, cgWindowId: 101, bundleId: "com.apple.Terminal", x: 10, y: 20, w: 800, h: 600, title: "Main" },
      ],
      frontPid: 11,
      frontBundleId: "com.apple.TextEdit",
      frontName: "TextEdit",
    });

    syncMetadataDocs(store as never, "/display/0", divergent, { shellChildren: [] });
    syncMetadataDocs(store as never, "/display/0", divergent, { shellChildren: [] });

    expect(displayRoot.get("windowLeases")).toBeUndefined();
  });

  test("yields a stale position lease once native movement clearly diverged", () => {
    const store = makeStore();
    const metadata = withScreen({
      apps: [
        { pid: 10, bundleId: "com.apple.Terminal", name: "Terminal", regular: true },
      ],
      windowRects: [
        { pid: 10, cgWindowId: 101, bundleId: "com.apple.Terminal", x: 10, y: 20, w: 800, h: 600, title: "Main" },
      ],
      frontPid: 10,
      frontBundleId: "com.apple.Terminal",
      frontName: "Terminal",
    });

    syncMetadataDocs(store as never, "/display/0", metadata, { shellChildren: [] });

    const displayRoot = store.get("/display/0")!.getMap("root");
    displayRoot.set("windowLeases", undefined);
    applyWindowPosition(displayRoot, 101, 320, 240, { now: Date.now() - 5_000, source: "webui", phase: "settling" });

    const divergent = withScreen({
      ...metadata,
      windowRects: [
        { pid: 10, cgWindowId: 101, bundleId: "com.apple.Terminal", x: 44, y: 66, w: 800, h: 600, title: "Main" },
      ],
    });

    syncMetadataDocs(store as never, "/display/0", divergent, { shellChildren: [] });
    syncMetadataDocs(store as never, "/display/0", divergent, { shellChildren: [] });

    expect(displayRoot.get("windowLeases")).toBeUndefined();
    const windowRoot = store.get("/windows/101")!.getMap("root");
    expect(windowRoot.get("x")).toBe(44);
    expect(windowRoot.get("y")).toBe(66);
  });

  test("adopts native position when the doc diverged without an active lease", () => {
    const store = makeStore();
    const metadata = withScreen({
      apps: [
        { pid: 10, bundleId: "com.apple.Terminal", name: "Terminal", regular: true },
      ],
      windowRects: [
        { pid: 10, cgWindowId: 101, bundleId: "com.apple.Terminal", x: 10, y: 20, w: 800, h: 600, title: "Main" },
      ],
      frontPid: 10,
      frontBundleId: "com.apple.Terminal",
      frontName: "Terminal",
    });

    syncMetadataDocs(store as never, "/display/0", metadata, { shellChildren: [] });

    const windowRoot = store.get("/windows/101")!.getMap("root");
    windowRoot.set("x", 320);
    windowRoot.set("y", 240);

    syncMetadataDocs(store as never, "/display/0", withScreen({
      ...metadata,
      windowRects: [
        { pid: 10, cgWindowId: 101, bundleId: "com.apple.Terminal", x: 11, y: 21, w: 800, h: 600, title: "Main" },
      ],
    }), { shellChildren: [] });

    expect(windowRoot.get("x")).toBe(11);
    expect(windowRoot.get("y")).toBe(21);
  });

  test("adopts native position when the doc was previously in sync and macOS moved independently", () => {
    const store = makeStore();
    const metadata = withScreen({
      apps: [
        { pid: 10, bundleId: "com.apple.Terminal", name: "Terminal", regular: true },
      ],
      windowRects: [
        { pid: 10, cgWindowId: 101, bundleId: "com.apple.Terminal", x: 10, y: 20, w: 800, h: 600, title: "Main" },
      ],
      frontPid: 10,
      frontBundleId: "com.apple.Terminal",
      frontName: "Terminal",
    });

    syncMetadataDocs(store as never, "/display/0", metadata, { shellChildren: [] });
    syncMetadataDocs(store as never, "/display/0", withScreen({
      ...metadata,
      windowRects: [
        { pid: 10, cgWindowId: 101, bundleId: "com.apple.Terminal", x: 40, y: 60, w: 800, h: 600, title: "Main" },
      ],
    }), { shellChildren: [] });

    const windowRoot = store.get("/windows/101")!.getMap("root");
    expect(windowRoot.get("x")).toBe(40);
    expect(windowRoot.get("y")).toBe(60);
  });

  test("adopts native window stack when stale CRDT focus has no active lease", () => {
    const store = makeStore();
    const metadata = withScreen({
      apps: [
        { pid: 10, bundleId: "com.apple.Terminal", name: "Terminal", regular: true },
        { pid: 11, bundleId: "com.apple.TextEdit", name: "TextEdit", regular: true },
      ],
      windowRects: [
        { pid: 10, cgWindowId: 101, bundleId: "com.apple.Terminal", x: 10, y: 20, w: 800, h: 600, title: "Main" },
        { pid: 11, cgWindowId: 102, bundleId: "com.apple.TextEdit", x: 40, y: 50, w: 700, h: 500, title: "Doc" },
      ],
      frontPid: 10,
      frontBundleId: "com.apple.Terminal",
      frontName: "Terminal",
    });

    syncMetadataDocs(store as never, "/display/0", metadata, { shellChildren: [] });

    const displayDoc = store.get("/display/0");
    expect(displayDoc).toBeDefined();
    const displayRoot = displayDoc!.getMap("root");
    const terminalApp = findChildById(rootChildren(displayDoc!), "app:com.apple.Terminal")!;
    const textEditApp = findChildById(rootChildren(displayDoc!), "app:com.apple.TextEdit")!;
    const terminalWindow = (terminalApp.get("_children") as Y.Array<Y.Map<unknown>>).get(0);
    const textEditWindow = (textEditApp.get("_children") as Y.Array<Y.Map<unknown>>).get(0);
    terminalWindow.set("z", 1);
    terminalWindow.set("focused", "false");
    textEditWindow.set("z", 0);
    textEditWindow.set("focused", "true");

    syncMetadataDocs(store as never, "/display/0", withScreen({
      ...metadata,
      windowRects: [
        { pid: 10, cgWindowId: 101, bundleId: "com.apple.Terminal", x: 11, y: 21, w: 800, h: 600, title: "Main updated" },
        { pid: 11, cgWindowId: 102, bundleId: "com.apple.TextEdit", x: 41, y: 51, w: 700, h: 500, title: "Doc" },
      ],
    }), { shellChildren: [] });

    expect(terminalWindow.get("z")).toBe(0);
    expect(terminalWindow.get("focused")).toBe("true");
    expect(textEditWindow.get("z")).toBe(1);
    expect(textEditWindow.get("focused")).toBe("false");
  });

  test("adopts native window stack when the doc was previously in sync and macOS focused a different window", () => {
    const store = makeStore();
    const metadata = withScreen({
      apps: [
        { pid: 10, bundleId: "com.apple.Terminal", name: "Terminal", regular: true },
        { pid: 11, bundleId: "com.apple.TextEdit", name: "TextEdit", regular: true },
      ],
      windowRects: [
        { pid: 10, cgWindowId: 101, bundleId: "com.apple.Terminal", x: 10, y: 20, w: 800, h: 600, title: "Main" },
        { pid: 11, cgWindowId: 102, bundleId: "com.apple.TextEdit", x: 40, y: 50, w: 700, h: 500, title: "Doc" },
      ],
      frontPid: 10,
      frontBundleId: "com.apple.Terminal",
      frontName: "Terminal",
    });

    syncMetadataDocs(store as never, "/display/0", metadata, { shellChildren: [] });
    syncMetadataDocs(store as never, "/display/0", withScreen({
      ...metadata,
      windowRects: [
        { pid: 11, cgWindowId: 102, bundleId: "com.apple.TextEdit", x: 40, y: 50, w: 700, h: 500, title: "Doc" },
        { pid: 10, cgWindowId: 101, bundleId: "com.apple.Terminal", x: 10, y: 20, w: 800, h: 600, title: "Main" },
      ],
      frontPid: 11,
      frontBundleId: "com.apple.TextEdit",
      frontName: "TextEdit",
    }), { shellChildren: [] });

    const displayDoc = store.get("/display/0")!;
    const terminalApp = findChildById(rootChildren(displayDoc), "app:com.apple.Terminal")!;
    const textEditApp = findChildById(rootChildren(displayDoc), "app:com.apple.TextEdit")!;
    const terminalWindow = (terminalApp.get("_children") as Y.Array<Y.Map<unknown>>).get(0);
    const textEditWindow = (textEditApp.get("_children") as Y.Array<Y.Map<unknown>>).get(0);
    expect(terminalWindow.get("z")).toBe(1);
    expect(terminalWindow.get("focused")).toBe("false");
    expect(textEditWindow.get("z")).toBe(0);
    expect(textEditWindow.get("focused")).toBe("true");
  });

  test("two windows from the same app keep independent positions after a move", () => {
    const store = makeStore();
    const metadata = withScreen({
      apps: [
        { pid: 10, bundleId: "com.apple.Terminal", name: "Terminal", regular: true },
      ],
      windowRects: [
        { pid: 10, cgWindowId: 101, bundleId: "com.apple.Terminal", x: 10, y: 20, w: 800, h: 600, title: "Term 1" },
        { pid: 10, cgWindowId: 102, bundleId: "com.apple.Terminal", x: 40, y: 50, w: 800, h: 600, title: "Term 2" },
      ],
      frontPid: 10,
      frontBundleId: "com.apple.Terminal",
      frontName: "Terminal",
    });

    // Initial sync
    syncMetadataDocs(store as never, "/display/0", metadata, { shellChildren: [] });

    const displayRoot = store.get("/display/0")!.getMap("root");

    // Move window 101 via CRDT (simulating web UI drag)
    applyWindowPosition(displayRoot, 101, 300, 200, { now: Date.now(), source: "webui", phase: "settling" });

    // Refresh with native still at old positions (lease protects 101)
    syncMetadataDocs(store as never, "/display/0", metadata, { shellChildren: [] });

    // Now native catches up: 101 moved, 102 unchanged
    syncMetadataDocs(store as never, "/display/0", withScreen({
      ...metadata,
      windowRects: [
        { pid: 10, cgWindowId: 101, bundleId: "com.apple.Terminal", x: 300, y: 200, w: 800, h: 600, title: "Term 1" },
        { pid: 10, cgWindowId: 102, bundleId: "com.apple.Terminal", x: 40, y: 50, w: 800, h: 600, title: "Term 2" },
      ],
    }), { shellChildren: [] });

    // Per-window docs should have correct independent positions
    const win101 = store.get("/windows/101")!.getMap("root");
    const win102 = store.get("/windows/102")!.getMap("root");
    expect(win101.get("x")).toBe(300);
    expect(win101.get("y")).toBe(200);
    expect(win102.get("x")).toBe(40);
    expect(win102.get("y")).toBe(50);

    // Display doc window nodes should also be correct
    const app = findChildById(rootChildren(store.get("/display/0")!), "app:com.apple.Terminal")!;
    const windows = app.get("_children") as Y.Array<Y.Map<unknown>>;
    const w101 = findChildById(windows, "Window:101")!;
    const w102 = findChildById(windows, "Window:102")!;
    expect(w101.get("x")).toBe(300);
    expect(w101.get("y")).toBe(200);
    expect(w102.get("x")).toBe(40);
    expect(w102.get("y")).toBe(50);
  });

  test("same-app windows don't cross-contaminate during z-order swap", () => {
    const store = makeStore();
    const metadata = withScreen({
      apps: [
        { pid: 10, bundleId: "com.apple.Terminal", name: "Terminal", regular: true },
      ],
      windowRects: [
        { pid: 10, cgWindowId: 101, bundleId: "com.apple.Terminal", x: 10, y: 20, w: 800, h: 600, title: "Term 1" },
        { pid: 10, cgWindowId: 102, bundleId: "com.apple.Terminal", x: 400, y: 50, w: 800, h: 600, title: "Term 2" },
      ],
      frontPid: 10,
      frontBundleId: "com.apple.Terminal",
      frontName: "Terminal",
    });

    // Sync twice to populate lastNative
    syncMetadataDocs(store as never, "/display/0", metadata, { shellChildren: [] });
    syncMetadataDocs(store as never, "/display/0", metadata, { shellChildren: [] });

    // Move window 101 via CRDT
    const displayRoot = store.get("/display/0")!.getMap("root");
    applyWindowPosition(displayRoot, 101, 300, 200, { now: Date.now(), source: "webui", phase: "settling" });

    // Now native catches up AND z-order swaps (102 comes to front)
    syncMetadataDocs(store as never, "/display/0", withScreen({
      ...metadata,
      windowRects: [
        { pid: 10, cgWindowId: 102, bundleId: "com.apple.Terminal", x: 400, y: 50, w: 800, h: 600, title: "Term 2" },
        { pid: 10, cgWindowId: 101, bundleId: "com.apple.Terminal", x: 300, y: 200, w: 800, h: 600, title: "Term 1" },
      ],
    }), { shellChildren: [] });

    // After z-order swap + position change, positions must not cross
    const win101 = store.get("/windows/101")!.getMap("root");
    const win102 = store.get("/windows/102")!.getMap("root");
    expect(win101.get("x")).toBe(300);
    expect(win101.get("y")).toBe(200);
    expect(win102.get("x")).toBe(400);
    expect(win102.get("y")).toBe(50);

    // Subsequent refresh with same z-order should be stable
    syncMetadataDocs(store as never, "/display/0", withScreen({
      ...metadata,
      windowRects: [
        { pid: 10, cgWindowId: 102, bundleId: "com.apple.Terminal", x: 400, y: 50, w: 800, h: 600, title: "Term 2" },
        { pid: 10, cgWindowId: 101, bundleId: "com.apple.Terminal", x: 300, y: 200, w: 800, h: 600, title: "Term 1" },
      ],
    }), { shellChildren: [] });

    expect(win101.get("x")).toBe(300);
    expect(win101.get("y")).toBe(200);
    expect(win102.get("x")).toBe(400);
    expect(win102.get("y")).toBe(50);
  });

  test("removes stale per-window docs when windows disappear", () => {
    const store = makeStore();
    const metadata = {
      apps: [
        { pid: 10, bundleId: "com.apple.Terminal", name: "Terminal", regular: true },
      ],
      windowRects: [
        { pid: 10, cgWindowId: 101, bundleId: "com.apple.Terminal", x: 10, y: 20, w: 800, h: 600, title: "Main" },
      ],
      frontPid: 10,
      frontBundleId: "com.apple.Terminal",
      frontName: "Terminal",
    };

    syncMetadataDocs(store as never, "/display/0", withScreen(metadata), { shellChildren: [] });
    expect(store.get("/windows/101")).toBeDefined();

    syncMetadataDocs(store as never, "/display/0", withScreen({ ...metadata, windowRects: [] }), { shellChildren: [] });
    expect(store.get("/windows/101")).toBeUndefined();
  });

  test("pruneAppByBundleId removes app node and owned window docs", () => {
    const store = makeStore();
    syncMetadataDocs(store as never, "/display/0", withScreen({
      apps: [
        { pid: 10, bundleId: "com.apple.Terminal", name: "Terminal", regular: true },
      ],
      windowRects: [
        { pid: 10, cgWindowId: 101, bundleId: "com.apple.Terminal", x: 10, y: 20, w: 800, h: 600, title: "Main" },
      ],
      frontPid: 10,
      frontBundleId: "com.apple.Terminal",
      frontName: "Terminal",
    }), { shellChildren: [] });

    pruneAppByBundleId(store as never, "/display/0", "com.apple.Terminal");

    const children = rootChildren(store.getOrCreate("/display/0"));
    expect(findChildById(children, "app:com.apple.Terminal")).toBeUndefined();
    expect(store.get("/windows/101")).toBeUndefined();
  });
});
