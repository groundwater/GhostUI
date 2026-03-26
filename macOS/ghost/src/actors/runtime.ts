import type { DisplayInfo } from "../a11y/native-ax.js";
import { makeActorDisplaySpace, primaryCenter, validateActorPoint } from "./display-space.js";
import {
  ACTOR_CLICK_VISUAL_DURATION_MS,
  ActorApiError,
  type ActorAction,
  type ActorListEntry,
  type ActorRunRequest,
  type ActorSpawnRequest,
  type ActorType,
} from "./protocol.js";

export interface ActorOverlayCommand {
  op: "spawn" | "show" | "move" | "click" | "drag" | "scroll" | "thinkStart" | "thinkStop" | "narrate" | "dismiss" | "kill" | "cancel";
  name: string;
  type?: ActorType;
  position?: { x: number; y: number };
  to?: { x: number; y: number };
  durationMs?: number;
  style?: string;
  button?: string;
  dx?: number;
  dy?: number;
  text?: string;
}

export interface ActorOverlayRenderer {
  send(command: ActorOverlayCommand): void;
}

interface ActorState {
  name: string;
  type: ActorType;
  durationScale: number;
  position: { x: number; y: number };
  hidden: boolean;
  activeRun?: { controller: AbortController };
}

export interface ActorRuntimeDeps {
  getDisplays(): DisplayInfo[];
  postOverlay(kind: string, payload: string): void;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) {
    if (signal.aborted) {
      return Promise.reject(signal.reason);
    }
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };

    if (signal.aborted) {
      onAbort();
      return;
    }

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundDuration(ms: number): number {
  return Math.max(0, Math.round(ms));
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export class ActorRuntime {
  private readonly actors = new Map<string, ActorState>();

  constructor(private readonly deps: ActorRuntimeDeps) {}

  list(): { ok: true; actors: ActorListEntry[] } {
    return {
      ok: true,
      actors: [...this.actors.values()]
        .map((actor) => ({ name: actor.name, type: actor.type }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  spawn(request: ActorSpawnRequest): { ok: true; name: string; type: ActorType; durationScale: number } {
    if (this.actors.has(request.name)) {
      throw new ActorApiError("actor_exists", `Actor '${request.name}' already exists`);
    }

    const space = makeActorDisplaySpace(this.deps.getDisplays());
    const position = primaryCenter(space);
    const actor: ActorState = {
      name: request.name,
      type: request.type,
      durationScale: request.durationScale,
      position,
      hidden: false,
    };
    this.actors.set(actor.name, actor);
    this.post({
      op: "spawn",
      name: actor.name,
      type: actor.type,
      position,
      durationMs: this.scaleDuration(actor, 180),
    });
    return {
      ok: true,
      name: actor.name,
      type: actor.type,
      durationScale: actor.durationScale,
    };
  }

  kill(name: string): { ok: true; name: string; killed: true } {
    const actor = this.actors.get(name);
    if (!actor) {
      throw new ActorApiError("actor_not_found", `No actor named '${name}'`);
    }

    actor.activeRun?.controller.abort(new ActorApiError("run_canceled", `Run canceled for actor '${name}'`));
    this.post({ op: "kill", name });
    this.actors.delete(name);
    return { ok: true, name, killed: true };
  }

  async run(name: string, request: ActorRunRequest): Promise<{ ok: true; name: string; completed: true }> {
    const actor = this.actors.get(name);
    if (!actor) {
      throw new ActorApiError("actor_not_found", `No actor named '${name}'`);
    }

    this.validateAction(actor, request.action);

    actor.activeRun?.controller.abort(new ActorApiError("run_preempted", `Run preempted for actor '${name}'`));
    const controller = new AbortController();
    actor.activeRun = { controller };

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    if (request.timeoutMs !== undefined) {
      timeoutHandle = setTimeout(() => {
        controller.abort(new ActorApiError("timeout", `Actor run timed out for '${name}'`));
      }, request.timeoutMs);
    }

    try {
      await this.execute(actor, request.action, controller.signal);
      return { ok: true, name, completed: true };
    } catch (error) {
      if (error instanceof ActorApiError && error.code === "timeout") {
        this.post({ op: "cancel", name });
      }
      throw error;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (actor.activeRun?.controller === controller) {
        delete actor.activeRun;
      }
    }
  }

  private validateAction(actor: ActorState, action: ActorAction): void {
    const space = makeActorDisplaySpace(this.deps.getDisplays());
    switch (action.kind) {
      case "move":
        validateActorPoint(space, action.to, "to");
        return;
      case "click":
        if (action.at) validateActorPoint(space, action.at, "at");
        return;
      case "drag":
        validateActorPoint(space, action.to, "to");
        return;
      case "scroll":
        if (!Number.isFinite(action.dx) || !Number.isFinite(action.dy) || (action.dx === 0 && action.dy === 0)) {
          throw new ActorApiError("invalid_args", "scroll requires a non-zero --dx or --dy");
        }
        return;
      case "think":
        if (action.forMs < 0) {
          throw new ActorApiError("invalid_args", "think duration must be non-negative");
        }
        return;
      case "narrate":
        if (!action.text.trim()) {
          throw new ActorApiError("invalid_args", "narrate text must be non-empty");
        }
        return;
      case "dismiss":
        return;
    }
  }

  private async execute(actor: ActorState, action: ActorAction, signal: AbortSignal): Promise<void> {
    switch (action.kind) {
      case "move":
        await this.ensureVisible(actor, signal);
        await this.moveActor(actor, action.to, this.moveDuration(actor, action.style, action.to), action.style, signal);
        return;
      case "click":
        await this.ensureVisible(actor, signal);
        if (action.at) {
          await this.moveActor(actor, action.at, this.moveDuration(actor, "fast", action.at), "fast", signal);
        }
        this.post({
          op: "click",
          name: actor.name,
          button: action.button,
          durationMs: this.scaleDuration(actor, ACTOR_CLICK_VISUAL_DURATION_MS),
        });
        await sleep(this.scaleDuration(actor, ACTOR_CLICK_VISUAL_DURATION_MS), signal);
        return;
      case "drag":
        await this.ensureVisible(actor, signal);
        {
          const durationMs = this.dragDuration(actor, action.to);
          this.post({
            op: "drag",
            name: actor.name,
            to: action.to,
            durationMs,
          });
          await sleep(durationMs, signal);
          actor.position = { ...action.to };
        }
        return;
      case "scroll":
        await this.ensureVisible(actor, signal);
        this.post({
          op: "scroll",
          name: actor.name,
          dx: action.dx,
          dy: action.dy,
          durationMs: this.scrollDuration(actor, action.dx, action.dy),
        });
        await sleep(this.scrollDuration(actor, action.dx, action.dy), signal);
        return;
      case "think":
        await this.ensureVisible(actor, signal);
        this.post({
          op: "thinkStart",
          name: actor.name,
          durationMs: this.scaleDuration(actor, 160),
        });
        await sleep(this.scaleDuration(actor, action.forMs), signal);
        this.post({
          op: "thinkStop",
          name: actor.name,
          durationMs: this.scaleDuration(actor, 120),
        });
        await sleep(this.scaleDuration(actor, 120), signal);
        return;
      case "narrate":
        await this.ensureVisible(actor, signal);
        this.post({
          op: "narrate",
          name: actor.name,
          text: action.text,
          durationMs: this.narrateDuration(actor, action.text),
        });
        await sleep(this.narrateDuration(actor, action.text), signal);
        return;
      case "dismiss":
        if (actor.hidden) return;
        {
          const durationMs = this.scaleDuration(actor, 180);
          this.post({
            op: "dismiss",
            name: actor.name,
            durationMs,
          });
          await sleep(durationMs, signal);
          actor.hidden = true;
        }
        return;
    }
  }

  private async ensureVisible(actor: ActorState, signal: AbortSignal): Promise<void> {
    if (!actor.hidden) return;
    const durationMs = this.scaleDuration(actor, 180);
    this.post({
      op: "show",
      name: actor.name,
      position: actor.position,
      durationMs,
    });
    await sleep(durationMs, signal);
    actor.hidden = false;
  }

  private async moveActor(
    actor: ActorState,
    to: { x: number; y: number },
    durationMs: number,
    style: string,
    signal: AbortSignal,
  ): Promise<void> {
    this.post({
      op: "move",
      name: actor.name,
      to,
      durationMs,
      style,
    });
    await sleep(durationMs, signal);
    actor.position = { ...to };
  }

  private scaleDuration(actor: ActorState, ms: number): number {
    return roundDuration(ms * actor.durationScale);
  }

  private moveDuration(actor: ActorState, style: string, to: { x: number; y: number }): number {
    const d = distance(actor.position, to);
    switch (style) {
      case "fast":
        return this.scaleDuration(actor, clamp(120 + d * 0.18, 120, 320));
      case "slow":
        return this.scaleDuration(actor, clamp(320 + d * 0.55, 320, 1200));
      case "wandering":
        return this.scaleDuration(actor, clamp(420 + d * 0.62, 420, 1400));
      case "purposeful":
      default:
        return this.scaleDuration(actor, clamp(180 + d * 0.35, 180, 760));
    }
  }

  private dragDuration(actor: ActorState, to: { x: number; y: number }): number {
    return this.scaleDuration(actor, clamp(280 + distance(actor.position, to) * 0.45, 280, 1400));
  }

  private scrollDuration(actor: ActorState, dx: number, dy: number): number {
    const magnitude = Math.abs(dx) + Math.abs(dy);
    return this.scaleDuration(actor, clamp(180 + magnitude * 1.4, 180, 900));
  }

  private narrateDuration(actor: ActorState, text: string): number {
    return this.scaleDuration(actor, clamp(900 + text.length * 35, 1200, 4200));
  }

  private post(command: ActorOverlayCommand): void {
    this.deps.postOverlay("actor", JSON.stringify(command));
  }
}
