import type { NodeDescriptor } from "../crdt/schema.js";
import type { ActionTarget, ActionCommand } from "./traits.js";

// ── AX tree types (canonical source, re-exported by refresher.ts) ──

export interface AXNode {
  role: string;
  subrole?: string;
  title?: string;
  label?: string;
  value?: string;
  identifier?: string;
  placeholder?: string;
  windowNumber?: number;
  frame?: { x: number; y: number; width: number; height: number };
  capabilities?: {
    selected?: boolean;
    checked?: boolean;
    expanded?: boolean;
    focused?: boolean;
    enabled?: boolean;
    canScroll?: boolean;
    scrollAxis?: string;
    scrollValueV?: number;
    scrollValueH?: number;
  };
  actions?: string[];
  children?: AXNode[];
}

// ── Window geometry ──

export interface WindowFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
  screenW?: number;
  screenH?: number;
}

// ── App bundle contract ──

export interface AppBundle<S = unknown> {
  bundleId: string;
  extract(axTree: AXNode, windowFrame: WindowFrame): S | null;
  /** Build the CRDT tree. Must return Application > Window > children. */
  buildTree(geo: WindowGeometry, state: S | null): NodeDescriptor;
  resolveAction?(target: ActionTarget, axTree: AXNode): ActionCommand | null;
  followUpQuery?(target: ActionTarget): string | null;
}
