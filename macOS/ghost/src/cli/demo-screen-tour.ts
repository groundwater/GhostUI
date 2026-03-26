#!/usr/bin/env bun
/**
 * demo-screen-tour.ts — Live screen-tour runner using pointer, canvas, and spotlight actors.
 *
 * Discovers visible windows dynamically from live AX queries and narrates a
 * tour with pointer movement, canvas annotations, and overlay text.
 * No real input is sent — all actions are visual-only.
 *
 * Environment knobs:
 *   GHOSTUI_TEST_GUI_PATH  Path to the bundled gui helper (required)
 *   DEMO_MAX_WINDOWS       Max windows to tour (default: unlimited)
 *   DEMO_DURATION_S        Approx total duration in seconds (default: 600 = 10 min)
 *   DEMO_PAUSE_SCALE       Multiplier for pause durations (default: 1.0, use 0.01 for CI)
 *   DEMO_MAX_CONTROLS      Max controls to inspect per window (default: 6)
 */

import { existsSync } from "fs";

type Bounds = { x: number; y: number; width: number; height: number };

const GUI_PATH = process.env.GHOSTUI_TEST_GUI_PATH?.trim() ?? "";
if (!GUI_PATH || !existsSync(GUI_PATH)) {
  console.error(`Bundled gui helper not found at "${GUI_PATH}". Build GhostUI.app first.`);
  process.exit(1);
}

const PAUSE_SCALE = Math.max(0, Number(process.env.DEMO_PAUSE_SCALE) || 1.0);
const MAX_WINDOWS = Number(process.env.DEMO_MAX_WINDOWS) || 0; // 0 = unlimited
const MAX_CONTROLS = Number(process.env.DEMO_MAX_CONTROLS) || 6;
const DURATION_S = Number(process.env.DEMO_DURATION_S) || 600;

const INTERRUPT_ERROR_MESSAGE = "Demo tour interrupted";

interface GuiResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface AXTarget {
  type: "ax.target";
  pid: number;
  point: { x: number; y: number };
  bounds?: Bounds;
  role: string;
  subrole?: string | null;
  title?: string | null;
  label?: string | null;
}

interface AXPayload {
  type: "gui.payload";
  target?: AXTarget;
  bounds?: Bounds;
  point?: { x: number; y: number };
  node?: { _tag?: string; _id?: string; _displayName?: string };
}

interface PayloadMatch {
  payload: AXPayload;
  rawText: string;
}

interface DemoScreenTourOptions {
  guiPath: string;
  pauseScale: number;
  maxWindows: number;
  maxControls: number;
  durationSeconds: number;
  pointerName: string;
  canvasName: string;
  spotlightName: string;
  env: NodeJS.ProcessEnv;
}

interface AXQueryOptions {
  query: string;
  focused?: boolean;
  all?: boolean;
  first?: boolean;
  json?: boolean;
  ndjson?: boolean;
  pid?: number;
}

interface DrawStyle {
  padding?: number;
  size?: number;
  color?: string;
}

type OutlineTransition = "fade" | "pop" | "draw";

interface OutlineStyle {
  color?: string;
  size?: number;
  transition?: OutlineTransition;
  fill?: string;
  durationMs?: number;
}

type SpotlightTransition = "fade" | "instant";

interface SpotlightStyle {
  padding?: number;
  blur?: number;
}

interface WindowTourState {
  window: AXNode;
  index: number;
  total: number;
  title: string;
  pid?: number;
  bounds: Bounds;
  titleBar: Bounds;
}

function interruptError(): Error {
  return new Error(INTERRUPT_ERROR_MESSAGE);
}

function isInterruptError(error: unknown): boolean {
  return error instanceof Error && error.message === INTERRUPT_ERROR_MESSAGE;
}

function parseJSON<T>(text: string): T {
  return JSON.parse(text) as T;
}

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function payloadBox(payload: AXPayload): Bounds | null {
  return payload.target?.bounds ?? payload.bounds ?? null;
}

function sameBounds(left: Bounds | undefined, right: Bounds | undefined): boolean {
  if (!left || !right) return false;
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}

function humanizeRole(role: string | undefined): string {
  const cleaned = (role ?? "").replace(/^AX/, "");
  if (!cleaned) return "control";
  return cleaned.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
}

function describeWindow(payload: AXPayload): string {
  const title = payload.target?.title || payload.node?._displayName || payload.node?._id || "unnamed window";
  const role = payload.target?.role || payload.node?._tag || "Window";
  if (role === "AXWindow") return title;
  return `${title} (${role})`;
}

function boxCenter(bounds: Bounds): { x: number; y: number } {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

function titleBarBox(bounds: Bounds): Bounds {
  return {
    x: bounds.x + 12,
    y: bounds.y + 8,
    width: Math.max(120, bounds.width - 24),
    height: Math.min(42, Math.max(24, Math.round(bounds.height * 0.1))),
  };
}

function boundsContainedIn(inner: Bounds, outer: Bounds, tolerance = 12): boolean {
  const innerRight = inner.x + inner.width;
  const innerBottom = inner.y + inner.height;
  const outerRight = outer.x + outer.width;
  const outerBottom = outer.y + outer.height;
  return (
    inner.x >= outer.x - tolerance &&
    inner.y >= outer.y - tolerance &&
    innerRight <= outerRight + tolerance &&
    innerBottom <= outerBottom + tolerance
  );
}

class AXNode {
  constructor(private readonly match: PayloadMatch) {}

  get payload(): AXPayload {
    return this.match.payload;
  }

  get rawText(): string {
    return this.match.rawText;
  }

  get bounds(): Bounds | null {
    return payloadBox(this.match.payload);
  }

  get pid(): number | undefined {
    return this.match.payload.target?.pid;
  }

  get center(): { x: number; y: number } | null {
    return this.bounds ? boxCenter(this.bounds) : null;
  }

  get title(): string {
    return describeWindow(this.match.payload);
  }

  within(bounds: Bounds): boolean {
    return this.bounds ? boundsContainedIn(this.bounds, bounds) : false;
  }

  meetsSize(minSize = 10): boolean {
    return this.bounds ? this.bounds.width >= minSize && this.bounds.height >= minSize : false;
  }

  key(): string {
    const bounds = this.bounds;
    const role = this.match.payload.target?.role || this.match.payload.node?._tag || "";
    const label =
      this.match.payload.target?.title ||
      this.match.payload.target?.label ||
      this.match.payload.node?._displayName ||
      this.match.payload.node?._id ||
      "";
    if (!bounds) {
      return `${this.pid ?? "?"}:${role}:${label}`;
    }
    return [this.pid ?? "?", role, label, bounds.x, bounds.y, bounds.width, bounds.height].join(":");
  }

  kind(fallbackKind = "control"): string {
    return humanizeRole(this.match.payload.target?.role || this.match.payload.node?._tag) || fallbackKind;
  }

  label(fallbackKind = "control"): string {
    return (
      this.match.payload.target?.title ||
      this.match.payload.target?.label ||
      this.match.payload.node?._displayName ||
      this.match.payload.node?._id ||
      this.kind(fallbackKind) ||
      fallbackKind
    );
  }

  describe(fallbackKind = "control"): string {
    const kind = this.kind(fallbackKind);
    const label = this.label(fallbackKind);
    if (label && label !== kind) {
      return `${kind} "${label}"`;
    }
    return kind;
  }
}

class AXSelection {
  constructor(private readonly nodes: AXNode[]) {}

  static fromMatches(matches: PayloadMatch[]): AXSelection {
    return new AXSelection(matches.map((match) => new AXNode(match)));
  }

  get length(): number {
    return this.nodes.length;
  }

  isEmpty(): boolean {
    return this.nodes.length === 0;
  }

  first(): AXNode | null {
    return this.nodes[0] ?? null;
  }

  toArray(): AXNode[] {
    return [...this.nodes];
  }

  concat(other: AXSelection): AXSelection {
    return new AXSelection([...this.nodes, ...other.nodes]);
  }

  withBounds(): AXSelection {
    return new AXSelection(this.nodes.filter((node) => node.bounds));
  }

  within(bounds: Bounds): AXSelection {
    return new AXSelection(this.nodes.filter((node) => node.within(bounds)));
  }

  visible(minSize = 10): AXSelection {
    return new AXSelection(this.nodes.filter((node) => node.meetsSize(minSize)));
  }

  unique(): AXSelection {
    const seen = new Set<string>();
    const uniqueNodes: AXNode[] = [];
    for (const node of this.nodes) {
      const key = node.key();
      if (seen.has(key)) continue;
      seen.add(key);
      uniqueNodes.push(node);
    }
    return new AXSelection(uniqueNodes);
  }

  limit(count: number): AXSelection {
    return new AXSelection(this.nodes.slice(0, count));
  }

  exclude(other: AXSelection): AXSelection {
    const excluded = new Set(other.nodes.map((node) => node.key()));
    return new AXSelection(this.nodes.filter((node) => !excluded.has(node.key())));
  }

  toPayloadText(): string {
    return this.nodes.map((node) => node.rawText).join("\n");
  }
}

class DemoScreenTour {
  private activeGuiProc: Bun.Subprocess | null = null;
  private interruptReject: ((error: Error) => void) | null = null;
  private readonly interruptPromise: Promise<never>;

  constructor(private readonly options: DemoScreenTourOptions) {
    this.interruptPromise = new Promise<never>((_, reject) => {
      this.interruptReject = reject;
    });
    this.interruptPromise.catch(() => {});
  }

  requestInterrupt(signal: "SIGINT" | "SIGTERM"): void {
    log(`${signal} received; stopping the tour and cleaning up actors.`);
    this.activeGuiProc?.kill();
    this.activeGuiProc = null;
    this.interruptReject?.(interruptError());
    this.interruptReject = null;
  }

  async run(): Promise<void> {
    const startTime = Date.now();
    const maxDurationMs = this.options.durationSeconds * 1000;
    let toured = 0;

    log(
      `Demo config: PAUSE_SCALE=${this.options.pauseScale}, MAX_WINDOWS=${this.options.maxWindows || "unlimited"}, MAX_CONTROLS=${this.options.maxControls}, DURATION_S=${this.options.durationSeconds}`,
    );

    await this.spawnActors();

    try {
      log("Starting intro phase");
      await this.pointerNarrate("Welcome to the GhostUI screen tour!");
      await this.sleep(1500);
      await this.pointerNarrate("I'll start with the foreground window, then fan out to the rest of the screen.");
      await this.sleep(1500);

      const focusedWindows = await this.axQuery({
        query: "Window[frame]",
        focused: true,
        first: true,
        json: true,
      });
      const backgroundWindows = await this.axQuery({
        query: "Application { Window[frame] }",
        all: true,
        ndjson: true,
      });
      const allWindows = focusedWindows.concat(backgroundWindows).withBounds().unique();
      await this.pointerDismiss();
      await this.sleep(500);

      if (allWindows.isEmpty()) {
        log("No windows discovered. Ending tour early.");
        await this.pointerNarrate("I couldn't find any windows to tour. Make sure some apps are open!");
        await this.sleep(2000);
        await this.pointerDismiss();
        return;
      }

      log(`Discovered ${allWindows.length} window(s)`);

      const windows = (this.options.maxWindows > 0 ? allWindows.limit(this.options.maxWindows) : allWindows).toArray();
      for (let i = 0; i < windows.length; i++) {
        const elapsed = Date.now() - startTime;
        if (elapsed > maxDurationMs) {
          log(`Duration limit reached (${this.options.durationSeconds}s). Stopping after ${toured} windows.`);
          break;
        }

        const state = this.buildWindowState(windows[i], i, windows.length);
        log(`Touring window ${state.index + 1}/${state.total}: ${state.title}`);

        await this.pointerMove(state.titleBar.x + state.titleBar.width / 2, state.titleBar.y + state.titleBar.height / 2, "purposeful");
        await this.sleep(400);
        await this.canvasClear();
        await this.spotlightRect(state.window, {
          padding: 8,
          blur: 16,
        });
        await this.pointerNarrate(
          state.index === 0
            ? `Starting with the foreground window. This is "${state.title}".`
            : `Next up is window ${state.index + 1} of ${state.total}. This is "${state.title}".`,
        );
        await this.sleep(3000);
        await this.pointerDismiss();
        await this.sleep(300);

        if (!state.pid) {
          await this.spotlightOff("instant");
          await this.pointerNarrate("I can't resolve a live process for this window, so I'll move on.");
          await this.sleep(1800);
          await this.pointerDismiss();
          await this.canvasClear();
          await this.sleep(500);
          toured++;
          continue;
        }

        const buttons = (await this.axQuery({
          query: "Button[frame]",
          ndjson: true,
          pid: state.pid,
        }))
          .visible()
          .within(state.bounds)
          .unique()
          .limit(this.options.maxControls);

        if (!buttons.isEmpty()) {
          const button = buttons.first();
          if (button?.center) {
            await this.canvasClear();
            await this.circle(button, {
              padding: 8,
              size: 4,
              color: "rgba(255,59,48,0.72)",
            });
            await this.pointerMove(button.center.x, button.center.y, "purposeful");
            await this.sleep(300);
            await this.pointerNarrate(`I can click this ${button.describe("button")}. This is visual-only, no real input is sent.`);
            await this.sleep(1800);
            await this.pointerClick(button.center.x, button.center.y);
            await this.sleep(900);
            await this.pointerDismiss();
          }

          await this.sleep(250);
          await this.canvasClear();
          await this.outline(buttons);
          const anchor = buttons.first();
          if (anchor?.center) {
            await this.pointerMove(anchor.center.x, anchor.center.y, "purposeful");
            await this.sleep(250);
          }
          await this.pointerNarrate("I can click ANY of these buttons. The outlines show every button I found in this window.");
          await this.sleep(2200);
          await this.pointerDismiss();
        } else {
          await this.canvasClear();
          await this.pointerNarrate("I don't see any buttons here, so I'll skip the click demo and keep scanning.");
          await this.sleep(1800);
          await this.pointerDismiss();
        }

        await this.spotlightOff("fade");
        await this.sleep(250);
        await this.canvasClear();
        await this.pointerNarrate("Let me scan for other controls");
        await this.scan(state.window, 1900);
        await this.sleep(1000)
        await this.pointerNarrate("Hmm...");
        await this.sleep(1000)
        await this.pointerNarrate("Let me scan deeper");
        await this.xray(state.window, 2100);
        await this.sleep(250);
        await this.pointerDismiss();

        await this.sleep(250);
        await this.canvasClear();
        const additionalActionControls = (await this.axQuery({
          query: "Window//*[actions]",
          ndjson: true,
          pid: state.pid,
        }))
          .visible()
          .within(state.bounds)
          .unique()
          .limit(this.options.maxControls);

        if (additionalActionControls.isEmpty()) {
          await this.pointerNarrate("Searching by actions did not reveal any additional controls in this window.");
          await this.sleep(1800);
          await this.pointerDismiss();
        } else {
          await this.outline(additionalActionControls, {
            color: 'rgba(255, 30, 10, 1)',
            durationMs: 5000,
            fill: 'rgba(255, 30, 10, .5)',
            size: 2,
          });
          const anchor = additionalActionControls.first();
          if (anchor?.center) {
            await this.pointerMove(anchor.center.x, anchor.center.y, "purposeful");
            await this.sleep(250);
          }
          await this.pointerNarrate(
            `There are also controls here. I searched by actions and outlined all ${additionalActionControls.length} of them without sending real input.`,
          );
          await this.sleep(2200);
          await this.pointerDismiss();
        }

        await this.canvasClear();
        await this.sleep(500);
        toured++;
      }

      log("Starting outro phase");
      await this.pointerNarrate(`Tour complete! I visited ${toured} window${toured !== 1 ? "s" : ""} on this screen.`);
      await this.sleep(3000);
      await this.pointerNarrate("Thanks for watching the GhostUI screen tour.");
      await this.sleep(2000);
      await this.pointerDismiss();
      await this.sleep(500);
    } finally {
      await this.killActors();
    }

    const totalSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
    log(`Demo finished in ${totalSeconds}s`);
  }

  private buildWindowState(window: AXNode, index: number, total: number): WindowTourState {
    const bounds = window.bounds;
    if (!bounds) {
      throw new Error("Window payload is missing bounds");
    }
    return {
      window,
      index,
      total,
      title: window.title,
      pid: window.pid,
      bounds,
      titleBar: titleBarBox(bounds),
    };
  }

  private async sleep(ms: number): Promise<void> {
    await Promise.race([
      new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms * this.options.pauseScale))),
      this.interruptPromise,
    ]);
  }

  private async guiWithInput(stdinText: string, ...args: string[]): Promise<GuiResult> {
    const proc = Bun.spawn({
      cmd: [this.options.guiPath, ...args],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: this.options.env,
    });
    this.activeGuiProc = proc;
    try {
      if (stdinText.length > 0) {
        proc.stdin.write(stdinText);
      }
      proc.stdin.end();
      const [stdout, stderr, exitCode] = await Promise.race([
        Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]),
        this.interruptPromise,
      ]);
      return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
    } finally {
      if (this.activeGuiProc === proc) {
        this.activeGuiProc = null;
      }
    }
  }

  private async gui(...args: string[]): Promise<GuiResult> {
    return this.guiWithInput("", ...args);
  }

  private async spawnActors(): Promise<void> {
    const pointerResult = await this.gui("actor", "spawn", "pointer", this.options.pointerName);
    if (pointerResult.exitCode !== 0) {
      throw new Error(`Failed to spawn pointer: ${pointerResult.stderr}`);
    }
    log(`Spawned pointer actor: ${this.options.pointerName}`);

    const canvasResult = await this.gui("actor", "spawn", "canvas", this.options.canvasName);
    if (canvasResult.exitCode !== 0) {
      throw new Error(`Failed to spawn canvas: ${canvasResult.stderr}`);
    }
    log(`Spawned canvas actor: ${this.options.canvasName}`);

    const spotlightResult = await this.gui("actor", "spawn", "spotlight", this.options.spotlightName);
    if (spotlightResult.exitCode !== 0) {
      throw new Error(`Failed to spawn spotlight: ${spotlightResult.stderr}`);
    }
    log(`Spawned spotlight actor: ${this.options.spotlightName}`);
  }

  private async killActors(): Promise<void> {
    log("Cleaning up actors...");
    await this.spotlightOff("instant").catch(() => {});
    await this.gui("actor", "kill", this.options.spotlightName).catch(() => {});
    await this.gui("actor", "kill", this.options.pointerName).catch(() => {});
    await this.gui("actor", "kill", this.options.canvasName).catch(() => {});
    log("Actors cleaned up.");
  }

  private async pointerMove(x: number, y: number, style = "purposeful"): Promise<void> {
    await this.gui(
      "actor",
      "run",
      `${this.options.pointerName}.move`,
      "--to",
      String(Math.round(x)),
      String(Math.round(y)),
      "--style",
      style,
    );
  }

  private async pointerClick(x: number, y: number): Promise<void> {
    await this.gui(
      "actor",
      "run",
      `${this.options.pointerName}.click`,
      "--at",
      String(Math.round(x)),
      String(Math.round(y)),
    );
  }

  private async pointerNarrate(text: string): Promise<void> {
    await this.gui("actor", "run", `${this.options.pointerName}.narrate`, "--text", text);
  }

  private async pointerDismiss(): Promise<void> {
    await this.gui("actor", "run", `${this.options.pointerName}.dismiss`);
  }

  private async canvasClear(): Promise<void> {
    await this.gui("actor", "run", `${this.options.canvasName}.clear`);
  }

  private async spotlightRect(target: AXNode, style: SpotlightStyle = {}): Promise<void> {
    const args = ["actor", "run", `${this.options.spotlightName}.rect`];
    if (style.padding != null) args.push("--padding", String(style.padding));
    if (style.blur != null) args.push("--blur", String(style.blur));
    args.push("-");
    await this.guiWithInput(target.rawText, ...args);
  }

  private async spotlightCirc(target: AXNode, style: SpotlightStyle = {}): Promise<void> {
    const args = ["actor", "run", `${this.options.spotlightName}.circ`];
    if (style.padding != null) args.push("--padding", String(style.padding));
    if (style.blur != null) args.push("--blur", String(style.blur));
    args.push("-");
    await this.guiWithInput(target.rawText, ...args);
  }

  private async spotlightOn(transition: SpotlightTransition = "fade"): Promise<void> {
    await this.gui("actor", "run", `${this.options.spotlightName}.on`, "--transition", transition);
  }

  private async spotlightOff(transition: SpotlightTransition = "fade"): Promise<void> {
    await this.gui("actor", "run", `${this.options.spotlightName}.off`, "--transition", transition);
  }

  private async spotlightColor(color: string): Promise<void> {
    await this.gui("actor", "run", `${this.options.spotlightName}.color`, color);
  }

  private async draw(shape: string, target: AXNode, style: DrawStyle = {}): Promise<void> {
    const args = ["actor", "run", `${this.options.canvasName}.draw`, shape, "-"];
    if (style.padding != null) args.push("--padding", String(style.padding));
    if (style.size != null) args.push("--size", String(style.size));
    if (style.color) args.push("--color", style.color);
    await this.guiWithInput(target.rawText, ...args);
  }

  private async rect(target: AXNode, style: DrawStyle = {}): Promise<void> {
    await this.draw("rect", target, style);
  }

  private async circle(target: AXNode, style: DrawStyle = {}): Promise<void> {
    await this.draw("circ", target, style);
  }

  private scaledEffectDuration(ms: number): string {
    return String(Math.max(1, Math.round(ms * this.options.pauseScale)));
  }

  private async outline(target: AXSelection, style: OutlineStyle = {}): Promise<void> {
    if (target.isEmpty()) return;
    const args = ["gfx", "outline"];
    if (style.color) args.push("--color", style.color);
    if (style.size != null) args.push("--size", String(style.size));
    if (style.transition) args.push("--transition", style.transition);
    if (style.fill) args.push("--fill", style.fill);
    if (style.durationMs != null) args.push("--duration", this.scaledEffectDuration(style.durationMs));
    args.push("-");
    await this.guiWithInput(target.toPayloadText(), ...args);
  }

  private async scan(target: AXNode | AXSelection, durationMs = 900): Promise<void> {
    const payloadText = target instanceof AXSelection ? target.toPayloadText() : target.rawText;
    if (!payloadText) return;
    await this.guiWithInput(payloadText, "gfx", "scan", "--duration", this.scaledEffectDuration(durationMs), "-");
  }

  private async xray(target: AXNode | AXSelection, durationMs = 1100): Promise<void> {
    const payloadText = target instanceof AXSelection ? target.toPayloadText() : target.rawText;
    if (!payloadText) return;
    await this.guiWithInput(payloadText, "gfx", "xray", "--duration", this.scaledEffectDuration(durationMs), "-");
  }

  private async axQuery(options: AXQueryOptions): Promise<AXSelection> {
    const args = ["ax", "query"];
    if (options.focused) args.push("--focused");
    if (options.all) args.push("--all");
    if (options.pid != null) args.push("--pid", String(options.pid));
    const wantsNdjson = options.ndjson ?? (options.all || options.pid != null);
    const wantsJson = options.json ?? !wantsNdjson;
    if (wantsNdjson) args.push("--ndjson");
    if (wantsJson) args.push("--json");
    if (options.first) args.push("--first");
    args.push(options.query);

    const result = await this.gui(...args);
    if (result.exitCode !== 0) {
      log(`AX query failed for "${options.query}": ${result.stderr || "empty response"}`);
      return new AXSelection([]);
    }
    if (!result.stdout) {
      return new AXSelection([]);
    }

    if (wantsNdjson) {
      const matches: PayloadMatch[] = [];
      for (const line of result.stdout.split("\n").filter((candidate) => candidate.trim().length > 0)) {
        try {
          matches.push({ payload: parseJSON<AXPayload>(line), rawText: line });
        } catch {
          // skip malformed lines
        }
      }
      return AXSelection.fromMatches(matches);
    }

    try {
      return AXSelection.fromMatches([{ payload: parseJSON<AXPayload>(result.stdout), rawText: result.stdout }]);
    } catch {
      log(`AX query parse failed for "${options.query}"`);
      return new AXSelection([]);
    }
  }
}

async function main(): Promise<void> {
  const tour = new DemoScreenTour({
    guiPath: GUI_PATH,
    pauseScale: PAUSE_SCALE,
    maxWindows: MAX_WINDOWS,
    maxControls: MAX_CONTROLS,
    durationSeconds: DURATION_S,
    pointerName: `demo.pointer.${Date.now()}`,
    canvasName: `demo.canvas.${Date.now()}`,
    spotlightName: `demo.spotlight.${Date.now()}`,
    env: process.env,
  });

  process.once("SIGINT", tour.requestInterrupt.bind(tour, "SIGINT"));
  process.once("SIGTERM", tour.requestInterrupt.bind(tour, "SIGTERM"));

  try {
    await tour.run();
  } catch (error) {
    if (isInterruptError(error)) {
      process.exitCode = 130;
      return;
    }
    console.error("Demo tour failed:", error);
    process.exitCode = 1;
  }
}

await main();
