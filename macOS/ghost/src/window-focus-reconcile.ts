import type { WindowLeaseState } from "./window-state.js";

function observedBufferedFrontWindowId(leases: WindowLeaseState): number {
  const stack = leases.focus?.bufferedNative?.stack;
  if (!stack) return 0;

  let candidateId = 0;
  let candidateZ = Number.POSITIVE_INFINITY;
  for (const [key, value] of Object.entries(stack)) {
    const cgWindowId = Number(key);
    if (!Number.isFinite(cgWindowId) || cgWindowId <= 0) continue;
    if (value?.focused === true) return cgWindowId;

    const z = Number(value?.z);
    if (Number.isFinite(z) && z < candidateZ) {
      candidateId = cgWindowId;
      candidateZ = z;
    }
  }

  return candidateId;
}

export function shouldClearWindowFocusLease(
  leases: WindowLeaseState,
  desiredFrontId: number,
  pendingFocusTargetWindowId: number,
  pendingFocusExpiresAt: number,
  now = Date.now(),
): boolean {
  if (!leases.focus) return false;
  if (!Number.isFinite(desiredFrontId) || desiredFrontId <= 0) return false;
  if (pendingFocusTargetWindowId === desiredFrontId && pendingFocusExpiresAt > now) return false;

  const observedFrontId = observedBufferedFrontWindowId(leases);
  if (!Number.isFinite(observedFrontId) || observedFrontId <= 0) return false;
  return observedFrontId !== desiredFrontId;
}

export function shouldReconcileWindowFocus(
  leases: WindowLeaseState,
  desiredFrontId: number,
  pendingFocusTargetWindowId: number,
  pendingFocusExpiresAt: number,
  now = Date.now(),
): boolean {
  if (!leases.focus) return false;
  if (!Number.isFinite(desiredFrontId) || desiredFrontId <= 0) return false;
  if (pendingFocusTargetWindowId === desiredFrontId && pendingFocusExpiresAt > now) return false;
  if (shouldClearWindowFocusLease(leases, desiredFrontId, pendingFocusTargetWindowId, pendingFocusExpiresAt, now)) return false;
  return true;
}
