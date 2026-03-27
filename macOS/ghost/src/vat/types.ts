import type { AXTarget } from "../a11y/ax-target.js";

export interface VatNode {
  _tag: string;
  _text?: string;
  _children?: VatNode[];
  [key: string]: unknown;
}

export type VatErrorCode = "invalid_args" | "unknown_driver" | "mount_not_found";

export class VatApiError extends Error {
  readonly code: VatErrorCode;
  readonly status: number;

  constructor(code: VatErrorCode, message: string, status = vatErrorStatus(code)) {
    super(message);
    this.name = "VatApiError";
    this.code = code;
    this.status = status;
  }
}

export function vatErrorStatus(code: VatErrorCode): number {
  switch (code) {
    case "mount_not_found":
      return 404;
    case "unknown_driver":
      return 422;
    case "invalid_args":
    default:
      return 400;
  }
}

export const VAT_A11Y_STDIN_AX_QUERY_ARG = "--stdin-ax-query-json";
export const VAT_A11Y_STDIN_AX_QUERY_PLAN_ARG = "--stdin-ax-query-plan-json";

export type VatA11YQueryCardinality = "first" | "only" | "all" | "each";

export type VatA11YQueryScope =
  | { kind: "all" }
  | { kind: "focused" }
  | { kind: "pid"; pid: number }
  | { kind: "app"; app: string };

export interface VatA11YQueryPlan {
  type: "vat.a11y-query-plan";
  query: string;
  cardinality: VatA11YQueryCardinality;
  scope: VatA11YQueryScope;
  target?: AXTarget;
}

export interface VatMountRequest {
  path: string;
  driver: string;
  args: string[];
}

export type VatUnmountTimeout =
  | { kind: "never" }
  | { kind: "seconds"; seconds: number };

export type VatMountPolicy =
  | { kind: "always" }
  | { kind: "disabled" }
  | { kind: "auto"; unmountTimeout: VatUnmountTimeout };

export interface VatPersistedMount extends VatMountRequest {
  mountPolicy: VatMountPolicy;
}

export interface VatMountBuild {
  tree: VatNode;
  observedBundleIds?: string[];
  observedPids?: number[];
}

export interface VatMountSummary extends VatPersistedMount {
  active: boolean;
  activeSince: number | null;
}

export interface VatMountRecord extends VatMountSummary {
  active: true;
  activeSince: number;
  tree: VatNode;
}

export interface VatTreeResponse {
  path: string | null;
  tree: VatNode;
}

export interface VatMountResponse {
  ok: true;
  mount: VatMountSummary;
  activeMount: VatMountRecord | null;
  tree?: VatNode;
}

export interface VatUnmountResponse {
  ok: true;
  unmounted: VatMountSummary;
  activeMount: VatMountRecord | null;
}

export interface VatPolicyResponse {
  ok: true;
  mount: VatMountSummary;
  activeMount: VatMountRecord | null;
  tree?: VatNode;
}
