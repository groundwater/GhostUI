import type * as Y from "yjs";
import type { WindowLeaseState } from "../window-state";

export type YNode = Y.Map<unknown>;
export type YNodeArray = Y.Array<YNode>;
export type StyleMap = Record<string, string | number>;
export type YMapEvent = { keysChanged: Set<string> };
export type WindowRenderSource = "live" | "cached" | "placeholder";

export interface WindowDragStartPayload {
  cgWindowId: number;
  x: number;
  y: number;
  grabOffsetX: number;
  grabOffsetY: number;
  startClientX: number;
  startClientY: number;
  scaleX: number;
  scaleY: number;
}

export interface WindowDocEntry {
  docPath: string;
  doc: Y.Doc;
  root: YNode;
  source: WindowRenderSource;
  controller?: { dispose(): void } | null;
}

export interface WindowDocRegistry {
  subscribe(listener: () => void): () => void;
  getActivePath(): string | null;
  getEntry(docPath: string): WindowDocEntry | undefined;
  activate(docPath: string | null): void;
  pruneVisible(docPaths: Iterable<string>): void;
  destroy(): void;
}

export interface SchemaComponentProps {
  ymap: YNode;
  windowDocs?: WindowDocRegistry;
  commandRoot?: Y.Doc;
  windowLeases?: WindowLeaseState | null;
  onWindowFocusCommand?: (cgWindowId: number) => boolean;
  onWindowDragStart?: (payload: WindowDragStartPayload) => boolean;
}
