import type { DisplayInfo } from "../a11y/native-ax.js";
import { ActorApiError } from "./protocol.js";

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ActorDisplaySpace {
  desktopFrame: Rect;
  primaryFrame: Rect;
  displays: DisplayInfo[];
}

function rectContainsPoint(rect: Rect, point: { x: number; y: number }): boolean {
  return point.x >= rect.x
    && point.x < rect.x + rect.width
    && point.y >= rect.y
    && point.y < rect.y + rect.height;
}

export function makeActorDisplaySpace(displays: DisplayInfo[]): ActorDisplaySpace {
  if (displays.length === 0) {
    throw new ActorApiError("invalid_args", "No displays available");
  }

  const primary = displays.find((display) => display.main) ?? displays[0]!;
  let minX = primary.frame.x;
  let minY = primary.frame.y;
  let maxX = primary.frame.x + primary.frame.width;
  let maxY = primary.frame.y + primary.frame.height;

  for (const display of displays) {
    minX = Math.min(minX, display.frame.x);
    minY = Math.min(minY, display.frame.y);
    maxX = Math.max(maxX, display.frame.x + display.frame.width);
    maxY = Math.max(maxY, display.frame.y + display.frame.height);
  }

  return {
    desktopFrame: {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
    },
    primaryFrame: { ...primary.frame },
    displays,
  };
}

export function validateActorPoint(space: ActorDisplaySpace, point: { x: number; y: number }, label: string): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new ActorApiError("invalid_args", `${label} must be finite coordinates`);
  }

  const matches = space.displays.some((display) => rectContainsPoint(display.frame, point));
  if (!matches) {
    throw new ActorApiError("invalid_args", `${label} is outside the current desktop bounds`);
  }
}

export function primaryCenter(space: ActorDisplaySpace): { x: number; y: number } {
  return {
    x: Math.round(space.primaryFrame.x + space.primaryFrame.width / 2),
    y: Math.round(space.primaryFrame.y + space.primaryFrame.height / 2),
  };
}
