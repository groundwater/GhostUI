import { describe, expect, test } from "bun:test";
import { composeVatMountForest, findVatNodeByPath, vatPathSegments, wrapVatMountPath } from "./path.js";
import type { VatNode } from "./types.js";

function vatNode(tag: string, children: VatNode[] = []): VatNode {
  return {
    _tag: tag,
    _children: children,
  };
}

describe("VAT path composition", () => {
  test("root mounts round-trip as mounted content", () => {
    const root = composeVatMountForest([
      {
        path: "/",
        tree: vatNode("Application", [
          vatNode("Window", [
            vatNode("Button"),
          ]),
        ]),
      },
    ]);

    expect(root._tag).toBe("Application");
    expect(root._children?.[0]?._tag).toBe("Window");
    expect(findVatNodeByPath(root, vatPathSegments("/"))?._tag).toBe("Application");
    expect(findVatNodeByPath(root, vatPathSegments("/Window"))?._tag).toBe("Window");
  });

  test("inner mounts overlay matching descendant subtrees", () => {
    const mounts: Array<{ path: string; tree: VatNode }> = [
      {
        path: "/",
        tree: vatNode("A", [
          vatNode("B", [
            vatNode("C", [
              vatNode("D"),
            ]),
          ]),
          vatNode("Sibling"),
          vatNode("B", [
            vatNode("C", [
              vatNode("Second"),
            ]),
          ]),
        ]),
      },
      {
        path: "/B",
        tree: wrapVatMountPath("/B", [
          vatNode("C", [
            vatNode("Overlay"),
          ]),
        ]),
      },
    ];
    const root = composeVatMountForest(mounts);

    expect(root._tag).toBe("A");
    expect(root._children?.map((child) => child._tag)).toEqual(["B", "Sibling", "B"]);

    const b = findVatNodeByPath(root, vatPathSegments("/B"));
    expect(b?._children?.[0]?._tag).toBe("C");
    expect(b?._children?.[0]?._children?.[0]?._tag).toBe("Overlay");
    expect(JSON.stringify(b)).not.toContain("D");

    const secondB = findVatNodeByPath(root, vatPathSegments("/B[1]"));
    expect(secondB?._tag).toBe("B");
    expect(secondB?._children?.[0]?._children?.[0]?._tag).toBe("Second");
  });
});
