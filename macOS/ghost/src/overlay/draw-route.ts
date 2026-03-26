import type { DrawScript } from "./draw.js";

export interface DrawOverlayRouteHooks {
  postOverlay: (payload: string) => void;
  clearAttachment: (attachmentId: string) => void;
}

function makeRemoveOnlyResponse(): Response {
  return new Response(JSON.stringify({ ok: true }), {
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });
}

const XRAY_ATTACHMENT_BUFFER_MS = 100;

function computeXrayAttachmentTimeout(body: DrawScript): number | undefined {
  const liveItems = body.items.filter((item) => item.remove !== true);
  if (liveItems.length === 0 || !liveItems.every((item) => item.kind === "xray")) {
    return undefined;
  }

  const longestSweepMs = liveItems.reduce((longest, item) => {
    return Math.max(longest, item.animation?.durMs ?? 400);
  }, 0);

  return longestSweepMs + XRAY_ATTACHMENT_BUFFER_MS;
}

export function makeOverlayDrawResponse(
  body: DrawScript,
  hooks: DrawOverlayRouteHooks,
  signal: AbortSignal,
): Response {
  const attachmentId = `draw:${crypto.randomUUID()}`;
  const hasLiveItems = body.items.some((item) => item.remove !== true);
  hooks.postOverlay(JSON.stringify({
    ...body,
    attachmentId,
  }));

  if (!hasLiveItems) {
    return makeRemoveOnlyResponse();
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let finished = false;
      let cleanupScheduled = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      let heartbeatHandle: ReturnType<typeof setInterval> | undefined;
      const timeoutMs = body.timeout ?? computeXrayAttachmentTimeout(body);

      const scheduleCleanup = () => {
        if (cleanupScheduled) {
          return;
        }
        cleanupScheduled = true;
        setTimeout(() => {
          try {
            hooks.clearAttachment(attachmentId);
          } catch {}
        }, 0);
      };

      const finish = () => {
        if (finished) {
          return;
        }
        finished = true;
        if (timeoutHandle !== undefined) {
          clearTimeout(timeoutHandle);
          timeoutHandle = undefined;
        }
        if (heartbeatHandle !== undefined) {
          clearInterval(heartbeatHandle);
          heartbeatHandle = undefined;
        }
        try {
          controller.close();
        } catch {}
        scheduleCleanup();
      };

      try {
        controller.enqueue(encoder.encode("attached\n"));
      } catch {
        finish();
        return;
      }

      heartbeatHandle = setInterval(() => {
        if (finished) {
          return;
        }
        try {
          controller.enqueue(encoder.encode("keepalive\n"));
        } catch {
          finish();
        }
      }, 15_000);

      signal.addEventListener("abort", finish, { once: true });

      if (timeoutMs !== undefined) {
        timeoutHandle = setTimeout(finish, timeoutMs);
      }
    },
    cancel() {},
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-cache",
      "access-control-allow-origin": "*",
    },
  });
}
