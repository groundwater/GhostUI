/**
 * Test: GhostUI (or any overlay/tool app) should never be treated as the
 * foreground app in the CRDT. When GhostUI is reported as frontmost by the
 * native layer, the refresher should skip it and treat the *real* user-facing
 * app as foreground.
 *
 * Bug: Terminal shows as a visual-only stub because GhostUI steals frontmost
 * status. The native axGetFrontmostPid() returns GhostUI's PID, so the
 * refresher marks every other app as visual-only.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import {
  snapshotToTree,
  treeNodeToDescriptor,
  resetScreenDims,
  type SnapshotResponse,
} from "./ax-tree.js";
import { populateFromDescriptor, type NodeDescriptor } from "../crdt/schema.js";
import { yMapToJSON } from "../server/cli.js";
import { toGUIML } from "../cli/guiml.js";
import type { PlainNode } from "../cli/types.js";
import * as Y from "yjs";

// ─── Helpers ──────────────────────────────────────────────────────

/** Minimal applySystemUpdate reproduction (from refresher.ts background-app logic). */
function applySystemUpdate(doc: Y.Doc, descriptor: NodeDescriptor, windowRects?: { bundleId: string; x: number; y: number; w: number; h: number }[]): void {
  const root = doc.getMap("root");
  doc.transact(() => {
    if (root.get("type") !== descriptor.type) root.set("type", descriptor.type);
    if (root.get("_tag") !== descriptor.type) root.set("_tag", descriptor.type);
    const id = descriptor.id || descriptor.type;
    if (root.get("id") !== id) root.set("id", id);

    // Copy Display-level attrs
    if (descriptor.attrs) {
      for (const [key, value] of Object.entries(descriptor.attrs)) {
        if (value !== undefined && value !== null && root.get(key) !== value) {
          root.set(key, value);
        }
      }
    }

    let ychildren = root.get("_children") as Y.Array<Y.Map<unknown>> | undefined;
    if (!ychildren) {
      ychildren = new Y.Array<Y.Map<unknown>>();
      root.set("_children", ychildren);
    }

    const appDesc = descriptor.children?.find(c => c.type === "Application");
    if (appDesc) {
      appDesc.attrs = { ...appDesc.attrs, foreground: "true" };
      let found = false;
      for (let i = 0; i < ychildren.length; i++) {
        const child = ychildren.get(i);
        const childType = child.get("type") || child.get("_tag");
        if (childType === "Application") {
          if (child.get("id") === appDesc.id) {
            populateFromDescriptor(child, appDesc);
            found = true;
          } else {
            // Background app — mark not foreground
            const curFg = child.get("foreground");
            if (curFg !== "false") {
              child.set("foreground", "false");
            }

            // Check for real content vs visual-only stubs
            const bgChildren = child.get("_children") as Y.Array<Y.Map<unknown>> | undefined;
            const hasRealContent = bgChildren && bgChildren.length > 0 && (() => {
              for (let j = 0; j < bgChildren.length; j++) {
                if (!bgChildren.get(j).get("visualOnly")) return true;
              }
              return false;
            })();

            if (!hasRealContent && windowRects) {
              const appId = child.get("id") as string | undefined;
              const bgBundleId = appId?.startsWith("app:") ? appId.slice(4) : undefined;
              if (bgBundleId) {
                const appWindows = windowRects.filter(wr => wr.bundleId === bgBundleId);
                if (appWindows.length > 0) {
                  if (bgChildren) bgChildren.delete(0, bgChildren.length);
                  const arr = bgChildren || new Y.Array<Y.Map<unknown>>();
                  if (!bgChildren) child.set("_children", arr);
                  for (let wi = 0; wi < appWindows.length; wi++) {
                    const wr = appWindows[wi];
                    const winMap = new Y.Map<unknown>();
                    arr.push([winMap]);
                    winMap.set("type", "Window");
                    winMap.set("_tag", "Window");
                    winMap.set("id", `Window::${wi}`);
                    winMap.set("x", Math.round(wr.x));
                    winMap.set("y", Math.round(wr.y));
                    winMap.set("w", Math.round(wr.w));
                    winMap.set("h", Math.round(wr.h));
                    winMap.set("visualOnly", "true");
                  }
                }
              }
            }
          }
        }
      }
      if (!found) {
        const newMap = new Y.Map<unknown>();
        ychildren.push([newMap]);
        populateFromDescriptor(newMap, appDesc);
      }
    }

    // Discover background apps from windowRects
    if (windowRects) {
      const existingBundleIds = new Set<string>();
      for (let i = 0; i < ychildren.length; i++) {
        const child = ychildren.get(i);
        if ((child.get("type") || child.get("_tag")) !== "Application") continue;
        const cid = child.get("id") as string | undefined;
        const bid = cid?.startsWith("app:") ? cid.slice(4) : undefined;
        if (bid) existingBundleIds.add(bid);
      }

      const windowsByBundle = new Map<string, typeof windowRects>();
      for (const wr of windowRects) {
        if (!wr.bundleId) continue;
        if (existingBundleIds.has(wr.bundleId)) continue;
        if (!windowsByBundle.has(wr.bundleId)) windowsByBundle.set(wr.bundleId, []);
        windowsByBundle.get(wr.bundleId)!.push(wr);
      }

      for (const [bundleId, windows] of windowsByBundle) {
        const appMap = new Y.Map<unknown>();
        ychildren.push([appMap]);
        appMap.set("type", "Application");
        appMap.set("_tag", "Application");
        appMap.set("id", `app:${bundleId}`);
        appMap.set("bundleId", bundleId);
        appMap.set("foreground", "false");

        const winArr = new Y.Array<Y.Map<unknown>>();
        appMap.set("_children", winArr);
        for (let wi = 0; wi < windows.length; wi++) {
          const wr = windows[wi];
          const winMap = new Y.Map<unknown>();
          winArr.push([winMap]);
          winMap.set("type", "Window");
          winMap.set("_tag", "Window");
          winMap.set("id", `Window::${wi}`);
          winMap.set("x", Math.round(wr.x));
          winMap.set("y", Math.round(wr.y));
          winMap.set("w", Math.round(wr.w));
          winMap.set("h", Math.round(wr.h));
          winMap.set("visualOnly", "true");
        }
      }
    }
  });
}

function getAppNode(doc: Y.Doc, bundleId: string): Y.Map<unknown> | undefined {
  const root = doc.getMap("root");
  const ychildren = root.get("_children") as Y.Array<Y.Map<unknown>> | undefined;
  if (!ychildren) return undefined;
  for (let i = 0; i < ychildren.length; i++) {
    const child = ychildren.get(i);
    if (child.get("id") === `app:${bundleId}`) return child;
  }
  return undefined;
}

// ─── The core bug scenario ───────────────────────────────────────

describe("overlay app should not steal foreground (#background-bug)", () => {
  /**
   * Scenario: GhostUI is an overlay tool. Terminal is the real user-facing app.
   * The native layer reports GhostUI as frontmostBundleId because it has
   * .regular activation policy. Terminal windows exist in windowRects but
   * Terminal never gets polled as foreground, so its windows are always
   * visual-only stubs.
   *
   * Expected: The snapshot/refresher should recognize that GhostUI is a tool app
   * and treat Terminal as the real foreground app.
   */

  const GHOSTUI_BUNDLE = "org.ghostvm.GhostUI";
  const TERMINAL_BUNDLE = "com.apple.Terminal";

  test("when only GhostUI is ever frontmost, Terminal windows get visual-only stubs", () => {
    const doc = new Y.Doc();

    // GhostUI is frontmost with its window
    const ghostDesc: NodeDescriptor = {
      type: "Display",
      id: "Display::0",
      attrs: { screenW: 1440, screenH: 900, frontApp: GHOSTUI_BUNDLE },
      children: [
        {
          type: "Application",
          id: `app:${GHOSTUI_BUNDLE}`,
          attrs: { bundleId: GHOSTUI_BUNDLE, title: "GhostUI" },
          children: [
            { type: "Window", id: "Window::0", attrs: { title: "GhostUI" } },
          ],
        },
      ],
    };

    // Terminal has visible windows but isn't the focused app
    const terminalRects = [
      { bundleId: TERMINAL_BUNDLE, x: 73, y: 25, w: 787, h: 721 },
      { bundleId: TERMINAL_BUNDLE, x: 811, y: 25, w: 681, h: 735 },
    ];

    applySystemUpdate(doc, ghostDesc, terminalRects);

    // Terminal gets visual-only stubs — this is the BUG
    const terminal = getAppNode(doc, TERMINAL_BUNDLE)!;
    expect(terminal).toBeDefined();
    expect(terminal.get("foreground")).toBe("false");

    const termChildren = terminal.get("_children") as Y.Array<Y.Map<unknown>>;
    expect(termChildren.length).toBe(2);
    // Both windows are visual-only stubs
    expect(termChildren.get(0).get("visualOnly")).toBe("true");
    expect(termChildren.get(1).get("visualOnly")).toBe("true");
  });

  test("after Terminal is focused then GhostUI reclaims, Terminal keeps content", () => {
    const doc = new Y.Doc();

    // Step 1: Terminal is foreground with real content
    const termDesc: NodeDescriptor = {
      type: "Display",
      id: "Display::0",
      attrs: { screenW: 1440, screenH: 900, frontApp: TERMINAL_BUNDLE },
      children: [
        {
          type: "Application",
          id: `app:${TERMINAL_BUNDLE}`,
          attrs: { bundleId: TERMINAL_BUNDLE, title: "Terminal" },
          children: [
            {
              type: "Window",
              id: "Window:bash:0",
              attrs: { title: "bash" },
              children: [
                { type: "TextArea", id: "TextArea::0", attrs: { value: "$ ls" } },
              ],
            },
          ],
        },
      ],
    };
    applySystemUpdate(doc, termDesc);

    const term1 = getAppNode(doc, TERMINAL_BUNDLE)!;
    expect(term1.get("foreground")).toBe("true");
    const children1 = term1.get("_children") as Y.Array<Y.Map<unknown>>;
    expect(children1.length).toBe(1);
    expect(children1.get(0).get("title")).toBe("bash");

    // Step 2: GhostUI steals foreground
    const ghostDesc: NodeDescriptor = {
      type: "Display",
      id: "Display::0",
      attrs: { screenW: 1440, screenH: 900, frontApp: GHOSTUI_BUNDLE },
      children: [
        {
          type: "Application",
          id: `app:${GHOSTUI_BUNDLE}`,
          attrs: { bundleId: GHOSTUI_BUNDLE, title: "GhostUI" },
          children: [
            { type: "Window", id: "Window::0", attrs: { title: "GhostUI" } },
          ],
        },
      ],
    };
    applySystemUpdate(doc, ghostDesc);

    // Terminal should keep its real content (not replaced with visual-only stubs)
    const term2 = getAppNode(doc, TERMINAL_BUNDLE)!;
    expect(term2.get("foreground")).toBe("false");
    const children2 = term2.get("_children") as Y.Array<Y.Map<unknown>>;
    expect(children2.length).toBe(1);
    // Real content is preserved — window still has title and children
    expect(children2.get(0).get("title")).toBe("bash");
    expect(children2.get(0).has("visualOnly")).toBe(false);
  });
});

// ─── Native layer fix: skip own bundleId ─────────────────────────

describe("buildSnapshot should skip own app as frontmost", () => {
  beforeEach(() => resetScreenDims());

  test("snapshot with GhostUI as frontmost should still build a valid tree", () => {
    // This tests the snapshot pipeline when the snapshot response says
    // the frontmost app is GhostUI — the tree should still be valid
    // (this is a pipeline sanity check, the real fix is in native code)
    const snap: SnapshotResponse = {
      schemaVersion: "1",
      focus: { frontmostBundleId: GHOSTUI_BUNDLE, frontmostPid: 100 },
      windowRects: [
        { pid: 200, bundleId: TERMINAL_BUNDLE, x: 73, y: 25, w: 787, h: 721 },
      ],
      channels: {
        focused: {
          items: [
            {
              app: "GhostUI",
              bundleId: GHOSTUI_BUNDLE,
              pid: 100,
              tree: {
                role: "AXApplication",
                title: "GhostUI",
                children: [
                  { role: "AXWindow", title: "GhostUI" },
                ],
              },
            },
          ],
        },
      },
    };
    const tree = snapshotToTree(snap);
    expect(tree).not.toBeNull();
    expect(tree!.tag).toBe("Display");
    // GhostUI appears as the Application
    const app = tree!.children!.find(c => c.tag === "Application");
    expect(app).toBeDefined();
    expect(app!.props.bundleId).toBe(GHOSTUI_BUNDLE);
  });
});

const GHOSTUI_BUNDLE = "org.ghostvm.GhostUI";
const TERMINAL_BUNDLE = "com.apple.Terminal";
const FINDER_BUNDLE = "com.apple.finder";

// ─── Multiple app focus cycling ──────────────────────────────────

describe("focus cycling preserves app content (#background-bug)", () => {
  test("Terminal → Finder → Terminal: Terminal keeps content after round-trip", () => {
    const doc = new Y.Doc();

    // Terminal foreground
    applySystemUpdate(doc, {
      type: "Display", id: "Display::0",
      attrs: { screenW: 1440, screenH: 900, frontApp: TERMINAL_BUNDLE },
      children: [{
        type: "Application", id: `app:${TERMINAL_BUNDLE}`,
        attrs: { bundleId: TERMINAL_BUNDLE, title: "Terminal" },
        children: [{
          type: "Window", id: "Window:bash:0",
          attrs: { title: "bash" },
          children: [{ type: "TextArea", id: "TextArea::0", attrs: { value: "$ whoami" } }],
        }],
      }],
    });

    // Finder foreground
    applySystemUpdate(doc, {
      type: "Display", id: "Display::0",
      attrs: { screenW: 1440, screenH: 900, frontApp: FINDER_BUNDLE },
      children: [{
        type: "Application", id: `app:${FINDER_BUNDLE}`,
        attrs: { bundleId: FINDER_BUNDLE, title: "Finder" },
        children: [{
          type: "Window", id: "Window:Documents:0",
          attrs: { title: "Documents" },
        }],
      }],
    });

    // Terminal still has its real content
    const term = getAppNode(doc, TERMINAL_BUNDLE)!;
    expect(term.get("foreground")).toBe("false");
    const children = term.get("_children") as Y.Array<Y.Map<unknown>>;
    expect(children.length).toBe(1);
    expect(children.get(0).get("title")).toBe("bash");
    expect(children.get(0).has("visualOnly")).toBe(false);

    // Terminal foreground again
    applySystemUpdate(doc, {
      type: "Display", id: "Display::0",
      attrs: { screenW: 1440, screenH: 900, frontApp: TERMINAL_BUNDLE },
      children: [{
        type: "Application", id: `app:${TERMINAL_BUNDLE}`,
        attrs: { bundleId: TERMINAL_BUNDLE, title: "Terminal" },
        children: [{
          type: "Window", id: "Window:bash:0",
          attrs: { title: "bash" },
          children: [{ type: "TextArea", id: "TextArea::0", attrs: { value: "$ pwd" } }],
        }],
      }],
    });

    const term2 = getAppNode(doc, TERMINAL_BUNDLE)!;
    expect(term2.get("foreground")).toBe("true");
    const children2 = term2.get("_children") as Y.Array<Y.Map<unknown>>;
    expect(children2.get(0).get("title")).toBe("bash");
  });

  test("never-focused app with windowRects gets visual-only stubs, not real content", () => {
    const doc = new Y.Doc();

    // Only Finder was ever focused
    applySystemUpdate(doc, {
      type: "Display", id: "Display::0",
      attrs: { screenW: 1440, screenH: 900, frontApp: FINDER_BUNDLE },
      children: [{
        type: "Application", id: `app:${FINDER_BUNDLE}`,
        attrs: { bundleId: FINDER_BUNDLE, title: "Finder" },
        children: [{
          type: "Window", id: "Window:Documents:0",
          attrs: { title: "Documents" },
        }],
      }],
    }, [
      { bundleId: TERMINAL_BUNDLE, x: 100, y: 100, w: 800, h: 600 },
    ]);

    // Terminal was never focused — should have visual-only stubs
    const term = getAppNode(doc, TERMINAL_BUNDLE)!;
    expect(term).toBeDefined();
    expect(term.get("foreground")).toBe("false");
    const children = term.get("_children") as Y.Array<Y.Map<unknown>>;
    expect(children.length).toBe(1);
    expect(children.get(0).get("visualOnly")).toBe("true");
  });
});

// ─── GUIML rendering of visual-only windows ──────────────────────

describe("GUIML should not show visual-only placeholders for previously-focused apps", () => {
  test("app that was focused then backgrounded still shows window content in GUIML", () => {
    const doc = new Y.Doc();

    // Terminal was foreground
    const termDesc: NodeDescriptor = {
      type: "Display",
      id: "Display::0",
      attrs: { screenW: 1440, screenH: 900, frontApp: TERMINAL_BUNDLE },
      children: [
        {
          type: "Application",
          id: `app:${TERMINAL_BUNDLE}`,
          attrs: { bundleId: TERMINAL_BUNDLE, title: "Terminal" },
          children: [
            {
              type: "Window",
              id: "Window:bash:0",
              attrs: { title: "bash" },
              children: [
                { type: "TextArea", id: "TextArea::0", attrs: { value: "$ ls" } },
              ],
            },
          ],
        },
      ],
    };
    applySystemUpdate(doc, termDesc);

    // GhostUI takes over
    const ghostDesc: NodeDescriptor = {
      type: "Display",
      id: "Display::0",
      attrs: { screenW: 1440, screenH: 900, frontApp: GHOSTUI_BUNDLE },
      children: [
        {
          type: "Application",
          id: `app:${GHOSTUI_BUNDLE}`,
          attrs: { bundleId: GHOSTUI_BUNDLE, title: "GhostUI" },
          children: [
            { type: "Window", id: "Window::0", attrs: { title: "GhostUI" } },
          ],
        },
      ],
    };
    applySystemUpdate(doc, ghostDesc);

    // Render GUIML
    const json = yMapToJSON(doc.getMap("root")) as PlainNode;
    const guiml = toGUIML([json]);

    // Terminal's window should NOT show {... deflated}
    expect(guiml).not.toContain("{... deflated}");
    // Terminal's window should show its real content
    expect(guiml).toContain("Window#bash");
  });
});
