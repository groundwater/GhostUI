/**
 * Regression test for #131: Toggle element attributes disappear after interaction.
 *
 * Verifies that CRDT Toggle nodes preserve their attributes (label, checked, frame)
 * through various update scenarios that occur after clicking a toggle.
 */
import { describe, it, expect } from "bun:test";
import * as Y from "yjs";
import { populateFromDescriptor } from "./schema.js";
import { settingsTree } from "../apps/com.apple.systempreferences/tree.js";
import type { SystemSettingsState } from "../apps/com.apple.systempreferences/types.js";

/** Read all attrs from a Y.Map as a plain object */
function yMapAttrs(ymap: Y.Map<unknown>): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const [key, value] of ymap.entries()) {
    obj[key] = value;
  }
  return obj;
}

/** Find a Y.Map node by id recursively */
function findYNode(ymap: Y.Map<unknown>, targetId: string): Y.Map<unknown> | null {
  const id = ymap.get("id") as string | undefined;
  if (id === targetId) return ymap;
  const children = ymap.get("_children") as Y.Array<Y.Map<unknown>> | undefined;
  if (children) {
    for (let i = 0; i < children.length; i++) {
      const found = findYNode(children.get(i), targetId);
      if (found) return found;
    }
  }
  return null;
}

const GEO = { x: 0, y: 25, w: 780, h: 550, screenW: 1440, screenH: 900 };

function makeState(checked: boolean): SystemSettingsState {
  return {
    sidebarItems: [{ label: "Lock Screen", selected: true }],
    selectedSidebar: "Lock Screen",
    isSubPage: false,
    breadcrumb: [],
    contentTitle: "Lock Screen",
    contentGroups: [
      {
        heading: "Require password",
        controls: [
          {
            type: "toggle",
            label: "Show user name and photo",
            checked,
            frame: "(904,390,26,15)",
          },
        ],
      },
    ],
  };
}

describe("Toggle attrs in CRDT (#131)", () => {
  it("preserves toggle attrs after checked state change", () => {
    const desc1 = settingsTree(GEO, makeState(true));
    const doc = new Y.Doc();
    const root = doc.getMap("root");
    doc.transact(() => { populateFromDescriptor(root, desc1); });

    const toggle = findYNode(root, "Toggle:Show user name and photo:0");
    expect(toggle).not.toBeNull();
    expect(yMapAttrs(toggle!).label).toBe("Show user name and photo");
    expect(yMapAttrs(toggle!).checked).toBe(true);
    expect(yMapAttrs(toggle!).frame).toBe("(904,390,26,15)");

    // Simulate post-click update: checked changes from true to false
    const desc2 = settingsTree(GEO, makeState(false));
    doc.transact(() => { populateFromDescriptor(root, desc2); });

    const toggleAfter = findYNode(root, "Toggle:Show user name and photo:0");
    expect(toggleAfter).not.toBeNull();
    expect(yMapAttrs(toggleAfter!).label).toBe("Show user name and photo");
    expect(yMapAttrs(toggleAfter!).checked).toBe(false);
    expect(yMapAttrs(toggleAfter!).frame).toBe("(904,390,26,15)");
  });

  it("removes toggle when extraction returns null (transient AX state)", () => {
    const desc1 = settingsTree(GEO, makeState(true));
    const doc = new Y.Doc();
    const root = doc.getMap("root");
    doc.transact(() => { populateFromDescriptor(root, desc1); });

    expect(findYNode(root, "Toggle:Show user name and photo:0")).not.toBeNull();

    // Simulate null extraction (transient AX state during animation)
    const desc2 = settingsTree(GEO, undefined);
    doc.transact(() => { populateFromDescriptor(root, desc2); });

    // Toggle should be gone (not present with empty attrs)
    expect(findYNode(root, "Toggle:Show user name and photo:0")).toBeNull();
  });

  it("restores toggle attrs after transient empty state and recovery", () => {
    const desc1 = settingsTree(GEO, makeState(true));
    const doc = new Y.Doc();
    const root = doc.getMap("root");
    doc.transact(() => { populateFromDescriptor(root, desc1); });

    // Simulate null extraction (skeleton tree)
    const desc2 = settingsTree(GEO, undefined);
    doc.transact(() => { populateFromDescriptor(root, desc2); });
    expect(findYNode(root, "Toggle:Show user name and photo:0")).toBeNull();

    // Recovery: full state restored by the next successful refresh
    const desc3 = settingsTree(GEO, makeState(false));
    doc.transact(() => { populateFromDescriptor(root, desc3); });

    const toggle = findYNode(root, "Toggle:Show user name and photo:0");
    expect(toggle).not.toBeNull();
    expect(yMapAttrs(toggle!).label).toBe("Show user name and photo");
    expect(yMapAttrs(toggle!).checked).toBe(false);
    expect(yMapAttrs(toggle!).frame).toBe("(904,390,26,15)");
  });
});
