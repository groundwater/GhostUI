/**
 * Integration tests: AXNode → axToTree → treeNodeToDescriptor → populateFromDescriptor → yMapToJSON → toGUIML.
 * End-to-end pipeline verification — no app boot required.
 */
import { describe, test, expect } from "bun:test";
import type { AXNode } from "../apps/types.js";
import { axToTree, treeNodeToDescriptor, snapshotToTree, resetScreenDims, type SnapshotResponse } from "./ax-tree.js";
import { populateFromDescriptor, buildDoc } from "../crdt/schema.js";
import { yMapToJSON } from "../server/cli.js";
import { toGUIML } from "../cli/guiml.js";
import type { PlainNode } from "../cli/types.js";
import * as Y from "yjs";

/** Helper to create an AXNode concisely. */
function ax(role: string, props?: Partial<AXNode>, children?: AXNode[]): AXNode {
  return { role, ...props, children } as AXNode;
}

/** Run the full pipeline: AXNode → GUIML string. */
function pipelineToGUIML(axNode: AXNode): string {
  const tree = axToTree(axNode);
  const desc = treeNodeToDescriptor(tree);
  const doc = buildDoc(desc);
  const json = yMapToJSON(doc.getMap("root")) as PlainNode;
  return toGUIML([json]);
}

// ─── Simple window with buttons ───────────────────────────────────

describe("pipeline — simple window", () => {
  test("renders expected GUIML", () => {
    const guiml = pipelineToGUIML(
      ax("AXWindow", { title: "Settings" }, [
        ax("AXButton", { title: "Save" }),
        ax("AXButton", { title: "Cancel" }),
      ]),
    );
    expect(guiml).toContain("Window#Settings");
    expect(guiml).toContain("Button#Save");
    expect(guiml).toContain("Button#Cancel");
    expect(guiml).toContain("</Window>");
  });

  test("self-closing leaf renders correctly", () => {
    const guiml = pipelineToGUIML(ax("AXButton", { title: "OK" }));
    expect(guiml).toContain("Button#OK");
    expect(guiml).toContain("/>");
  });
});

// ─── Menu bar open vs closed ──────────────────────────────────────

describe("pipeline — menu bar open vs closed", () => {
  test("closed menu bar hides dropdown children", () => {
    const guiml = pipelineToGUIML(
      ax("AXMenuBar", {}, [
        ax("AXMenuBarItem", { title: "File" }, [
          ax("AXMenu", {}, [
            ax("AXMenuItem", { title: "New" }),
          ]),
        ]),
      ]),
    );
    expect(guiml).toContain("MenuBarItem#File");
    // Closed: no Menu children
    expect(guiml).not.toContain("MenuItem");
  });

  test("open menu bar shows dropdown children", () => {
    const guiml = pipelineToGUIML(
      ax("AXMenuBar", {}, [
        ax("AXMenuBarItem", { title: "File", capabilities: { selected: true } }, [
          ax("AXMenu", {}, [
            ax("AXMenuItem", { title: "New" }),
            ax("AXMenuItem", { title: "Open" }),
          ]),
        ]),
      ]),
    );
    expect(guiml).toContain("MenuBarItem#File");
    expect(guiml).toContain("MenuItem#New");
    expect(guiml).toContain("MenuItem#Open");
  });
});

// ─── Capabilities round-trip ──────────────────────────────────────

describe("pipeline — capabilities", () => {
  test("checked checkbox renders as bare attr", () => {
    const guiml = pipelineToGUIML(
      ax("AXCheckBox", { title: "Dark Mode", capabilities: { checked: true } }),
    );
    expect(guiml).toContain("CheckBox");
    expect(guiml).toMatch(/\bchecked\b/);
  });

  test("disabled button shows enabled=false", () => {
    const guiml = pipelineToGUIML(
      ax("AXButton", { title: "Submit", capabilities: { enabled: false } }),
    );
    expect(guiml).toContain('enabled="false"');
  });
});

// ─── Non-semantic collapsing round-trip ───────────────────────────

describe("pipeline — non-semantic collapsing", () => {
  test("AXGroup is collapsed, children promoted", () => {
    const guiml = pipelineToGUIML(
      ax("AXWindow", { title: "App" }, [
        ax("AXGroup", {}, [
          ax("AXButton", { title: "A" }),
          ax("AXButton", { title: "B" }),
        ]),
      ]),
    );
    expect(guiml).not.toContain("Group");
    expect(guiml).toContain("Button#A");
    expect(guiml).toContain("Button#B");
  });
});

// ─── Snapshot → GUIML pipeline ────────────────────────────────────

describe("pipeline — snapshot to GUIML", () => {
  test("full snapshot produces valid GUIML", () => {
    const snap: SnapshotResponse = {
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
                  { role: "AXMenuBarItem", title: "Edit" },
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
                      { role: "AXButton", title: "Minimize" },
                      {
                        role: "AXTable",
                        children: [
                          { role: "AXRow", title: "file1.txt" },
                          { role: "AXRow", title: "file2.txt" },
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
    };

    const displayTree = snapshotToTree(snap);
    expect(displayTree).not.toBeNull();

    const desc = treeNodeToDescriptor(displayTree!);
    const doc = buildDoc(desc);
    const json = yMapToJSON(doc.getMap("root")) as PlainNode;
    const guiml = toGUIML([json]);

    expect(guiml).toContain("Display");
    expect(guiml).toContain("Application#com.apple.finder");
    expect(guiml).toContain("Window#Documents");
    expect(guiml).toContain("MenuBar");
    expect(guiml).toContain("MenuBarItem#File");
    expect(guiml).toContain("Button#Close");
    expect(guiml).toContain("Table");
    expect(guiml).toContain("Row");
  });
});

// ─── Pruned/depth-limited AXNode ──────────────────────────────────

describe("pipeline — partial capture", () => {
  test("depth-limited AXNode produces valid subset", () => {
    // Simulate a shallow capture (no deep children)
    const guiml = pipelineToGUIML(
      ax("AXApplication", { title: "TestApp" }, [
        ax("AXWindow", { title: "Main" }),
      ]),
    );
    expect(guiml).toContain("Application#TestApp");
    expect(guiml).toContain("Window#Main");
    // Should not crash with no deep content
  });

  test("empty window renders self-closing", () => {
    const guiml = pipelineToGUIML(ax("AXWindow", { title: "Empty" }));
    expect(guiml).toContain("Window#Empty");
    expect(guiml).toContain("/>");
  });
});

// ─── ScrollArea More sentinel round-trip ──────────────────────────

describe("pipeline — ScrollArea More sentinel", () => {
  test("truncated scroll area shows More in GUIML", () => {
    const guiml = pipelineToGUIML(
      ax("AXScrollArea", {
        capabilities: { canScroll: true, scrollValueV: 0.4 },
      }, [
        ax("AXButton", { title: "Item1" }),
      ]),
    );
    expect(guiml).toContain("More");
    expect(guiml).toContain("Button#Item1");
  });
});
