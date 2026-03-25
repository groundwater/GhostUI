import { html, useCallback } from "../../lib/preact";
import type * as Y from "../../lib/yjs";
import { useYAttr, useYChildren } from "../../hooks/useYMap";
import { SchemaChildren } from "../SchemaNode";
import { Titlebar } from "../semantic/Titlebar";
import type { SchemaComponentProps, WindowDragStartPayload, WindowRenderSource } from "../../types";
import {
  applyWindowFocus,
  applyWindowPosition,
  focusedLeaseTarget,
  positionLeaseTarget,
  type WindowLeaseState,
  type PositionLeasePhase,
} from "../../../window-state";

function windowSourceLabel(source: WindowRenderSource): string {
  switch (source) {
    case "live":
      return "live";
    case "cached":
      return "cached";
    default:
      return "placeholder";
  }
}

export function SchemaWindow({
  ymap,
  windowDocs,
  commandRoot,
  windowLeases,
  onWindowFocusCommand,
  onWindowDragStart,
}: SchemaComponentProps) {
  const observedX = Number(useYAttr(ymap, "x"));
  const observedY = Number(useYAttr(ymap, "y"));
  const w = Number(useYAttr(ymap, "w"));
  const h = Number(useYAttr(ymap, "h"));
  const z = Number(useYAttr(ymap, "z"));
  const cgWindowId = Number(useYAttr(ymap, "cgWindowId"));
  const focused = String(useYAttr(ymap, "focused") || "") === "true";
  const docPath = String(useYAttr(ymap, "doc") || "");
  const focusLeaseTargetCgWindowId = windowLeases ? focusedLeaseTarget(windowLeases) : null;
  const focusLease = windowLeases?.focus && Number(windowLeases.focus.cgWindowId) === cgWindowId
    ? windowLeases.focus
    : null;
  const renderPosition = resolveWindowRenderPosition(observedX, observedY, cgWindowId, windowLeases);
  const x = renderPosition.x;
  const y = renderPosition.y;
  const positionLease = renderPosition.positionLease;
  const observedFront = isWindowObservedFront(focused, z);
  const desiredFront = focusLeaseTargetCgWindowId === cgWindowId;
  const front = isWindowFront(focused, z, desiredFront);

  const entry = docPath && windowDocs ? windowDocs.getEntry(docPath) : undefined;
  const activePath = windowDocs?.getActivePath() || null;
  const source: WindowRenderSource = entry ? (activePath === docPath ? "live" : "cached") : "placeholder";
  const windowRoot = entry?.root;
  const windowChildren = windowRoot ? useYChildren(windowRoot) : [];
  const hasContent = windowChildren.length > 0;
  const hasFrame = Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(w) && Number.isFinite(h);
  const hasZ = Number.isFinite(z);
  const style = hasFrame
    ? {
        left: x + "px",
        top: y + "px",
        width: w + "px",
        height: h + "px",
        zIndex: computeWindowZIndex(hasZ ? z : undefined, desiredFront && !observedFront),
      }
    : {
        width: "100%",
        height: "100%",
        position: "relative",
        zIndex: computeWindowZIndex(hasZ ? z : undefined, desiredFront && !observedFront),
      };

  const classes = [
    "mac-window",
    `is-${windowSourceLabel(source)}`,
  ];
  if (front) classes.push("is-front");
  if (desiredFront && !observedFront) classes.push("is-front-pending");
  if (positionLease) classes.push("is-position-pending");

  const requestFocus = useCallback((event: MouseEvent) => {
    if (front) return;
    if (!Number.isFinite(cgWindowId) || cgWindowId <= 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (onWindowFocusCommand?.(cgWindowId)) return;
    if (!commandRoot) return;
    emitRootWindowFocusCommand(commandRoot, cgWindowId);
  }, [cgWindowId, commandRoot, front, onWindowFocusCommand]);

  const startDrag = useCallback((event: MouseEvent) => {
    if (!Number.isFinite(cgWindowId) || cgWindowId <= 0) return;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) return;

    const chrome = event.currentTarget as HTMLDivElement | null;
    const windowEl = chrome?.parentElement as HTMLDivElement | null;
    const rect = windowEl?.getBoundingClientRect();
    const scaleX = rect && rect.width > 0 ? w / rect.width : 1;
    const scaleY = rect && rect.height > 0 ? h / rect.height : 1;
    const grabOffsetX = rect ? (event.clientX - rect.left) * scaleX : w / 2;
    const grabOffsetY = rect ? (event.clientY - rect.top) * scaleY : Math.min(Math.max(h * 0.08, 8), 18);

    event.preventDefault();
    event.stopPropagation();

    const payload: WindowDragStartPayload = {
      cgWindowId,
      x,
      y,
      grabOffsetX,
      grabOffsetY,
      startClientX: event.clientX,
      startClientY: event.clientY,
      scaleX,
      scaleY,
    };
    onWindowDragStart?.(payload);
  }, [cgWindowId, h, onWindowDragStart, w, x, y]);

  return html`<div
    class=${classes.join(" ")}
    style=${style}
    data-focused=${focused ? "true" : "false"}
    data-observed-front=${observedFront ? "true" : "false"}
    data-desired-front=${desiredFront ? "true" : "false"}
    data-z=${hasZ ? String(z) : undefined}
    data-doc=${docPath || undefined}
    data-source=${source}
    data-focus-lease=${focusLease ? "true" : "false"}
    data-position-lease=${positionLease ? "true" : "false"}
    data-position-lease-phase=${positionLease?.phase || undefined}
    onClickCapture=${front ? undefined : requestFocus}
  >
    <div class="mac-window-chrome" onMouseDown=${startDrag}>
      <${Titlebar} ymap=${ymap} />
    </div>
    <div class="mac-window-body">
      ${windowRoot && hasContent
        ? html`<${SchemaChildren} ymap=${windowRoot} windowDocs=${windowDocs} />`
        : null}
    </div>
  </div>`;
}

export function resolveWindowRenderPosition(
  observedX: number,
  observedY: number,
  cgWindowId: number,
  windowLeases: WindowLeaseState | null | undefined,
): {
  x: number;
  y: number;
  positionLease: { x: number; y: number; phase: PositionLeasePhase } | null;
} {
  const positionLease = windowLeases ? positionLeaseTarget(windowLeases, cgWindowId) : null;
  if (positionLease) {
    return {
      x: positionLease.x,
      y: positionLease.y,
      positionLease,
    };
  }
  return {
    x: observedX,
    y: observedY,
    positionLease: null,
  };
}

export function emitRootWindowFocusCommand(
  commandRoot: Y.Doc | null | undefined,
  cgWindowId: number,
): boolean {
  if (!commandRoot || !Number.isFinite(cgWindowId) || cgWindowId <= 0) return false;
  const root = commandRoot.getMap("root");
  commandRoot.transact(() => {
    applyWindowFocus(root, cgWindowId);
  });

  return true;
}

export function emitRootWindowDragCommand(
  commandRoot: Y.Doc | null | undefined,
  payload: Pick<WindowDragStartPayload, "cgWindowId"> & { targetX: number; targetY: number; phase?: PositionLeasePhase },
): boolean {
  if (!commandRoot) return false;
  if (!Number.isFinite(payload.cgWindowId) || payload.cgWindowId <= 0) return false;
  if (!Number.isFinite(payload.targetX) || !Number.isFinite(payload.targetY)) return false;

  const root = commandRoot.getMap("root");
  commandRoot.transact(() => {
    applyWindowPosition(root, payload.cgWindowId, payload.targetX, payload.targetY, {
      source: "webui",
      phase: payload.phase,
    });
  });

  return true;
}

export function isWindowObservedFront(focused: boolean, z: number | undefined): boolean {
  return focused || z === 0;
}

export function computeWindowZIndex(z: number | undefined, desiredFront = false): string | undefined {
  if (desiredFront) return "200000";
  if (!Number.isFinite(z)) return undefined;
  const numericZ = z as number;
  return String(100000 - numericZ);
}

export function isWindowFront(focused: boolean, z: number | undefined, desiredFront = false): boolean {
  return desiredFront || isWindowObservedFront(focused, z);
}
