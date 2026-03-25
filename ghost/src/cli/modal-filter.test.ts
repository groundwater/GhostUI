import { describe, test, expect } from "bun:test";
import type { PlainNode } from "./types.js";
import { filterTree, findMatchedNodeWithContext } from "./filter.js";
import { parseQuery } from "./query.js";
import { toGUIML } from "./guiml.js";

function node(tag: string, id: string, props: Record<string, unknown> = {}, children?: PlainNode[]): PlainNode {
  return { _tag: tag, _id: id, id, ...props, _children: children } as PlainNode;
}

function makeTree(): PlainNode {
  return node("Display", "Display::0", {}, [
    node("Application", "app:com.apple.systempreferences", { title: "System Settings", bundleId: "com.apple.systempreferences" }, [
      node("Window", "Window:Settings:0", { title: "Settings" }, [
        node("Toolbar", "Toolbar::0", {}, [
          node("Button", "Button:Back:0", { label: "Back" }),
        ]),
        node("SplitGroup", "SplitGroup::0", {}, [
          node("List", "List::0", {}, [
            node("ListItem", "ListItem:Wi-Fi:0", { label: "Wi-Fi" }),
          ]),
          node("ScrollArea", "ScrollArea::0"),
        ]),
        node("Sheet", "Sheet:Add Account:0", { title: "Add Account" }, [
          node("TextField", "TextField:Email:0", { label: "Email" }),
          node("Button", "Button:Cancel:0", { label: "Cancel" }),
          node("Button", "Button:OK:0", { label: "OK" }),
        ]),
      ]),
    ]),
  ]);
}

function makeTreeNoModal(): PlainNode {
  return node("Display", "Display::0", {}, [
    node("Application", "app:com.apple.systempreferences", { title: "System Settings", bundleId: "com.apple.systempreferences" }, [
      node("Window", "Window:Settings:0", { title: "Settings" }, [
        node("Toolbar", "Toolbar::0", {}, [
          node("Button", "Button:Back:0", { label: "Back" }),
        ]),
        node("SplitGroup", "SplitGroup::0", {}, [
          node("List", "List::0", {}, [
            node("ListItem", "ListItem:Wi-Fi:0", { label: "Wi-Fi" }),
          ]),
        ]),
      ]),
    ]),
  ]);
}

describe("filterTree with modal blocking", () => {
  test("querying blocked Toolbar returns no matches", () => {
    const tree = makeTree();
    const queries = parseQuery("Toolbar");
    const { matchCount } = filterTree(tree, queries);
    expect(matchCount).toBe(0);
  });

  test("querying blocked Button#Back returns no matches", () => {
    const tree = makeTree();
    const queries = parseQuery("Button#Back");
    const { matchCount } = filterTree(tree, queries);
    expect(matchCount).toBe(0);
  });

  test("querying blocked ListItem returns no matches", () => {
    const tree = makeTree();
    const queries = parseQuery("ListItem");
    const { matchCount } = filterTree(tree, queries);
    expect(matchCount).toBe(0);
  });

  test("querying Sheet returns a match", () => {
    const tree = makeTree();
    const queries = parseQuery("Sheet");
    const { matchCount } = filterTree(tree, queries);
    expect(matchCount).toBe(1);
  });

  test("querying Button inside Sheet returns matches", () => {
    const tree = makeTree();
    const queries = parseQuery("Sheet { Button }");
    const { nodes, matchCount } = filterTree(tree, queries);
    expect(matchCount).toBe(1);
    const guiml = toGUIML(nodes);
    expect(guiml).toContain("Button");
    expect(guiml).toContain("Cancel");
  });

  test("querying Button#OK finds the modal button", () => {
    const tree = makeTree();
    const queries = parseQuery("Button#OK");
    const { matchCount } = filterTree(tree, queries);
    expect(matchCount).toBe(1);
  });

  test("querying TextField#Email finds the modal field", () => {
    const tree = makeTree();
    const queries = parseQuery("TextField#Email");
    const { matchCount } = filterTree(tree, queries);
    expect(matchCount).toBe(1);
  });

  test("** wildcard does not include blocked elements", () => {
    const tree = makeTree();
    const queries = parseQuery("Window { ** }");
    const { nodes } = filterTree(tree, queries);
    const guiml = toGUIML(nodes);
    // Should contain Sheet content
    expect(guiml).toContain("Sheet");
    expect(guiml).toContain("TextField");
    // Should NOT contain blocked elements
    expect(guiml).not.toContain("Toolbar");
    expect(guiml).not.toContain("SplitGroup");
  });

  test("without modal, Toolbar is findable", () => {
    const tree = makeTreeNoModal();
    const queries = parseQuery("Toolbar");
    const { matchCount } = filterTree(tree, queries);
    expect(matchCount).toBe(1);
  });

  test("without modal, Button#Back is findable", () => {
    const tree = makeTreeNoModal();
    const queries = parseQuery("Button#Back");
    const { matchCount } = filterTree(tree, queries);
    expect(matchCount).toBe(1);
  });
});

/** Tree with an obscured Window (56%) that contains a modal Sheet. */
function makeObscuredModalTree(): PlainNode {
  return node("Display", "Display::0", {}, [
    node("Application", "app:com.apple.systempreferences", { title: "System Settings", bundleId: "com.apple.systempreferences" }, [
      node("Window", "Window:Screen Time:0", { title: "Screen Time", obscured: "56" }, [
        node("Toolbar", "Toolbar::0", {}, [
          node("Button", "Button:Back:0", { label: "Back" }),
        ]),
        node("SplitGroup", "SplitGroup::0", {}, [
          node("List", "List::0", {}, [
            node("ListItem", "ListItem:Screen Time:0", { label: "Screen Time" }),
          ]),
        ]),
        node("Sheet", "Sheet:App & Website Activity:0", { title: "App & Website Activity" }, [
          node("Button", "Button:Done:0", { label: "Done" }),
          node("Button", "Button:Cancel:0", { label: "Cancel" }),
          node("ScrollArea", "ScrollArea::0", {}, [
            node("Group", "Group::0", {}, [
              node("StaticText", "StaticText:Usage:0", { value: "Usage" }),
            ]),
          ]),
        ]),
      ]),
    ]),
  ]);
}

/** Tree with an obscured Window (56%) and NO modal — should remain suppressed. */
function makeObscuredNoModalTree(): PlainNode {
  return node("Display", "Display::0", {}, [
    node("Application", "app:com.apple.safari", { title: "Safari", bundleId: "com.apple.safari" }, [
      node("Window", "Window:Safari:0", { title: "Safari", obscured: "56" }, [
        node("Toolbar", "Toolbar::0", {}, [
          node("Button", "Button:Back:0", { label: "Back" }),
        ]),
      ]),
    ]),
  ]);
}

describe("filterTree with obscured window + modal (issue #124)", () => {
  test("querying Button finds modal buttons despite window being obscured", () => {
    const tree = makeObscuredModalTree();
    const queries = parseQuery("Button");
    const { matchCount } = filterTree(tree, queries);
    // Should find Done and Cancel inside the Sheet (not Back which is blocked by modal)
    expect(matchCount).toBe(2);
  });

  test("querying Button#Done finds the modal button in obscured window", () => {
    const tree = makeObscuredModalTree();
    const queries = parseQuery("Button#Done");
    const { matchCount } = filterTree(tree, queries);
    expect(matchCount).toBe(1);
  });

  test("querying Sheet finds the modal in obscured window", () => {
    const tree = makeObscuredModalTree();
    const queries = parseQuery("Sheet");
    const { matchCount } = filterTree(tree, queries);
    expect(matchCount).toBe(1);
  });

  test("blocked elements behind modal in obscured window still blocked", () => {
    const tree = makeObscuredModalTree();
    const queries = parseQuery("Toolbar");
    const { matchCount } = filterTree(tree, queries);
    expect(matchCount).toBe(0);
  });

  test("** wildcard includes modal content in obscured window", () => {
    const tree = makeObscuredModalTree();
    const queries = parseQuery("Window { ** }");
    const { nodes } = filterTree(tree, queries);
    const guiml = toGUIML(nodes);
    expect(guiml).toContain("Sheet");
    expect(guiml).toContain("Button");
    expect(guiml).not.toContain("Toolbar");
  });

  test("obscured window WITHOUT modal is still suppressed", () => {
    const tree = makeObscuredNoModalTree();
    const queries = parseQuery("Button#Back");
    const { matchCount } = filterTree(tree, queries);
    expect(matchCount).toBe(0);
  });
});

describe("findMatchedNodeWithContext with modal blocking", () => {
  test("does not find blocked nodes", () => {
    const tree = makeTree();
    const queries = parseQuery("Button#Back");
    const ctx = findMatchedNodeWithContext(tree, queries);
    expect(ctx).toBeNull();
  });

  test("finds modal-internal nodes", () => {
    const tree = makeTree();
    const queries = parseQuery("Button#OK");
    const ctx = findMatchedNodeWithContext(tree, queries);
    expect(ctx).not.toBeNull();
    expect(ctx!.node.label).toBe("OK");
  });

  test("finds the Sheet itself", () => {
    const tree = makeTree();
    const queries = parseQuery("Sheet");
    const ctx = findMatchedNodeWithContext(tree, queries);
    expect(ctx).not.toBeNull();
    expect(ctx!.node._tag).toBe("Sheet");
  });

  test("finds modal button in obscured window (issue #124)", () => {
    const tree = makeObscuredModalTree();
    const queries = parseQuery("Button#Done");
    const ctx = findMatchedNodeWithContext(tree, queries);
    expect(ctx).not.toBeNull();
    expect(ctx!.node.label).toBe("Done");
  });

  test("does not find blocked node behind modal in obscured window", () => {
    const tree = makeObscuredModalTree();
    const queries = parseQuery("Button#Back");
    const ctx = findMatchedNodeWithContext(tree, queries);
    expect(ctx).toBeNull();
  });
});
