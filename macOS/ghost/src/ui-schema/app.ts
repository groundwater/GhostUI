import { h, render, html, useState, useEffect, useRef, memo } from "./lib/preact";
import * as Y from "./lib/yjs";
import { SchemaNode } from "./components/SchemaNode";
import { emitRootWindowDragCommand, emitRootWindowFocusCommand } from "./components/layout/SchemaWindow";
import type { WindowDragStartPayload, YNode } from "./types";
import { createLiveDocSocket, type LiveDocSocketController } from "./ws-client";
import {
  collectWindowDocPaths,
  createWindowDocRegistry,
  findDesiredWindowDocPath,
  windowDocPath,
} from "./window-doc-registry";
import { focusedLeaseTarget, readWindowLeaseState, type WindowLeaseState } from "../window-state";

const MSG_SYNC_FULL = 0;
const MSG_UPDATE = 1;
const ROOT_DOC_PATH = "/display/0";
const WINDOW_POSITION_STREAM_INTERVAL_MS = 16;
const DRAG_START_THRESHOLD_PX = 4;

interface ActiveWindowDrag {
  cgWindowId: number;
  x: number;
  y: number;
  currentX: number;
  currentY: number;
  grabOffsetX: number;
  grabOffsetY: number;
  startClientX: number;
  startClientY: number;
  scaleX: number;
  scaleY: number;
  dragging: boolean;
}

function shouldRequestWindowFocus(windowLeases: WindowLeaseState | null, cgWindowId: number): boolean {
  if (!Number.isFinite(cgWindowId) || cgWindowId <= 0) return false;
  const targetCgWindowId = focusedLeaseTarget(windowLeases ?? {});
  return targetCgWindowId !== cgWindowId;
}

function makeSocketUrl(docPath: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/crdt?doc=${encodeURIComponent(docPath)}`;
}

const StatusBar = memo(function StatusBar({
  connected,
  rootDocPath,
  activeDocPath,
}: {
  connected: boolean;
  rootDocPath: string;
  activeDocPath: string | null;
}) {
  return html`
    <div class="status-bar">
      <div class="left">
        <span class=${connected ? "connected" : "disconnected"}>
          ${connected ? "connected" : "disconnected"}
        </span>
        <span>root ${rootDocPath}</span>
        <span>window ${activeDocPath || "none"}</span>
      </div>
    </div>
  `;
});

function connectDoc(docPath: string, doc: Y.Doc): LiveDocSocketController {
  const controller = createLiveDocSocket({
    createSocket: () => new WebSocket(makeSocketUrl(docPath)),
    onMessage: (ev) => {
      if (typeof ev.data === "string") return;
      const data = new Uint8Array(ev.data);
      const msgType = data[0];
      const payload = data.slice(1);
      if (msgType === MSG_SYNC_FULL || msgType === MSG_UPDATE) {
        Y.applyUpdate(doc, payload, "remote");
      }
    },
  });

  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === "remote") return;
    const msg = new Uint8Array(1 + update.length);
    msg[0] = MSG_UPDATE;
    msg.set(update, 1);
    controller.sendBinary(msg);
  });

  return controller;
}

function App() {
  const [connected, setConnected] = useState(false);
  const [root, setRoot] = useState<YNode | null>(null);
  const [rootTick, setRootTick] = useState(0);
  const [, setRegistryTick] = useState(0);
  const rootDocRef = useRef<Y.Doc | null>(null);
  const rootSocketRef = useRef<LiveDocSocketController | null>(null);
  const registryRef = useRef<ReturnType<typeof createWindowDocRegistry> | null>(null);
  const activeDragRef = useRef<ActiveWindowDrag | null>(null);
  const windowLeasesRef = useRef<WindowLeaseState | null>(null);
  const streamMoveRef = useRef<{
    queued: { x: number; y: number } | null;
    lastSentAt: number;
  }>({ queued: null, lastSentAt: 0 });

  if (!registryRef.current) {
    registryRef.current = createWindowDocRegistry({
      connect: (docPath, doc) => connectDoc(docPath, doc),
    });
  }

  useEffect(() => {
    const doc = new Y.Doc();
    rootDocRef.current = doc;
    const rootMap = doc.getMap("root");
    let destroyed = false;

    function syncRoot() {
      if (destroyed) return;
      setRootTick((tick) => tick + 1);
      if (rootMap.get("type") || rootMap.get("_tag")) {
        setRoot(rootMap);
      }
    }

    rootMap.observe(syncRoot);
    doc.on("afterTransaction", syncRoot);
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === "remote") return;
      const msg = new Uint8Array(1 + update.length);
      msg[0] = MSG_UPDATE;
      msg.set(update, 1);
      rootSocketRef.current?.sendBinary(msg);
    });
    syncRoot();

    rootSocketRef.current = createLiveDocSocket({
      createSocket: () => new WebSocket(makeSocketUrl(ROOT_DOC_PATH)),
      onOpen: () => setConnected(true),
      onClose: () => setConnected(false),
      onError: () => setConnected(false),
      onMessage: (ev) => {
        if (typeof ev.data === "string") return;
        const data = new Uint8Array(ev.data);
        const msgType = data[0];
        const payload = data.slice(1);
        if (msgType === MSG_SYNC_FULL || msgType === MSG_UPDATE) {
          Y.applyUpdate(doc, payload, "remote");
        }
      },
    });

    return () => {
      destroyed = true;
      rootMap.unobserve(syncRoot);
      doc.off("afterTransaction", syncRoot);
      rootDocRef.current = null;
      rootSocketRef.current?.dispose();
      rootSocketRef.current = null;
      registryRef.current?.destroy();
      registryRef.current = null;
      doc.destroy();
    };
  }, []);

  useEffect(() => {
    const registry = registryRef.current;
    if (!registry) return;
    return registry.subscribe(() => setRegistryTick((tick) => tick + 1));
  }, []);

  useEffect(() => {
    const registry = registryRef.current;
    if (!registry || !root) return;

    const visibleWindowDocPaths = collectWindowDocPaths(root);
    const activeWindowDocPath = findDesiredWindowDocPath(root);

    registry.activate(activeWindowDocPath);
    registry.pruneVisible(visibleWindowDocPaths);
  }, [root, rootTick]);

  useEffect(() => {
    function beginDrag(activeDrag: ActiveWindowDrag): void {
      if (activeDrag.dragging) return;
      activeDrag.dragging = true;
      const targetDocPath = windowDocPath(activeDrag.cgWindowId);
      registryRef.current?.activate(targetDocPath);
      if (shouldRequestWindowFocus(windowLeasesRef.current, activeDrag.cgWindowId)) {
        handleWindowFocusCommand(activeDrag.cgWindowId);
      }
    }

    function clearDragState(): ActiveWindowDrag | null {
      const activeDrag = activeDragRef.current;
      if (!activeDrag) return null;
      activeDragRef.current = null;
      streamMoveRef.current.queued = null;
      return activeDrag;
    }

    function emitDragPosition(cgWindowId: number, x: number, y: number): boolean {
      const activeDrag = activeDragRef.current;
      if (!activeDrag || !activeDrag.dragging) return false;
      return emitRootWindowDragCommand(rootDocRef.current, {
        cgWindowId,
        targetX: x,
        targetY: y,
        phase: "gesture",
      });
    }

    function sendQueuedDragPosition(cgWindowId: number): void {
      const stream = streamMoveRef.current;
      const queued = stream.queued;
      if (!queued) return;
      const now = Date.now();
      if (now - stream.lastSentAt < WINDOW_POSITION_STREAM_INTERVAL_MS) return;
      stream.queued = null;
      stream.lastSentAt = now;
      if (!emitDragPosition(cgWindowId, queued.x, queued.y)) {
        stream.queued = queued;
      }
    }

    function handleMouseMove(event: MouseEvent) {
      const activeDrag = activeDragRef.current;
      if (!activeDrag) return;
      if ((event.buttons & 1) === 0) {
        clearDragState();
        return;
      }
      const deltaClientX = event.clientX - activeDrag.startClientX;
      const deltaClientY = event.clientY - activeDrag.startClientY;
      if (!activeDrag.dragging) {
        const distanceSq = deltaClientX * deltaClientX + deltaClientY * deltaClientY;
        if (distanceSq < DRAG_START_THRESHOLD_PX * DRAG_START_THRESHOLD_PX) return;
        beginDrag(activeDrag);
      }
      const nextX = Math.round(activeDrag.x + (event.clientX - activeDrag.startClientX) * activeDrag.scaleX);
      const nextY = Math.round(activeDrag.y + (event.clientY - activeDrag.startClientY) * activeDrag.scaleY);
      activeDrag.currentX = nextX;
      activeDrag.currentY = nextY;
      streamMoveRef.current.queued = { x: nextX, y: nextY };
      sendQueuedDragPosition(activeDrag.cgWindowId);
    }

    function handleMouseUp() {
      const activeDrag = clearDragState();
      if (!activeDrag) return;
      if (!activeDrag.dragging) {
        if (shouldRequestWindowFocus(windowLeasesRef.current, activeDrag.cgWindowId)) {
          handleWindowFocusCommand(activeDrag.cgWindowId);
        }
        return;
      }
      emitRootWindowDragCommand(rootDocRef.current, {
        cgWindowId: activeDrag.cgWindowId,
        targetX: activeDrag.currentX,
        targetY: activeDrag.currentY,
        phase: "settling",
      });
    }

    function handleWindowBlur() {
      clearDragState();
    }

    function handleVisibilityChange() {
      if (document.visibilityState !== "visible") clearDragState();
    }

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    window.addEventListener("blur", handleWindowBlur);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      window.removeEventListener("blur", handleWindowBlur);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [root]);

  function handleWindowFocusCommand(cgWindowId: number): boolean {
    return emitRootWindowFocusCommand(rootDocRef.current, cgWindowId);
  }

  function handleWindowDragStart(payload: WindowDragStartPayload): boolean {
    streamMoveRef.current.queued = null;
    activeDragRef.current = {
      cgWindowId: payload.cgWindowId,
      x: payload.x,
      y: payload.y,
      currentX: payload.x,
      currentY: payload.y,
      grabOffsetX: payload.grabOffsetX,
      grabOffsetY: payload.grabOffsetY,
      startClientX: payload.startClientX,
      startClientY: payload.startClientY,
      scaleX: payload.scaleX,
      scaleY: payload.scaleY,
      dragging: false,
    };
    return true;
  }

  const registry = registryRef.current;
  const activeDocPath = registry?.getActivePath() || null;
  const windowLeases = root ? readWindowLeaseState(root) : null;
  windowLeasesRef.current = windowLeases;

  if (!root) {
    return html`<div style="color:var(--text-dim);padding:40px;text-align:center;">
      Waiting for data...
    </div>`;
  }

  return html`
    <${StatusBar}
      connected=${connected}
      rootDocPath=${ROOT_DOC_PATH}
      activeDocPath=${activeDocPath}
    />
    <${SchemaNode}
      ymap=${root}
      windowDocs=${registry || undefined}
      commandRoot=${rootDocRef.current || undefined}
      windowLeases=${windowLeases}
      onWindowFocusCommand=${handleWindowFocusCommand}
      onWindowDragStart=${handleWindowDragStart}
    />
  `;
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Missing display UI root element");
render(html`<${App} />`, rootEl);
