import { describe, expect, test } from "bun:test";
import { buildDockVatMountTree } from "./dock.js";
import type { AXNode } from "../apps/types.js";
import { VatApiError } from "./types.js";

function dockTree(children: AXNode[]): AXNode {
  return {
    role: "AXApplication",
    title: "Dock",
    children: [
      {
        role: "AXGroup",
        children: [
          {
            role: "AXList",
            children,
          },
        ],
      },
    ],
  };
}

describe("dock VAT driver", () => {
  test("rejects extra args", () => {
    expect(() => buildDockVatMountTree({ path: "/System/Dock", driver: "dock", args: ["running"] })).toThrow(VatApiError);
    expect(() => buildDockVatMountTree({ path: "/System/Dock", driver: "dock", args: ["running"] })).toThrow(
      "dock VAT driver does not accept any args",
    );
  });

  test("errors when the Dock app is not running", () => {
    expect(() =>
      buildDockVatMountTree(
        { path: "/System/Dock", driver: "dock", args: [] },
        {
          getAppMetadata: () => ({ apps: [] }),
          snapshotApp: () => null,
        },
      )).toThrow("Unable to find a running Dock app (com.apple.dock)");
  });

  test("flattens Dock AX content into semantic VAT nodes", () => {
    const tree = buildDockVatMountTree(
      { path: "/System/Dock", driver: "dock", args: [] },
      {
        getAppMetadata: () => ({
          apps: [
            { pid: 99, bundleId: "com.apple.dock", name: "Dock", regular: false },
          ],
        }),
        snapshotApp: () => ({
          tree: dockTree([
            {
              role: "AXGroup",
              subrole: "AXApplicationDockItem",
              title: "Finder running badge 2 bouncing",
              frame: { x: 10, y: 20, width: 64, height: 64 },
              identifier: "finder",
            },
            {
              role: "AXGroup",
              subrole: "AXSeparatorDockItem",
            },
            {
              role: "AXGroup",
              subrole: "AXFolderDockItem",
              title: "Downloads stack",
            },
            {
              role: "AXGroup",
              subrole: "AXMinimizedWindowDockItem",
              title: "Notes - Shopping List",
            },
            {
              role: "AXGroup",
              subrole: "AXTrashDockItem",
              title: "Trash empty",
            },
          ]),
        }),
      },
    );

    expect(tree.observedBundleIds).toEqual(["com.apple.dock"]);
    expect(tree.observedPids).toEqual([99]);
    expect(tree.tree).toEqual({
      _tag: "System",
      _children: [
        {
          _tag: "Dock",
          _children: [
            {
              _tag: "AppIcon",
              _text: "Finder running badge 2 bouncing",
              badge: "2",
              bouncing: true,
              frame: "(10,20,64,64)",
              identifier: "finder",
              running: true,
            },
            {
              _tag: "Separator",
            },
            {
              _tag: "Stack",
              _text: "Downloads stack",
            },
            {
              _tag: "MinimizedWindow",
              _text: "Notes - Shopping List",
            },
            {
              _tag: "Trash",
              _text: "Trash empty",
              empty: true,
            },
          ],
        },
      ],
    });
  });

  test("falls back to button leaves when Dock variants omit dock-specific subroles", () => {
    const tree = buildDockVatMountTree(
      { path: "/System/Dock", driver: "dock", args: [] },
      {
        getAppMetadata: () => ({
          apps: [
            { pid: 99, bundleId: "com.apple.dock", name: "Dock", regular: false },
          ],
        }),
        snapshotApp: () => ({
          tree: dockTree([
            {
              role: "AXButton",
              title: "Safari running",
            },
          ]),
        }),
      },
    );

    expect(tree.tree._children?.[0]?._children).toEqual([
      {
        _tag: "AppIcon",
        _text: "Safari running",
        running: true,
      },
    ]);
  });
});
