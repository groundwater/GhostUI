/**
 * Unit tests for treeNodeToDescriptor and snapshotToTree.
 * Uses inline fixtures — no app boot required.
 */
import { describe, test, expect } from "bun:test";
import type { AXNode } from "../apps/types.js";
import {
  treeNodeToDescriptor,
  snapshotToTree,
  axToTree,
  resetScreenDims,
  type TreeNode,
  type SnapshotResponse,
} from "./ax-tree.js";
import { populateFromDescriptor, buildDoc } from "../crdt/schema.js";
import { yMapToJSON } from "../server/cli.js";
import { toGUIML } from "../cli/guiml.js";
import type { PlainNode } from "../cli/types.js";

// ─── treeNodeToDescriptor ─────────────────────────────────────────

describe("treeNodeToDescriptor", () => {
  test("basic props → attrs", () => {
    const tree: TreeNode = {
      id: "Button:Save:0",
      tag: "Button",
      props: { title: "Save", label: "Save Button" },
    };
    const desc = treeNodeToDescriptor(tree);
    expect(desc.type).toBe("Button");
    expect(desc.id).toBe("Button:Save:0");
    expect(desc.attrs).toEqual({ title: "Save", label: "Save Button" });
    expect(desc.children).toBeUndefined();
  });

  test("children are recursively converted", () => {
    const tree: TreeNode = {
      id: "Window:Main:0",
      tag: "Window",
      props: { title: "Main" },
      children: [
        { id: "Button:OK:0", tag: "Button", props: { title: "OK" } },
      ],
    };
    const desc = treeNodeToDescriptor(tree);
    expect(desc.children).toBeDefined();
    expect(desc.children!.length).toBe(1);
    expect(desc.children![0].type).toBe("Button");
  });

  test("MenuBarItem gating: closed hides children", () => {
    const tree: TreeNode = {
      id: "MenuBarItem:File:0",
      tag: "MenuBarItem",
      props: { title: "File" },
      children: [
        {
          id: "Menu::0",
          tag: "Menu",
          props: {},
          children: [
            { id: "MenuItem:New:0", tag: "MenuItem", props: { title: "New" } },
          ],
        },
      ],
    };
    const desc = treeNodeToDescriptor(tree);
    // Not selected → children should be empty
    expect(desc.children).toBeUndefined();
  });

  test("MenuBarItem gating: open includes children", () => {
    const tree: TreeNode = {
      id: "MenuBarItem:File:0",
      tag: "MenuBarItem",
      props: { title: "File", selected: "true" },
      children: [
        {
          id: "Menu::0",
          tag: "Menu",
          props: {},
          children: [
            { id: "MenuItem:New:0", tag: "MenuItem", props: { title: "New" } },
          ],
        },
      ],
    };
    const desc = treeNodeToDescriptor(tree);
    expect(desc.children).toBeDefined();
    expect(desc.children!.length).toBe(1);
    expect(desc.children![0].type).toBe("Menu");
  });

  test("MenuExtra gating: closed hides children", () => {
    const tree: TreeNode = {
      id: "MenuExtra:WiFi:0",
      tag: "MenuExtra",
      props: { title: "WiFi" },
      children: [
        { id: "Menu::0", tag: "Menu", props: {} },
      ],
    };
    const desc = treeNodeToDescriptor(tree);
    expect(desc.children).toBeUndefined();
  });

  test("MenuItem always includes children (submenus)", () => {
    const tree: TreeNode = {
      id: "MenuItem:Recent:0",
      tag: "MenuItem",
      props: { title: "Recent", hasSubmenu: "true" },
      children: [
        {
          id: "Menu::0",
          tag: "Menu",
          props: {},
          children: [
            { id: "MenuItem:File1:0", tag: "MenuItem", props: { title: "File1" } },
          ],
        },
      ],
    };
    const desc = treeNodeToDescriptor(tree);
    expect(desc.children).toBeDefined();
    expect(desc.children!.length).toBe(1);
    expect(desc.children![0].children).toBeDefined();
  });
});

// ─── snapshotToTree ───────────────────────────────────────────────

function makeSnap(overrides?: Partial<SnapshotResponse>): SnapshotResponse {
  return {
    schemaVersion: "1",
    focus: { frontmostBundleId: "com.apple.finder", frontmostPid: 123 },
    channels: {
      focused: {
        items: [
          {
            app: "Finder",
            bundleId: "com.apple.finder",
            pid: 123,
            frame: { x: 0, y: 25, width: 800, height: 600 },
            menuBar: {
              role: "AXMenuBar",
              children: [
                { role: "AXMenuBarItem", title: "File" },
              ],
            },
            tree: {
              role: "AXApplication",
              title: "Finder",
              children: [
                {
                  role: "AXWindow",
                  title: "Documents",
                  children: [
                    { role: "AXButton", title: "Close" },
                  ],
                },
              ],
            },
          },
        ],
      },
    },
    ...overrides,
  };
}

import { beforeEach } from "bun:test";

describe("snapshotToTree", () => {
  beforeEach(() => resetScreenDims());

  test("produces Display root with correct tag", () => {
    const tree = snapshotToTree(makeSnap());
    expect(tree).not.toBeNull();
    expect(tree!.tag).toBe("Display");
    expect(tree!.id).toBe("Display::0");
  });

  test("Display has screen dimensions", () => {
    const tree = snapshotToTree(makeSnap());
    expect(tree!.props.screenW).toBeDefined();
    expect(tree!.props.screenH).toBeDefined();
  });

  test("Application with bundleId", () => {
    const tree = snapshotToTree(makeSnap());
    const app = tree!.children!.find(c => c.tag === "Application");
    expect(app).toBeDefined();
    expect(app!.props.bundleId).toBe("com.apple.finder");
    expect(app!.id).toBe("app:com.apple.finder");
  });

  test("MenuBar placed at Display level, not inside Window", () => {
    const tree = snapshotToTree(makeSnap());
    // MenuBar should be a Display-level child
    const menuBar = tree!.children!.find(c => c.tag === "MenuBar");
    expect(menuBar).toBeDefined();
    // Window should NOT contain MenuBar
    const app = tree!.children!.find(c => c.tag === "Application");
    const win = app!.children!.find(c => c.tag === "Window");
    expect(win).toBeDefined();
    expect(win!.children!.some(c => c.tag === "MenuBar")).toBe(false);
    expect(win!.children!.some(c => c.tag === "Button")).toBe(true);
  });

  test("window frame is injected", () => {
    const tree = snapshotToTree(makeSnap());
    const app = tree!.children!.find(c => c.tag === "Application");
    const win = app!.children!.find(c => c.tag === "Window");
    expect(win!.props.x).toBe("0");
    expect(win!.props.y).toBe("25");
    expect(win!.props.w).toBe("800");
    expect(win!.props.h).toBe("600");
  });

  test("MenuExtras at Display level", () => {
    const tree = snapshotToTree(makeSnap({
      menuExtras: [
        {
          bundleId: "com.apple.controlcenter",
          items: [
            { role: "AXMenuBarItem", title: "WiFi" },
          ],
        },
      ],
    }));
    const extras = tree!.children!.find(c => c.tag === "MenuExtras");
    expect(extras).toBeDefined();
    expect(extras!.children!.length).toBe(1);
    expect(extras!.children![0].tag).toBe("MenuExtra");
    expect(extras!.children![0].props.bundleId).toBe("com.apple.controlcenter");
  });

  test("null when no focused items", () => {
    const tree = snapshotToTree({
      schemaVersion: "1",
      focus: { frontmostBundleId: "", frontmostPid: 0 },
      channels: { focused: { items: [] } },
    });
    expect(tree).toBeNull();
  });
});

// ─── Multi-window apps ────────────────────────────────────────────

describe("snapshotToTree — multi-window apps", () => {
  beforeEach(() => resetScreenDims());

  function makeMultiWindowSnap(): SnapshotResponse {
    return {
      schemaVersion: "1",
      focus: { frontmostBundleId: "com.apple.Terminal", frontmostPid: 341 },
      channels: {
        focused: {
          items: [
            {
              app: "Terminal",
              bundleId: "com.apple.Terminal",
              pid: 341,
              frame: { x: 100, y: 50, width: 800, height: 600 },
              menuBar: {
                role: "AXMenuBar",
                children: [
                  { role: "AXMenuBarItem", title: "Shell" },
                ],
              },
              tree: {
                role: "AXApplication",
                title: "Terminal",
                children: [
                  {
                    role: "AXWindow",
                    title: "Window1",
                    children: [
                      { role: "AXTextArea", title: "" },
                    ],
                  },
                  {
                    role: "AXWindow",
                    title: "Window2",
                    children: [
                      { role: "AXTextArea", title: "" },
                    ],
                  },
                ],
              },
            },
          ],
        },
      },
    };
  }

  test("both windows appear as children of Application", () => {
    const tree = snapshotToTree(makeMultiWindowSnap());
    const app = tree!.children!.find(c => c.tag === "Application");
    expect(app).toBeDefined();
    const windows = app!.children!.filter(c => c.tag === "Window");
    expect(windows.length).toBe(2);
    expect(windows[0].props.title).toBe("Window1");
    expect(windows[1].props.title).toBe("Window2");
  });

  test("MenuBar is at Display level, not in any Window", () => {
    const tree = snapshotToTree(makeMultiWindowSnap());
    // MenuBar should be a Display-level child
    const menuBar = tree!.children!.find(c => c.tag === "MenuBar");
    expect(menuBar).toBeDefined();
    // Neither window should contain MenuBar
    const app = tree!.children!.find(c => c.tag === "Application");
    const windows = app!.children!.filter(c => c.tag === "Window");
    expect(windows[0].children!.some(c => c.tag === "MenuBar")).toBe(false);
    expect(windows[1].children?.some(c => c.tag === "MenuBar") ?? false).toBe(false);
  });

  test("each window gets its own frame from AX props", () => {
    // Add per-window frames to the AX tree
    const snap = makeMultiWindowSnap();
    const axChildren = snap.channels.focused!.items[0].tree!.children!;
    axChildren[0].frame = { x: 100, y: 50, width: 800, height: 600 };
    axChildren[1].frame = { x: 300, y: 200, width: 640, height: 480 };

    const tree = snapshotToTree(snap);
    const app = tree!.children!.find(c => c.tag === "Application");
    const windows = app!.children!.filter(c => c.tag === "Window");

    // Window1 should have its own frame
    expect(windows[0].props.x).toBe("100");
    expect(windows[0].props.y).toBe("50");
    expect(windows[0].props.w).toBe("800");
    expect(windows[0].props.h).toBe("600");

    // Window2 should have its own DIFFERENT frame
    expect(windows[1].props.x).toBe("300");
    expect(windows[1].props.y).toBe("200");
    expect(windows[1].props.w).toBe("640");
    expect(windows[1].props.h).toBe("480");
  });

  test("window without own frame falls back to front.frame", () => {
    // Only first window has a frame, second doesn't
    const snap = makeMultiWindowSnap();
    const axChildren = snap.channels.focused!.items[0].tree!.children!;
    axChildren[0].frame = { x: 100, y: 50, width: 800, height: 600 };
    // axChildren[1] has no frame — should fall back to front.frame

    const tree = snapshotToTree(snap);
    const app = tree!.children!.find(c => c.tag === "Application");
    const windows = app!.children!.filter(c => c.tag === "Window");

    // Window1: own frame
    expect(windows[0].props.x).toBe("100");
    expect(windows[0].props.y).toBe("50");

    // Window2: falls back to front.frame (100, 50, 800, 600)
    expect(windows[1].props.x).toBe("100");
    expect(windows[1].props.y).toBe("50");
    expect(windows[1].props.w).toBe("800");
    expect(windows[1].props.h).toBe("600");
  });

  test("collapses degenerate nested Window wrappers from the focused AX tree", () => {
    const snap = makeSnap({
      channels: {
        focused: {
          items: [
            {
              app: "Terminal",
              bundleId: "com.apple.Terminal",
              pid: 341,
              frame: { x: 100, y: 50, width: 800, height: 600 },
              tree: {
                role: "AXApplication",
                title: "Terminal",
                children: [
                  {
                    role: "AXWindow",
                    title: "Wrapper",
                    frame: { x: 100, y: 50, width: 800, height: 600 },
                    children: [
                      {
                        role: "AXWindow",
                        title: "Inner",
                        frame: { x: 100, y: 50, width: 800, height: 600 },
                        children: [
                          { role: "AXTextArea", value: "$ pwd" },
                        ],
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
      },
    });

    const tree = snapshotToTree(snap);
    const app = tree!.children!.find(c => c.tag === "Application");
    const windows = app!.children!.filter(c => c.tag === "Window");

    expect(windows).toHaveLength(1);
    expect(windows[0].props.title).toBe("Inner");
    expect(windows[0].children?.[0].tag).toBe("TextArea");
  });

  test("full pipeline: both windows appear in GUIML output", () => {
    const tree = snapshotToTree(makeMultiWindowSnap());
    const desc = treeNodeToDescriptor(tree!);
    const doc = buildDoc(desc);
    const json = yMapToJSON(doc.getMap("root")) as PlainNode;
    const guiml = toGUIML([json]);
    expect(guiml).toContain("Window#Window1");
    expect(guiml).toContain("Window#Window2");
    expect(guiml).toContain("Application#com.apple.Terminal");
  });
});

// ─── separateMenuBar (tested through snapshotToTree) ──────────────

describe("snapshotToTree — menu bar handling", () => {
  test("strips ALL AXMenuBars from app tree (not just first)", () => {
    const tree = snapshotToTree(makeSnap({
      channels: {
        focused: {
          items: [
            {
              app: "Finder",
              bundleId: "com.apple.finder",
              pid: 123,
              menuBar: { role: "AXMenuBar", children: [{ role: "AXMenuBarItem", title: "File" }] },
              tree: {
                role: "AXApplication",
                title: "Finder",
                children: [
                  // Extra extraneous empty MenuBar from macOS
                  { role: "AXMenuBar" },
                  {
                    role: "AXWindow",
                    title: "Docs",
                    children: [{ role: "AXButton", title: "Close" }],
                  },
                ],
              },
            },
          ],
        },
      },
    }));
    const app = tree!.children!.find(c => c.tag === "Application");
    // The empty MenuBar should have been filtered by empty MenuBar filtering (#149)
    // The real one is injected inside the Window
    const menuBarsInApp = app!.children!.filter(c => c.tag === "MenuBar");
    // MenuBar should only appear inside Window, not as direct App child
    expect(menuBarsInApp.length).toBe(0);
  });
});
