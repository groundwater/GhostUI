import * as Y from "yjs";
import type { CRDTStore } from "../crdt/store.js";
import { DEFAULT_DOC_PATH, isWindowDocPath } from "../crdt/doc-paths.js";

// Simple protocol:
// MSG_SYNC_FULL = 0  — full state vector (server→client on connect, client→server on connect)
// MSG_UPDATE    = 1  — incremental update

const MSG_SYNC_FULL = 0;
const MSG_UPDATE = 1;

export interface WSData {
  doc?: Y.Doc;
  docPath?: string;
}

type UpgradeServer = {
  upgrade(req: Request, options: { data: WSData }): boolean;
};

const clients = new Map<Bun.ServerWebSocket<WSData>, WSData>();

export function handleWSUpgrade(req: Request, server: UpgradeServer, store: CRDTStore): boolean {
  const url = new URL(req.url);

  if (url.pathname === "/crdt") {
    const docPath = url.searchParams.get("doc") || DEFAULT_DOC_PATH;
    const doc = store.getOrCreate(docPath);
    const upgraded = server.upgrade(req, { data: { doc, docPath } });
    return !!upgraded;
  }

  return false;
}

function sendMsg(ws: Bun.ServerWebSocket<WSData>, type: number, data: Uint8Array) {
  const msg = new Uint8Array(1 + data.length);
  msg[0] = type;
  msg.set(data, 1);
  ws.sendBinary(msg);
}

// Ping all CRDT clients every 15s to detect dead connections
setInterval(() => {
  for (const [ws] of clients) {
    try {
      ws.ping();
    } catch {
      clients.delete(ws);
    }
  }
}, 15_000);

export const wsHandlers = {
  open(ws: Bun.ServerWebSocket<WSData>) {
    // CRDT client
    clients.set(ws, ws.data);
    // connected log suppressed
    const state = Y.encodeStateAsUpdate(ws.data.doc!);
    sendMsg(ws, MSG_SYNC_FULL, state);
  },

  message(ws: Bun.ServerWebSocket<WSData>, message: Buffer<ArrayBuffer> | ArrayBuffer | string) {
    // CRDT client
    if (typeof message === "string") return;
    const data = message instanceof ArrayBuffer ? new Uint8Array(message) : new Uint8Array(message);
    if (data.length === 0 || !ws.data.doc) return;
    if (!ws.data.docPath || (ws.data.docPath !== DEFAULT_DOC_PATH && !isWindowDocPath(ws.data.docPath))) return;
    const msgType = data[0];
    if (msgType !== MSG_UPDATE) return;
    Y.applyUpdate(ws.data.doc, data.slice(1), ws);
  },

  close(ws: Bun.ServerWebSocket<WSData>) {
    clients.delete(ws);
  },
};

// Called when doc changes server-side (e.g. via the a11y refresher)
export function setupDocBroadcast(store: CRDTStore) {
  for (const [path, doc] of store.docs) {
    attachBroadcast(doc, path);
  }
}

export function attachBroadcast(doc: Y.Doc, docPath: string) {
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    const msg = new Uint8Array(1 + update.length);
    msg[0] = MSG_UPDATE;
    msg.set(update, 1);

    let sent = 0;
    const dead: Bun.ServerWebSocket<WSData>[] = [];
    for (const [ws, state] of clients) {
      if (state.docPath === docPath && origin !== ws) {
        try {
          ws.sendBinary(msg);
          sent++;
        } catch {
          dead.push(ws);
        }
      }
    }
    for (const ws of dead) clients.delete(ws);
    // broadcast log suppressed
  });
}
