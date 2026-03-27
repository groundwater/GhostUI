import { describe, test, expect } from "bun:test";
import { settingsTree } from "../apps/com.apple.systempreferences/tree.js";
import type { SystemSettingsState, SheetState } from "../apps/com.apple.systempreferences/types.js";
import type { NodeDescriptor } from "../crdt/schema.js";

/** Walk a NodeDescriptor tree to find a node by type */
function findNode(root: NodeDescriptor, type: string): NodeDescriptor | null {
  if (root.type === type) return root;
  for (const child of root.children || []) {
    const found = findNode(child, type);
    if (found) return found;
  }
  return null;
}

/** Get children of a node by type */
function findChildren(root: NodeDescriptor, type: string): NodeDescriptor[] {
  return (root.children || []).filter((c) => c.type === type);
}

function makeState(sheet?: SheetState): SystemSettingsState {
  return {
    sidebarItems: [
      { label: "Lock Screen", selected: true },
    ],
    selectedSidebar: "Lock Screen",
    isSubPage: false,
    breadcrumb: [],
    contentTitle: "Lock Screen",
    contentGroups: [
      {
        controls: [
          { type: "toggle", label: "Start Screen Saver when inactive", checked: false },
          { type: "toggle", label: "Show 24-hour time", checked: true },
        ],
      },
    ],
    sheet,
  };
}

describe("settingsTree sheet rendering", () => {
  test("sheet renders as Sheet type, not VStack", () => {
    const sheet: SheetState = {
      title: "Accessibility",
      groups: [
        {
          controls: [
            { type: "toggle", label: "VoiceOver", checked: false },
          ],
        },
      ],
      buttons: ["Done"],
    };
    const state = makeState(sheet);
    const tree = settingsTree(undefined, state);
    const sheetNode = findNode(tree, "Sheet");
    expect(sheetNode).not.toBeNull();
    expect(sheetNode!.type).toBe("Sheet");
  });

  test("sheet is a direct child of Window", () => {
    const sheet: SheetState = {
      title: "Accessibility",
      groups: [],
      buttons: ["Done"],
    };
    const state = makeState(sheet);
    const tree = settingsTree(undefined, state);
    const windowNode = findNode(tree, "Window");
    expect(windowNode).not.toBeNull();
    const sheetChildren = findChildren(windowNode!, "Sheet");
    expect(sheetChildren).toHaveLength(1);
  });

  test("sheet is NOT inside content-body", () => {
    const sheet: SheetState = {
      title: "Accessibility",
      groups: [
        { controls: [{ type: "toggle", label: "VoiceOver", checked: false }] },
      ],
      buttons: ["Done"],
    };
    const state = makeState(sheet);
    const tree = settingsTree(undefined, state);

    // Find content-body VStack
    function findById(node: NodeDescriptor, id: string): NodeDescriptor | null {
      if (node.id === id) return node;
      for (const child of node.children || []) {
        const found = findById(child, id);
        if (found) return found;
      }
      return null;
    }

    const contentBody = findById(tree, "content-body");
    expect(contentBody).not.toBeNull();
    // Sheet should NOT be inside content-body
    const nestedSheet = findNode(contentBody!, "Sheet");
    expect(nestedSheet).toBeNull();
  });

  test("sheet contains rendered controls and buttons", () => {
    const sheet: SheetState = {
      title: "Accessibility",
      groups: [
        {
          controls: [
            { type: "toggle", label: "VoiceOver", checked: false },
            { type: "toggle", label: "Zoom", checked: true },
          ],
        },
      ],
      buttons: ["Done", "Cancel"],
    };
    const state = makeState(sheet);
    const tree = settingsTree(undefined, state);
    const sheetNode = findNode(tree, "Sheet");
    expect(sheetNode).not.toBeNull();

    // Flatten all descendants to check for controls
    function collectTypes(node: NodeDescriptor): string[] {
      const types = [node.type];
      for (const child of node.children || []) {
        types.push(...collectTypes(child));
      }
      return types;
    }

    const types = collectTypes(sheetNode!);
    // Should contain Toggle nodes for VoiceOver and Zoom
    const toggles = types.filter((t) => t === "Toggle");
    expect(toggles.length).toBeGreaterThanOrEqual(2);
    // Should contain Button nodes for Done and Cancel
    const buttons = types.filter((t) => t === "Button");
    expect(buttons.length).toBeGreaterThanOrEqual(2);
  });

  test("sheet has title attribute", () => {
    const sheet: SheetState = {
      title: "Accessibility",
      groups: [],
      buttons: ["Done"],
    };
    const state = makeState(sheet);
    const tree = settingsTree(undefined, state);
    const sheetNode = findNode(tree, "Sheet");
    expect(sheetNode).not.toBeNull();
    expect(sheetNode!.attrs?.title).toBe("Accessibility");
  });

  test("without sheet, no Sheet node in tree", () => {
    const state = makeState(undefined);
    const tree = settingsTree(undefined, state);
    const sheetNode = findNode(tree, "Sheet");
    expect(sheetNode).toBeNull();
  });
});
