import { describe, test, expect } from "bun:test";
import type { PlainNode } from "./types.js";
import { findWindowModal, isBlockedByModal, collapseBlockedChildren } from "./modal.js";
import { toGUIML } from "./guiml.js";

type TruncatedNode = PlainNode & { _truncatedLabel?: string };

function node(tag: string, props: Record<string, unknown> = {}, children?: PlainNode[]): PlainNode {
  return { _tag: tag, ...props, _children: children } as PlainNode;
}

describe("findWindowModal", () => {
  test("returns null for Window without modal", () => {
    const win = node("Window", { title: "Settings" }, [
      node("Toolbar"),
      node("SplitGroup"),
    ]);
    expect(findWindowModal(win)).toBeNull();
  });

  test("finds Sheet child", () => {
    const sheet = node("Sheet", { title: "Add Account" });
    const win = node("Window", { title: "Settings" }, [
      node("Toolbar"),
      node("SplitGroup"),
      sheet,
    ]);
    expect(findWindowModal(win)).toBe(sheet);
  });

  test("finds Dialog child", () => {
    const dialog = node("Dialog", { title: "Confirm" });
    const win = node("Window", {}, [node("Toolbar"), dialog]);
    expect(findWindowModal(win)).toBe(dialog);
  });

  test("finds Popover child", () => {
    const popover = node("Popover");
    const win = node("Window", {}, [node("List"), popover]);
    expect(findWindowModal(win)).toBe(popover);
  });

  test("returns null for non-Window nodes", () => {
    const group = node("SplitGroup", {}, [node("Sheet")]);
    expect(findWindowModal(group)).toBeNull();
  });
});

describe("isBlockedByModal", () => {
  test("returns modal tag when node is outside the modal", () => {
    const toolbar = node("Toolbar");
    const sheet = node("Sheet", { title: "Add Account" });
    const win = node("Window", { title: "Settings" }, [toolbar, node("SplitGroup"), sheet]);
    const app = node("Application", {}, [win]);

    // Path to toolbar: [Application, Window] -> Toolbar is inside Window but not inside Sheet
    // The path should contain ancestors up to (but not including) the target node
    // toolbar's path from root: app -> win -> toolbar
    // path = [app, win], node = toolbar
    const path = [app, win];
    expect(isBlockedByModal(path, toolbar)).toBe("Sheet");
  });

  test("returns null when node IS the modal", () => {
    const sheet = node("Sheet", { title: "Add Account" });
    const win = node("Window", {}, [node("Toolbar"), sheet]);
    const app = node("Application", {}, [win]);

    const path = [app, win];
    expect(isBlockedByModal(path, sheet)).toBeNull();
  });

  test("returns null when node is inside the modal", () => {
    const textField = node("TextField", { label: "Email" });
    const sheet = node("Sheet", { title: "Add Account" }, [textField]);
    const win = node("Window", {}, [node("Toolbar"), sheet]);
    const app = node("Application", {}, [win]);

    // Path to textField: [app, win, sheet], node = textField
    const path = [app, win, sheet];
    expect(isBlockedByModal(path, textField)).toBeNull();
  });

  test("returns null when no modal present", () => {
    const button = node("Button", { label: "OK" });
    const win = node("Window", {}, [node("Toolbar"), button]);
    const app = node("Application", {}, [win]);

    const path = [app, win];
    expect(isBlockedByModal(path, button)).toBeNull();
  });

  test("returns null when no Window in path", () => {
    const button = node("Button");
    const toolbar = node("Toolbar", {}, [button]);
    expect(isBlockedByModal([toolbar], button)).toBeNull();
  });
});

describe("collapseBlockedChildren", () => {
  test("returns original children when no modal present", () => {
    const children = [node("Toolbar"), node("SplitGroup")];
    const win = node("Window", {}, children);
    expect(collapseBlockedChildren(win)).toBe(children);
  });

  test("collapses non-modal children when Sheet present", () => {
    const sheet = node("Sheet", { title: "Add Account" }, [
      node("TextField", { label: "Email" }),
      node("Button", { label: "Cancel" }),
    ]);
    const win = node("Window", { title: "Settings" }, [
      node("Toolbar"),
      node("SplitGroup"),
      sheet,
    ]);

    const result = collapseBlockedChildren(win)!;
    expect(result).toHaveLength(2); // truncation marker + Sheet
    expect(result[0]._tag).toBe("_truncated");
    expect((result[0] as TruncatedNode)._truncatedLabel).toBe("blocked by Sheet");
    expect(result[1]).toBe(sheet);
  });

  test("returns undefined for non-Window nodes", () => {
    const group = node("SplitGroup", {}, [node("Sheet")]);
    expect(collapseBlockedChildren(group)).toEqual([node("Sheet")]);
  });
});

describe("GUIML output with modal", () => {
  test("renders blocked-by marker in Window with Sheet", () => {
    const win = node("Window", { title: "Settings", _id: "Window:Settings:0" }, [
      node("Toolbar", { _id: "Toolbar::0" }),
      node("SplitGroup", { _id: "SplitGroup::0" }),
      node("Sheet", { title: "Add Account", _id: "Sheet:Add Account:0" }, [
        node("TextField", { label: "Email", _id: "TextField:Email:0" }),
        node("Button", { label: "Cancel", _id: "Button:Cancel:0" }),
        node("Button", { label: "OK", _id: "Button:OK:0" }),
      ]),
    ]);

    const guiml = toGUIML([win]);
    // Should contain the blocked-by marker
    expect(guiml).toContain("{... blocked by Sheet}");
    // Should contain the Sheet and its children
    expect(guiml).toContain("Sheet");
    expect(guiml).toContain("TextField");
    expect(guiml).toContain("Button");
    // Should NOT contain the Toolbar or SplitGroup
    expect(guiml).not.toContain("Toolbar");
    expect(guiml).not.toContain("SplitGroup");
  });

  test("renders normally when no modal present", () => {
    const win = node("Window", { title: "Settings", _id: "Window:Settings:0" }, [
      node("Toolbar", { _id: "Toolbar::0" }),
      node("SplitGroup", { _id: "SplitGroup::0" }),
    ]);

    const guiml = toGUIML([win]);
    expect(guiml).toContain("Toolbar");
    expect(guiml).toContain("SplitGroup");
    expect(guiml).not.toContain("blocked by");
  });
});
