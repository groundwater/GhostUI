import { afterEach, describe, expect, test } from "bun:test";
import { __setAuthAccessGroupReaderForTests, __setDaemonAuthSecretReaderForTests, daemonFetch, dragWindow, fetchFilteredCGWindows, fetchPbRead, postPbWrite, fetchPbTypes, postPbClear, fetchDisplayList, fetchDisplayMain, fetchDisplayById, fetchDefaultsRead, postDefaultsWrite, fetchDefaultsDomains, postDrawOverlay, findCGWindowAt, focusWindow, killActor, listActors, postRecFilmstrip, postRecImage, runActor, spawnActor, postCgMove, postCgClick, postCgDoubleClick, postCgDrag, postCgScroll, postCgKeyDown, postCgKeyUp, postCgModDown, postCgModUp, fetchCgMousePos, fetchCgMouseState, postVatMount, fetchVatMounts, fetchVatTree, openVatWatchStream, deleteVatMount, resetDaemonAuthSecretCache, VatMountRequestError } from "./client.js";

afterEach(() => {
  __setAuthAccessGroupReaderForTests();
  __setDaemonAuthSecretReaderForTests();
  resetDaemonAuthSecretCache();
});

function mockFetch(responseBody: unknown, status = 200) {
  const originalFetch = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const normalizedInit = init
      ? { ...init, headers: Object.fromEntries(new Headers(init.headers).entries()) }
      : init;
    calls.push({ url: typeof input === "string" ? input : input.toString(), init: normalizedInit });
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}

describe("daemon auth", () => {
  test("adds a bearer token when the shared secret is available", async () => {
    const previous = process.env.GHOSTUI_AUTH_SECRET;
    process.env.GHOSTUI_AUTH_SECRET = "test-secret";
    resetDaemonAuthSecretCache();
    const { calls, restore } = mockFetch({ ok: true });
    try {
      await daemonFetch("http://localhost:7861/cli/tree");
      expect(calls[0].init?.headers).toEqual({ authorization: "Bearer test-secret" });
    } finally {
      if (previous === undefined) delete process.env.GHOSTUI_AUTH_SECRET;
      else process.env.GHOSTUI_AUTH_SECRET = previous;
      resetDaemonAuthSecretCache();
      restore();
    }
  });

  test("omits authorization when no shared secret is available", async () => {
    const previous = process.env.GHOSTUI_AUTH_SECRET;
    delete process.env.GHOSTUI_AUTH_SECRET;
    __setDaemonAuthSecretReaderForTests(async () => null);
    resetDaemonAuthSecretCache();
    const { calls, restore } = mockFetch({ ok: true });
    try {
      await daemonFetch("http://localhost:7861/cli/tree");
      expect(calls[0].init?.headers).toEqual({});
    } finally {
      if (previous === undefined) delete process.env.GHOSTUI_AUTH_SECRET;
      else process.env.GHOSTUI_AUTH_SECRET = previous;
      resetDaemonAuthSecretCache();
      restore();
    }
  });

  test("uses the native keychain reader when no env secret is set", async () => {
    const previous = process.env.GHOSTUI_AUTH_SECRET;
    delete process.env.GHOSTUI_AUTH_SECRET;
    __setDaemonAuthSecretReaderForTests(async () => "native-secret");
    resetDaemonAuthSecretCache();
    const { calls, restore } = mockFetch({ ok: true });
    try {
      await daemonFetch("http://localhost:7861/cli/tree");
      expect(calls[0].init?.headers).toEqual({ authorization: "Bearer native-secret" });
    } finally {
      if (previous === undefined) delete process.env.GHOSTUI_AUTH_SECRET;
      else process.env.GHOSTUI_AUTH_SECRET = previous;
      resetDaemonAuthSecretCache();
      restore();
    }
  });

  test("reads the access group from the enclosing app Info.plist when env is unset", async () => {
    const previous = process.env.GHOSTUI_KEYCHAIN_ACCESS_GROUP;
    delete process.env.GHOSTUI_KEYCHAIN_ACCESS_GROUP;
    __setAuthAccessGroupReaderForTests(async () => "plist-group");
    __setDaemonAuthSecretReaderForTests(async () => "plist-secret");
    resetDaemonAuthSecretCache();
    const { calls, restore } = mockFetch({ ok: true });
    try {
      await daemonFetch("http://localhost:7861/cli/tree");
      expect(calls[0].init?.headers).toEqual({ authorization: "Bearer plist-secret" });
    } finally {
      if (previous === undefined) delete process.env.GHOSTUI_KEYCHAIN_ACCESS_GROUP;
      else process.env.GHOSTUI_KEYCHAIN_ACCESS_GROUP = previous;
      __setAuthAccessGroupReaderForTests();
      resetDaemonAuthSecretCache();
      restore();
    }
  });
});

describe("dragWindow", () => {
  test("posts cgWindowId and destination coordinates to the CRDT drag route", async () => {
    const { calls, restore } = mockFetch({ ok: true, queued: true, commandId: "cli:123:1" }, 202);
    try {
      const result = await dragWindow(42, 800, 600);
      expect(result).toEqual({ ok: true, queued: true, commandId: "cli:123:1" });
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("http://localhost:7861/api/window/drag");
      expect(calls[0].init?.method).toBe("POST");
      expect(calls[0].init?.headers).toEqual({ "content-type": "application/json" });
      expect(calls[0].init?.body).toBe(JSON.stringify({ cgWindowId: 42, targetX: 800, targetY: 600 }));
    } finally {
      restore();
    }
  });
});

describe("focusWindow", () => {
  test("posts cgWindowId and returns the synchronous focus result", async () => {
    const { calls, restore } = mockFetch({ ok: true, pid: 123, bundleId: "com.apple.TextEdit", title: "Untitled", leased: true });
    try {
      const result = await focusWindow(42);
      expect(result).toEqual({ ok: true, pid: 123, bundleId: "com.apple.TextEdit", title: "Untitled", leased: true });
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("http://localhost:7861/api/window/focus");
      expect(calls[0].init?.method).toBe("POST");
      expect(calls[0].init?.headers).toEqual({ "content-type": "application/json" });
      expect(calls[0].init?.body).toBe(JSON.stringify({ cgWindowId: 42 }));
    } finally {
      restore();
    }
  });
});

describe("CG window helpers", () => {
  test("fetchFilteredCGWindows applies client-side layer filtering", async () => {
    const { calls, restore } = mockFetch([
      { pid: 1, x: 0, y: 0, w: 100, h: 100, layer: 0, title: "Main" },
      { pid: 2, x: 10, y: 10, w: 50, h: 50, layer: 101, title: "Menu" },
    ]);
    try {
      const windows = await fetchFilteredCGWindows(101);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("http://localhost:7861/api/raw/cg/windows");
      expect(windows).toEqual([
        { pid: 2, x: 10, y: 10, w: 50, h: 50, layer: 101, title: "Menu" },
      ]);
    } finally {
      restore();
    }
  });

  test("findCGWindowAt returns the first containing window, respecting layer filters", () => {
    const windows = [
      { pid: 1, x: 0, y: 0, w: 500, h: 500, layer: 0, title: "Main" },
      { pid: 2, x: 100, y: 100, w: 200, h: 200, layer: 101, title: "Menu" },
    ];

    expect(findCGWindowAt(windows, 150, 150)).toEqual(windows[0]);
    expect(findCGWindowAt(windows, 150, 150, 101)).toEqual(windows[1]);
    expect(findCGWindowAt(windows, 900, 900)).toBeNull();
  });
});

describe("actor client", () => {
  test("spawnActor posts to /api/actors/spawn", async () => {
    const { calls, restore } = mockFetch({ ok: true, name: "pointer", type: "pointer", durationScale: 0 });
    try {
      const result = await spawnActor("pointer", "pointer", 0);
      expect(result).toEqual({ ok: true, name: "pointer", type: "pointer", durationScale: 0 });
      expect(calls[0].url).toBe("http://localhost:7861/api/actors/spawn");
      expect(calls[0].init?.method).toBe("POST");
      expect(calls[0].init?.body).toBe(JSON.stringify({ type: "pointer", name: "pointer", durationScale: 0 }));
    } finally {
      restore();
    }
  });

  test("runActor posts to /api/actors/:name/run", async () => {
    const { calls, restore } = mockFetch({ ok: true, name: "pointer", completed: true });
    try {
      const result = await runActor("pointer.main", { kind: "move", to: { x: 500, y: 300 }, style: "fast" }, 200);
      expect(result).toEqual({ ok: true, name: "pointer", completed: true });
      expect(calls[0].url).toBe("http://localhost:7861/api/actors/pointer.main/run");
      expect(calls[0].init?.method).toBe("POST");
      expect(calls[0].init?.body).toBe(JSON.stringify({
        kind: "move",
        to: { x: 500, y: 300 },
        style: "fast",
        timeoutMs: 200,
      }));
    } finally {
      restore();
    }
  });

  test("killActor sends DELETE to /api/actors/:name", async () => {
    const { calls, restore } = mockFetch({ ok: true, name: "pointer", killed: true });
    try {
      const result = await killActor("pointer.main");
      expect(result).toEqual({ ok: true, name: "pointer", killed: true });
      expect(calls[0].url).toBe("http://localhost:7861/api/actors/pointer.main");
      expect(calls[0].init?.method).toBe("DELETE");
    } finally {
      restore();
    }
  });

  test("listActors gets /api/actors", async () => {
    const { calls, restore } = mockFetch({ ok: true, actors: [{ name: "pointer", type: "pointer" }] });
    try {
      const result = await listActors();
      expect(result).toEqual({ ok: true, actors: [{ name: "pointer", type: "pointer" }] });
      expect(calls[0].url).toBe("http://localhost:7861/api/actors");
    } finally {
      restore();
    }
  });
});

describe("vat client", () => {
  test("fetchVatTree returns the union root tree when no path is provided", async () => {
    const { calls, restore } = mockFetch({
      path: null,
      tree: {
        _tag: "VATRoot",
        _children: [
          { _tag: "demo", driver: "fixed", label: "demo", _children: [] },
        ],
      },
    });
    try {
      const tree = await fetchVatTree();
      expect(tree.path).toBeNull();
      expect(tree.tree._tag).toBe("VATRoot");
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("http://localhost:7861/api/vat/tree");
    } finally {
      restore();
    }
  });

  test("fetchVatMounts returns mount summaries without embedded trees", async () => {
    const { calls, restore } = mockFetch([
      { path: "/demo", driver: "a11y", args: ["Application"], mountPolicy: { kind: "always" }, active: true, activeSince: 123 },
    ]);
    try {
      const mounts = await fetchVatMounts();
      expect(mounts).toEqual([
        { path: "/demo", driver: "a11y", args: ["Application"], mountPolicy: { kind: "always" }, active: true, activeSince: 123 },
      ]);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("http://localhost:7861/api/vat/mounts");
      expect("tree" in mounts[0]).toBe(false);
    } finally {
      restore();
    }
  });

  test("openVatWatchStream targets the VAT watch endpoint with once/filter params", async () => {
    const originalFetch = globalThis.fetch;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{\"source\":\"vat.watch\"}\n"));
        controller.close();
      },
    });
    const liveResponse = new Response(stream, {
      status: 200,
      headers: { "content-type": "application/x-ndjson" },
    });
    let seenUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seenUrl = typeof input === "string" ? input : input.toString();
      return liveResponse;
    }) as typeof fetch;

    try {
      const result = await openVatWatchStream("Window", { once: true, filter: ["updated", "removed"] });
      expect(result).toBe(liveResponse);
      expect(seenUrl).toBe("http://localhost:7861/api/vat/watch?q=Window&once=1&filter=updated%2Cremoved");
      expect(await result.text()).toBe("{\"source\":\"vat.watch\"}\n");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("postVatMount returns the remounted tree payload", async () => {
    const { restore } = mockFetch({
      ok: true,
      mount: {
        path: "/demo",
        driver: "fixed",
        args: ["again"],
        mountPolicy: { kind: "always" },
        active: true,
        activeSince: 456,
      },
      activeMount: {
        path: "/demo",
        driver: "fixed",
        args: ["again"],
        mountPolicy: { kind: "always" },
        active: true,
        activeSince: 456,
        tree: { _tag: "demo", _children: [{ _tag: "VATValue", _text: "again" }] },
      },
      tree: { _tag: "demo", _children: [{ _tag: "VATValue", _text: "again" }] },
    });
    try {
      await expect(postVatMount({ path: "/demo", driver: "fixed", args: ["again"] }))
        .resolves.toMatchObject({
          ok: true,
          mount: {
            path: "/demo",
            driver: "fixed",
            args: ["again"],
          },
        });
    } finally {
      restore();
    }
  });

  test("postVatMount wraps transport failures as runtime errors", async () => {
    const originalFetch = globalThis.fetch;
    const failingFetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    globalThis.fetch = failingFetch;
    try {
      await expect(postVatMount({ path: "/demo", driver: "fixed", args: [] }))
        .rejects.toBeInstanceOf(VatMountRequestError);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("deleteVatMount returns the unmounted record", async () => {
    const { calls, restore } = mockFetch({
      ok: true,
      unmounted: {
        path: "/demo",
        driver: "fixed",
        args: [],
        mountPolicy: { kind: "always" },
        active: true,
        activeSince: 123,
      },
      activeMount: {
        path: "/demo",
        driver: "fixed",
        args: [],
        mountPolicy: { kind: "always" },
        active: true,
        activeSince: 123,
        tree: { _tag: "demo" },
      },
    });
    try {
      const result = await deleteVatMount("/demo");
      expect(result).toEqual({
        ok: true,
        unmounted: {
          path: "/demo",
          driver: "fixed",
          args: [],
          mountPolicy: { kind: "always" },
          active: true,
          activeSince: 123,
        },
        activeMount: {
          path: "/demo",
          driver: "fixed",
          args: [],
          mountPolicy: { kind: "always" },
          active: true,
          activeSince: 123,
          tree: { _tag: "demo" },
        },
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("http://localhost:7861/api/vat/mount?path=%2Fdemo");
      expect(calls[0].init?.method).toBe("DELETE");
    } finally {
      restore();
    }
  });
});

describe("draw overlay client", () => {
  test("posts normalized draw payloads to the draw overlay route", async () => {
    const { calls, restore } = mockFetch({ ok: true });
    try {
      const payload = {
        coordinateSpace: "screen" as const,
        items: [
          {
            kind: "rect" as const,
            rect: { x: 420, y: 240, width: 240, height: 140 },
            style: {
              stroke: "#00E5FF",
              fill: "#00E5FF18",
              lineWidth: 2,
              cornerRadius: 8,
              opacity: 1,
            },
          },
        ],
      };
      await postDrawOverlay(payload);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("http://localhost:7861/api/overlay/draw");
      expect(calls[0].init?.method).toBe("POST");
      expect(calls[0].init?.headers).toEqual({ "content-type": "application/json" });
      expect(calls[0].init?.body).toBe(JSON.stringify(payload));
    } finally {
      restore();
    }
  });

  test("returns the live response stream without buffering it", async () => {
    const originalFetch = globalThis.fetch;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("attached\n"));
        controller.close();
      },
    });
    const liveResponse = new Response(stream, {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
    let seenInit: RequestInit | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenInit = init;
      return liveResponse;
    }) as typeof fetch;

    try {
      const result = await postDrawOverlay({
        coordinateSpace: "screen",
        items: [],
      });

      expect(result).toBe(liveResponse);
      expect(seenInit?.method).toBe("POST");
      expect(await result.text()).toBe("attached\n");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("rec client", () => {
  test("postRecImage posts capture requests to /api/rec/image", async () => {
    const { calls, restore } = mockFetch({ ok: true });
    try {
      await postRecImage({
        target: {
          kind: "rect",
          rect: { x: 100, y: 120, width: 1440, height: 900 },
        },
        frameSize: { width: 1280, height: 800 },
        format: "heic",
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("http://localhost:7861/api/rec/image");
      expect(calls[0].init?.method).toBe("POST");
      expect(calls[0].init?.headers).toEqual({ "content-type": "application/json" });
      expect(calls[0].init?.body).toBe(JSON.stringify({
        target: {
          kind: "rect",
          rect: { x: 100, y: 120, width: 1440, height: 900 },
        },
        frameSize: { width: 1280, height: 800 },
        format: "heic",
      }));
    } finally {
      restore();
    }
  });

  test("postRecFilmstrip posts capture requests to /api/rec/filmstrip", async () => {
    const { calls, restore } = mockFetch({ ok: true });
    try {
      await postRecFilmstrip({
        target: { kind: "window", cgWindowId: 13801 },
        grid: { cols: 3, rows: 3 },
        timing: { kind: "every", everyMs: 5000 },
        frameSize: { width: 320, height: 200 },
        format: "png",
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("http://localhost:7861/api/rec/filmstrip");
      expect(calls[0].init?.method).toBe("POST");
      expect(calls[0].init?.body).toBe(JSON.stringify({
        target: { kind: "window", cgWindowId: 13801 },
        grid: { cols: 3, rows: 3 },
        timing: { kind: "every", everyMs: 5000 },
        frameSize: { width: 320, height: 200 },
        format: "png",
      }));
    } finally {
      restore();
    }
  });
});

describe("pasteboard client", () => {
  test("fetchPbRead sends GET to /api/pb/read", async () => {
    const { calls, restore } = mockFetch({ value: "hello" });
    try {
      const result = await fetchPbRead();
      expect(result).toEqual({ value: "hello" });
      expect(calls[0].url).toBe("http://localhost:7861/api/pb/read");
    } finally {
      restore();
    }
  });

  test("fetchPbRead with type passes query param", async () => {
    const { calls, restore } = mockFetch({ value: "<b>hi</b>" });
    try {
      await fetchPbRead("public.html");
      expect(calls[0].url).toBe("http://localhost:7861/api/pb/read?type=public.html");
    } finally {
      restore();
    }
  });

  test("postPbWrite sends POST with text body", async () => {
    const { calls, restore } = mockFetch({ ok: true });
    try {
      const result = await postPbWrite("test value");
      expect(result).toEqual({ ok: true });
      expect(calls[0].url).toBe("http://localhost:7861/api/pb/write");
      expect(calls[0].init?.method).toBe("POST");
      expect(JSON.parse(calls[0].init?.body as string)).toEqual({ text: "test value" });
    } finally {
      restore();
    }
  });

  test("fetchPbTypes sends GET to /api/pb/types", async () => {
    const { calls, restore } = mockFetch(["public.utf8-plain-text", "public.html"]);
    try {
      const result = await fetchPbTypes();
      expect(result).toEqual(["public.utf8-plain-text", "public.html"]);
      expect(calls[0].url).toBe("http://localhost:7861/api/pb/types");
    } finally {
      restore();
    }
  });

  test("postPbClear sends POST to /api/pb/clear", async () => {
    const { calls, restore } = mockFetch({ ok: true });
    try {
      const result = await postPbClear();
      expect(result).toEqual({ ok: true });
      expect(calls[0].url).toBe("http://localhost:7861/api/pb/clear");
      expect(calls[0].init?.method).toBe("POST");
    } finally {
      restore();
    }
  });
});

describe("display client", () => {
  const mockDisplay = {
    id: 1, name: "Built-in", main: true,
    frame: { x: 0, y: 0, width: 1728, height: 1117 },
    visibleFrame: { x: 0, y: 25, width: 1728, height: 1055 },
    scale: 2, physicalSize: { width: 345, height: 223 }, rotation: 0,
  };

  test("fetchDisplayList sends GET to /api/display/list", async () => {
    const { calls, restore } = mockFetch([mockDisplay]);
    try {
      const result = await fetchDisplayList();
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Built-in");
      expect(calls[0].url).toBe("http://localhost:7861/api/display/list");
    } finally {
      restore();
    }
  });

  test("fetchDisplayMain sends GET to /api/display/main", async () => {
    const { calls, restore } = mockFetch(mockDisplay);
    try {
      const result = await fetchDisplayMain();
      expect(result?.main).toBe(true);
      expect(calls[0].url).toBe("http://localhost:7861/api/display/main");
    } finally {
      restore();
    }
  });

  test("fetchDisplayById sends GET to /api/display/<id>", async () => {
    const { calls, restore } = mockFetch(mockDisplay);
    try {
      const result = await fetchDisplayById(1);
      expect(result.id).toBe(1);
      expect(calls[0].url).toBe("http://localhost:7861/api/display/1");
    } finally {
      restore();
    }
  });
});

describe("defaults client", () => {
  test("fetchDefaultsRead sends domain and key as query params", async () => {
    const { calls, restore } = mockFetch("Dark");
    try {
      await fetchDefaultsRead("-g", "AppleInterfaceStyle");
      expect(calls[0].url).toContain("domain=-g");
      expect(calls[0].url).toContain("key=AppleInterfaceStyle");
    } finally {
      restore();
    }
  });

  test("fetchDefaultsRead without key omits key param", async () => {
    const { calls, restore } = mockFetch({ autohide: true });
    try {
      await fetchDefaultsRead("com.apple.dock");
      expect(calls[0].url).toContain("domain=com.apple.dock");
      expect(calls[0].url).not.toContain("key=");
    } finally {
      restore();
    }
  });

  test("postDefaultsWrite sends domain, key, value", async () => {
    const { calls, restore } = mockFetch({ ok: true });
    try {
      await postDefaultsWrite("com.apple.dock", "autohide", "true", "bool");
      const body = JSON.parse(calls[0].init?.body as string);
      expect(body).toEqual({ domain: "com.apple.dock", key: "autohide", value: "true", type: "bool" });
    } finally {
      restore();
    }
  });

  test("fetchDefaultsDomains sends GET", async () => {
    const { calls, restore } = mockFetch(["com.apple.dock", "NSGlobalDomain"]);
    try {
      const result = await fetchDefaultsDomains();
      expect(result).toContain("com.apple.dock");
      expect(calls[0].url).toBe("http://localhost:7861/api/defaults/domains");
    } finally {
      restore();
    }
  });
});

describe("CG pointer injection client", () => {
  test("postCgMove posts x,y to /api/cg/move", async () => {
    const { calls, restore } = mockFetch({ ok: true });
    try {
      const result = await postCgMove(400, 300);
      expect(result).toEqual({ ok: true });
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("http://localhost:7861/api/cg/move");
      expect(calls[0].init?.method).toBe("POST");
      expect(calls[0].init?.body).toBe(JSON.stringify({ x: 400, y: 300 }));
    } finally {
      restore();
    }
  });

  test("postCgClick posts x,y to /api/cg/click without button", async () => {
    const { calls, restore } = mockFetch({ ok: true });
    try {
      await postCgClick(400, 300);
      expect(calls[0].url).toBe("http://localhost:7861/api/cg/click");
      expect(calls[0].init?.body).toBe(JSON.stringify({ x: 400, y: 300 }));
    } finally {
      restore();
    }
  });

  test("postCgClick includes button when specified", async () => {
    const { calls, restore } = mockFetch({ ok: true });
    try {
      await postCgClick(400, 300, "right");
      expect(calls[0].url).toBe("http://localhost:7861/api/cg/click");
      expect(calls[0].init?.body).toBe(JSON.stringify({ x: 400, y: 300, button: "right" }));
    } finally {
      restore();
    }
  });

  test("postCgDoubleClick posts x,y to /api/cg/doubleclick", async () => {
    const { calls, restore } = mockFetch({ ok: true });
    try {
      await postCgDoubleClick(400, 300);
      expect(calls[0].url).toBe("http://localhost:7861/api/cg/doubleclick");
      expect(calls[0].init?.body).toBe(JSON.stringify({ x: 400, y: 300 }));
    } finally {
      restore();
    }
  });

  test("postCgDrag posts from/to coords to /api/cg/drag", async () => {
    const { calls, restore } = mockFetch({ ok: true });
    try {
      await postCgDrag(100, 200, 500, 600);
      expect(calls[0].url).toBe("http://localhost:7861/api/cg/drag");
      expect(calls[0].init?.body).toBe(JSON.stringify({ fromX: 100, fromY: 200, toX: 500, toY: 600 }));
    } finally {
      restore();
    }
  });

  test("postCgDrag includes button when specified", async () => {
    const { calls, restore } = mockFetch({ ok: true });
    try {
      await postCgDrag(100, 200, 500, 600, "middle");
      expect(calls[0].init?.body).toBe(JSON.stringify({ fromX: 100, fromY: 200, toX: 500, toY: 600, button: "middle" }));
    } finally {
      restore();
    }
  });

  test("postCgScroll posts x,y,dx,dy to /api/cg/scroll", async () => {
    const { calls, restore } = mockFetch({ ok: true });
    try {
      await postCgScroll(400, 300, 0, -240);
      expect(calls[0].url).toBe("http://localhost:7861/api/cg/scroll");
      expect(calls[0].init?.body).toBe(JSON.stringify({ x: 400, y: 300, dx: 0, dy: -240 }));
    } finally {
      restore();
    }
  });

  test("postCgKeyDown posts key to /api/cg/keydown without mods", async () => {
    const { calls, restore } = mockFetch({ ok: true });
    try {
      const result = await postCgKeyDown("a");
      expect(result).toEqual({ ok: true });
      expect(calls[0].url).toBe("http://localhost:7861/api/cg/keydown");
      expect(calls[0].init?.method).toBe("POST");
      expect(calls[0].init?.body).toBe(JSON.stringify({ key: "a" }));
    } finally {
      restore();
    }
  });

  test("postCgKeyDown includes mods when specified", async () => {
    const { calls, restore } = mockFetch({ ok: true });
    try {
      await postCgKeyDown("a", ["cmd", "shift"]);
      expect(calls[0].url).toBe("http://localhost:7861/api/cg/keydown");
      expect(calls[0].init?.body).toBe(JSON.stringify({ key: "a", mods: ["cmd", "shift"] }));
    } finally {
      restore();
    }
  });

  test("postCgKeyUp posts key to /api/cg/keyup", async () => {
    const { calls, restore } = mockFetch({ ok: true });
    try {
      const result = await postCgKeyUp("return");
      expect(result).toEqual({ ok: true });
      expect(calls[0].url).toBe("http://localhost:7861/api/cg/keyup");
      expect(calls[0].init?.body).toBe(JSON.stringify({ key: "return" }));
    } finally {
      restore();
    }
  });

  test("postCgModDown posts mods array to /api/cg/moddown", async () => {
    const { calls, restore } = mockFetch({ ok: true });
    try {
      const result = await postCgModDown(["cmd"]);
      expect(result).toEqual({ ok: true });
      expect(calls[0].url).toBe("http://localhost:7861/api/cg/moddown");
      expect(calls[0].init?.method).toBe("POST");
      expect(calls[0].init?.body).toBe(JSON.stringify({ mods: ["cmd"] }));
    } finally {
      restore();
    }
  });

  test("postCgModUp posts mods array to /api/cg/modup", async () => {
    const { calls, restore } = mockFetch({ ok: true });
    try {
      const result = await postCgModUp(["cmd", "shift"]);
      expect(result).toEqual({ ok: true });
      expect(calls[0].url).toBe("http://localhost:7861/api/cg/modup");
      expect(calls[0].init?.body).toBe(JSON.stringify({ mods: ["cmd", "shift"] }));
    } finally {
      restore();
    }
  });

  test("fetchCgMousePos sends GET to /api/cg/mousepos", async () => {
    const { calls, restore } = mockFetch({ x: 512, y: 384 });
    try {
      const result = await fetchCgMousePos();
      expect(result).toEqual({ x: 512, y: 384 });
      expect(calls[0].url).toBe("http://localhost:7861/api/cg/mousepos");
      expect(calls[0].init).toEqual({ headers: {} });
    } finally {
      restore();
    }
  });

  test("fetchCgMouseState sends GET to /api/cg/mousestate", async () => {
    const mockState = { x: 512, y: 384, buttons: { left: false, right: false, middle: false } };
    const { calls, restore } = mockFetch(mockState);
    try {
      const result = await fetchCgMouseState();
      expect(result).toEqual(mockState);
      expect(calls[0].url).toBe("http://localhost:7861/api/cg/mousestate");
      expect(calls[0].init).toEqual({ headers: {} });
    } finally {
      restore();
    }
  });
});
