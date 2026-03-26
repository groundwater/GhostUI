import { describe, expect, test } from "bun:test";
import type { DrawScript } from "./draw.js";
import { makeOverlayDrawResponse } from "./draw-route.js";

function makeBody(overrides: Partial<DrawScript> = {}): DrawScript {
  return {
    coordinateSpace: "screen",
    items: [
      {
        kind: "rect",
        rect: { x: 100, y: 100, width: 200, height: 120 },
      },
    ],
    ...overrides,
  };
}

describe("/api/overlay/draw route lifecycle", () => {
  test("streams attached for live payloads, short-circuits remove-only payloads, and clears once on abort or timeout", async () => {
    const clearAttachmentIds: string[] = [];
    const postedPayloads: string[] = [];
    const hooks = {
      postOverlay(payload: string) {
        postedPayloads.push(payload);
      },
      clearAttachment(attachmentId: string) {
        clearAttachmentIds.push(attachmentId);
      },
    };

    const liveAbort = new AbortController();
    const liveResponse = makeOverlayDrawResponse(makeBody(), hooks, liveAbort.signal);
    expect(liveResponse.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(liveResponse.headers.get("cache-control")).toBe("no-cache");
    expect(liveResponse.headers.get("access-control-allow-origin")).toBe("*");

    const liveReader = liveResponse.body?.getReader();
    expect(liveReader).toBeDefined();
    const liveFirst = await liveReader!.read();
    expect(new TextDecoder().decode(liveFirst.value)).toBe("attached\n");
    expect(postedPayloads).toHaveLength(1);
    expect(JSON.parse(postedPayloads[0] as string).attachmentId).toMatch(/^draw:/);

    liveAbort.abort();
    await Bun.sleep(20);
    expect(clearAttachmentIds).toHaveLength(1);

    liveAbort.abort();
    await Bun.sleep(20);
    expect(clearAttachmentIds).toHaveLength(1);

    const removeOnlyResponse = makeOverlayDrawResponse(
      makeBody({
        items: [
          {
            kind: "rect",
            id: "box-1",
            remove: true,
          },
        ],
      }),
      hooks,
      new AbortController().signal,
    );
    expect(removeOnlyResponse.headers.get("content-type")).toBe("application/json");
    expect(await removeOnlyResponse.json()).toEqual({ ok: true });
    expect(postedPayloads).toHaveLength(2);
    expect(clearAttachmentIds).toHaveLength(1);

    const timeoutAbort = new AbortController();
    const timeoutResponse = makeOverlayDrawResponse(
      makeBody({ timeout: 10 }),
      hooks,
      timeoutAbort.signal,
    );
    const timeoutReader = timeoutResponse.body?.getReader();
    expect(timeoutReader).toBeDefined();
    const timeoutFirst = await timeoutReader!.read();
    expect(new TextDecoder().decode(timeoutFirst.value)).toBe("attached\n");
    await Bun.sleep(30);
    expect(clearAttachmentIds).toHaveLength(2);
    timeoutAbort.abort();
    await Bun.sleep(20);
    expect(clearAttachmentIds).toHaveLength(2);
  });

  test("swallows cleanup hook failures on abort without surfacing uncaught exceptions", async () => {
    const uncaughtErrors: unknown[] = [];
    const uncaughtHandler = (error: unknown) => {
      uncaughtErrors.push(error);
    };
    process.prependListener("uncaughtException", uncaughtHandler);

    try {
      const hooks = {
        postOverlay() {},
        clearAttachment() {
          throw new Error("cleanup failed");
        },
      };

      const abortController = new AbortController();
      const response = makeOverlayDrawResponse(makeBody(), hooks, abortController.signal);
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();

      const first = await reader!.read();
      expect(new TextDecoder().decode(first.value)).toBe("attached\n");

      abortController.abort();
      await Bun.sleep(0);
      expect(uncaughtErrors).toHaveLength(0);

      const done = await reader!.read();
      expect(done.done).toBe(true);
    } finally {
      process.off("uncaughtException", uncaughtHandler);
    }
  });

  test("auto-closes xray-only payloads from the item animation duration without a top-level timeout", async () => {
    const clearAttachmentIds: string[] = [];
    const postedPayloads: string[] = [];
    const hooks = {
      postOverlay(payload: string) {
        postedPayloads.push(payload);
      },
      clearAttachment(attachmentId: string) {
        clearAttachmentIds.push(attachmentId);
      },
    };

    const response = makeOverlayDrawResponse(
      {
        coordinateSpace: "screen",
        items: [
          {
            kind: "xray",
            rect: { x: 100, y: 100, width: 200, height: 120 },
            direction: "leftToRight",
            animation: { durMs: 20, ease: "easeInOut" },
          },
        ],
      },
      hooks,
      new AbortController().signal,
    );

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    const first = await reader!.read();
    expect(new TextDecoder().decode(first.value)).toBe("attached\n");
    expect(postedPayloads).toHaveLength(1);
    expect(JSON.parse(postedPayloads[0] as string).timeout).toBeUndefined();

    await Bun.sleep(200);
    expect(clearAttachmentIds).toHaveLength(1);

    const done = await reader!.read();
    expect(done.done).toBe(true);
  });

  test("closes the HTTP stream before deferred cleanup runs", async () => {
    const clearAttachmentIds: string[] = [];
    const scheduledCallbacks: Array<() => void> = [];
    const originalSetTimeout = globalThis.setTimeout;
    const hooks = {
      postOverlay() {},
      clearAttachment(attachmentId: string) {
        clearAttachmentIds.push(attachmentId);
      },
    };

    try {
      const abortController = new AbortController();
      const response = makeOverlayDrawResponse(
        makeBody({ timeout: 10 }),
        hooks,
        abortController.signal,
      );
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();

      const first = await reader!.read();
      expect(new TextDecoder().decode(first.value)).toBe("attached\n");

      const scheduledSetTimeout = ((handler: unknown, _timeout?: number, ...args: unknown[]) => {
        scheduledCallbacks.push(() => {
          if (typeof handler === "function") {
            (handler as (...handlerArgs: unknown[]) => void)(...args);
          }
        });
        return 0;
      }) as typeof setTimeout;
      globalThis.setTimeout = scheduledSetTimeout;

      abortController.abort();

      const done = await reader!.read();
      expect(done.done).toBe(true);
      expect(clearAttachmentIds).toHaveLength(0);
      expect(scheduledCallbacks).toHaveLength(1);

      scheduledCallbacks[0]!();
      expect(clearAttachmentIds).toHaveLength(1);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });
});
