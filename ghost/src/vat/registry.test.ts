import { describe, expect, test } from "bun:test";
import { createVatRegistry } from "./registry.js";
import { wrapVatMountPath } from "./path.js";
import type { VatMountBuild } from "./types.js";

const ALWAYS = { kind: "always" } as const;
const AUTO_1S = { kind: "auto", unmountTimeout: { kind: "seconds", seconds: 1 } } as const;

type TestNode = {
  _tag: string;
  _text?: string;
  title?: string;
  _children?: TestNode[];
};

function buttonText(tree: TestNode): string | undefined {
  return tree._children?.[0]?._children?.[0]?._children?.[0]?._children?.[0]?._text;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("VAT registry observer refresh", () => {
  test("replaces an existing mount in place without leaving stale observer tracking behind", () => {
    let firstBuilds = 0;
    let secondBuilds = 0;

    const registry = createVatRegistry({
      drivers: new Map<string, (request: { path: string; driver: string; args: string[] }) => VatMountBuild>([
        [
          "first",
          () => {
            firstBuilds += 1;
            return {
              tree: {
                _tag: "Display",
                title: `first ${firstBuilds}`,
              },
              observedBundleIds: ["com.example.Editor"],
            };
          },
        ],
        [
          "second",
          () => {
            secondBuilds += 1;
            return {
              tree: {
                _tag: "Display",
                title: `second ${secondBuilds}`,
              },
              observedBundleIds: ["com.example.TextEdit"],
            };
          },
        ],
      ]),
    });

    const first = registry.mount({ path: "/demo", driver: "first", args: [], mountPolicy: ALWAYS });
    expect(first.mount.path).toBe("/demo");
    expect(first.mount.driver).toBe("first");
    expect(first.mount.active).toBe(true);
    expect(firstBuilds).toBe(1);
    expect(secondBuilds).toBe(0);

    const second = registry.mount({ path: "/demo", driver: "second", args: [], mountPolicy: ALWAYS });
    expect(second.mount.path).toBe("/demo");
    expect(second.mount.driver).toBe("second");
    expect(firstBuilds).toBe(1);
    expect(secondBuilds).toBe(1);
    expect(registry.list()).toEqual([
      {
        path: "/demo",
        driver: "second",
        args: [],
        mountPolicy: ALWAYS,
        active: true,
        activeSince: second.activeMount?.activeSince ?? null,
      },
    ]);

    const staleRefreshes = registry.handleAXObserverEvent({
      type: "window-created",
      pid: 123,
      bundleId: "com.example.Editor",
    });
    expect(staleRefreshes).toBe(0);
    expect(firstBuilds).toBe(1);
    expect(secondBuilds).toBe(1);

    const liveRefreshes = registry.handleAXObserverEvent({
      type: "window-created",
      pid: 123,
      bundleId: "com.example.TextEdit",
    });
    expect(liveRefreshes).toBe(1);
    expect(firstBuilds).toBe(1);
    expect(secondBuilds).toBe(2);
  });

  test("refreshes only matching a11y mounts and preserves nested overlays", () => {
    let parentBuilds = 0;
    let otherBuilds = 0;

    const registry = createVatRegistry({
      drivers: new Map<string, (request: { path: string; driver: string; args: string[] }) => VatMountBuild>([
        [
          "watched",
          () => {
            parentBuilds += 1;
            return {
              tree: {
                _tag: "Display",
                _children: [
                  {
                    _tag: "Application",
                    bundleId: "com.example.Editor",
                    _children: [
                      {
                        _tag: "Window",
                        title: `Main ${parentBuilds}`,
                        _children: [
                          {
                            _tag: "Button",
                            _children: [
                              {
                                _tag: "VATValue",
                                _text: `version ${parentBuilds}`,
                              },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
              observedBundleIds: ["com.example.Editor"],
            };
          },
        ],
        [
          "other",
          () => {
            otherBuilds += 1;
            return {
              tree: wrapVatMountPath("/Other", [
                {
                  _tag: "VATValue",
                  _text: `other ${otherBuilds}`,
                },
              ]),
              observedBundleIds: ["com.example.TextEdit"],
            };
          },
        ],
      ]),
    });

    registry.mount({ path: "/", driver: "watched", args: [], mountPolicy: ALWAYS });
    registry.mount({ path: "/Application/Window/Button", driver: "fixed", args: ["overlay"], mountPolicy: ALWAYS });
    registry.mount({ path: "/Other", driver: "other", args: [], mountPolicy: ALWAYS });

    expect(parentBuilds).toBe(1);
    expect(otherBuilds).toBe(1);

    const before = registry.tree("/");
    expect(before.tree._children?.[0]?._children?.[0]?._children?.[0]?._children?.[0]?._tag).toBe("VATValue");
    expect(buttonText(before.tree)).toBe("overlay");
    expect(before.tree._children?.[0]?._children?.[0]?._tag).toBe("Window");

    const refreshed = registry.handleAXObserverEvent({
      type: "window-created",
      pid: 123,
      bundleId: "com.example.Editor",
    });

    expect(refreshed).toBe(1);
    expect(parentBuilds).toBe(2);
    expect(otherBuilds).toBe(1);

    const after = registry.tree("/");
    expect(after.tree._children?.[0]?._children?.[0]?._tag).toBe("Window");
    expect(after.tree._children?.[0]?._children?.[0]?._children?.[0]?._tag).toBe("Button");
    expect(buttonText(after.tree)).toBe("overlay");
    expect(after.tree._children?.[0]?._children?.[0]?._children?.[0]?._children?.[0]?._text).toBe("overlay");
    expect(after.tree._children?.[0]?._children?.[0]?._children?.[0]?._children?.[0]?._children).toBeUndefined();
  });

  test("ignores unrelated observer events", () => {
    let calls = 0;
    const registry = createVatRegistry({
      drivers: new Map<string, (request: { path: string; driver: string; args: string[] }) => VatMountBuild>([
        [
          "watched",
          () => {
            calls += 1;
            return {
              tree: { _tag: "Display" },
              observedBundleIds: ["com.example.Editor"],
            };
          },
        ],
      ]),
    });

    registry.mount({ path: "/watched", driver: "watched", args: [], mountPolicy: ALWAYS });
    expect(calls).toBe(1);

    const refreshed = registry.handleAXObserverEvent({
      type: "window-created",
      pid: 999,
      bundleId: "com.example.Other",
    });

    expect(refreshed).toBe(0);
    expect(calls).toBe(1);
  });

  test("matches observer events by pid when bundleId does not match", () => {
    let calls = 0;
    const registry = createVatRegistry({
      drivers: new Map<string, (request: { path: string; driver: string; args: string[] }) => VatMountBuild>([
        [
          "watched",
          () => {
            calls += 1;
            return {
              tree: { _tag: "Display" },
              observedPids: [321],
            };
          },
        ],
      ]),
    });

    registry.mount({ path: "/watched", driver: "watched", args: [], mountPolicy: ALWAYS });
    expect(calls).toBe(1);

    const refreshed = registry.handleAXObserverEvent({
      type: "window-created",
      pid: 321,
      bundleId: "com.example.Other",
    });

    expect(refreshed).toBe(1);
    expect(calls).toBe(2);
  });

  test("auto mounts stay inactive until their path is touched", () => {
    let builds = 0;
    const registry = createVatRegistry({
      drivers: new Map<string, (request: { path: string; driver: string; args: string[] }) => VatMountBuild>([
        [
          "lazy",
          () => {
            builds += 1;
            return {
              tree: wrapVatMountPath("/Window/Button", [{ _tag: "VATValue", _text: `lazy ${builds}` }]),
            };
          },
        ],
      ]),
    });

    registry.mount({ path: "/Window/Button", driver: "lazy", args: [], mountPolicy: AUTO_1S });
    expect(builds).toBe(0);
    expect(registry.list()[0]).toMatchObject({
      path: "/Window/Button",
      active: false,
      mountPolicy: AUTO_1S,
    });

    registry.activatePath("/Window/Button");
    expect(builds).toBe(1);
    expect(registry.list()[0]?.active).toBe(true);
    expect(registry.tree("/Window/Button").tree._children?.[0]?._text).toBe("lazy 1");
  });

  test("auto mounts only activate the longest matching persisted path", () => {
    let parentBuilds = 0;
    let childBuilds = 0;

    const registry = createVatRegistry({
      drivers: new Map<string, (request: { path: string; driver: string; args: string[] }) => VatMountBuild>([
        [
          "parent",
          () => {
            parentBuilds += 1;
            return {
              tree: wrapVatMountPath("/Window", [{ _tag: "VATValue", _text: "parent" }]),
            };
          },
        ],
        [
          "child",
          () => {
            childBuilds += 1;
            return {
              tree: wrapVatMountPath("/Window/Button", [{ _tag: "VATValue", _text: "child" }]),
            };
          },
        ],
      ]),
    });

    registry.mount({ path: "/Window", driver: "parent", args: [], mountPolicy: AUTO_1S });
    registry.mount({ path: "/Window/Button", driver: "child", args: [], mountPolicy: AUTO_1S });

    const activated = registry.activatePath("/Window/Button/Label");

    expect(activated.map((mount) => mount.path)).toEqual(["/Window/Button"]);
    expect(parentBuilds).toBe(0);
    expect(childBuilds).toBe(1);
    expect(registry.list()).toMatchObject([
      { path: "/Window", active: false },
      { path: "/Window/Button", active: true },
    ]);
  });

  test("observer refresh does not reset auto unmount inactivity", async () => {
    let builds = 0;

    const registry = createVatRegistry({
      drivers: new Map<string, (request: { path: string; driver: string; args: string[] }) => VatMountBuild>([
        [
          "watched-auto",
          () => {
            builds += 1;
            return {
              tree: wrapVatMountPath("/watched", [{ _tag: "VATValue", _text: `build ${builds}` }]),
              observedPids: [321],
            };
          },
        ],
      ]),
    });

    registry.mount({ path: "/watched", driver: "watched-auto", args: [], mountPolicy: AUTO_1S });
    registry.activatePath("/watched");
    expect(builds).toBe(1);
    expect(registry.list()[0]?.active).toBe(true);

    await wait(600);
    expect(registry.handleAXObserverEvent({
      type: "window-created",
      pid: 321,
      bundleId: "com.example.Watched",
    })).toBe(1);
    expect(builds).toBe(2);
    expect(registry.list()[0]?.active).toBe(true);

    await wait(550);
    expect(registry.list()[0]?.active).toBe(false);
  });
});
