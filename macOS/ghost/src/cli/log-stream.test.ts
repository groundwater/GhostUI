import { describe, expect, test } from "bun:test";
import { isRetryableLogStreamError, tailLogStream } from "./log-stream.js";

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

function streamThenError(chunks: string[], err: Error): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]));
        index += 1;
        return;
      }
      controller.error(err);
    },
  });
}

describe("isRetryableLogStreamError", () => {
  test("matches Bun unexpected socket close message", () => {
    expect(isRetryableLogStreamError(new Error("The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()"))).toBe(true);
  });

  test("does not match unrelated failures", () => {
    expect(isRetryableLogStreamError(new Error("permission denied"))).toBe(false);
  });
});

describe("tailLogStream", () => {
  test("reconnects after a retryable stream failure and avoids replaying backlog", async () => {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const calls: number[] = [];
    let attempts = 0;

    const promise = tailLogStream(
      async (last) => {
        calls.push(last);
        attempts += 1;
        if (attempts === 1) {
          throw new Error("The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()");
        }
        if (attempts === 2) {
          return new Response(streamThenError(
            ["[daemon] one\n", "[daemon] two\n"],
            new Error("stop"),
          ));
        }
        throw new Error("unreachable");
      },
      { write(chunk) { stdoutChunks.push(String(chunk)); return true; } },
      { write(chunk) { stderrChunks.push(String(chunk)); return true; } },
      20,
      0,
    );

    await expect(promise).rejects.toThrow("stop");
    expect(calls).toEqual([20, 20]);
    expect(stdoutChunks.join("")).toBe("[daemon] one\n[daemon] two\n");
    expect(stderrChunks.join("")).toBe("log stream disconnected; reconnecting...\n");
  });
});
