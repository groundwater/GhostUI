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
  type CanvasBox,
  type CanvasDrawStyle,
  type CanvasDrawShape,
  type CanvasTextStyle,
  type SpotlightShape,
} from "./protocol.js";
import type { DrawScript } from "../overlay/draw.js";

const DEFAULT_SPOTLIGHT_COLOR = "rgba(0,0,0,.5)";
const SPOTLIGHT_GEOMETRY_ANIMATION_MS = 200;
const SPOTLIGHT_FADE_ANIMATION_MS = 180;
const SPOTLIGHT_COLOR_ANIMATION_MS = 180;

type SpotlightGeometryAction = Extract<ActorAction, { kind: "rect" | "circ" }>;

interface ActorState {
  name: string;
  type: ActorType;
  durationScale: number;
  idleMs: number;
  position: { x: number; y: number };
  hidden: boolean;
  activeRun?: { controller: AbortController };
  canvas?: CanvasState;
  spotlight?: SpotlightState;
}

interface CanvasState {
  nextItemIndex: number;
  drawItems: CanvasDrawItemState[];
  textItems: CanvasTextItemState[];
}

interface CanvasDrawItemState {
  id: string;
  shape: CanvasDrawShape;
  rect: { x: number; y: number; width: number; height: number };
  style: CanvasDrawStyle;
}

interface CanvasTextItemState {
  id: string;
  text: string;
  style: CanvasTextStyle;
}

interface SpotlightState {
  shape: SpotlightShape;
  rects: CanvasBox[];
  color: string;
  padding: number;
  blur: number;
  visible: boolean;
}

interface ActorOverlayCommand {
  op: "spawn" | "show" | "move" | "click" | "drag" | "scroll" | "thinkStart" | "thinkStop" | "narrate" | "encircle" | "dismiss" | "kill" | "cancel" | "draw" | "text" | "clear";
  name: string;
  type?: ActorType;
  position?: { x: number; y: number };
  to?: { x: number; y: number };
  center?: { x: number; y: number };
  rect?: { x: number; y: number; width: number; height: number };
  box?: { x: number; y: number; width: number; height: number };
  durationMs?: number;
  idleMs?: number;
  radius?: number;
  loops?: number;
  style?: string;
  button?: string;
  dx?: number;
  dy?: number;
  text?: string;
  shape?: CanvasDrawShape;
  font?: string;
  size?: number;
  color?: string;
  highlight?: string;
  padding?: number;
  roughness?: number;
  opacity?: number;
  id?: string;
}

export interface ActorRuntimeDeps {
  getDisplays(): DisplayInfo[];
  getMousePosition?(): { x: number; y: number } | null;
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

function rectContainsPoint(rect: { x: number; y: number; width: number; height: number }, point: { x: number; y: number }): boolean {
  return point.x >= rect.x
    && point.x < rect.x + rect.width
    && point.y >= rect.y
    && point.y < rect.y + rect.height;
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
    const position = request.type === "canvas"
      ? this.deps.getMousePosition?.() ?? primaryCenter(space)
      : primaryCenter(space);
    const actor: ActorState = {
      name: request.name,
      type: request.type,
      durationScale: request.durationScale,
      idleMs: request.idleMs ?? 3000,
      position,
      hidden: request.type === "spotlight",
      canvas: request.type === "canvas"
        ? {
            nextItemIndex: 0,
            drawItems: [],
            textItems: [],
          }
        : undefined,
      spotlight: request.type === "spotlight"
        ? {
            shape: "rect",
            rects: [],
            color: DEFAULT_SPOTLIGHT_COLOR,
            padding: 0,
            blur: 0,
            visible: false,
          }
        : undefined,
    };
    this.actors.set(actor.name, actor);
    if (actor.type === "pointer") {
      this.post({
        op: "spawn",
        name: actor.name,
        type: actor.type,
        position,
        durationMs: this.scaleDuration(actor, 180),
        idleMs: actor.idleMs,
      });
    } else if (actor.type === "canvas") {
      this.post({
        op: "spawn",
        name: actor.name,
        type: actor.type,
        position,
      });
    }
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
    if (actor.type === "pointer") {
      this.post({ op: "kill", name });
    } else if (actor.type === "spotlight") {
      this.clearSpotlight(actor);
    } else {
      this.clearCanvas(actor);
      this.post({ op: "kill", name, type: "canvas" });
    }
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
    if (actor.type === "canvas") {
      switch (action.kind) {
        case "draw":
        case "text":
        case "clear":
          return;
        default:
          throw new ActorApiError("unknown_action", `Unknown action: ${action.kind}`);
      }
    }

    if (actor.type === "spotlight") {
      switch (action.kind) {
        case "rect":
        case "circ":
        case "on":
        case "off":
        case "color":
          return;
        default:
          throw new ActorApiError("unknown_action", `Unknown action: ${action.kind}`);
      }
    }

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
      case "encircle":
        validateActorPoint(space, action.center, "center");
        return;
      case "dismiss":
        return;
      default:
        throw new ActorApiError("unknown_action", `Unknown action: ${action.kind}`);
    }
  }

  private async execute(actor: ActorState, action: ActorAction, signal: AbortSignal): Promise<void> {
    if (actor.type === "canvas") {
      await this.executeCanvas(actor, action);
      return;
    }

    if (actor.type === "spotlight") {
      await this.executeSpotlight(actor, action, signal);
      return;
    }

    await this.runPointerAction(actor, action, signal);
  }

  private async runPointerAction(actor: ActorState, action: ActorAction, signal: AbortSignal): Promise<void> {
    switch (action.kind) {
      case "move":
        await this.ensureVisible(actor, signal);
        await this.moveActor(actor, action.to, this.moveDuration(actor, action.style, action.to), action.style, signal);
        return;
      case "click":
        await this.ensureVisible(actor, signal);
        if (action.at) {
          await this.movePointerIntoPosition(actor, action.at, signal);
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
      case "encircle":
        await this.ensureVisible(actor, signal);
        {
          const start = this.encircleStartPoint(action.center, action.radius);
          await this.movePointerIntoPosition(actor, start, signal);
          const durationMs = this.encircleDuration(actor, action.radius, action.loops, action.speed);
          this.post({
            op: "encircle",
            name: actor.name,
            center: action.center,
            radius: action.radius,
            loops: action.loops,
            durationMs,
          });
          await sleep(durationMs, signal);
          actor.position = start;
        }
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
      case "draw":
      case "text":
      case "clear":
      case "rect":
      case "circ":
      case "on":
      case "off":
      case "color":
        throw new ActorApiError("unknown_action", `Unknown action: ${action.kind}`);
    }
  }

  private async executeSpotlight(actor: ActorState, action: ActorAction, signal: AbortSignal): Promise<void> {
    if (!actor.spotlight) {
      throw new ActorApiError("actor_not_found", `No spotlight state for actor '${actor.name}'`);
    }

    switch (action.kind) {
      case "rect":
      case "circ": {
        const durationMs = this.scaleDuration(actor, this.spotlightGeometryDuration(actor.spotlight, action));
        actor.spotlight.shape = action.kind;
        actor.spotlight.rects = action.rects;
        actor.spotlight.padding = action.padding;
        actor.spotlight.blur = action.blur;
        actor.spotlight.visible = true;
        this.postSpotlight(actor, {
          opacity: 1,
          durationMs,
        });
        if (durationMs > 0) {
          await sleep(durationMs, signal);
        }
        return;
      }
      case "on": {
        actor.spotlight.visible = true;
        if (actor.spotlight.rects.length === 0) {
          return;
        }
        const durationMs = this.scaleDuration(actor, action.transition === "instant" ? 0 : SPOTLIGHT_FADE_ANIMATION_MS);
        this.postSpotlight(actor, {
          opacity: 1,
          durationMs,
        });
        if (durationMs > 0) {
          await sleep(durationMs, signal);
        }
        return;
      }
      case "off": {
        actor.spotlight.visible = false;
        if (actor.spotlight.rects.length === 0) {
          return;
        }
        const durationMs = this.scaleDuration(actor, action.transition === "instant" ? 0 : SPOTLIGHT_FADE_ANIMATION_MS);
        this.postSpotlight(actor, {
          opacity: 0,
          durationMs,
        });
        if (durationMs > 0) {
          await sleep(durationMs, signal);
        }
        return;
      }
      case "color": {
        actor.spotlight.color = action.color;
        if (actor.spotlight.rects.length === 0) {
          return;
        }
        const durationMs = this.scaleDuration(actor, SPOTLIGHT_COLOR_ANIMATION_MS);
        this.postSpotlight(actor, {
          opacity: actor.spotlight.visible ? 1 : 0,
          durationMs,
        });
        if (actor.spotlight.visible) {
          await sleep(durationMs, signal);
        }
        return;
      }
      default:
        throw new ActorApiError("unknown_action", `Unknown action: ${action.kind}`);
    }
  }

  private async executeCanvas(actor: ActorState, action: ActorAction): Promise<void> {
    if (!actor.canvas) {
      throw new ActorApiError("actor_not_found", `No canvas state for actor '${actor.name}'`);
    }

    switch (action.kind) {
      case "draw": {
        const boxes = action.boxes ?? (action.box ? [action.box] : undefined);
        if (boxes && boxes.length > 0) {
          for (const box of boxes) {
            const item = this.nextCanvasDrawItem(actor, undefined, action.shape, action.style, box);
            actor.canvas.drawItems.push(item);
            this.post({
              op: "draw",
              type: "canvas",
              name: actor.name,
              id: item.id,
              shape: action.shape,
              box: item.rect,
              padding: action.style.padding,
              size: action.style.size,
              color: action.style.color,
              roughness: this.canvasRoughness(actor, action.style, item.rect),
              opacity: 1,
            });
          }
          return;
        }
        const position = this.resolveCanvasPosition(actor);
        const item = this.nextCanvasDrawItem(actor, position, action.shape, action.style, undefined);
        actor.canvas.drawItems.push(item);
        this.post({
          op: "draw",
          type: "canvas",
          name: actor.name,
          id: item.id,
          shape: action.shape,
          box: item.rect,
          position,
          padding: action.style.padding,
          size: action.style.size,
          color: action.style.color,
          roughness: this.canvasRoughness(actor, action.style, item.rect),
          opacity: 1,
        });
        return;
      }
      case "text": {
        const position = action.box ? undefined : this.resolveCanvasPosition(actor);
        const item = this.nextCanvasTextItem(actor, action.text, action.style);
        actor.canvas.textItems.push(item);
        this.post({
          op: "text",
          type: "canvas",
          name: actor.name,
          id: item.id,
          position,
          text: action.text,
          font: action.style.font,
          size: action.style.size,
          color: action.style.color,
          highlight: action.style.highlight,
          box: action.box,
        });
        return;
      }
      case "clear":
        this.clearCanvas(actor);
        this.post({
          op: "clear",
          type: "canvas",
          name: actor.name,
        });
        return;
      default:
        throw new ActorApiError("unknown_action", `Unknown action: ${action.kind}`);
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

  private async movePointerIntoPosition(
    actor: ActorState,
    to: { x: number; y: number },
    signal: AbortSignal,
  ): Promise<void> {
    if (distance(actor.position, to) <= 0.5) {
      return;
    }
    await this.moveActor(actor, to, this.moveDuration(actor, "purposeful", to), "purposeful", signal);
  }

  private scaleDuration(actor: ActorState, ms: number): number {
    return roundDuration(ms * actor.durationScale);
  }

  private moveDuration(actor: ActorState, style: string, to: { x: number; y: number }): number {
    const d = distance(actor.position, to);
    const jitter = style === "purposeful"
      ? 0.92 + Math.random() * 0.16
      : 1;
    switch (style) {
      case "fast":
        return this.scaleDuration(actor, clamp(120 + d * 0.18, 120, 320));
      case "slow":
        return this.scaleDuration(actor, clamp(320 + d * 0.55, 320, 1200));
      case "wandering":
        return this.scaleDuration(actor, clamp(420 + d * 0.62, 420, 1400));
      case "purposeful":
      default:
        return this.scaleDuration(actor, clamp((180 + d * 0.35) * jitter, 180, 860));
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

  private encircleStartPoint(center: { x: number; y: number }, radius: number): { x: number; y: number } {
    return { x: center.x + radius, y: center.y };
  }

  private encircleDuration(actor: ActorState, radius: number, loops: number, speed: number): number {
    const circumference = Math.PI * 2 * radius * loops;
    return this.scaleDuration(actor, Math.max(1, Math.round((circumference / speed) * 1000)));
  }

  private clearSpotlight(actor: ActorState): void {
    if (!actor.spotlight) {
      return;
    }

    if (actor.spotlight.rects.length === 0) {
      actor.spotlight.visible = false;
      return;
    }

    this.postSpotlight(actor, {
      opacity: 0,
      durationMs: 0,
      remove: true,
    });
    actor.spotlight.visible = false;
  }

  private spotlightGeometryDuration(
    spotlight: SpotlightState,
    action: SpotlightGeometryAction,
  ): number {
    if (action.speed === undefined) {
      return SPOTLIGHT_GEOMETRY_ANIMATION_MS;
    }

    const previousCenter = this.spotlightGeometryCenter(spotlight.rects, spotlight.padding);
    const nextCenter = this.spotlightGeometryCenter(action.rects, action.padding);
    if (!previousCenter || !nextCenter) {
      return SPOTLIGHT_GEOMETRY_ANIMATION_MS;
    }

    const movement = distance(previousCenter, nextCenter);
    if (movement <= 0) {
      return SPOTLIGHT_GEOMETRY_ANIMATION_MS;
    }

    const movementPx = movement * this.spotlightGeometryScale(previousCenter, nextCenter);
    if (movementPx <= 0) {
      return SPOTLIGHT_GEOMETRY_ANIMATION_MS;
    }

    return Math.max(1, Math.round((movementPx / action.speed) * 1000));
  }

  private spotlightGeometryScale(previousCenter: { x: number; y: number }, nextCenter: { x: number; y: number }): number {
    const displays = this.deps.getDisplays();
    const previousDisplay = displays.find((display) => rectContainsPoint(display.frame, previousCenter)) ?? null;
    const nextDisplay = displays.find((display) => rectContainsPoint(display.frame, nextCenter)) ?? null;

    const previousScale = previousDisplay?.scale || 1;
    const nextScale = nextDisplay?.scale || 1;
    if (!previousDisplay || !nextDisplay) {
      return previousScale || nextScale || 1;
    }

    if (previousDisplay.id === nextDisplay.id) {
      return previousScale || 1;
    }

    return (previousScale + nextScale) / 2;
  }

  private spotlightGeometryCenter(rects: CanvasBox[], padding: number): { x: number; y: number } | null {
    if (rects.length === 0) {
      return null;
    }

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    for (const rect of rects) {
      const inflated = this.inflateRect(rect, padding);
      minX = Math.min(minX, inflated.x);
      minY = Math.min(minY, inflated.y);
      maxX = Math.max(maxX, inflated.x + inflated.width);
      maxY = Math.max(maxY, inflated.y + inflated.height);
    }

    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      return null;
    }

    return {
      x: minX + (maxX - minX) / 2,
      y: minY + (maxY - minY) / 2,
    };
  }

  private postSpotlight(
    actor: ActorState,
    options: {
      opacity: number;
      durationMs: number;
      remove?: boolean;
    },
  ): void {
    const spotlight = actor.spotlight;
    if (!spotlight) {
      return;
    }

    const rects = spotlight.rects.map((rect) => this.inflateRect(rect, spotlight.padding));
    const item = options.remove
      ? {
          id: `${actor.name}.spotlight`,
          kind: "spotlight" as const,
          remove: true,
        }
      : {
          id: `${actor.name}.spotlight`,
          kind: "spotlight" as const,
          shape: spotlight.shape,
          rects,
          style: {
            fill: spotlight.color,
            cornerRadius: spotlight.shape === "circ" ? 0 : 18,
            opacity: options.opacity,
            blur: spotlight.blur > 0 ? spotlight.blur : undefined,
          },
          animation: {
            durMs: options.durationMs,
            ease: "easeInOut" as const,
          },
        };

    const script: DrawScript = {
      coordinateSpace: "screen",
      items: [item],
    };

    this.deps.postOverlay("draw", JSON.stringify(script));
  }

  private inflateRect(rect: CanvasBox, padding: number): CanvasBox {
    if (padding <= 0) {
      return rect;
    }

    return {
      x: rect.x - padding,
      y: rect.y - padding,
      width: rect.width + (padding * 2),
      height: rect.height + (padding * 2),
    };
  }

  private nextCanvasDrawItem(
    actor: ActorState,
    position: { x: number; y: number } | undefined,
    shape: CanvasDrawShape,
    style: CanvasDrawStyle,
    box?: CanvasBox,
  ): CanvasDrawItemState {
    const id = `${actor.name}.draw.${actor.canvas?.nextItemIndex ?? 0}`;
    if (actor.canvas) {
      actor.canvas.nextItemIndex += 1;
    }
    return {
      id,
      shape,
      rect: box ?? this.canvasFallbackRect(position ?? actor.position, style),
      style,
    };
  }

  private nextCanvasTextItem(actor: ActorState, text: string, style: CanvasTextStyle): CanvasTextItemState {
    const id = `${actor.name}.text.${actor.canvas?.nextItemIndex ?? 0}`;
    if (actor.canvas) {
      actor.canvas.nextItemIndex += 1;
    }
    return {
      id,
      text,
      style,
    };
  }

  private resolveCanvasPosition(actor: ActorState): { x: number; y: number } {
    const mouse = this.deps.getMousePosition?.();
    if (mouse) {
      actor.position = { ...mouse };
      return actor.position;
    }
    return actor.position;
  }

  private canvasFallbackRect(position: { x: number; y: number }, style: CanvasDrawStyle): { x: number; y: number; width: number; height: number } {
    const size = Math.max(96, Math.round(style.size * 24));
    return {
      x: Math.round(position.x - size / 2),
      y: Math.round(position.y - size / 2),
      width: size,
      height: size,
    };
  }

  private canvasRoughness(actor: ActorState, style: CanvasDrawStyle, rect: { x: number; y: number; width: number; height: number }): number {
    const seed = actor.name.length + style.size + style.padding + rect.x + rect.y + rect.width + rect.height;
    return clamp(0.14 + (seed % 7) * 0.02, 0.14, 0.28);
  }

  private clearCanvas(actor: ActorState): void {
    if (!actor.canvas) return;
    actor.canvas.nextItemIndex = 0;
    actor.canvas.drawItems = [];
    actor.canvas.textItems = [];
  }

  private post(command: ActorOverlayCommand): void {
    this.deps.postOverlay("actor", JSON.stringify(command));
  }
}
