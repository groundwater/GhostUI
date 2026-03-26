import { describe, expect, test } from "bun:test";
import { waitForDrawOverlayAttachment } from "./draw-stream.js";

function makeStream(
  chunks: string[],
  options: { onCancel?: () => void; closeWhenDone?: boolean } = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]));
        index += 1;
        return;
      }
      if (options.closeWhenDone) {
        controller.close();
        return;
      }
      return new Promise<void>(() => {});
    },
    cancel() {
      options.onCancel?.();
    },
  });
}

describe("waitForDrawOverlayAttachment", () => {
  test("emits attached once, ignores keepalive, and exits on EOF", async () => {
    const attached: string[] = [];
    const res = new Response(makeStream(["attached\n", "keepalive\n", "attached\n"], { closeWhenDone: true }), {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });

    await waitForDrawOverlayAttachment(res, new AbortController().signal, {
      onAttached() {
        attached.push("attached");
      },
    });

    expect(attached).toEqual(["attached"]);
  });

  test("exits cleanly when aborted while waiting for more stream data", async () => {
    const abortController = new AbortController();
    let canceled = 0;
    const res = new Response(makeStream(["attached\n"], {
      onCancel: () => {
        canceled += 1;
      },
    }), {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });

    const promise = waitForDrawOverlayAttachment(res, abortController.signal, {
      onAttached() {},
    });

    await Bun.sleep(0);
    abortController.abort();
    await expect(promise).resolves.toBeUndefined();
    expect(canceled).toBe(1);
  });

  test("returns immediately when the signal is already aborted", async () => {
    const abortController = new AbortController();
    abortController.abort();
    let canceled = 0;
    const res = new Response(makeStream(["attached\n", "keepalive\n"], {
      onCancel: () => {
        canceled += 1;
      },
    }), {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });

    await expect(waitForDrawOverlayAttachment(res, abortController.signal, {
      onAttached() {
        throw new Error("should not attach");
      },
    })).resolves.toBeUndefined();
    expect(canceled).toBe(1);
  });
});
