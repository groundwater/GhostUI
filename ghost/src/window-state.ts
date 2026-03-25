import * as Y from "yjs";

export interface WindowState {
  cgWindowId: number;
  docPath?: string;
  bundleId?: string;
  pid?: number;
  x?: number;
  y?: number;
  z?: number;
  focused?: boolean;
}

export const FOCUS_LEASE_MS = 1500;
export const POSITION_GESTURE_LEASE_MS = 500;
export const POSITION_SETTLE_LEASE_MS = 1200;
export const FOCUS_NATIVE_TAKEOVER_GRACE_MS = 300;
export const POSITION_GESTURE_NATIVE_TAKEOVER_GRACE_MS = 240;
export const POSITION_SETTLE_NATIVE_TAKEOVER_GRACE_MS = 400;
export const POSITION_MATCH_TOLERANCE_PX = 2;

export type WindowLeaseSource = "webui" | "cli" | "native-local" | "daemon";
export type PositionLeasePhase = "gesture" | "settling";

export interface FocusLeaseBufferedNative {
  frontBundleId?: string;
  seenAt: number;
  stack: Record<string, { z?: number; focused?: boolean }>;
}

export interface PositionLeaseBufferedNative {
  x: number;
  y: number;
  seenAt: number;
}

export interface FocusLease {
  kind: "focus";
  leaseId: string;
  source: WindowLeaseSource;
  provenance: "local-authored";
  cgWindowId: number;
  frontBundleId?: string;
  stack: Record<string, { z?: number; focused?: boolean }>;
  startedAt: number;
  updatedAt: number;
  expiresAt: number;
  bufferedNative?: FocusLeaseBufferedNative;
}

export interface PositionLease {
  kind: "position";
  leaseId: string;
  source: WindowLeaseSource;
  provenance: "local-authored";
  cgWindowId: number;
  targetX: number;
  targetY: number;
  phase: PositionLeasePhase;
  startedAt: number;
  updatedAt: number;
  expiresAt: number;
  bufferedNative?: PositionLeaseBufferedNative;
}

export interface WindowLeaseState {
  focus?: FocusLease;
  positions?: Record<string, PositionLease>;
}

export interface WindowMutationOptions {
  now?: number;
  ttlMs?: number;
  leaseId?: string;
  source?: WindowLeaseSource;
}

export interface PositionLeaseOptions extends WindowMutationOptions {
  phase?: PositionLeasePhase;
}

function numeric(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function boolish(value: unknown): boolean | undefined {
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  return undefined;
}

function collectWindowNodes(root: Y.Map<unknown>, out: Y.Map<unknown>[] = []): Y.Map<unknown>[] {
  const type = String(root.get("type") || root.get("_tag") || "");
  if (type === "Window" && Number.isFinite(Number(root.get("cgWindowId")))) {
    out.push(root);
  }

  const children = root.get("_children") as Y.Array<Y.Map<unknown>> | undefined;
  if (!children) return out;
  for (let i = 0; i < children.length; i++) {
    collectWindowNodes(children.get(i) as Y.Map<unknown>, out);
  }
  return out;
}

export function readWindowStates(root: Y.Map<unknown>): WindowState[] {
  return collectWindowNodes(root).map((node) => ({
    cgWindowId: Number(node.get("cgWindowId")),
    docPath: typeof node.get("doc") === "string" ? String(node.get("doc")) : undefined,
    bundleId: typeof node.get("bundleId") === "string" ? String(node.get("bundleId")) : undefined,
    pid: numeric(node.get("pid")),
    x: numeric(node.get("x")),
    y: numeric(node.get("y")),
    z: numeric(node.get("z")),
    focused: boolish(node.get("focused")),
  }));
}

function getWindowNode(root: Y.Map<unknown>, cgWindowId: number): Y.Map<unknown> | undefined {
  return collectWindowNodes(root).find((node) => Number(node.get("cgWindowId")) === cgWindowId);
}

function createLeaseId(source: WindowLeaseSource, now: number): string {
  return `${source}:${now}:${Math.random().toString(36).slice(2, 8)}`;
}

function readWindowLeasesRaw(root: Y.Map<unknown>): WindowLeaseState {
  const raw = root.get("windowLeases");
  if (!raw || typeof raw !== "object") return {};
  return raw as WindowLeaseState;
}

function writeWindowLeases(root: Y.Map<unknown>, leases: WindowLeaseState): void {
  const hasFocus = Boolean(leases.focus);
  const hasPositions = Boolean(leases.positions && Object.keys(leases.positions).length > 0);
  if (!hasFocus && !hasPositions) {
    root.delete("windowLeases");
    return;
  }
  root.set("windowLeases", leases);
}

export function readWindowLeaseState(root: Y.Map<unknown>): WindowLeaseState {
  const raw = readWindowLeasesRaw(root);
  const next: WindowLeaseState = {};
  if (raw.focus && raw.focus.kind === "focus" && Number.isFinite(Number(raw.focus.cgWindowId))) {
    next.focus = {
      ...raw.focus,
      cgWindowId: Number(raw.focus.cgWindowId),
      startedAt: Number(raw.focus.startedAt),
      updatedAt: Number(raw.focus.updatedAt),
      expiresAt: Number(raw.focus.expiresAt),
      stack: raw.focus.stack && typeof raw.focus.stack === "object" ? { ...raw.focus.stack } : {},
      ...(raw.focus.bufferedNative ? {
        bufferedNative: {
          ...raw.focus.bufferedNative,
          seenAt: Number(raw.focus.bufferedNative.seenAt),
          stack: raw.focus.bufferedNative.stack && typeof raw.focus.bufferedNative.stack === "object"
            ? { ...raw.focus.bufferedNative.stack }
            : {},
        },
      } : {}),
    };
  }
  if (raw.positions && typeof raw.positions === "object") {
    const positions: Record<string, PositionLease> = {};
    for (const [key, value] of Object.entries(raw.positions)) {
      if (!value || typeof value !== "object") continue;
      const lease = value as PositionLease;
      if (lease.kind !== "position" || !Number.isFinite(Number(lease.cgWindowId))) continue;
      positions[key] = {
        ...lease,
        cgWindowId: Number(lease.cgWindowId),
        targetX: Number(lease.targetX),
        targetY: Number(lease.targetY),
        startedAt: Number(lease.startedAt),
        updatedAt: Number(lease.updatedAt),
        expiresAt: Number(lease.expiresAt),
        phase: lease.phase === "gesture" ? "gesture" : "settling",
        ...(lease.bufferedNative ? {
          bufferedNative: {
            x: Number(lease.bufferedNative.x),
            y: Number(lease.bufferedNative.y),
            seenAt: Number(lease.bufferedNative.seenAt),
          },
        } : {}),
      };
    }
    if (Object.keys(positions).length > 0) next.positions = positions;
  }
  return next;
}

export function focusedLeaseTarget(leases: WindowLeaseState): number | null {
  const cgWindowId = Number(leases.focus?.cgWindowId || 0);
  return Number.isFinite(cgWindowId) && cgWindowId > 0 ? cgWindowId : null;
}

export function positionLeaseTarget(
  leases: WindowLeaseState,
  cgWindowId: number,
): { x: number; y: number; phase: PositionLeasePhase } | null {
  const lease = leases.positions?.[String(cgWindowId)];
  if (!lease) return null;
  return {
    x: lease.targetX,
    y: lease.targetY,
    phase: lease.phase,
  };
}

export function projectWindowPosition(
  observedX: number | undefined,
  observedY: number | undefined,
  leases: WindowLeaseState | null | undefined,
  cgWindowId: number,
): { x: number | undefined; y: number | undefined; phase?: PositionLeasePhase; leased: boolean } {
  const lease = Number.isFinite(cgWindowId) ? leases?.positions?.[String(cgWindowId)] : undefined;
  if (!lease) {
    return {
      x: observedX,
      y: observedY,
      leased: false,
    };
  }
  return {
    x: lease.targetX,
    y: lease.targetY,
    phase: lease.phase,
    leased: true,
  };
}

export function projectWindowStack(
  observedZ: number | undefined,
  observedFocused: boolean | undefined,
  leases: WindowLeaseState | null | undefined,
  cgWindowId: number,
): { z: number | undefined; focused: boolean | undefined; leased: boolean } {
  const lease = Number.isFinite(cgWindowId) ? leases?.focus : undefined;
  if (!lease) {
    return {
      z: observedZ,
      focused: observedFocused,
      leased: false,
    };
  }

  const targetWindowId = Number(lease.cgWindowId);
  if (!Number.isFinite(targetWindowId) || targetWindowId <= 0) {
    return {
      z: observedZ,
      focused: observedFocused,
      leased: false,
    };
  }

  if (targetWindowId === cgWindowId) {
    return {
      z: 0,
      focused: true,
      leased: true,
    };
  }

  const targetZ = numeric(lease.stack[String(targetWindowId)]?.z);
  const leaseZ = numeric(lease.stack[String(cgWindowId)]?.z);
  const baseZ = leaseZ ?? observedZ;
  const projectedZ = baseZ == null
    ? observedZ
    : targetZ == null
      ? baseZ + 1
      : baseZ < targetZ
        ? baseZ + 1
        : baseZ;

  return {
    z: projectedZ,
    focused: false,
    leased: true,
  };
}

export function positionMatchesTarget(
  targetX: number,
  targetY: number,
  observedX: number | undefined,
  observedY: number | undefined,
  tolerancePx = POSITION_MATCH_TOLERANCE_PX,
): boolean {
  const normalizedObservedX = numeric(observedX);
  const normalizedObservedY = numeric(observedY);
  if (normalizedObservedX == null || normalizedObservedY == null) return false;
  return Math.abs(Math.round(normalizedObservedX) - Math.round(targetX)) <= tolerancePx
    && Math.abs(Math.round(normalizedObservedY) - Math.round(targetY)) <= tolerancePx;
}

export function shouldYieldFocusLeaseToObservedNative(
  lease: FocusLease | undefined,
  observedCgWindowId: number,
  now = Date.now(),
): boolean {
  if (!lease) return false;
  if (!Number.isFinite(observedCgWindowId) || observedCgWindowId <= 0) return false;
  if (Math.round(observedCgWindowId) === Number(lease.cgWindowId)) return false;
  if (!lease.bufferedNative) return false;
  return lease.bufferedNative.seenAt >= lease.updatedAt
    && now - lease.updatedAt >= FOCUS_NATIVE_TAKEOVER_GRACE_MS;
}

export function shouldYieldPositionLeaseToObservedNative(
  lease: PositionLease | undefined,
  observedX: number,
  observedY: number,
  now = Date.now(),
): boolean {
  if (!lease) return false;
  if (positionMatchesTarget(lease.targetX, lease.targetY, observedX, observedY)) return false;
  const graceMs = lease.phase === "gesture"
    ? POSITION_GESTURE_NATIVE_TAKEOVER_GRACE_MS
    : POSITION_SETTLE_NATIVE_TAKEOVER_GRACE_MS;
  if (!lease.bufferedNative) return false;
  return lease.bufferedNative.seenAt >= lease.updatedAt
    && now - lease.updatedAt >= graceMs;
}

function snapshotFocusStack(root: Y.Map<unknown>): Record<string, { z?: number; focused?: boolean }> {
  const stack: Record<string, { z?: number; focused?: boolean }> = {};
  for (const state of readWindowStates(root)) {
    stack[String(state.cgWindowId)] = {
      z: state.z,
      focused: state.focused,
    };
  }
  return stack;
}

export function beginFocusLease(
  root: Y.Map<unknown>,
  cgWindowId: number,
  options: WindowMutationOptions = {},
): boolean {
  const target = getWindowNode(root, cgWindowId);
  if (!target) return false;
  const now = options.now ?? Date.now();
  const source = options.source ?? "webui";
  const leases = readWindowLeaseState(root);
  leases.focus = {
    kind: "focus",
    leaseId: options.leaseId ?? createLeaseId(source, now),
    source,
    provenance: "local-authored",
    cgWindowId,
    frontBundleId: typeof target.get("bundleId") === "string" ? String(target.get("bundleId")) : undefined,
    stack: snapshotFocusStack(root),
    startedAt: leases.focus?.cgWindowId === cgWindowId ? leases.focus.startedAt : now,
    updatedAt: now,
    expiresAt: now + (options.ttlMs ?? FOCUS_LEASE_MS),
    bufferedNative: leases.focus?.cgWindowId === cgWindowId ? leases.focus.bufferedNative : undefined,
  };
  writeWindowLeases(root, leases);
  return true;
}

export function clearFocusLease(root: Y.Map<unknown>): void {
  const leases = readWindowLeaseState(root);
  if (!leases.focus) return;
  delete leases.focus;
  writeWindowLeases(root, leases);
}

export function satisfyFocusLease(
  root: Y.Map<unknown>,
  cgWindowId: number,
): boolean {
  const leases = readWindowLeaseState(root);
  if (!leases.focus) return false;
  if (Number(leases.focus.cgWindowId) !== Number(cgWindowId)) return false;
  delete leases.focus;
  writeWindowLeases(root, leases);
  return true;
}

export function bufferObservedFocusStack(
  root: Y.Map<unknown>,
  frontBundleId: string | undefined,
  stack: Record<string, { z?: number; focused?: boolean }>,
  now = Date.now(),
): void {
  const leases = readWindowLeaseState(root);
  if (!leases.focus) return;
  leases.focus = {
    ...leases.focus,
    bufferedNative: {
      frontBundleId,
      seenAt: now,
      stack,
    },
  };
  writeWindowLeases(root, leases);
}

export function beginPositionLease(
  root: Y.Map<unknown>,
  cgWindowId: number,
  x: number,
  y: number,
  options: PositionLeaseOptions = {},
): boolean {
  if (!getWindowNode(root, cgWindowId)) return false;
  const now = options.now ?? Date.now();
  const source = options.source ?? "webui";
  const phase = options.phase ?? "gesture";
  const ttlMs = options.ttlMs ?? (phase === "gesture" ? POSITION_GESTURE_LEASE_MS : POSITION_SETTLE_LEASE_MS);
  const roundedX = Math.round(x);
  const roundedY = Math.round(y);
  const leases = readWindowLeaseState(root);
  const key = String(cgWindowId);
  const existing = leases.positions?.[key];
  const positions = { ...(leases.positions || {}) };
  positions[key] = {
    kind: "position",
    leaseId: options.leaseId ?? existing?.leaseId ?? createLeaseId(source, now),
    source,
    provenance: "local-authored",
    cgWindowId,
    targetX: roundedX,
    targetY: roundedY,
    phase,
    startedAt: existing?.startedAt ?? now,
    updatedAt: now,
    expiresAt: now + ttlMs,
    bufferedNative: existing?.bufferedNative,
  };
  leases.positions = positions;
  writeWindowLeases(root, leases);
  return true;
}

export function clearPositionLease(root: Y.Map<unknown>, cgWindowId: number): void {
  const leases = readWindowLeaseState(root);
  if (!leases.positions) return;
  const key = String(cgWindowId);
  if (!leases.positions[key]) return;
  const positions = { ...leases.positions };
  delete positions[key];
  leases.positions = Object.keys(positions).length > 0 ? positions : undefined;
  writeWindowLeases(root, leases);
}

export function satisfyPositionLease(
  root: Y.Map<unknown>,
  cgWindowId: number,
  x: number,
  y: number,
): boolean {
  const leases = readWindowLeaseState(root);
  const key = String(cgWindowId);
  const lease = leases.positions?.[key];
  if (!lease) return false;
  if (!positionMatchesTarget(lease.targetX, lease.targetY, x, y)) return false;
  const positions = { ...(leases.positions || {}) };
  delete positions[key];
  leases.positions = Object.keys(positions).length > 0 ? positions : undefined;
  writeWindowLeases(root, leases);
  return true;
}

export function bufferObservedWindowPosition(
  root: Y.Map<unknown>,
  cgWindowId: number,
  x: number,
  y: number,
  now = Date.now(),
): void {
  const leases = readWindowLeaseState(root);
  const key = String(cgWindowId);
  const lease = leases.positions?.[key];
  if (!lease) return;
  leases.positions = {
    ...(leases.positions || {}),
    [key]: {
      ...lease,
      bufferedNative: {
        x: Math.round(x),
        y: Math.round(y),
        seenAt: now,
      },
    },
  };
  writeWindowLeases(root, leases);
}

export function pruneExpiredWindowLeases(root: Y.Map<unknown>, now = Date.now()): WindowLeaseState {
  const leases = readWindowLeaseState(root);
  let changed = false;
  if (leases.focus && leases.focus.expiresAt <= now) {
    delete leases.focus;
    changed = true;
  }
  if (leases.positions) {
    const positions = { ...leases.positions };
    for (const [key, lease] of Object.entries(positions)) {
      if (lease.expiresAt <= now) {
        delete positions[key];
        changed = true;
      }
    }
    leases.positions = Object.keys(positions).length > 0 ? positions : undefined;
  }
  if (changed) writeWindowLeases(root, leases);
  return leases;
}

export function applyWindowPosition(
  root: Y.Map<unknown>,
  cgWindowId: number,
  x: number,
  y: number,
  options: PositionLeaseOptions = {},
): boolean {
  const roundedX = Math.round(x);
  const roundedY = Math.round(y);
  if (!getWindowNode(root, cgWindowId)) return false;
  return beginPositionLease(root, cgWindowId, roundedX, roundedY, options);
}

export function applyWindowFocus(root: Y.Map<unknown>, cgWindowId: number, options: WindowMutationOptions = {}): boolean {
  if (!getWindowNode(root, cgWindowId)) return false;
  return beginFocusLease(root, cgWindowId, options);
}
