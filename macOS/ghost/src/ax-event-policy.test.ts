import { describe, expect, test } from "bun:test";
import { planAXEventRefresh } from "./ax-event-policy.js";

describe("AX event refresh policy", () => {
  test("prunes terminated apps and schedules a fast refresh", () => {
    expect(planAXEventRefresh({
      type: "app-terminated",
      pid: 181,
      bundleId: "com.microsoft.VSCode",
    })).toEqual({
      foregroundDelayMs: 250,
      pruneBundleId: "com.microsoft.VSCode",
    });
  });

  test("suppresses redundant deactivation noise", () => {
    expect(planAXEventRefresh({
      type: "app-deactivated",
      pid: 181,
      bundleId: "com.microsoft.VSCode",
    })).toBeNull();
  });

  test("refreshes quickly for native window movement", () => {
    expect(planAXEventRefresh({
      type: "window-moved",
      pid: 181,
      bundleId: "com.microsoft.VSCode",
    })).toEqual({
      foregroundDelayMs: 50,
    });
  });
});
