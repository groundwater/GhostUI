import { describe, expect, test } from "bun:test";
import { buildLiveVatMountTree } from "./live-vat.js";
import { VatApiError } from "../vat/types.js";

describe("live VAT driver", () => {
  test("requires a GUIML query", () => {
    expect(() => buildLiveVatMountTree({ path: "/editor", driver: "live", args: [] })).toThrow(VatApiError);
    expect(() => buildLiveVatMountTree({ path: "/editor", driver: "live", args: [] })).toThrow(
      "live VAT driver requires a GUIML query",
    );
  });

  test("rejects invalid GUIML queries", () => {
    expect(() =>
      buildLiveVatMountTree({
        path: "/editor",
        driver: "live",
        args: ["Application {"],
      }),
    ).toThrow(VatApiError);
    expect(() =>
      buildLiveVatMountTree({
        path: "/editor",
        driver: "live",
        args: ["Application {"],
      }),
    ).toThrow("Invalid live GUIML query:");
  });

  test("wraps build failures as VAT API errors", () => {
    expect(() =>
      buildLiveVatMountTree(
        {
          path: "/editor",
          driver: "live",
          args: ["Application { Window }"],
        },
        {
          buildTree: () => {
            throw new Error("AX trust missing");
          },
        },
      ),
    ).toThrow(VatApiError);
    expect(() =>
      buildLiveVatMountTree(
        {
          path: "/editor",
          driver: "live",
          args: ["Application { Window }"],
        },
        {
          buildTree: () => {
            throw new Error("AX trust missing");
          },
        },
      ),
    ).toThrow("Unable to build live tree: AX trust missing");
  });

  test("wraps mounted content under the path tag", () => {
    const tree = buildLiveVatMountTree(
      {
        path: "/editor",
        driver: "live",
        args: ["Application { Window }"],
      },
      {
        buildTree: () => ({
          _tag: "Application",
          _id: "app:com.example.Editor",
          title: "Editor",
          _children: [
            {
              _tag: "Window",
              title: "Main",
              _children: [],
            },
          ],
        }),
      },
    );

    expect(tree.tree._tag).toBe("editor");
    expect(tree.tree._children?.[0]?._tag).toBe("Application");
    expect(tree.observedBundleIds).toEqual(["com.example.Editor"]);
    expect(tree.observedPids).toEqual([]);
  });
});
