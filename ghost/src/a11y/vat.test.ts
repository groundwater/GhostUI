import { afterEach, describe, expect, test } from "bun:test";
import { __setNativeAXForTests, type NativeAXApi, type NativeAXNode } from "./native-ax.js";
import { buildA11yVatMountTree } from "./vat.js";
import { VAT_A11Y_STDIN_AX_QUERY_ARG, VAT_A11Y_STDIN_AX_QUERY_PLAN_ARG, VatApiError, type VatA11YQueryPlan } from "../vat/types.js";

function makeMockNativeAX(overrides: Partial<NativeAXApi> = {}): NativeAXApi {
  return {
    axIsProcessTrusted: () => true,
    axSnapshot: (_pid: number, _depth: number): NativeAXNode | null => null,
    wsGetRunningApps: () => [],
    wsGetFrontmostApp: () => null,
    wsGetScreenFrame: () => ({ x: 0, y: 0, width: 1728, height: 1117 }),
    cgGetWindowRects: () => [],
    axGetFrontmostPid: () => 0,
    axPointerEvent: () => ({ ok: true }),
    axPerformAction: () => true,
    axSetValue: () => true,
    axStartObserving: () => true,
    axStopObserving: () => true,
    axScreenshot: () => null,
    ...overrides,
  };
}

afterEach(() => {
  __setNativeAXForTests();
});

describe("a11y VAT driver", () => {
  test("requires a GUIML query", () => {
    expect(() => buildA11yVatMountTree({ path: "/editor", driver: "a11y", args: [] })).toThrow(VatApiError);
    expect(() => buildA11yVatMountTree({ path: "/editor", driver: "a11y", args: [] })).toThrow(
      "a11y VAT driver requires a GUIML query",
    );
  });

  test("rejects invalid GUIML queries", () => {
    __setNativeAXForTests(makeMockNativeAX({
      wsGetRunningApps: () => [
        { pid: 123, bundleId: "com.example.Editor", name: "Editor", regular: true },
      ],
      axSnapshot: () => ({
        role: "AXApplication",
        title: "Editor",
        children: [],
      }),
    }));

    expect(() =>
      buildA11yVatMountTree({
        path: "/editor",
        driver: "a11y",
        args: ["Application {"],
      }),
    ).toThrow(VatApiError);
    expect(() =>
      buildA11yVatMountTree({
        path: "/editor",
        driver: "a11y",
        args: ["Application {"],
      }),
    ).toThrow("Invalid a11y GUIML query:");
  });

  test("errors when no raw AX snapshots are available", () => {
    __setNativeAXForTests(makeMockNativeAX({
      wsGetRunningApps: () => [
        { pid: 123, bundleId: "com.example.Editor", name: "Editor", regular: true },
      ],
      axSnapshot: () => null,
    }));

    expect(() =>
      buildA11yVatMountTree({
        path: "/editor",
        driver: "a11y",
        args: ["Application#Editor"],
      }),
    ).toThrow(VatApiError);
    expect(() =>
      buildA11yVatMountTree({
        path: "/editor",
        driver: "a11y",
        args: ["Application#Editor"],
      }),
    ).toThrow("Unable to build raw a11y tree: no AX snapshots available");
  });

  test("mounts raw AX content and derives observer keys from the matched raw roots", () => {
    __setNativeAXForTests(makeMockNativeAX({
      wsGetRunningApps: () => [
        { pid: 123, bundleId: "com.example.Editor", name: "Editor", regular: true },
        { pid: 456, bundleId: "com.example.Other", name: "Other", regular: true },
      ],
      axSnapshot: (pid: number) => {
        if (pid !== 123) return null;
        return {
          role: "AXApplication",
          title: "Editor",
          children: [
            {
              role: "AXWindow",
              title: "Main",
              children: [
                {
                  role: "AXButton",
                  title: "Save",
                  children: [],
                },
              ],
            },
          ],
        };
      },
    }));

    const tree = buildA11yVatMountTree({
      path: "/editor",
      driver: "a11y",
      args: ["Application#Editor { Window { Button } }"],
    });

    expect(tree.observedBundleIds).toEqual(["com.example.Editor"]);
    expect(tree.observedPids).toEqual([123]);
    expect(tree.tree._tag).toBe("editor");
    expect(tree.tree._children?.[0]?._tag).toBe("Application");
    expect(tree.tree._children?.[0]?._children?.[0]?._tag).toBe("Window");
    expect(tree.tree._children?.[0]?._children?.[0]?._children?.[0]?._tag).toBe("Button");
  });

  test("mounts serialized AX query matches from stdin without collapsing to the wrapper root", () => {
    __setNativeAXForTests(makeMockNativeAX({
      wsGetRunningApps: () => [
        { pid: 123, bundleId: "com.example.Terminal", name: "Terminal", regular: true },
      ],
    }));

    const payload = JSON.stringify([
      {
        type: "ax.query-match",
        pid: 123,
        node: {
          _tag: "Application",
          title: "Terminal",
          _children: [
            {
              _tag: "Window",
              title: "Shell",
              _children: [
                { _tag: "Button", title: "Run" },
              ],
            },
          ],
        },
      },
      {
        type: "ax.query-match",
        pid: 123,
        node: {
          _tag: "Window",
          title: "Shell",
          _children: [
            { _tag: "Button", title: "Run" },
          ],
        },
      },
      {
        type: "ax.query-match",
        pid: 123,
        node: { _tag: "Button", title: "Run" },
      },
    ]);

    const tree = buildA11yVatMountTree({
      path: "/Terminal",
      driver: "a11y",
      args: [VAT_A11Y_STDIN_AX_QUERY_ARG, payload],
    });

    expect(tree.observedBundleIds).toEqual(["com.example.Terminal"]);
    expect(tree.observedPids).toEqual([123]);
    expect(tree.tree._tag).toBe("Terminal");
    expect(tree.tree._children?.[0]?._tag).toBe("Application");
    expect(tree.tree._children?.[0]?._children?.[0]?._tag).toBe("Window");
    expect(tree.tree._children?.[0]?._children?.[0]?._children?.[0]?._tag).toBe("Button");
  });

  test("preserves duplicate serialized matches when identical subtrees are distinct instances", () => {
    __setNativeAXForTests(makeMockNativeAX({
      wsGetRunningApps: () => [
        { pid: 123, bundleId: "com.example.Terminal", name: "Terminal", regular: true },
      ],
    }));

    const payload = JSON.stringify([
      {
        type: "ax.query-match",
        pid: 123,
        node: { _tag: "Button", title: "Run" },
      },
      {
        type: "ax.query-match",
        pid: 123,
        node: { _tag: "Button", title: "Run" },
      },
    ]);

    const tree = buildA11yVatMountTree({
      path: "/Terminal",
      driver: "a11y",
      args: [VAT_A11Y_STDIN_AX_QUERY_ARG, payload],
    });

    expect(tree.tree._children).toHaveLength(2);
    expect(tree.tree._children?.map((child) => child._tag)).toEqual(["Button", "Button"]);
  });

  test("does not let one pid suppress identical descendant matches from another pid", () => {
    __setNativeAXForTests(makeMockNativeAX({
      wsGetRunningApps: () => [
        { pid: 123, bundleId: "com.example.Terminal", name: "Terminal", regular: true },
        { pid: 456, bundleId: "com.example.OtherTerminal", name: "OtherTerminal", regular: true },
      ],
    }));

    const payload = JSON.stringify([
      {
        type: "ax.query-match",
        pid: 123,
        node: {
          _tag: "Application",
          title: "Terminal",
          _children: [
            {
              _tag: "Window",
              title: "Shell",
              _children: [{ _tag: "Button", title: "Run" }],
            },
          ],
        },
      },
      {
        type: "ax.query-match",
        pid: 456,
        node: {
          _tag: "Window",
          title: "Shell",
          _children: [{ _tag: "Button", title: "Run" }],
        },
      },
    ]);

    const tree = buildA11yVatMountTree({
      path: "/Terminal",
      driver: "a11y",
      args: [VAT_A11Y_STDIN_AX_QUERY_ARG, payload],
    });

    expect(tree.observedBundleIds).toEqual(["com.example.Terminal", "com.example.OtherTerminal"]);
    expect(tree.observedPids).toEqual([123, 456]);
    expect(tree.tree._children).toHaveLength(2);
    expect(tree.tree._children?.[0]?._tag).toBe("Application");
    expect(tree.tree._children?.[1]?._tag).toBe("Window");
    expect(tree.tree._children?.[1]?._children?.[0]?._tag).toBe("Button");
  });

  test("accepts NDJSON serialized AX query matches from stdin", () => {
    __setNativeAXForTests(makeMockNativeAX({
      wsGetRunningApps: () => [
        { pid: 123, bundleId: "com.example.Terminal", name: "Terminal", regular: true },
      ],
    }));

    const payload = [
      JSON.stringify({
        type: "ax.query-match",
        pid: 123,
        node: {
          _tag: "Application",
          title: "Terminal",
          _children: [
            {
              _tag: "Window",
              title: "Shell",
              _children: [{ _tag: "Button", title: "Run" }],
            },
          ],
        },
      }),
      JSON.stringify({
        type: "ax.query-match",
        pid: 123,
        node: {
          _tag: "Window",
          title: "Shell",
          _children: [{ _tag: "Button", title: "Run" }],
        },
      }),
      JSON.stringify({
        type: "ax.query-match",
        pid: 123,
        node: { _tag: "Button", title: "Run" },
      }),
    ].join("\n");

    const tree = buildA11yVatMountTree({
      path: "/Terminal",
      driver: "a11y",
      args: [VAT_A11Y_STDIN_AX_QUERY_ARG, payload],
    });

    expect(tree.observedBundleIds).toEqual(["com.example.Terminal"]);
    expect(tree.observedPids).toEqual([123]);
    expect(tree.tree._children?.[0]?._tag).toBe("Application");
    expect(tree.tree._children?.[0]?._children?.[0]?._tag).toBe("Window");
    expect(tree.tree._children?.[0]?._children?.[0]?._children?.[0]?._tag).toBe("Button");
  });

  test("rebuilds stdin-backed mounts from a live AX query plan", () => {
    __setNativeAXForTests(makeMockNativeAX({
      wsGetRunningApps: () => [
        { pid: 123, bundleId: "com.example.Terminal", name: "Terminal", regular: true },
      ],
      axSnapshot: () => ({
        role: "AXApplication",
        title: "Terminal",
        children: [
          {
            role: "AXWindow",
            title: "Shell",
            children: [
              {
                role: "AXButton",
                title: "Run",
                frame: { x: 10, y: 10, width: 40, height: 20 },
                children: [],
              },
            ],
          },
        ],
      }),
    }));

    const plan: VatA11YQueryPlan = {
      type: "vat.a11y-query-plan",
      query: "Application#Terminal { Window { Button } }",
      cardinality: "all",
      scope: { kind: "app", app: "Terminal" },
    };

    const tree = buildA11yVatMountTree({
      path: "/Terminal",
      driver: "a11y",
      args: [VAT_A11Y_STDIN_AX_QUERY_PLAN_ARG, JSON.stringify(plan)],
    });

    expect(tree.observedBundleIds).toEqual(["com.example.Terminal"]);
    expect(tree.observedPids).toEqual([123]);
    expect(tree.tree._tag).toBe("Terminal");
    expect(tree.tree._children?.[0]?._tag).toBe("Application");
    expect(tree.tree._children?.[0]?._children?.[0]?._tag).toBe("Window");
    expect(tree.tree._children?.[0]?._children?.[0]?._children?.[0]?._tag).toBe("Button");
  });
});
