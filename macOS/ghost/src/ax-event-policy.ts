import type { AXObserverEvent } from "./a11y/native-ax.js";

export interface RefreshPlan {
  foregroundDelayMs?: number;
  pruneBundleId?: string;
}

const SUPPRESSED_EVENTS = new Set(["element-destroyed", "app-deactivated"]);
const FAST_FOCUS_EVENTS = new Set([
  "focused-app-changed",
  "focused-window-changed",
]);
const FAST_WINDOW_EVENTS = new Set([
  "main-window-changed",
  "window-moved",
  "window-resized",
]);
const FULL_REFRESH_EVENTS = new Set([
  "app-launched",
  "app-terminated",
]);
const LOCAL_REFRESH_EVENTS = new Set([
  "window-created",
  "main-window-changed",
  "window-moved",
  "window-resized",
  "title-changed",
  "focused-element-changed",
  "value-changed",
  "selected-children-changed",
  "selected-text-changed",
  "layout-changed",
  "element-changed",
]);

export function planAXEventRefresh(event: AXObserverEvent): RefreshPlan | null {
  if (SUPPRESSED_EVENTS.has(event.type)) return null;

  if (FAST_FOCUS_EVENTS.has(event.type)) {
    return { foregroundDelayMs: 50 };
  }

  if (FAST_WINDOW_EVENTS.has(event.type)) {
    return { foregroundDelayMs: 50 };
  }

  if (event.type === "app-terminated") {
    return {
      foregroundDelayMs: 250,
      ...(event.bundleId ? { pruneBundleId: event.bundleId } : {}),
    };
  }

  if (FULL_REFRESH_EVENTS.has(event.type)) {
    return { foregroundDelayMs: 500 };
  }

  if (LOCAL_REFRESH_EVENTS.has(event.type)) {
    return { foregroundDelayMs: 750 };
  }

  return { foregroundDelayMs: 1000 };
}
