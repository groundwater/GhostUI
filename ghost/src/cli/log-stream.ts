export function isRetryableLogStreamError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  return (
    lower.includes("socket connection was closed unexpectedly")
    || lower.includes("econnreset")
    || lower.includes("connection reset")
    || lower.includes("broken pipe")
  );
}

export async function tailLogStream(
  openStream: (last: number) => Promise<Response>,
  stdout: Pick<NodeJS.WriteStream, "write">,
  stderr: Pick<NodeJS.WriteStream, "write">,
  initialLast = 20,
  reconnectDelayMs = 500,
): Promise<void> {
  let last = initialLast;
  let announcedReconnect = false;

  while (true) {
    try {
      const res = await openStream(last);
      last = 0;
      announcedReconnect = false;

      if (!res.body) {
        throw new Error("log stream missing response body");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          throw new Error("log stream ended unexpectedly");
        }
        stdout.write(decoder.decode(value, { stream: true }));
      }
    } catch (err: unknown) {
      if (!isRetryableLogStreamError(err)) {
        throw err;
      }

      if (!announcedReconnect) {
        stderr.write("log stream disconnected; reconnecting...\n");
        announcedReconnect = true;
      }

      await Bun.sleep(reconnectDelayMs);
    }
  }
}
