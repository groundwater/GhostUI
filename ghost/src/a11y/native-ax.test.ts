import { afterEach, describe, expect, test } from "bun:test";
import {
  __setNativeAXForTests,
  buildSnapshot,
  findCursor,
  getAppMetadata,
  getDisplays,
  keychainReadGenericPassword,
  pbRead, pbWrite, pbTypes, pbClear,
  axAt, axGetActions, findAndFocus, focusContainingWindow, menuAt,
  findAndClick, findAndPerformAction, findAndType,
  shouldLogNativeAXLoad,
  type NativeAXApi,
  type NativeAXCursor,
  type NativeAXNode,
  type DisplayInfo,
} from "./native-ax.js";

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
    axSetSelectedTextRange: () => true,
    axSetWindowPosition: () => true,
    axFocusWindow: () => true,
    axStartObserving: () => true,
    axStopObserving: () => true,
    axScreenshot: () => null,
    pbRead: () => null,
    pbWrite: () => true,
    pbTypes: () => [],
    pbClear: () => true,
    wsGetDisplays: () => [],
    ...overrides,
  };
}

afterEach(() => {
  __setNativeAXForTests();
});

describe("native AX metadata assembly", () => {
  test("native AX load logging is gated behind an explicit debug env flag", () => {
    const original = process.env.GHOSTUI_NATIVE_AX_DEBUG;
    try {
      delete process.env.GHOSTUI_NATIVE_AX_DEBUG;
      expect(shouldLogNativeAXLoad()).toBe(false);
      process.env.GHOSTUI_NATIVE_AX_DEBUG = "1";
      expect(shouldLogNativeAXLoad()).toBe(true);
    } finally {
      if (original === undefined) {
        delete process.env.GHOSTUI_NATIVE_AX_DEBUG;
      } else {
        process.env.GHOSTUI_NATIVE_AX_DEBUG = original;
      }
    }
  });

  test("getAppMetadata preserves bundle ids for CG windows discovered from ws app data", () => {
    __setNativeAXForTests(makeMockNativeAX({
      wsGetRunningApps: () => [
        { pid: 181, bundleId: "com.microsoft.VSCode", name: "Code", regular: true },
        { pid: 13954, bundleId: "com.apple.Terminal", name: "Terminal", regular: true },
      ],
      cgGetWindowRects: () => [
        { pid: 181, cgWindowId: 12588, x: 200, y: 25, w: 971, h: 734, layer: 0, title: "Code" },
        { pid: 13954, cgWindowId: 10965, x: 803, y: 176, w: 679, h: 581, layer: 0, title: "Terminal" },
      ],
      axGetFrontmostPid: () => 181,
    }));

    const metadata = getAppMetadata();

    expect(metadata.apps).toContainEqual({
      pid: 181,
      bundleId: "com.microsoft.VSCode",
      name: "Code",
      regular: true,
    });
    expect(metadata.frontBundleId).toBe("com.microsoft.VSCode");
    expect(metadata.screenW).toBe(1728);
    expect(metadata.screenH).toBe(1117);
    expect(metadata.windowRects).toContainEqual({
      pid: 181,
      cgWindowId: 12588,
      bundleId: "com.microsoft.VSCode",
      x: 200,
      y: 25,
      w: 971,
      h: 734,
      title: "Code",
    });
  });

  test("getDisplays returns display info from native module", () => {
    const mockDisplays: DisplayInfo[] = [
      {
        id: 1,
        name: "Built-in Retina Display",
        main: true,
        frame: { x: 0, y: 0, width: 1728, height: 1117 },
        visibleFrame: { x: 0, y: 25, width: 1728, height: 1055 },
        scale: 2,
        physicalSize: { width: 345, height: 223 },
        rotation: 0,
      },
    ];
    __setNativeAXForTests(makeMockNativeAX({
      wsGetDisplays: () => mockDisplays,
    }));

    const displays = getDisplays();
    expect(displays).toHaveLength(1);
    expect(displays[0].name).toBe("Built-in Retina Display");
    expect(displays[0].main).toBe(true);
    expect(displays[0].scale).toBe(2);
  });

  test("pbRead returns clipboard content from native module", () => {
    __setNativeAXForTests(makeMockNativeAX({
      pbRead: (type?: string) => type === "public.html" ? "<b>hi</b>" : "hi",
    }));

    expect(pbRead()).toBe("hi");
    expect(pbRead("public.html")).toBe("<b>hi</b>");
  });

  test("pbWrite writes to native clipboard", () => {
    let written: { text: string; type?: string } | null = null;
    __setNativeAXForTests(makeMockNativeAX({
      pbWrite: (text: string, type?: string) => { written = { text, type }; return true; },
    }));

    const result = pbWrite("test");
    expect(result).toBe(true);
    expect(written!.text).toBe("test");
  });

  test("pbTypes returns type list from native module", () => {
    __setNativeAXForTests(makeMockNativeAX({
      pbTypes: () => ["public.utf8-plain-text", "public.html"],
    }));

    const types = pbTypes();
    expect(types).toEqual(["public.utf8-plain-text", "public.html"]);
  });

  test("pbClear returns true from native module", () => {
    __setNativeAXForTests(makeMockNativeAX({
      pbClear: () => true,
    }));

    expect(pbClear()).toBe(true);
  });

  test("keychainReadGenericPassword delegates to the native module", () => {
    __setNativeAXForTests(makeMockNativeAX({
      keychainReadGenericPassword: (service: string, account: string, accessGroup?: string) => {
        expect(service).toBe("svc");
        expect(account).toBe("acct");
        expect(accessGroup).toBe("group");
        return "secret";
      },
    }));

    expect(keychainReadGenericPassword("svc", "acct", "group")).toBe("secret");
  });

  test("axAt returns null when no element frame contains the point", () => {
    __setNativeAXForTests(makeMockNativeAX({
      axGetFrontmostPid: () => 100,
      axSnapshot: () => ({
        role: "AXApplication",
        // no frame — root without frame
        children: [
          {
            role: "AXWindow",
            frame: { x: 0, y: 0, width: 800, height: 600 },
            children: [],
          },
        ],
      }),
    }));

    // Point inside the window frame
    const hit = axAt(400, 300);
    expect(hit).not.toBeNull();
    expect(hit!.node.role).toBe("AXWindow");

    // Point completely outside
    const miss = axAt(2000, 2000);
    expect(miss).toBeNull();
  });

  test("axAt returns the deepest element containing the point", () => {
    __setNativeAXForTests(makeMockNativeAX({
      axGetFrontmostPid: () => 100,
      axSnapshot: () => ({
        role: "AXApplication",
        children: [
          {
            role: "AXWindow",
            frame: { x: 0, y: 0, width: 800, height: 600 },
            children: [
              {
                role: "AXButton",
                title: "OK",
                frame: { x: 100, y: 100, width: 80, height: 30 },
                children: [],
              },
            ],
          },
        ],
      }),
    }));

    const hit = axAt(130, 115);
    expect(hit).not.toBeNull();
    expect(hit!.node.role).toBe("AXButton");
    expect(hit!.node.title).toBe("OK");
    // path: child 0 of root (AXWindow) > child 0 (AXButton)
    expect(hit!.path).toEqual([0, 0]);
  });

  test("axAt respects explicit pid", () => {
    let snapshotCalled = 0;
    __setNativeAXForTests(makeMockNativeAX({
      axSnapshot: (pid: number) => {
        snapshotCalled++;
        if (pid !== 999) return null;
        return {
          role: "AXApplication",
          children: [
            {
              role: "AXWindow",
              frame: { x: 0, y: 0, width: 800, height: 600 },
              children: [],
            },
          ],
        };
      },
    }));

    const hit = axAt(400, 300, 999);
    expect(snapshotCalled).toBe(1);
    expect(hit).not.toBeNull();
    expect(hit!.node.role).toBe("AXWindow");
  });

  test("axGetActions returns role-based actions for AXButton", () => {
    __setNativeAXForTests(makeMockNativeAX({
      axGetFrontmostPid: () => 100,
      axSnapshot: () => ({
        role: "AXApplication",
        children: [
          {
            role: "AXButton",
            title: "Save",
            frame: { x: 100, y: 100, width: 80, height: 30 },
            children: [],
          },
        ],
      }),
    }));

    const actions = axGetActions({ label: "Save", role: "AXButton" });
    expect(actions).toContain("AXPress");
  });

  test("axGetActions returns role-based actions for AXWindow", () => {
    __setNativeAXForTests(makeMockNativeAX({
      axGetFrontmostPid: () => 100,
      axSnapshot: () => ({
        role: "AXApplication",
        children: [
          {
            role: "AXWindow",
            title: "Main",
            frame: { x: 0, y: 0, width: 800, height: 600 },
            children: [],
          },
        ],
      }),
    }));

    const actions = axGetActions({ role: "AXWindow" });
    expect(actions).toContain("AXRaise");
    expect(actions).toContain("AXMinimize");
  });

  test("axGetActions throws when element not found", () => {
    __setNativeAXForTests(makeMockNativeAX({
      axGetFrontmostPid: () => 100,
      axSnapshot: () => ({
        role: "AXApplication",
        children: [],
      }),
    }));

    expect(() => axGetActions({ label: "NonExistent" })).toThrow("Element not found");
  });

  test("findAndFocus performs AXRaise on AXWindow", () => {
    const performed: Array<{ pid: number; path: number[]; action: string }> = [];
    __setNativeAXForTests(makeMockNativeAX({
      axGetFrontmostPid: () => 100,
      axSnapshot: () => ({
        role: "AXApplication",
        children: [
          {
            role: "AXWindow",
            title: "Main",
            frame: { x: 0, y: 0, width: 800, height: 600 },
            children: [],
          },
        ],
      }),
      axPerformAction: (pid: number, path: number[], action: string) => {
        performed.push({ pid, path, action });
        return true;
      },
    }));

    const result = findAndFocus({ role: "AXWindow" });
    expect(result.ok).toBe(true);
    expect(performed).toHaveLength(1);
    expect(performed[0].action).toBe("AXRaise");
  });

  test("findAndFocus performs AXFocus on non-window elements", () => {
    const performed: Array<{ pid: number; path: number[]; action: string }> = [];
    __setNativeAXForTests(makeMockNativeAX({
      axGetFrontmostPid: () => 100,
      axSnapshot: () => ({
        role: "AXApplication",
        children: [
          {
            role: "AXTextField",
            label: "Search",
            frame: { x: 10, y: 10, width: 200, height: 30 },
            children: [],
          },
        ],
      }),
      axPerformAction: (pid: number, path: number[], action: string) => {
        performed.push({ pid, path, action });
        return true;
      },
    }));

    const result = findAndFocus({ label: "Search" });
    expect(result.ok).toBe(true);
    expect(performed[0].action).toBe("AXFocus");
  });

  test("focusContainingWindow raises the ancestor AXWindow for a live AX target", () => {
    const focused: Array<{ pid: number; path: number[] }> = [];
    __setNativeAXForTests(makeMockNativeAX({
      axSnapshot: () => ({
        role: "AXApplication",
        children: [
          {
            role: "AXWindow",
            title: "Main",
            frame: { x: 0, y: 0, width: 800, height: 600 },
            children: [
              {
                role: "AXGroup",
                frame: { x: 20, y: 20, width: 760, height: 560 },
                children: [
                  {
                    role: "AXTextField",
                    label: "Name",
                    frame: { x: 40, y: 40, width: 200, height: 32 },
                    children: [],
                  },
                ],
              },
            ],
          },
        ],
      }),
      axFocusWindow: (pid: number, path: number[]) => {
        focused.push({ pid, path });
        return true;
      },
    }));

    const result = focusContainingWindow({
      axTarget: {
        type: "ax.target",
        pid: 100,
        point: { x: 60, y: 56 },
        bounds: { x: 40, y: 40, width: 200, height: 32 },
        role: "AXTextField",
        title: null,
        label: "Name",
        identifier: null,
      },
    });

    expect(result.ok).toBe(true);
    expect(focused).toEqual([{ pid: 100, path: [0] }]);
  });

  test("findAndFocus falls back to click when AXFocus fails", () => {
    const clicked: Array<{ action: string; x?: number; y?: number }> = [];
    __setNativeAXForTests(makeMockNativeAX({
      axGetFrontmostPid: () => 100,
      axSnapshot: () => ({
        role: "AXApplication",
        children: [
          {
            role: "AXButton",
            title: "OK",
            frame: { x: 50, y: 50, width: 100, height: 40 },
            children: [],
          },
        ],
      }),
      axPerformAction: () => false,
      axPointerEvent: (opts) => { clicked.push(opts); return { ok: true }; },
    }));

    const result = findAndFocus({ label: "OK" });
    expect(result.ok).toBe(true);
    expect(clicked).toHaveLength(1);
    expect(clicked[0].x).toBe(100); // center of frame (50 + 100/2)
    expect(clicked[0].y).toBe(70);  // center of frame (50 + 40/2)
  });

  test("findAndPerformAction does not synthesize a click behind AXPress", () => {
    const clicked: Array<{ action: string; x?: number; y?: number }> = [];
    const performed: Array<{ pid: number; path: number[]; action: string }> = [];
    __setNativeAXForTests(makeMockNativeAX({
      axGetFrontmostPid: () => 100,
      axSnapshot: () => ({
        role: "AXApplication",
        children: [
          {
            role: "AXButton",
            title: "Save",
            frame: { x: 50, y: 50, width: 100, height: 40 },
            children: [],
          },
        ],
      }),
      axPerformAction: (pid: number, path: number[], action: string) => {
        performed.push({ pid, path, action });
        return false;
      },
      axPointerEvent: (opts) => { clicked.push(opts); return { ok: true }; },
    }));

    expect(() => findAndPerformAction({ label: "Save", role: "AXButton" })).toThrow("axPerformAction failed");
    expect(performed).toHaveLength(1);
    expect(performed[0].action).toBe("AXPress");
    expect(clicked).toHaveLength(0);
  });

  test("findAndClick uses pointer click instead of AXPress", () => {
    const clicked: Array<{ action: string; x?: number; y?: number }> = [];
    const focused: Array<{ pid: number; path: number[] }> = [];
    const performed: Array<{ pid: number; path: number[]; action: string }> = [];
    __setNativeAXForTests(makeMockNativeAX({
      axGetFrontmostPid: () => 100,
      axSnapshot: () => ({
        role: "AXApplication",
        children: [
          {
            role: "AXWindow",
            frame: { x: 0, y: 0, width: 300, height: 200 },
            children: [
              {
                role: "AXButton",
                title: "Save",
                frame: { x: 50, y: 50, width: 100, height: 40 },
                children: [],
              },
            ],
          },
        ],
      }),
      axFocusWindow: (pid: number, path: number[]) => {
        focused.push({ pid, path });
        return true;
      },
      axPerformAction: (pid: number, path: number[], action: string) => {
        performed.push({ pid, path, action });
        return true;
      },
      axPointerEvent: (opts) => { clicked.push(opts); return { ok: true }; },
    }));

    const result = findAndClick({ label: "Save", role: "AXButton" });
    expect(result.ok).toBe(true);
    expect(focused).toEqual([{ pid: 100, path: [0] }]);
    expect(performed).toHaveLength(0);
    expect(clicked).toHaveLength(1);
    expect(clicked[0]).toEqual({ action: "click", x: 100, y: 70 });
  });

  test("findAndClick fails when target has no frame", () => {
    __setNativeAXForTests(makeMockNativeAX({
      axGetFrontmostPid: () => 100,
      axSnapshot: () => ({
        role: "AXApplication",
        children: [
          {
            role: "AXWindow",
            frame: { x: 0, y: 0, width: 300, height: 200 },
            children: [
              {
                role: "AXButton",
                title: "Save",
                children: [],
              },
            ],
          },
        ],
      }),
    }));

    expect(() => findAndClick({ label: "Save", role: "AXButton" })).toThrow("Element has no frame");
  });

  test("findCursor returns a focused text cursor payload when native data is available", () => {
    const nativeCursor: NativeAXCursor = {
      pid: 100,
      node: {
        role: "AXTextArea",
        frame: { x: 20, y: 30, width: 200, height: 100 },
        value: "hello world",
      },
      selection: { location: 5, length: 0 },
    };
    __setNativeAXForTests(makeMockNativeAX({
      axGetCursor: () => nativeCursor,
    }));

    expect(findCursor()).toEqual({
      type: "ax.cursor",
      target: {
        type: "ax.target",
        pid: 100,
        point: { x: 120, y: 80 },
        bounds: { x: 20, y: 30, width: 200, height: 100 },
        role: "AXTextArea",
        title: null,
        label: null,
        identifier: null,
      },
      selection: { location: 5, length: 0 },
    });
  });

  test("findAndType replaces the selected range when passed an ax.cursor", () => {
    const setCalls: Array<{ pid: number; path: number[]; value: string }> = [];
    const selectionCalls: Array<{ pid: number; path: number[]; location: number; length: number }> = [];
    let currentSelection = { location: 11, length: 0 };
    __setNativeAXForTests(makeMockNativeAX({
      axSnapshot: () => ({
        role: "AXApplication",
        children: [
          {
            role: "AXTextArea",
            frame: { x: 20, y: 30, width: 200, height: 100 },
            value: "hello world",
            children: [],
          },
        ],
      }),
      axSetValue: (pid: number, path: number[], value: string) => {
        setCalls.push({ pid, path, value });
        return true;
      },
      axSetSelectedTextRange: (pid: number, path: number[], location: number, length: number) => {
        selectionCalls.push({ pid, path, location, length });
        currentSelection = { location, length };
        return true;
      },
      axGetCursor: () => ({
        pid: 100,
        node: {
          role: "AXTextArea",
          frame: { x: 20, y: 30, width: 200, height: 100 },
          value: "hello brave world",
        },
        selection: currentSelection,
      }),
    }));

    const result = findAndType({
      value: " brave",
      axCursor: {
        type: "ax.cursor",
        target: {
          type: "ax.target",
          pid: 100,
          point: { x: 120, y: 80 },
          bounds: { x: 20, y: 30, width: 200, height: 100 },
          role: "AXTextArea",
          title: null,
          label: null,
          identifier: null,
        },
        selection: { location: 5, length: 0 },
      },
    });

    expect(result.ok).toBe(true);
    expect(setCalls).toEqual([{ pid: 100, path: [0], value: "hello brave world" }]);
    expect(selectionCalls).toEqual([{ pid: 100, path: [0], location: 11, length: 0 }]);
  });

  test("findAndType retries selection until the live cursor reflects the inserted-end position", () => {
    let cursorReads = 0;
    const selectionCalls: Array<number> = [];
    __setNativeAXForTests(makeMockNativeAX({
      axSnapshot: () => ({
        role: "AXApplication",
        children: [
          {
            role: "AXTextArea",
            frame: { x: 20, y: 30, width: 200, height: 100 },
            value: "hello world",
            children: [],
          },
        ],
      }),
      axSetValue: () => true,
      axSetSelectedTextRange: (_pid: number, _path: number[], location: number) => {
        selectionCalls.push(location);
        return true;
      },
      axGetCursor: () => {
        cursorReads += 1;
        return {
          pid: 100,
          node: {
            role: "AXTextArea",
            frame: { x: 20, y: 30, width: 200, height: 100 },
            value: "hello brave world",
          },
          selection: cursorReads >= 2 ? { location: 11, length: 0 } : { location: 17, length: 0 },
        };
      },
    }));

    const result = findAndType({
      value: " brave",
      axCursor: {
        type: "ax.cursor",
        target: {
          type: "ax.target",
          pid: 100,
          point: { x: 120, y: 80 },
          bounds: { x: 20, y: 30, width: 200, height: 100 },
          role: "AXTextArea",
          title: null,
          label: null,
          identifier: null,
        },
        selection: { location: 5, length: 0 },
      },
    });

    expect(result.ok).toBe(true);
    expect(selectionCalls).toEqual([11, 11]);
    expect(cursorReads).toBe(2);
  });

  test("findAndFocus resolves AXTarget against an ancestor when hit-test lands on a child", () => {
    const performed: Array<{ pid: number; path: number[]; action: string }> = [];
    __setNativeAXForTests(makeMockNativeAX({
      axSnapshot: () => ({
        role: "AXApplication",
        children: [
          {
            role: "AXWindow",
            frame: { x: 0, y: 0, width: 800, height: 600 },
            children: [
              {
                role: "AXButton",
                title: "Save",
                identifier: "save-button",
                frame: { x: 100, y: 100, width: 80, height: 40 },
                children: [
                  {
                    role: "AXStaticText",
                    title: "Save",
                    frame: { x: 110, y: 110, width: 40, height: 20 },
                    children: [],
                  },
                ],
              },
            ],
          },
        ],
      }),
      axPerformAction: (pid: number, path: number[], action: string) => {
        performed.push({ pid, path, action });
        return true;
      },
    }));

    const result = findAndFocus({
      axTarget: {
        type: "ax.target",
        pid: 100,
        point: { x: 120, y: 120 },
        bounds: { x: 100, y: 100, width: 80, height: 40 },
        role: "AXButton",
        title: "Save",
        label: null,
        identifier: "save-button",
      },
    });

    expect(result.ok).toBe(true);
    expect(performed).toHaveLength(1);
    expect(performed[0]).toEqual({ pid: 100, path: [0, 0], action: "AXFocus" });
  });

  test("menuAt returns null when no high-layer window contains the point", () => {
    __setNativeAXForTests(makeMockNativeAX({
      cgGetWindowRects: () => [
        { pid: 100, cgWindowId: 1, x: 0, y: 0, w: 800, h: 600, layer: 0 },
      ],
    }));

    const result = menuAt(400, 300);
    expect(result).toBeNull();
  });

  test("menuAt returns AXMenu node from high-layer window at point", () => {
    __setNativeAXForTests(makeMockNativeAX({
      cgGetWindowRects: () => [
        { pid: 200, cgWindowId: 99, x: 100, y: 100, w: 200, h: 300, layer: 101 },
      ],
      axSnapshot: () => ({
        role: "AXApplication",
        children: [
          {
            role: "AXMenu",
            children: [
              { role: "AXMenuItem", title: "Copy" },
              { role: "AXMenuItem", title: "Paste" },
            ],
          },
        ],
      }),
    }));

    const menu = menuAt(150, 150);
    expect(menu).not.toBeNull();
    expect(menu!.role).toBe("AXMenu");
    expect(menu!.children).toHaveLength(2);
  });

  test("menuAt returns null when point is outside high-layer window bounds", () => {
    __setNativeAXForTests(makeMockNativeAX({
      cgGetWindowRects: () => [
        { pid: 200, cgWindowId: 99, x: 100, y: 100, w: 200, h: 300, layer: 101 },
      ],
    }));

    const result = menuAt(50, 50); // outside [100,100,300,400]
    expect(result).toBeNull();
  });

  test("menuAt filters by pid when provided", () => {
    let snapshotPids: number[] = [];
    __setNativeAXForTests(makeMockNativeAX({
      cgGetWindowRects: () => [
        { pid: 200, cgWindowId: 99, x: 100, y: 100, w: 200, h: 300, layer: 101 },
        { pid: 300, cgWindowId: 88, x: 100, y: 100, w: 200, h: 300, layer: 101 },
      ],
      axSnapshot: (pid: number) => {
        snapshotPids.push(pid);
        return null; // no menu found
      },
    }));

    menuAt(150, 150, 200);
    expect(snapshotPids).toEqual([200]); // only pid 200 was queried
  });

  test("buildSnapshot includes newly discovered app bundle ids and window rects", () => {
    __setNativeAXForTests(makeMockNativeAX({
      wsGetRunningApps: () => [
        { pid: 181, bundleId: "com.microsoft.VSCode", name: "Code", regular: true },
      ],
      cgGetWindowRects: () => [
        { pid: 181, cgWindowId: 12588, x: 200, y: 25, w: 971, h: 734, layer: 0, title: "Code" },
      ],
      axGetFrontmostPid: () => 181,
      axSnapshot: () => ({
        role: "AXApplication",
        title: "Code",
        children: [],
      }),
    }));

    const snapshot = buildSnapshot({ focusedDepth: 2 });

    expect(snapshot).not.toBeNull();
    expect(snapshot!.runningBundleIds).toContain("com.microsoft.VSCode");
    expect(snapshot!.focus.frontmostBundleId).toBe("com.microsoft.VSCode");
    expect(snapshot!.windowRects).toContainEqual(expect.objectContaining({
      pid: 181,
      bundleId: "com.microsoft.VSCode",
      x: 200,
      y: 25,
      w: 971,
      h: 734,
      title: "Code",
    }));
  });
});
