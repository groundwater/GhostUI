import { afterEach, describe, expect, test } from "bun:test";
import { __setNativeAXForTests, type NativeAXApi, type NativeAXNode } from "../a11y/native-ax.js";
import { toGUIML } from "../cli/guiml.js";
import { createVatRegistry } from "../vat/registry.js";
import { VAT_A11Y_STDIN_AX_QUERY_PLAN_ARG, type VatA11YQueryPlan } from "../vat/types.js";
import { handleVAT } from "./vat.js";

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

describe("VAT routes", () => {
  test("mounts and serves a fixed driver tree", async () => {
    const registry = createVatRegistry();
    const mountRes = await handleVAT(
      new Request("http://localhost:7861/api/vat/mount", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: "/demo",
          driver: "fixed",
          args: ["hello", "world"],
        }),
      }),
      registry,
    );

    expect(mountRes).not.toBeNull();
    expect((mountRes as Response).status).toBe(200);
    const mounted = await (mountRes as Response).json();
    expect(mounted.ok).toBe(true);
    expect(mounted.mount.path).toBe("/demo");
    expect(mounted.mount.driver).toBe("fixed");
    expect(mounted.tree._tag).toBe("demo");
    expect(mounted.tree).not.toHaveProperty("label");
    expect(mounted.tree._children?.[0]?._text).toBe("hello world");

    const treeRes = await handleVAT(new Request("http://localhost:7861/api/vat/tree?path=/demo"), registry);
    expect(treeRes).not.toBeNull();
    expect((treeRes as Response).status).toBe(200);
    expect(await (treeRes as Response).json()).toMatchObject({
      path: "/demo",
      tree: {
        _tag: "demo",
        _children: [
          {
            _tag: "VATValue",
            _text: "hello world",
          },
        ],
      },
    });

    const mountsRes = await handleVAT(new Request("http://localhost:7861/api/vat/mounts"), registry);
    expect(mountsRes).not.toBeNull();
    expect((mountsRes as Response).status).toBe(200);
    const mounts = await (mountsRes as Response).json();
    expect(mounts).toMatchObject([
      {
        path: "/demo",
        driver: "fixed",
        args: ["hello", "world"],
      },
    ]);
    expect(mounts[0]).not.toHaveProperty("tree");

    await handleVAT(
      new Request("http://localhost:7861/api/vat/mount", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: "/other",
          driver: "fixed",
          args: ["second"],
        }),
      }),
      registry,
    );

    const rootRes = await handleVAT(new Request("http://localhost:7861/api/vat/tree"), registry);
    expect(rootRes).not.toBeNull();
    expect((rootRes as Response).status).toBe(200);
    expect(await (rootRes as Response).json()).toMatchObject({
      path: null,
      tree: {
        _tag: "VATRoot",
        _children: [
          {
            _tag: "demo",
            _children: [
              {
                _tag: "VATValue",
                _text: "hello world",
              },
            ],
          },
          {
            _tag: "other",
            _children: [
              {
                _tag: "VATValue",
                _text: "second",
              },
            ],
          },
        ],
      },
    });
  });

  test("unmounts a VAT path and restores the remaining tree", async () => {
    const registry = createVatRegistry();
    await handleVAT(
      new Request("http://localhost:7861/api/vat/mount", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: "/demo",
          driver: "fixed",
          args: ["hello"],
        }),
      }),
      registry,
    );

    const unmountRes = await handleVAT(new Request("http://localhost:7861/api/vat/mount?path=/demo", {
      method: "DELETE",
    }), registry);
    expect(unmountRes).not.toBeNull();
    expect((unmountRes as Response).status).toBe(200);
    expect(await (unmountRes as Response).json()).toMatchObject({
      ok: true,
      unmounted: {
        path: "/demo",
        driver: "fixed",
      },
    });

    const mountsRes = await handleVAT(new Request("http://localhost:7861/api/vat/mounts"), registry);
    expect(mountsRes).not.toBeNull();
    expect(await (mountsRes as Response).json()).toEqual([]);

    const treeRes = await handleVAT(new Request("http://localhost:7861/api/vat/tree"), registry);
    expect(treeRes).not.toBeNull();
    expect((treeRes as Response).status).toBe(200);
    expect(await (treeRes as Response).json()).toMatchObject({
      path: null,
      tree: {
        _tag: "VATRoot",
        _children: [],
      },
    });
  });

  test("mounts a root a11y tree and overlays repeated sibling paths deterministically", async () => {
    __setNativeAXForTests(makeMockNativeAX({
      wsGetRunningApps: () => [
        { pid: 123, bundleId: "com.example.Editor", name: "Editor", regular: true },
      ],
      cgGetWindowRects: () => [
        { pid: 123, cgWindowId: 99, bundleId: "com.example.Editor", x: 40, y: 50, w: 900, h: 700, layer: 0, title: "Editor" },
      ],
      axGetFrontmostPid: () => 123,
      axSnapshot: () => ({
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
          {
            role: "AXWindow",
            title: "Aux",
            children: [
              {
                role: "AXButton",
                title: "Cancel",
                children: [],
              },
            ],
          },
        ],
      }),
    }));

    const registry = createVatRegistry();
    const mountRes = await handleVAT(
      new Request("http://localhost:7861/api/vat/mount", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: "/",
          driver: "a11y",
          args: ["Application#Editor { Window { Button } }"],
        }),
      }),
      registry,
    );

    expect(mountRes).not.toBeNull();
    expect((mountRes as Response).status).toBe(200);
    const mounted = await (mountRes as Response).json();
    expect(mounted.mount.driver).toBe("a11y");
    expect(mounted.mount.path).toBe("/");
    expect(mounted.tree._tag).toBe("Application");
    expect(mounted.tree).not.toHaveProperty("driver");
    expect(mounted.tree).not.toHaveProperty("source");
    expect(mounted.tree).not.toHaveProperty("query");
    expect(mounted.tree).not.toHaveProperty("matchCount");

    const guiml = toGUIML([mounted.tree]);
    expect(guiml).toContain("<Application");
    expect(guiml).toContain("Application#Editor");
    expect(guiml).toContain("Window#Main");
    expect(guiml).toContain("Window#Aux");

    const rootRes = await handleVAT(new Request("http://localhost:7861/api/vat/tree?path=/"), registry);
    expect(rootRes).not.toBeNull();
    expect((rootRes as Response).status).toBe(200);
    const rootTree = await (rootRes as Response).json();
    expect(rootTree.path).toBe("/");
    expect(rootTree.tree._tag).toBe("Application");
    expect(rootTree.tree._children?.map((child: { _tag: string }) => child._tag)).toEqual(["Window", "Window"]);

    const treeRes = await handleVAT(new Request("http://localhost:7861/api/vat/tree?path=/Window"), registry);
    expect(treeRes).not.toBeNull();
    expect((treeRes as Response).status).toBe(200);
    const tree = await (treeRes as Response).json();
    expect(tree.path).toBe("/Window");
    expect(tree.tree._tag).toBe("Window");
    expect(tree.tree._children?.[0]?._tag).toBe("Button");
    expect(tree.tree._children?.[0]?._children).toBeUndefined();

    await handleVAT(
      new Request("http://localhost:7861/api/vat/mount", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: "/Window/Button",
          driver: "fixed",
          args: ["overlay"],
        }),
      }),
      registry,
    );

    const overlayRes = await handleVAT(new Request("http://localhost:7861/api/vat/tree?path=/Window/Button"), registry);
    expect(overlayRes).not.toBeNull();
    expect((overlayRes as Response).status).toBe(200);
    const overlay = await (overlayRes as Response).json();
    expect(overlay.path).toBe("/Window/Button");
    expect(overlay.tree._tag).toBe("Button");
    expect(overlay.tree._children?.[0]?._tag).toBe("VATValue");
    expect(overlay.tree._children?.[0]?._text).toBe("overlay");

    const refreshedRootRes = await handleVAT(new Request("http://localhost:7861/api/vat/tree?path=/"), registry);
    expect(refreshedRootRes).not.toBeNull();
    expect((refreshedRootRes as Response).status).toBe(200);
    const refreshedRootTree = await (refreshedRootRes as Response).json();
    expect(refreshedRootTree.tree._children?.[0]?._tag).toBe("Window");
    expect(refreshedRootTree.tree._children?.[0]?._children?.[0]?._tag).toBe("Button");
    expect(refreshedRootTree.tree._children?.[1]?._tag).toBe("Window");
    expect(refreshedRootTree.tree._children?.[1]?._children?.[0]?._tag).toBe("Button");
    expect(refreshedRootTree.tree._children?.[0]?._children?.[0]?._children?.[0]?._tag).toBe("VATValue");
    expect(refreshedRootTree.tree._children?.[0]?._children?.[0]?._children?.[0]?._text).toBe("overlay");
    expect(refreshedRootTree.tree._children?.[1]?._children?.[0]?._children).toBeUndefined();

    const secondWindowRes = await handleVAT(new Request("http://localhost:7861/api/vat/tree?path=/Window[1]/Button"), registry);
    expect(secondWindowRes).not.toBeNull();
    expect((secondWindowRes as Response).status).toBe(200);
    const secondWindowTree = await (secondWindowRes as Response).json();
    expect(secondWindowTree.path).toBe("/Window[1]/Button");
    expect(secondWindowTree.tree._tag).toBe("Button");
    expect(secondWindowTree.tree._children).toBeUndefined();
  });

  test("refreshes matching a11y mounts on observer events and ignores unrelated ones", async () => {
    let snapshotVersion = 0;
    let snapshotCalls = 0;

    __setNativeAXForTests(makeMockNativeAX({
      wsGetRunningApps: () => [
        { pid: 123, bundleId: "com.example.Editor", name: "Editor", regular: true },
      ],
      cgGetWindowRects: () => [
        { pid: 123, cgWindowId: 99, bundleId: "com.example.Editor", x: 40, y: 50, w: 900, h: 700, layer: 0, title: "Editor" },
      ],
      axGetFrontmostPid: () => 123,
      axSnapshot: () => {
        snapshotCalls += 1;
        return snapshotVersion === 0 ? {
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
        } : {
          role: "AXApplication",
          title: "Editor",
          children: [
            {
              role: "AXWindow",
              title: "Main updated",
              children: [
                {
                  role: "AXButton",
                  title: "Save updated",
                  children: [],
                },
              ],
            },
          ],
        };
      },
    }));

    const registry = createVatRegistry();
    await handleVAT(
      new Request("http://localhost:7861/api/vat/mount", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: "/",
          driver: "a11y",
          args: ["Application#Editor { Window { Button } }"],
        }),
      }),
      registry,
    );

    await handleVAT(
      new Request("http://localhost:7861/api/vat/mount", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: "/Application/Window/Button",
          driver: "fixed",
          args: ["overlay"],
        }),
      }),
      registry,
    );

    const buttonBefore = await handleVAT(new Request("http://localhost:7861/api/vat/tree?path=/Window/Button"), registry);
    expect(buttonBefore).not.toBeNull();
    expect((buttonBefore as Response).status).toBe(200);
    const buttonBeforeBody = await (buttonBefore as Response).json();
    expect(buttonBeforeBody.tree._children).toBeUndefined();

    const beforeRefreshSnapshotCalls = snapshotCalls;
    snapshotVersion = 1;
    const refreshed = registry.handleAXObserverEvent({
      type: "window-resized",
      pid: 123,
      bundleId: "com.example.Editor",
    });

    expect(refreshed).toBe(1);
    expect(snapshotCalls).toBeGreaterThan(beforeRefreshSnapshotCalls);

    const windowAfter = await handleVAT(new Request("http://localhost:7861/api/vat/tree?path=/Window"), registry);
    expect(windowAfter).not.toBeNull();
    expect((windowAfter as Response).status).toBe(200);
    expect((await (windowAfter as Response).json()).tree._id).toContain("Main updated");

    const buttonAfter = await handleVAT(new Request("http://localhost:7861/api/vat/tree?path=/Window/Button"), registry);
    expect(buttonAfter).not.toBeNull();
    expect((buttonAfter as Response).status).toBe(200);
    const buttonAfterBody = await (buttonAfter as Response).json();
    expect(buttonAfterBody.tree._children).toBeUndefined();

    const afterRefreshSnapshotCalls = snapshotCalls;
    const ignored = registry.handleAXObserverEvent({
      type: "window-resized",
      pid: 999,
      bundleId: "com.example.Other",
    });
    expect(ignored).toBe(0);
    expect(snapshotCalls).toBe(afterRefreshSnapshotCalls);
  });

  test("replaces duplicate mount paths in place", async () => {
    const registry = createVatRegistry();
    await handleVAT(
      new Request("http://localhost:7861/api/vat/mount", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: "/demo",
          driver: "fixed",
          args: [],
        }),
      }),
      registry,
    );

    const remountRes = await handleVAT(
      new Request("http://localhost:7861/api/vat/mount", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: "/demo",
          driver: "fixed",
          args: ["again"],
        }),
      }),
      registry,
    );

    expect(remountRes).not.toBeNull();
    expect((remountRes as Response).status).toBe(200);
    expect(await (remountRes as Response).json()).toMatchObject({
      ok: true,
      mount: {
        path: "/demo",
        driver: "fixed",
        args: ["again"],
      },
      tree: {
        _tag: "demo",
        _children: [
          {
            _tag: "VATValue",
            _text: "again",
          },
        ],
      },
    });

    const mountsRes = await handleVAT(new Request("http://localhost:7861/api/vat/mounts"), registry);
    expect(mountsRes).not.toBeNull();
    expect(await (mountsRes as Response).json()).toMatchObject([
      {
        path: "/demo",
        driver: "fixed",
        args: ["again"],
      },
    ]);
  });

  test("rejects unknown drivers", async () => {
    const registry = createVatRegistry();
    const res = await handleVAT(
      new Request("http://localhost:7861/api/vat/mount", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: "/demo",
          driver: "mystery",
          args: [],
        }),
      }),
      registry,
    );

    expect(res).not.toBeNull();
    expect((res as Response).status).toBe(422);
    expect(await (res as Response).json()).toMatchObject({
      error: "Unknown VAT driver: mystery",
    });
  });

  test("rejects invalid a11y GUIML queries", async () => {
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

    const registry = createVatRegistry();
    const res = await handleVAT(
      new Request("http://localhost:7861/api/vat/mount", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: "/editor",
          driver: "a11y",
          args: ["Application {"],
        }),
      }),
      registry,
    );

    expect(res).not.toBeNull();
    expect((res as Response).status).toBe(400);
    const body = await (res as Response).json();
    expect(body.error).toContain("Invalid a11y GUIML query:");
  });

  test("surfaces raw a11y build failures", async () => {
    __setNativeAXForTests(makeMockNativeAX({
      wsGetRunningApps: () => [
        { pid: 123, bundleId: "com.example.Editor", name: "Editor", regular: true },
      ],
      axSnapshot: () => {
        throw new Error("AX snapshot failed");
      },
    }));

    const registry = createVatRegistry();
    const res = await handleVAT(
      new Request("http://localhost:7861/api/vat/mount", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: "/editor",
          driver: "a11y",
          args: ["Application { Window }"],
        }),
      }),
      registry,
    );

    expect(res).not.toBeNull();
    expect((res as Response).status).toBe(400);
    const body = await (res as Response).json();
    expect(body.error).toContain("Unable to build raw a11y tree:");
    expect(body.error).toContain("AX snapshot failed");
  });

  test("refreshes stdin-backed a11y mounts from AX query plans", async () => {
    let snapshotVersion = 0;
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
            title: snapshotVersion === 0 ? "Shell" : "Shell updated",
            children: [
              {
                role: "AXButton",
                title: snapshotVersion === 0 ? "Run" : "Run updated",
                frame: { x: 20, y: 20, width: 40, height: 20 },
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
    const registry = createVatRegistry();

    const mountRes = await handleVAT(
      new Request("http://localhost:7861/api/vat/mount", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: "/Terminal",
          driver: "a11y",
          args: [VAT_A11Y_STDIN_AX_QUERY_PLAN_ARG, JSON.stringify(plan)],
        }),
      }),
      registry,
    );

    expect(mountRes).not.toBeNull();
    expect((mountRes as Response).status).toBe(200);
    expect((await (mountRes as Response).json()).tree._children?.[0]?._children?.[0]?._id).toBe("Shell");

    snapshotVersion = 1;
    const refreshed = registry.handleAXObserverEvent({
      type: "window-resized",
      pid: 123,
      bundleId: "com.example.Terminal",
    });
    expect(refreshed).toBe(1);

    const treeRes = await handleVAT(new Request("http://localhost:7861/api/vat/tree?path=/Terminal"), registry);
    expect(treeRes).not.toBeNull();
    expect((treeRes as Response).status).toBe(200);
    const treeBody = await (treeRes as Response).json();
    expect(treeBody.tree._children?.[0]?._children?.[0]?._id).toBe("Shell updated");
    expect(treeBody.tree._children?.[0]?._children?.[0]?._children?.[0]?._id).toBe("Run updated");
  });

  test("query-plan mounts preserve full-introspection attrs through a subsequent VAT query", async () => {
    __setNativeAXForTests(makeMockNativeAX({
      wsGetRunningApps: () => [
        { pid: 123, bundleId: "com.example.Codex", name: "Codex", regular: true },
      ],
      axSnapshot: () => ({
        role: "AXApplication",
        title: "Codex",
        frame: { x: 10, y: 20, width: 1200, height: 800 },
        children: [
          {
            role: "AXWindow",
            title: "Editor",
            frame: { x: 20, y: 40, width: 1000, height: 700 },
            children: [
              {
                role: "AXButton",
                title: "Run",
                frame: { x: 100, y: 120, width: 80, height: 28 },
                children: [],
              },
            ],
          },
        ],
      }),
    }));

    const plan: VatA11YQueryPlan = {
      type: "vat.a11y-query-plan",
      query: "@Application#Codex//*[**]",
      cardinality: "all",
      scope: { kind: "app", app: "Codex" },
    };
    const registry = createVatRegistry();

    const mountRes = await handleVAT(
      new Request("http://localhost:7861/api/vat/mount", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: "/Codex",
          driver: "a11y",
          args: [VAT_A11Y_STDIN_AX_QUERY_PLAN_ARG, JSON.stringify(plan)],
        }),
      }),
      registry,
    );

    expect(mountRes).not.toBeNull();
    expect((mountRes as Response).status).toBe(200);

    const fullQueryRes = await handleVAT(
      new Request(`http://localhost:7861/api/vat/query?q=${encodeURIComponent("Codex/Window[**]")}`),
      registry,
    );
    expect(fullQueryRes).not.toBeNull();
    expect((fullQueryRes as Response).status).toBe(200);
    const fullQueryBody = await (fullQueryRes as Response).json();
    const fullWindow = fullQueryBody.nodes?.[0]?._children?.[0]?._children?.[0];
    expect(fullQueryBody.matchCount).toBe(1);
    expect(fullWindow?.frame).toBe("(20,40,1000,700)");
    expect(fullWindow?.title).toBe("Editor");
    expect(fullWindow?._children).toBeUndefined();

    const keysOnlyRes = await handleVAT(
      new Request(`http://localhost:7861/api/vat/query?q=${encodeURIComponent("Codex/Window[*] { Button }")}`),
      registry,
    );
    expect(keysOnlyRes).not.toBeNull();
    expect((keysOnlyRes as Response).status).toBe(200);
    const keysOnlyBody = await (keysOnlyRes as Response).json();
    const keysOnlyWindow = keysOnlyBody.nodes?.[0]?._children?.[0]?._children?.[0];
    expect(keysOnlyBody.matchCount).toBe(1);
    expect(keysOnlyWindow?.frame).toBeUndefined();
    expect(keysOnlyWindow?._frame).toBe(true);
    expect(keysOnlyWindow?.title).toBeUndefined();
    expect(keysOnlyWindow?._children?.[0]?._frame).toBe("(100,120,80,28)");
  });

  test("updates mount policy and eagerly activates always mounts", async () => {
    const registry = createVatRegistry();
    await handleVAT(
      new Request("http://localhost:7861/api/vat/mount", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: "/demo",
          driver: "fixed",
          args: ["hello"],
          mountPolicy: { kind: "auto", unmountTimeout: { kind: "never" } },
        }),
      }),
      registry,
    );

    expect(registry.list()).toMatchObject([
      {
        path: "/demo",
        active: false,
        mountPolicy: { kind: "auto", unmountTimeout: { kind: "never" } },
      },
    ]);

    const policyRes = await handleVAT(
      new Request("http://localhost:7861/api/vat/policy?path=/demo", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mountPolicy: { kind: "always" } }),
      }),
      registry,
    );

    expect(policyRes).not.toBeNull();
    expect((policyRes as Response).status).toBe(200);
    const body = await (policyRes as Response).json();
    expect(body.mount.active).toBe(true);
    expect(body.mount.mountPolicy).toEqual({ kind: "always" });
    expect(body.activeMount.tree._tag).toBe("demo");
  });

  test("persist rollback restores already-active auto mounts", async () => {
    const registry = createVatRegistry();
    registry.mount({
      path: "/demo",
      driver: "fixed",
      args: ["hello"],
      mountPolicy: { kind: "auto", unmountTimeout: { kind: "never" } },
    });
    const activated = registry.activatePath("/demo");
    expect(activated).toHaveLength(1);
    const activeBefore = activated[0];

    const policyRes = await handleVAT(
      new Request("http://localhost:7861/api/vat/policy?path=/demo", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mountPolicy: { kind: "disabled" } }),
      }),
      registry,
      {
        persist: async () => {
          throw new Error("disk full");
        },
      },
    );

    expect(policyRes).not.toBeNull();
    expect((policyRes as Response).status).toBe(400);
    expect(await (policyRes as Response).json()).toMatchObject({
      error: "disk full",
    });
    expect(registry.list()).toMatchObject([
      {
        path: "/demo",
        mountPolicy: { kind: "auto", unmountTimeout: { kind: "never" } },
        active: true,
        activeSince: activeBefore.activeSince,
      },
    ]);
    expect(registry.tree("/demo")).toMatchObject({
      path: "/demo",
      tree: {
        _tag: "demo",
        _children: [
          {
            _tag: "VATValue",
            _text: "hello",
          },
        ],
      },
    });
  });

  test("vat queries lazily activate auto mounts", async () => {
    const registry = createVatRegistry();
    const mountRes = await handleVAT(
      new Request("http://localhost:7861/api/vat/mount", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: "/demo",
          driver: "fixed",
          args: ["hello"],
          mountPolicy: { kind: "auto", unmountTimeout: { kind: "never" } },
        }),
      }),
      registry,
    );

    expect(mountRes).not.toBeNull();
    const mountBody = await (mountRes as Response).json();
    expect(mountBody.mount.active).toBe(false);
    expect(mountBody.activeMount).toBeNull();

    const queryRes = await handleVAT(new Request("http://localhost:7861/api/vat/query?q=demo"), registry);
    expect(queryRes).not.toBeNull();
    expect((queryRes as Response).status).toBe(200);
    const queryBody = await (queryRes as Response).json();
    expect(queryBody.matchCount).toBe(1);
    expect(queryBody.tree._children?.[0]?._tag).toBe("demo");
    expect(registry.list()[0]?.active).toBe(true);
  });

  test("vat tree inspection does not activate auto mounts", async () => {
    const registry = createVatRegistry();
    await handleVAT(
      new Request("http://localhost:7861/api/vat/mount", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: "/demo",
          driver: "fixed",
          args: ["hello"],
          mountPolicy: { kind: "auto", unmountTimeout: { kind: "never" } },
        }),
      }),
      registry,
    );

    const treeRes = await handleVAT(new Request("http://localhost:7861/api/vat/tree?path=/demo"), registry);
    expect(treeRes).not.toBeNull();
    expect((treeRes as Response).status).toBe(404);
    expect(await (treeRes as Response).json()).toMatchObject({
      error: "No VAT mount at path: /demo",
    });
    expect(registry.list()[0]?.active).toBe(false);

    const rootRes = await handleVAT(new Request("http://localhost:7861/api/vat/tree"), registry);
    expect(rootRes).not.toBeNull();
    expect((rootRes as Response).status).toBe(200);
    expect(await (rootRes as Response).json()).toMatchObject({
      path: null,
      tree: {
        _tag: "VATRoot",
        _children: [],
      },
    });
    expect(registry.list()[0]?.active).toBe(false);
  });
});
