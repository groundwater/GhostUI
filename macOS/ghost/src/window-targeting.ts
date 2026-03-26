export interface WindowTargetFrame {
  x: number;
  y: number;
  w: number;
  h: number;
  title?: string;
  cgWindowId?: number;
}

export interface FocusableWindowNode {
  role?: string;
  title?: string;
  label?: string;
  description?: string;
  frame?: { x: number; y: number; width: number; height: number };
  windowNumber?: number;
  children?: FocusableWindowNode[];
}

export interface WindowFocusMatch {
  path: number[];
  node: FocusableWindowNode;
  score: number;
}

export type WindowFocusResolution =
  | { ok: true; match: WindowFocusMatch; exact: boolean }
  | { ok: false; error: string };

function frameDistance(a: { x: number; y: number; width: number; height: number } | undefined, b: WindowTargetFrame): number {
  if (!a) return Number.POSITIVE_INFINITY;
  return Math.abs(Math.round(a.x) - Math.round(b.x))
    + Math.abs(Math.round(a.y) - Math.round(b.y))
    + Math.abs(Math.round(a.width) - Math.round(b.w))
    + Math.abs(Math.round(a.height) - Math.round(b.h));
}

function collectWindowFocusMatches(
  node: FocusableWindowNode,
  target: WindowTargetFrame,
  path: number[] = [],
  out: WindowFocusMatch[] = [],
): WindowFocusMatch[] {
  if (node.role === "AXWindow") {
    const title = String(node.title || node.label || node.description || "").toLowerCase();
    const targetTitle = String(target.title || "").toLowerCase();
    const titleMatch = targetTitle && title ? (title === targetTitle ? 0 : title.includes(targetTitle) ? 10 : 100) : 50;
    const distance = frameDistance(node.frame, target);
    out.push({ path: [...path], node, score: titleMatch + distance });
  }

  if (node.children) {
    for (let i = 0; i < node.children.length; i++) {
      collectWindowFocusMatches(node.children[i], target, [...path, i], out);
    }
  }
  return out;
}

export function findWindowFocusMatch(tree: FocusableWindowNode, target: WindowTargetFrame): WindowFocusMatch | null {
  const matches = collectWindowFocusMatches(tree, target);
  if (matches.length === 0) return null;
  matches.sort((a, b) => a.score - b.score);
  const best = matches[0];
  return Number.isFinite(best.score) ? best : null;
}

export function resolveWindowFocusMatch(tree: FocusableWindowNode, target: WindowTargetFrame): WindowFocusResolution {
  const targetWindowNumber = Number(target.cgWindowId);
  const matches = collectWindowFocusMatches(tree, target);
  if (matches.length === 0) return { ok: false, error: "Window AX node not found" };

  if (Number.isFinite(targetWindowNumber) && targetWindowNumber > 0) {
    const exactMatches = matches.filter((match) => Number(match.node.windowNumber) === targetWindowNumber);
    if (exactMatches.length > 0) {
      if (exactMatches.length > 1) {
        return { ok: false, error: `Multiple AX windows matched windowNumber ${targetWindowNumber}` };
      }
      exactMatches.sort((a, b) => a.score - b.score);
      return { ok: true, match: exactMatches[0], exact: true };
    }
  }

  const targetIdentity = normalizedTargetIdentity(target);
  const identityMatches = matches.filter((match) => windowIdentityMatchesTarget(match.node, targetIdentity));
  if (identityMatches.length > 1) {
    return { ok: false, error: "Ambiguous AX window identity; refusing to guess" };
  }
  if (identityMatches.length === 1) {
    return { ok: true, match: identityMatches[0], exact: false };
  }

  return { ok: false, error: "Window AX node identity not found" };
}

function normalizedWindowIdentity(node: FocusableWindowNode): string {
  const title = String(node.title || node.label || node.description || "").toLowerCase();
  const frame = node.frame;
  if (!frame) return `${title}|noframe`;
  return `${title}|${Math.round(frame.x)}|${Math.round(frame.y)}|${Math.round(frame.width)}|${Math.round(frame.height)}`;
}

function normalizedTargetIdentity(target: WindowTargetFrame): string {
  return `${normalizedTitlePart(target.title)}|${Math.round(target.x)}|${Math.round(target.y)}|${Math.round(target.w)}|${Math.round(target.h)}`;
}

function normalizedTitlePart(title: string | undefined): string {
  const normalized = String(title || "").trim().toLowerCase();
  return normalized.length > 0 ? normalized : "*";
}

function windowIdentityMatchesTarget(node: FocusableWindowNode, targetIdentity: string): boolean {
  const [targetTitle, targetX, targetY, targetW, targetH] = targetIdentity.split("|");
  const frame = node.frame;
  if (!frame) return false;
  if (String(Math.round(frame.x)) !== targetX) return false;
  if (String(Math.round(frame.y)) !== targetY) return false;
  if (String(Math.round(frame.width)) !== targetW) return false;
  if (String(Math.round(frame.height)) !== targetH) return false;
  if (targetTitle === "*") return true;
  return normalizedWindowIdentity(node) === targetIdentity;
}
