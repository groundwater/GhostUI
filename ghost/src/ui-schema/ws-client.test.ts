import { describe, expect, test } from "bun:test";
import { createLiveDocSocket, type LiveDocSocketLike } from "./ws-client";

type PendingTimer = { id: ReturnType<typeof setTimeout>; fn: () => void };

class FakeSocket implements LiveDocSocketLike {
  binaryType = "";
  readyState = 1;
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent<ArrayBufferLike | string>) => void) | null = null;
  closed = 0;
  sent: ArrayBufferLike[] = [];

  close(): void {
    this.closed += 1;
    this.readyState = 3;
  }

  send(data: ArrayBufferLike | ArrayBufferView): void {
    this.sent.push(ArrayBuffer.isView(data) ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data);
  }

  emitOpen(): void {
    this.onopen?.(new Event("open"));
  }

  emitClose(): void {
    this.onclose?.(new CloseEvent("close"));
  }

  emitError(): void {
    this.onerror?.(new Event("error"));
  }

  emitMessage(data: ArrayBuffer | string): void {
    this.onmessage?.(new MessageEvent("message", { data }));
  }
}

describe("live doc websocket controller", () => {
  test("ignores stale close events after a reconnect", () => {
    const sockets: FakeSocket[] = [];
    const timers: PendingTimer[] = [];

    const controller = createLiveDocSocket({
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      scheduleTimeout: ((fn: () => void) => {
        const id = setTimeout(() => {}, 0);
        clearTimeout(id);
        timers.push({ id, fn });
        return id;
      }) as typeof setTimeout,
      clearTimeout: ((id: ReturnType<typeof setTimeout>) => {
        const idx = timers.findIndex(timer => timer.id === id);
        if (idx >= 0) timers.splice(idx, 1);
      }) as typeof clearTimeout,
    });

    expect(sockets).toHaveLength(1);
    sockets[0].emitClose();
    expect(timers).toHaveLength(1);

    timers.shift()!.fn();
    expect(sockets).toHaveLength(2);

    sockets[1].emitOpen();
    sockets[0].emitClose();

    expect(timers).toHaveLength(0);

    controller.dispose();
  });

  test("routes binary messages only from the active socket", () => {
    const sockets: FakeSocket[] = [];
    const updates: ArrayBufferLike[] = [];
    const timers: PendingTimer[] = [];

    const controller = createLiveDocSocket({
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      scheduleTimeout: ((fn: () => void) => {
        const id = setTimeout(() => {}, 0);
        clearTimeout(id);
        timers.push({ id, fn });
        return id;
      }) as typeof setTimeout,
      clearTimeout: ((id: ReturnType<typeof setTimeout>) => {
        const idx = timers.findIndex(timer => timer.id === id);
        if (idx >= 0) timers.splice(idx, 1);
      }) as typeof clearTimeout,
      onMessage: (ev) => {
        if (typeof ev.data !== "string") updates.push(ev.data);
      },
    });

    expect(sockets).toHaveLength(1);
    const first = sockets[0];
    first.emitOpen();
    first.emitMessage(new Uint8Array([0, 1, 2]).buffer);

    expect(updates).toHaveLength(1);

    first.emitClose();
    expect(timers).toHaveLength(1);
    timers.shift()!.fn();
    expect(sockets).toHaveLength(2);

    const second = sockets[1];
    second.emitOpen();
    first.emitMessage(new Uint8Array([9, 9]).buffer);
    second.emitMessage(new Uint8Array([3, 4]).buffer);

    expect(updates).toHaveLength(2);

    controller.dispose();
  });
});
