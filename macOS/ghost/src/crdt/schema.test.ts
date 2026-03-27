/**
 * Unit tests for populateFromDescriptor and yMapToJSON.
 * Uses Y.js directly — no app boot required.
 */
import { describe, test, expect } from "bun:test";
import * as Y from "yjs";
import { populateFromDescriptor, buildDoc, type NodeDescriptor } from "./schema.js";
import { yMapToJSON } from "../server/cli.js";
import type { PlainNode } from "../cli/types.js";

// ─── populateFromDescriptor ───────────────────────────────────────

describe("populateFromDescriptor", () => {
  test("sets type, id, _tag", () => {
    const doc = new Y.Doc();
    const root = doc.getMap("root");
    doc.transact(() => {
      populateFromDescriptor(root, { type: "Button", id: "Button:Save:0" });
    });
    expect(root.get("type")).toBe("Button");
    expect(root.get("id")).toBe("Button:Save:0");
    expect(root.get("_tag")).toBe("Button");
  });

  test("creates children", () => {
    const doc = new Y.Doc();
    const root = doc.getMap("root");
    doc.transact(() => {
      populateFromDescriptor(root, {
        type: "Window",
        id: "Window:Main:0",
        children: [
          { type: "Button", id: "Button:OK:0", attrs: { title: "OK" } },
          { type: "Button", id: "Button:Cancel:1", attrs: { title: "Cancel" } },
        ],
      });
    });
    const children = root.get("_children") as Y.Array<Y.Map<unknown>>;
    expect(children.length).toBe(2);
    expect(children.get(0).get("type")).toBe("Button");
    expect(children.get(0).get("title")).toBe("OK");
    expect(children.get(1).get("title")).toBe("Cancel");
  });

  test("removes stale attrs", () => {
    const doc = new Y.Doc();
    const root = doc.getMap("root");
    doc.transact(() => {
      populateFromDescriptor(root, {
        type: "Button",
        id: "btn",
        attrs: { title: "Old", label: "Stale" },
      });
    });
    expect(root.get("label")).toBe("Stale");

    doc.transact(() => {
      populateFromDescriptor(root, {
        type: "Button",
        id: "btn",
        attrs: { title: "New" },
      });
    });
    expect(root.get("title")).toBe("New");
    expect(root.has("label")).toBe(false);
  });

  test("unchanged attrs are not re-set (diffing)", () => {
    const doc = new Y.Doc();
    const root = doc.getMap("root");
    doc.transact(() => {
      populateFromDescriptor(root, {
        type: "Button",
        id: "btn",
        attrs: { title: "Same" },
      });
    });

    // Observe for changes
    let changeCount = 0;
    root.observe(() => { changeCount++; });

    doc.transact(() => {
      populateFromDescriptor(root, {
        type: "Button",
        id: "btn",
        attrs: { title: "Same" },
      });
    });
    // No actual changes should have been emitted
    expect(changeCount).toBe(0);
  });

  test("child matching by ID — same order fast path", () => {
    const doc = new Y.Doc();
    const root = doc.getMap("root");
    doc.transact(() => {
      populateFromDescriptor(root, {
        type: "List",
        id: "list",
        children: [
          { type: "ListItem", id: "item-0", attrs: { title: "A" } },
          { type: "ListItem", id: "item-1", attrs: { title: "B" } },
        ],
      });
    });

    // Update with same IDs, different attrs
    doc.transact(() => {
      populateFromDescriptor(root, {
        type: "List",
        id: "list",
        children: [
          { type: "ListItem", id: "item-0", attrs: { title: "A updated" } },
          { type: "ListItem", id: "item-1", attrs: { title: "B updated" } },
        ],
      });
    });

    const children = root.get("_children") as Y.Array<Y.Map<unknown>>;
    expect(children.get(0).get("title")).toBe("A updated");
    expect(children.get(1).get("title")).toBe("B updated");
  });

  test("children removed when descriptor has none", () => {
    const doc = new Y.Doc();
    const root = doc.getMap("root");
    doc.transact(() => {
      populateFromDescriptor(root, {
        type: "Window",
        id: "win",
        children: [{ type: "Button", id: "btn" }],
      });
    });
    expect(root.has("_children")).toBe(true);

    doc.transact(() => {
      populateFromDescriptor(root, { type: "Window", id: "win" });
    });
    expect(root.has("_children")).toBe(false);
  });

  test("children rebuilt when IDs change", () => {
    const doc = new Y.Doc();
    const root = doc.getMap("root");
    doc.transact(() => {
      populateFromDescriptor(root, {
        type: "Split",
        id: "split",
        attrs: { direction: "h" },
        children: [
          { type: "Button", id: "btn-0", attrs: { title: "File" } },
          { type: "Button", id: "btn-1", attrs: { title: "Edit" } },
        ],
      });
    });

    // New set of children with a different structure.
    doc.transact(() => {
      populateFromDescriptor(root, {
        type: "Split",
        id: "split",
        attrs: { direction: "h" },
        children: [
          { type: "Button", id: "btn-0", attrs: { title: "File" } },
          { type: "TextField", id: "field-0", attrs: { placeholder: "Search" } },
        ],
      });
    });

    const children = root.get("_children") as Y.Array<Y.Map<unknown>>;
    expect(children.length).toBe(2);
    expect(children.get(1).get("type")).toBe("TextField");
  });
});

// ─── yMapToJSON ───────────────────────────────────────────────────

describe("yMapToJSON", () => {
  test("round-trip with populateFromDescriptor", () => {
    const desc: NodeDescriptor = {
      type: "Window",
      id: "Window:Main:0",
      attrs: { title: "Main", x: 10, y: 20 },
      children: [
        { type: "Button", id: "Button:OK:0", attrs: { title: "OK" } },
        { type: "TextField", id: "TextField::0", attrs: { placeholder: "Type" } },
      ],
    };
    const doc = buildDoc(desc);
    const root = doc.getMap("root");
    const json = yMapToJSON(root);

    expect(json._tag).toBe("Window");
    expect(json.title).toBe("Main");
    expect(json.x).toBe(10);
    const children = json._children as Record<string, unknown>[];
    expect(children).toBeDefined();
    expect(children.length).toBe(2);
    expect(children[0]._tag).toBe("Button");
    expect(children[0].title).toBe("OK");
    expect(children[1]._tag).toBe("TextField");
    expect(children[1].placeholder).toBe("Type");
  });

  test("preserves _tag and _children structure", () => {
    const doc = buildDoc({
      type: "Display",
      id: "Display::0",
      children: [
        {
          type: "Application",
          id: "app:com.apple.finder",
          children: [
            { type: "Window", id: "Window::0" },
          ],
        },
      ],
    });
    const json = yMapToJSON(doc.getMap("root"));
    expect(json._tag).toBe("Display");
    const children = json._children as PlainNode[];
    const firstChild = children[0]!;
    expect(firstChild._tag).toBe("Application");
    expect(firstChild._children?.[0]?._tag).toBe("Window");
  });

  test("nested recursion with attrs", () => {
    const doc = buildDoc({
      type: "List",
      id: "list",
      children: [
        {
          type: "ListItem",
          id: "item-0",
          attrs: { title: "A", selected: true },
          children: [
            { type: "Button", id: "btn-0", attrs: { title: "Action" } },
          ],
        },
      ],
    });
    const json = yMapToJSON(doc.getMap("root"));
    const item = (json._children as PlainNode[])[0]!;
    expect(item.title).toBe("A");
    expect(item.selected).toBe(true);
    expect(item._children?.[0]?.title).toBe("Action");
  });
});
