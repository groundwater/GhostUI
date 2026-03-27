import { describe, expect, test } from "bun:test";
import { shouldClearWindowFocusLease, shouldReconcileWindowFocus } from "./window-focus-reconcile.js";

describe("window focus reconcile policy", () => {
  test("does not reconcile mirrored window focus without an active local lease", () => {
    expect(shouldReconcileWindowFocus({}, 101, 0, 0, 1_000)).toBe(false);
  });

  test("waits for an in-flight local focus target to settle before retrying", () => {
    expect(shouldReconcileWindowFocus({
      focus: {
        kind: "focus",
        leaseId: "webui:1",
        source: "webui",
        provenance: "local-authored",
        cgWindowId: 101,
        stack: {},
        startedAt: 100,
        updatedAt: 100,
        expiresAt: 1_000,
      },
    }, 101, 101, 900, 500)).toBe(false);
  });

  test("reconciles explicit local focus intent once it is no longer settling", () => {
    expect(shouldReconcileWindowFocus({
      focus: {
        kind: "focus",
        leaseId: "webui:1",
        source: "webui",
        provenance: "local-authored",
        cgWindowId: 101,
        stack: {},
        startedAt: 100,
        updatedAt: 100,
        expiresAt: 1_000,
      },
    }, 101, 0, 0, 500)).toBe(true);
  });

  test("clears a focus lease when buffered native focus contradicts it after settle", () => {
    expect(shouldClearWindowFocusLease({
      focus: {
        kind: "focus",
        leaseId: "webui:1",
        source: "webui",
        provenance: "local-authored",
        cgWindowId: 101,
        stack: {},
        startedAt: 100,
        updatedAt: 100,
        expiresAt: 1_000,
        bufferedNative: {
          seenAt: 700,
          stack: {
            "101": { z: 1, focused: false },
            "202": { z: 0, focused: true },
          },
        },
      },
    }, 101, 0, 0, 700)).toBe(true);
  });

  test("does not clear a focus lease while the desired target is still settling", () => {
    expect(shouldClearWindowFocusLease({
      focus: {
        kind: "focus",
        leaseId: "webui:1",
        source: "webui",
        provenance: "local-authored",
        cgWindowId: 101,
        stack: {},
        startedAt: 100,
        updatedAt: 100,
        expiresAt: 1_000,
        bufferedNative: {
          seenAt: 700,
          stack: {
            "101": { z: 1, focused: false },
            "202": { z: 0, focused: true },
          },
        },
      },
    }, 101, 101, 900, 700)).toBe(false);
  });
});
