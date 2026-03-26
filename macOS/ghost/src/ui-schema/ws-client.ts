export interface LiveDocSocketLike {
  binaryType: string;
  readyState?: number;
  onopen: ((ev: Event) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent<ArrayBufferLike | string>) => void) | null;
  close(): void;
  send?(data: ArrayBufferLike | ArrayBufferView): void;
}

export interface LiveDocSocketDeps {
  createSocket: () => LiveDocSocketLike;
  scheduleTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  reconnectDelayMs?: number;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: () => void;
  onMessage?: (ev: MessageEvent<ArrayBufferLike | string>) => void;
}

export interface LiveDocSocketController {
  reconnectNow(): void;
  sendBinary(data: Uint8Array): boolean;
  dispose(): void;
}

/**
 * Browser websocket controller for the display doc.
 * Keeps reconnect state generation-safe so stale close/error events cannot
 * interfere with a newer socket.
 */
export function createLiveDocSocket(deps: LiveDocSocketDeps): LiveDocSocketController {
  const reconnectDelayMs = deps.reconnectDelayMs ?? 1000;
  const scheduleTimeout = deps.scheduleTimeout ?? setTimeout;
  const cancelTimeout = deps.clearTimeout ?? clearTimeout;

  let disposed = false;
  let generation = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let currentSocket: LiveDocSocketLike | null = null;

  function clearReconnectTimer(): void {
    if (reconnectTimer != null) {
      cancelTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function attachSocketHandlers(socket: LiveDocSocketLike, socketGeneration: number): void {
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      if (disposed || socketGeneration !== generation || currentSocket !== socket) return;
      clearReconnectTimer();
      deps.onOpen?.();
    };
    socket.onclose = () => {
      if (disposed || socketGeneration !== generation || currentSocket !== socket) return;
      currentSocket = null;
      deps.onClose?.();
      scheduleReconnect(socketGeneration);
    };
    socket.onerror = () => {
      if (disposed || socketGeneration !== generation || currentSocket !== socket) return;
      deps.onError?.();
      try {
        socket.close();
      } catch {
        // ignore close failures
      }
    };
    socket.onmessage = (ev) => {
      if (disposed || socketGeneration !== generation || currentSocket !== socket) return;
      deps.onMessage?.(ev);
    };
  }

  function openSocket(): void {
    if (disposed) return;
    clearReconnectTimer();
    generation += 1;
    const socketGeneration = generation;

    if (currentSocket) {
      const oldSocket = currentSocket;
      currentSocket = null;
      oldSocket.onopen = null;
      oldSocket.onclose = null;
      oldSocket.onerror = null;
      oldSocket.onmessage = null;
      try {
        oldSocket.close();
      } catch {
        // ignore close failures
      }
    }

    const socket = deps.createSocket();
    currentSocket = socket;
    attachSocketHandlers(socket, socketGeneration);
  }

  function scheduleReconnect(socketGeneration: number): void {
    if (disposed || socketGeneration !== generation) return;
    clearReconnectTimer();
    reconnectTimer = scheduleTimeout(() => {
      reconnectTimer = null;
      if (disposed || socketGeneration !== generation) return;
      openSocket();
    }, reconnectDelayMs);
  }

  openSocket();

  return {
    reconnectNow() {
      if (disposed) return;
      openSocket();
    },
    sendBinary(data: Uint8Array): boolean {
      if (disposed || !currentSocket || typeof currentSocket.send !== "function") return false;
      if (typeof currentSocket.readyState === "number" && currentSocket.readyState !== 1) return false;
      currentSocket.send(data);
      return true;
    },
    dispose() {
      disposed = true;
      clearReconnectTimer();
      if (currentSocket) {
        const socket = currentSocket;
        currentSocket = null;
        socket.onopen = null;
        socket.onclose = null;
        socket.onerror = null;
        socket.onmessage = null;
        try {
          socket.close();
        } catch {
          // ignore close failures
        }
      }
    },
  };
}
