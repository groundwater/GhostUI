export interface DrawOverlayStreamHooks {
  onAttached?: () => void;
}

export async function waitForDrawOverlayAttachment(
  res: Response,
  signal: AbortSignal,
  hooks: DrawOverlayStreamHooks = {},
): Promise<void> {
  if (!res.body) {
    throw new Error("draw overlay stream missing response body");
  }

  if (signal.aborted) {
    try {
      await res.body.cancel();
    } catch {}
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let attached = false;

  const cancelOnAbort = () => {
    void reader.cancel().catch(() => {});
  };

  signal.addEventListener("abort", cancelOnAbort, { once: true });

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line === "attached" && !attached) {
          attached = true;
          hooks.onAttached?.();
        }
        newlineIndex = buffer.indexOf("\n");
      }
    }

    const tail = buffer.trim();
    if (tail === "attached" && !attached) {
      hooks.onAttached?.();
    }
  } catch (error: unknown) {
    if (signal.aborted) {
      return;
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", cancelOnAbort);
    try {
      reader.releaseLock();
    } catch {}
  }
}
