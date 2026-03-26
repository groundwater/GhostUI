export const ACTOR_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type ActorType = "pointer";
export type PointerMoveStyle = "purposeful" | "fast" | "slow" | "wandering";
export type PointerButton = "left" | "right" | "middle";
export const ACTOR_CLICK_VISUAL_DURATION_MS = 260;
export const ACTOR_CLICK_PASSTHROUGH_DELAY_MS = Math.round(ACTOR_CLICK_VISUAL_DURATION_MS / 2);
export type ActorErrorCode =
  | "actor_exists"
  | "unknown_type"
  | "unknown_action"
  | "invalid_args"
  | "actor_not_found"
  | "timeout"
  | "run_preempted"
  | "run_canceled";

export interface ActorSpawnRequest {
  type: ActorType;
  name: string;
  durationScale: number;
}

export interface ActorListEntry {
  name: string;
  type: ActorType;
}

export type ActorAction =
  | { kind: "move"; to: { x: number; y: number }; style: PointerMoveStyle }
  | { kind: "click"; button: PointerButton; at?: { x: number; y: number } }
  | { kind: "drag"; to: { x: number; y: number } }
  | { kind: "scroll"; dx: number; dy: number }
  | { kind: "think"; forMs: number }
  | { kind: "narrate"; text: string }
  | { kind: "dismiss" };

export interface ActorRunRequest {
  action: ActorAction;
  timeoutMs?: number;
}

export class ActorApiError extends Error {
  readonly code: ActorErrorCode;
  readonly status: number;

  constructor(code: ActorErrorCode, message: string, status = actorErrorStatus(code)) {
    super(message);
    this.name = "ActorApiError";
    this.code = code;
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ActorApiError("invalid_args", `${label} must be an object`);
  }
  return value;
}

function expectFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ActorApiError("invalid_args", `${label} must be a finite number`);
  }
  return value;
}

function expectPositiveNumber(value: unknown, label: string): number {
  const parsed = expectFiniteNumber(value, label);
  if (parsed <= 0) {
    throw new ActorApiError("invalid_args", `${label} must be greater than 0`);
  }
  return parsed;
}

function expectNonNegativeNumber(value: unknown, label: string): number {
  const parsed = expectFiniteNumber(value, label);
  if (parsed < 0) {
    throw new ActorApiError("invalid_args", `${label} must be greater than or equal to 0`);
  }
  return parsed;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ActorApiError("invalid_args", `${label} must be a non-empty string`);
  }
  return value;
}

function expectActorName(name: unknown, label = "name"): string {
  const parsed = expectString(name, label);
  if (!ACTOR_NAME_RE.test(parsed)) {
    throw new ActorApiError("invalid_args", `${label} must match ${ACTOR_NAME_RE.source}`);
  }
  return parsed;
}

function expectActorType(type: unknown): ActorType {
  if (type !== "pointer") {
    throw new ActorApiError("unknown_type", `Unknown actor type: ${String(type || "")}`);
  }
  return "pointer";
}

function normalizePoint(value: unknown, label: string): { x: number; y: number } {
  const record = expectRecord(value, label);
  return {
    x: expectFiniteNumber(record.x, `${label}.x`),
    y: expectFiniteNumber(record.y, `${label}.y`),
  };
}

export function actorErrorStatus(code: ActorErrorCode): number {
  switch (code) {
    case "actor_exists":
    case "run_preempted":
    case "run_canceled":
      return 409;
    case "unknown_type":
    case "unknown_action":
      return 422;
    case "actor_not_found":
      return 404;
    case "timeout":
      return 408;
    case "invalid_args":
    default:
      return 400;
  }
}

export function actorErrorBody(error: unknown): { ok: false; error: ActorErrorCode; message: string; status: number } {
  if (error instanceof ActorApiError) {
    return {
      ok: false,
      error: error.code,
      message: error.message,
      status: error.status,
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    error: "invalid_args",
    message,
    status: 400,
  };
}

export function normalizeActorSpawnRequest(value: unknown): ActorSpawnRequest {
  const record = expectRecord(value, "spawn body");
  return {
    type: expectActorType(record.type),
    name: expectActorName(record.name),
    durationScale: record.durationScale === undefined
      ? 1
      : expectNonNegativeNumber(record.durationScale, "durationScale"),
  };
}

export function normalizeActorRunRequest(value: unknown): ActorRunRequest {
  const record = expectRecord(value, "run body");
  const kind = expectString(record.kind, "kind");
  const timeoutMs = record.timeoutMs === undefined ? undefined : Math.trunc(expectPositiveNumber(record.timeoutMs, "timeoutMs"));

  switch (kind) {
    case "move": {
      const style = record.style === undefined ? "purposeful" : expectString(record.style, "style");
      if (!["purposeful", "fast", "slow", "wandering"].includes(style)) {
        throw new ActorApiError("invalid_args", `style must be one of purposeful, fast, slow, wandering`);
      }
      return {
        timeoutMs,
        action: {
          kind,
          to: normalizePoint(record.to, "to"),
          style: style as PointerMoveStyle,
        },
      };
    }
    case "click": {
      const button = record.button === undefined ? "left" : expectString(record.button, "button");
      if (!["left", "right", "middle"].includes(button)) {
        throw new ActorApiError("invalid_args", "button must be one of left, right, middle");
      }
      return {
        timeoutMs,
        action: {
          kind,
          button: button as PointerButton,
          at: record.at === undefined ? undefined : normalizePoint(record.at, "at"),
        },
      };
    }
    case "drag":
      return { timeoutMs, action: { kind, to: normalizePoint(record.to, "to") } };
    case "scroll":
      return {
        timeoutMs,
        action: {
          kind,
          dx: expectFiniteNumber(record.dx, "dx"),
          dy: expectFiniteNumber(record.dy, "dy"),
        },
      };
    case "think":
      return {
        timeoutMs,
        action: {
          kind,
          forMs: record.forMs === undefined ? 1400 : Math.trunc(expectNonNegativeNumber(record.forMs, "forMs")),
        },
      };
    case "narrate":
      return {
        timeoutMs,
        action: {
          kind,
          text: expectString(record.text, "text"),
        },
      };
    case "dismiss":
      return { timeoutMs, action: { kind } };
    default:
      throw new ActorApiError("unknown_action", `Unknown action: ${kind}`);
  }
}

function requireOptionValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new ActorApiError("invalid_args", `${flag} requires a value`);
  }
  return value;
}

function parseTimeout(args: string[]): number | undefined {
  const index = args.indexOf("--timeout");
  if (index < 0) return undefined;
  const value = Number(requireOptionValue(args, index, "--timeout"));
  args.splice(index, 2);
  return Math.trunc(expectPositiveNumber(value, "--timeout"));
}

function parsePointFlag(args: string[], flag: string): { x: number; y: number } {
  const index = args.indexOf(flag);
  if (index < 0) {
    throw new ActorApiError("invalid_args", `${flag} is required`);
  }
  const x = Number(requireOptionValue(args, index, `${flag} <x>`));
  const yToken = args[index + 2];
  if (!yToken || yToken.startsWith("--")) {
    throw new ActorApiError("invalid_args", `${flag} requires <x> <y>`);
  }
  const y = Number(yToken);
  args.splice(index, 3);
  return {
    x: expectFiniteNumber(x, `${flag} x`),
    y: expectFiniteNumber(y, `${flag} y`),
  };
}

export function parseActorSpawnCLIArgs(args: string[]): ActorSpawnRequest {
  const rest = [...args];
  const type = rest.shift();
  const name = rest.shift();
  if (!type || !name) {
    throw new ActorApiError("invalid_args", "Usage: gui actor spawn <type> <name> [--duration-scale <scale>]");
  }

  let durationScale = 1;
  const durationIndex = rest.indexOf("--duration-scale");
  if (durationIndex >= 0) {
    durationScale = expectNonNegativeNumber(Number(requireOptionValue(rest, durationIndex, "--duration-scale")), "--duration-scale");
    rest.splice(durationIndex, 2);
  }

  if (rest.length > 0) {
    throw new ActorApiError("invalid_args", `Unknown actor spawn args: ${rest.join(" ")}`);
  }

  return {
    type: expectActorType(type),
    name: expectActorName(name),
    durationScale,
  };
}

export function parseActorRunCLIArgs(actionName: string, args: string[]): ActorRunRequest {
  const rest = [...args];
  const timeoutMs = parseTimeout(rest);

  switch (actionName) {
    case "move": {
      const to = parsePointFlag(rest, "--to");
      let style: PointerMoveStyle = "purposeful";
      const styleIndex = rest.indexOf("--style");
      if (styleIndex >= 0) {
        const value = requireOptionValue(rest, styleIndex, "--style");
        if (!["purposeful", "fast", "slow", "wandering"].includes(value)) {
          throw new ActorApiError("invalid_args", "--style must be one of purposeful, fast, slow, wandering");
        }
        style = value as PointerMoveStyle;
        rest.splice(styleIndex, 2);
      }
      if (rest.length > 0) {
        throw new ActorApiError("invalid_args", `Unknown move args: ${rest.join(" ")}`);
      }
      return { timeoutMs, action: { kind: "move", to, style } };
    }
    case "click": {
      let button: PointerButton = "left";
      const buttonIndex = rest.indexOf("--button");
      if (buttonIndex >= 0) {
        const value = requireOptionValue(rest, buttonIndex, "--button");
        if (!["left", "right", "middle"].includes(value)) {
          throw new ActorApiError("invalid_args", "--button must be one of left, right, middle");
        }
        button = value as PointerButton;
        rest.splice(buttonIndex, 2);
      }
      let at: { x: number; y: number } | undefined;
      if (rest.includes("--at")) {
        at = parsePointFlag(rest, "--at");
      }
      if (rest.length > 0) {
        throw new ActorApiError("invalid_args", `Unknown click args: ${rest.join(" ")}`);
      }
      return { timeoutMs, action: { kind: "click", button, at } };
    }
    case "drag": {
      const to = parsePointFlag(rest, "--to");
      if (rest.length > 0) {
        throw new ActorApiError("invalid_args", `Unknown drag args: ${rest.join(" ")}`);
      }
      return { timeoutMs, action: { kind: "drag", to } };
    }
    case "scroll": {
      const dxIndex = rest.indexOf("--dx");
      const dyIndex = rest.indexOf("--dy");
      if (dxIndex < 0 || dyIndex < 0) {
        throw new ActorApiError("invalid_args", "scroll requires --dx <n> --dy <n>");
      }
      const dx = Number(requireOptionValue(rest, dxIndex, "--dx"));
      rest.splice(dxIndex, 2);
      const nextDyIndex = rest.indexOf("--dy");
      const dy = Number(requireOptionValue(rest, nextDyIndex, "--dy"));
      rest.splice(nextDyIndex, 2);
      if (rest.length > 0) {
        throw new ActorApiError("invalid_args", `Unknown scroll args: ${rest.join(" ")}`);
      }
      return {
        timeoutMs,
        action: {
          kind: "scroll",
          dx: expectFiniteNumber(dx, "--dx"),
          dy: expectFiniteNumber(dy, "--dy"),
        },
      };
    }
    case "think": {
      let forMs = 1400;
      const forIndex = rest.indexOf("--for");
      if (forIndex >= 0) {
        forMs = Math.trunc(expectNonNegativeNumber(Number(requireOptionValue(rest, forIndex, "--for")), "--for"));
        rest.splice(forIndex, 2);
      }
      if (rest.length > 0) {
        throw new ActorApiError("invalid_args", `Unknown think args: ${rest.join(" ")}`);
      }
      return { timeoutMs, action: { kind: "think", forMs } };
    }
    case "narrate": {
      const textIndex = rest.indexOf("--text");
      if (textIndex < 0) {
        throw new ActorApiError("invalid_args", "narrate requires --text <text>");
      }
      const text = requireOptionValue(rest, textIndex, "--text");
      rest.splice(textIndex, 2);
      if (rest.length > 0) {
        throw new ActorApiError("invalid_args", `Unknown narrate args: ${rest.join(" ")}`);
      }
      return { timeoutMs, action: { kind: "narrate", text } };
    }
    case "dismiss":
      if (rest.length > 0) {
        throw new ActorApiError("invalid_args", `Unknown dismiss args: ${rest.join(" ")}`);
      }
      return { timeoutMs, action: { kind: "dismiss" } };
    default:
      throw new ActorApiError("unknown_action", `Unknown action: ${actionName}`);
  }
}
