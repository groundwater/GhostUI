#!/usr/bin/env bun
/**
 * demo-screen-tour.ts — Live screen-tour runner using pointer + canvas actors.
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

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let activeGuiProc: Bun.Subprocess | null = null;
let interruptReject: ((error: Error) => void) | null = null;
const interruptPromise = new Promise<never>((_, reject) => {
  interruptReject = reject;
});

function interruptError(): Error {
  return new Error(INTERRUPT_ERROR_MESSAGE);
}

function isInterruptError(error: unknown): boolean {
  return error instanceof Error && error.message === INTERRUPT_ERROR_MESSAGE;
}

function requestInterrupt(signal: "SIGINT" | "SIGTERM"): void {
  log(`${signal} received; stopping the tour and cleaning up actors.`);
  activeGuiProc?.kill();
  activeGuiProc = null;
  interruptReject?.(interruptError());
  interruptReject = null;
}

process.once("SIGINT", () => requestInterrupt("SIGINT"));
process.once("SIGTERM", () => requestInterrupt("SIGTERM"));

function sleep(ms: number): Promise<void> {
  return Promise.race([
    new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms * PAUSE_SCALE))),
    interruptPromise,
  ]);
}

interface GuiResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function guiWithInput(stdinText: string, ...args: string[]): Promise<GuiResult> {
  const proc = Bun.spawn({
    cmd: [GUI_PATH, ...args],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  activeGuiProc = proc;
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
      interruptPromise,
    ]);
    return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
  } finally {
    if (activeGuiProc === proc) {
      activeGuiProc = null;
    }
  }
}

async function gui(...args: string[]): Promise<GuiResult> {
  return guiWithInput("", ...args);
}

function parseJSON<T>(text: string): T {
  return JSON.parse(text) as T;
}

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

// ---------------------------------------------------------------------------
// AX query types (minimal subset)
// ---------------------------------------------------------------------------

interface AXTarget {
  type: "ax.target";
  pid: number;
  point: { x: number; y: number };
  bounds?: { x: number; y: number; width: number; height: number };
  role: string;
  subrole?: string | null;
  title?: string | null;
  label?: string | null;
}

interface AXPayload {
  type: "gui.payload";
  target?: AXTarget;
  bounds?: { x: number; y: number; width: number; height: number };
  point?: { x: number; y: number };
  node?: { _tag?: string; _id?: string; _displayName?: string };
}

interface PayloadMatch {
  payload: AXPayload;
  rawText: string;
}

function payloadBox(payload: AXPayload): { x: number; y: number; width: number; height: number } | null {
  return payload.target?.bounds ?? payload.bounds ?? null;
}

function sameBounds(
  left: AXPayload["bounds"] | undefined,
  right: AXPayload["bounds"] | undefined,
): boolean {
  if (!left || !right) return false;
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}

// ---------------------------------------------------------------------------
// Actor management
// ---------------------------------------------------------------------------

const POINTER_NAME = `demo.pointer.${Date.now()}`;
const CANVAS_NAME = `demo.canvas.${Date.now()}`;

async function spawnActors(): Promise<void> {
  const pRes = await gui("actor", "spawn", "pointer", POINTER_NAME);
  if (pRes.exitCode !== 0) throw new Error(`Failed to spawn pointer: ${pRes.stderr}`);
  log(`Spawned pointer actor: ${POINTER_NAME}`);

  const cRes = await gui("actor", "spawn", "canvas", CANVAS_NAME);
  if (cRes.exitCode !== 0) throw new Error(`Failed to spawn canvas: ${cRes.stderr}`);
  log(`Spawned canvas actor: ${CANVAS_NAME}`);
}

async function killActors(): Promise<void> {
  log("Cleaning up actors...");
  await gui("actor", "kill", POINTER_NAME).catch(() => {});
  await gui("actor", "kill", CANVAS_NAME).catch(() => {});
  log("Actors cleaned up.");
}

// ---------------------------------------------------------------------------
// Actor action wrappers
// ---------------------------------------------------------------------------

async function pointerMove(x: number, y: number, style: string = "purposeful"): Promise<void> {
  await gui("actor", "run", `${POINTER_NAME}.move`, "--to", String(Math.round(x)), String(Math.round(y)), "--style", style);
}

async function pointerClick(x: number, y: number): Promise<void> {
  await gui("actor", "run", `${POINTER_NAME}.click`, "--at", String(Math.round(x)), String(Math.round(y)));
}

async function pointerNarrate(text: string): Promise<void> {
  await gui("actor", "run", `${POINTER_NAME}.narrate`, "--text", text);
}

async function pointerThink(ms: number): Promise<void> {
  await gui("actor", "run", `${POINTER_NAME}.think`, "--for", String(Math.round(ms * PAUSE_SCALE)));
}

async function pointerDismiss(): Promise<void> {
  await gui("actor", "run", `${POINTER_NAME}.dismiss`);
}

async function canvasDraw(
  shape: string,
  box: { x: number; y: number; width: number; height: number },
  opts: { padding?: number; size?: number; color?: string } = {},
): Promise<void> {
  const args = [
    "actor", "run", `${CANVAS_NAME}.draw`, shape,
    "--box", String(Math.round(box.x)), String(Math.round(box.y)),
    String(Math.round(box.width)), String(Math.round(box.height)),
  ];
  if (opts.padding != null) args.push("--padding", String(opts.padding));
  if (opts.size != null) args.push("--size", String(opts.size));
  if (opts.color) args.push("--color", opts.color);
  await gui(...args);
}

async function canvasDrawFromPayload(
  shape: string,
  payloadText: string,
  opts: { padding?: number; size?: number; color?: string } = {},
): Promise<void> {
  const args = ["actor", "run", `${CANVAS_NAME}.draw`, shape, "-"];
  if (opts.padding != null) args.push("--padding", String(opts.padding));
  if (opts.size != null) args.push("--size", String(opts.size));
  if (opts.color) args.push("--color", opts.color);
  await guiWithInput(payloadText, ...args);
}

async function canvasText(
  text: string,
  box: { x: number; y: number; width: number; height: number },
  opts: { font?: string; size?: number; color?: string; highlight?: string } = {},
): Promise<void> {
  const args = [
    "actor", "run", `${CANVAS_NAME}.text`, text, "literal",
    "--box", String(Math.round(box.x)), String(Math.round(box.y)),
    String(Math.round(box.width)), String(Math.round(box.height)),
  ];
  if (opts.font) args.push("--font", opts.font);
  if (opts.size != null) args.push("--size", String(opts.size));
  if (opts.color) args.push("--color", opts.color);
  if (opts.highlight) args.push("--highlight", opts.highlight);
  await gui(...args);
}

async function canvasClear(): Promise<void> {
  await gui("actor", "run", `${CANVAS_NAME}.clear`);
}

function scaledEffectDuration(ms: number): string {
  return String(Math.max(1, Math.round(ms * PAUSE_SCALE)));
}

async function discoverForegroundWindow(): Promise<PayloadMatch | null> {
  const res = await gui("ax", "query", "--focused", "--json", "--first", "Window[frame]");
  if (res.exitCode !== 0 || !res.stdout) {
    log(`Foreground window discovery failed: ${res.stderr || "empty response"}`);
    return null;
  }
  try {
    const payload = parseJSON<AXPayload>(res.stdout);
    if (payload.bounds && payload.bounds.width > 50 && payload.bounds.height > 50) {
      return { payload, rawText: res.stdout };
    }
  } catch {
    // ignored
  }
  return null;
}

async function discoverWindows(): Promise<PayloadMatch[]> {
  const windows: PayloadMatch[] = [];
  const focused = await discoverForegroundWindow();
  if (focused) {
    windows.push(focused);
  }

  const res = await gui("ax", "query", "--all", "--ndjson", "--each", "Application { Window[frame] }");
  if (res.exitCode !== 0) {
    log(`Background window discovery failed: ${res.stderr}`);
    return windows;
  }

  const lines = res.stdout.split("\n").filter((l) => l.trim().length > 0);
  for (const line of lines) {
    try {
      const payload = parseJSON<AXPayload>(line);
      if (!payload.bounds || payload.bounds.width <= 50 || payload.bounds.height <= 50) {
        continue;
      }
      if (windows.some((candidate) =>
        candidate.payload.target?.pid === payload.target?.pid && sameBounds(candidate.payload.bounds, payload.bounds)
      )) {
        continue;
      }
      windows.push({ payload, rawText: line });
    } catch {
      // skip malformed lines
    }
  }
  return windows;
}

interface ControlInfo {
  payload: AXPayload;
  rawText: string;
  kind: string;
  label: string;
}

function humanizeRole(role: string | undefined): string {
  const cleaned = (role ?? "").replace(/^AX/, "");
  if (!cleaned) return "control";
  return cleaned.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
}

function buildControlInfo(payload: AXPayload, rawText: string, fallbackKind: string): ControlInfo {
  const kind = humanizeRole(payload.target?.role || payload.node?._tag) || fallbackKind;
  const label =
    payload.target?.title ||
    payload.target?.label ||
    payload.node?._displayName ||
    payload.node?._id ||
    kind ||
    fallbackKind;
  return { payload, rawText, kind: kind || fallbackKind, label };
}

function controlKey(payload: AXPayload): string {
  const bounds = payloadBox(payload);
  const role = payload.target?.role || payload.node?._tag || "";
  const label = payload.target?.title || payload.target?.label || payload.node?._displayName || payload.node?._id || "";
  if (!bounds) {
    return `${payload.target?.pid ?? "?"}:${role}:${label}`;
  }
  return [
    payload.target?.pid ?? "?",
    role,
    label,
    bounds.x,
    bounds.y,
    bounds.width,
    bounds.height,
  ].join(":");
}

async function discoverTargets(
  pid: number,
  query: string,
  windowBounds: { x: number; y: number; width: number; height: number },
  fallbackKind: string,
  limit: number = MAX_CONTROLS,
): Promise<ControlInfo[]> {
  const controls: ControlInfo[] = [];
  const seen = new Set<string>();
  const res = await gui("ax", "query", "--pid", String(pid), "--ndjson", "--each", query);
  if (res.exitCode !== 0) {
    log(`AX discovery failed for "${query}": ${res.stderr || "empty response"}`);
    return controls;
  }
  const lines = res.stdout.split("\n").filter((l) => l.trim().length > 0);
  for (const line of lines) {
    if (controls.length >= limit) break;
    try {
      const payload = parseJSON<AXPayload>(line);
      const controlBox = payloadBox(payload);
      if (!controlBox || controlBox.width < 10 || controlBox.height < 10) continue;
      if (!boundsContainedIn(controlBox, windowBounds)) continue;
      const key = controlKey(payload);
      if (seen.has(key)) continue;
      seen.add(key);
      controls.push(buildControlInfo(payload, line, fallbackKind));
    } catch {
      // skip malformed lines
    }
  }
  return controls;
}

async function discoverButtons(
  pid: number,
  windowBounds: { x: number; y: number; width: number; height: number },
): Promise<ControlInfo[]> {
  return discoverTargets(pid, "Button[frame]", windowBounds, "button");
}

async function discoverActionControls(
  pid: number,
  windowBounds: { x: number; y: number; width: number; height: number },
): Promise<ControlInfo[]> {
  return discoverTargets(pid, "*[actions,frame,title,label]", windowBounds, "action control");
}

// ---------------------------------------------------------------------------
// Narration helpers
// ---------------------------------------------------------------------------

function describeWindow(payload: AXPayload): string {
  const title = payload.target?.title || payload.node?._displayName || payload.node?._id || "unnamed window";
  const role = payload.target?.role || payload.node?._tag || "Window";
  if (role === "AXWindow") return title;
  return `${title} (${role})`;
}

function describeControl(ctrl: ControlInfo): string {
  if (ctrl.label && ctrl.label !== ctrl.kind) {
    return `${ctrl.kind} "${ctrl.label}"`;
  }
  return ctrl.kind;
}

function boxCenter(b: { x: number; y: number; width: number; height: number }): { x: number; y: number } {
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

function titleBarBox(b: { x: number; y: number; width: number; height: number }): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  return {
    x: b.x + 12,
    y: b.y + 8,
    width: Math.max(120, b.width - 24),
    height: Math.min(42, Math.max(24, Math.round(b.height * 0.1))),
  };
}

function boundsContainedIn(
  inner: { x: number; y: number; width: number; height: number },
  outer: { x: number; y: number; width: number; height: number },
  tolerance = 12,
): boolean {
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

function circleBoxForBounds(
  bounds: { x: number; y: number; width: number; height: number },
  padding = 12,
): { x: number; y: number; width: number; height: number } {
  const center = boxCenter(bounds);
  const diameter = Math.max(bounds.width, bounds.height) + padding;
  return {
    x: center.x - diameter / 2,
    y: center.y - diameter / 2,
    width: diameter,
    height: diameter,
  };
}

function captionBoxForBounds(
  bounds: { x: number; y: number; width: number; height: number },
  opts: { preferredWidth?: number; yOffset?: number } = {},
): { x: number; y: number; width: number; height: number } {
  const preferredWidth = opts.preferredWidth ?? 420;
  const width = Math.max(260, Math.min(preferredWidth, Math.max(bounds.width, 260)));
  const height = 42;
  const x = bounds.x + Math.max(0, (bounds.width - width) / 2);
  const y = Math.max(0, bounds.y - height - (opts.yOffset ?? 12));
  return { x, y, width, height };
}

async function gfxOutlineFromPayload(payloadText: string): Promise<void> {
  await guiWithInput(payloadText, "gfx", "outline", "-");
}

async function gfxScanFromPayload(payloadText: string, durationMs = 900): Promise<void> {
  await guiWithInput(payloadText, "gfx", "scan", "--duration", scaledEffectDuration(durationMs), "-");
}

async function gfxXrayFromPayload(payloadText: string, durationMs = 1100): Promise<void> {
  await guiWithInput(payloadText, "gfx", "xray", "--duration", scaledEffectDuration(durationMs), "-");
}

function joinPayloadLines(items: Array<{ rawText: string }>): string {
  return items.map((item) => item.rawText).join("\n");
}

async function highlightWindowTitle(windowMatch: PayloadMatch): Promise<void> {
  await canvasDrawFromPayload("underline", windowMatch.rawText, {
    padding: 2,
    size: 5,
    color: "rgba(59,130,246,0.85)",
  });
}

// ---------------------------------------------------------------------------
// Tour phases
// ---------------------------------------------------------------------------

async function introPhase(): Promise<void> {
  log("Starting intro phase");
  await pointerNarrate("Welcome to the GhostUI screen tour!");
  await sleep(2000);
  await pointerNarrate("I'll start with the foreground window, then fan out to the rest of the screen.");
  await sleep(2500);
  await pointerDismiss();
  await sleep(500);
}

async function beatSingleButton(button: ControlInfo, _title: string): Promise<void> {
  const bounds = payloadBox(button.payload);
  if (!bounds) return;
  const center = boxCenter(bounds);
  await canvasClear();
  await canvasDrawFromPayload("circ", button.rawText, {
    padding: 8,
    size: 4,
    color: "rgba(255,59,48,0.72)",
  });
  await pointerMove(center.x, center.y, "purposeful");
  await sleep(300);
  await pointerNarrate(`I can click this ${describeControl(button)}. This is visual-only, no real input is sent.`);
  await sleep(1800);
  await pointerClick(center.x, center.y);
  await sleep(900);
  await pointerDismiss();
}

async function beatAllButtons(buttons: ControlInfo[]): Promise<void> {
  if (buttons.length === 0) return;
  await canvasClear();
  await gfxOutlineFromPayload(joinPayloadLines(buttons));
  const anchor = payloadBox(buttons[0].payload);
  if (anchor) {
    const center = boxCenter(anchor);
    await pointerMove(center.x, center.y, "purposeful");
    await sleep(250);
  }
  await pointerNarrate("I can click ANY of these buttons. The outlines show every button I found in this window.");
  await sleep(2200);
  await pointerDismiss();
}

async function beatNoButtons(): Promise<void> {
  await canvasClear();
  await pointerNarrate("I don't see any buttons here, so I'll skip the click demo and keep scanning.");
  await sleep(1800);
  await pointerDismiss();
}

async function beatScanDeeper(windowMatch: PayloadMatch): Promise<void> {
  await canvasClear();
  await pointerNarrate("Hmm... let me scan deeper");
  await gfxScanFromPayload(windowMatch.rawText, 900);
  await gfxXrayFromPayload(windowMatch.rawText, 1100);
  await sleep(250);
  await pointerDismiss();
}

async function beatActionDiscovery(actionControls: ControlInfo[]): Promise<void> {
  await canvasClear();
  if (actionControls.length === 0) {
    await pointerNarrate("Searching by actions did not reveal any additional controls in this window.");
    await sleep(1800);
    await pointerDismiss();
    return;
  }

  await gfxOutlineFromPayload(joinPayloadLines(actionControls));
  const anchor = payloadBox(actionControls[0].payload);
  if (anchor) {
    const center = boxCenter(anchor);
    await pointerMove(center.x, center.y, "purposeful");
    await sleep(250);
  }
  await pointerNarrate(
    `There are also controls here. I searched by actions and outlined all ${actionControls.length} of them without sending real input.`,
  );
  await sleep(2200);
  await pointerDismiss();
}

async function tourWindow(windowMatch: PayloadMatch, index: number, total: number): Promise<void> {
  const payload = windowMatch.payload;
  const bounds = payload.bounds!;
  const title = describeWindow(payload);
  const pid = payload.target?.pid;
  const titleBar = titleBarBox(bounds);

  log(`Touring window ${index + 1}/${total}: ${title}`);

  await pointerMove(titleBar.x + titleBar.width / 2, titleBar.y + titleBar.height / 2, "purposeful");
  await sleep(400);
  await canvasClear();
  await highlightWindowTitle(windowMatch);
  await pointerNarrate(`Starting with the foreground window. This is "${title}".`);
  await sleep(3000);
  await pointerDismiss();
  await sleep(300);

  if (!pid) {
    await pointerNarrate("I can't resolve a live process for this window, so I'll move on.");
    await sleep(1800);
    await pointerDismiss();
    await canvasClear();
    await sleep(500);
    return;
  }

  const buttons = await discoverButtons(pid, bounds);
  const buttonKeys = new Set(buttons.map((button) => controlKey(button.payload)));
  const additionalActionControls = (await discoverActionControls(pid, bounds))
    .filter((control) => !buttonKeys.has(controlKey(control.payload)));
  if (buttons.length > 0) {
    await beatSingleButton(buttons[0], title);
    await sleep(250);
    await beatAllButtons(buttons);
  } else {
    await beatNoButtons();
  }

  await sleep(250);
  await beatScanDeeper(windowMatch);
  await sleep(250);
  await beatActionDiscovery(additionalActionControls);

  await canvasClear();
  await sleep(500);
}

async function outroPhase(windowCount: number): Promise<void> {
  log("Starting outro phase");
  await pointerNarrate(`Tour complete! I visited ${windowCount} window${windowCount !== 1 ? "s" : ""} on this screen.`);
  await sleep(3000);
  await pointerNarrate("Thanks for watching the GhostUI screen tour.");
  await sleep(2000);
  await pointerDismiss();
  await sleep(500);
}

// ---------------------------------------------------------------------------
// Main tour loop
// ---------------------------------------------------------------------------

async function runTour(): Promise<void> {
  const startTime = Date.now();
  const maxDurationMs = DURATION_S * 1000;

  log(`Demo config: PAUSE_SCALE=${PAUSE_SCALE}, MAX_WINDOWS=${MAX_WINDOWS || "unlimited"}, MAX_CONTROLS=${MAX_CONTROLS}, DURATION_S=${DURATION_S}`);

  await spawnActors();

  try {
    await introPhase();

    // Discover windows
    const allWindows = await discoverWindows();
    if (allWindows.length === 0) {
      log("No windows discovered. Ending tour early.");
      await pointerNarrate("I couldn't find any windows to tour. Make sure some apps are open!");
      await sleep(2000);
      await pointerDismiss();
      return;
    }

    log(`Discovered ${allWindows.length} window(s)`);

    // Apply max-windows limit
    const windows = MAX_WINDOWS > 0 ? allWindows.slice(0, MAX_WINDOWS) : allWindows;

    // Tour each window, respecting duration limit
    let toured = 0;
    for (let i = 0; i < windows.length; i++) {
      const elapsed = Date.now() - startTime;
      if (elapsed > maxDurationMs) {
        log(`Duration limit reached (${DURATION_S}s). Stopping after ${toured} windows.`);
        break;
      }
      await tourWindow(windows[i], i, windows.length);
      toured++;
    }

    await outroPhase(toured);
  } finally {
    await killActors();
  }

  const totalSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
  log(`Demo finished in ${totalSeconds}s`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  try {
    await runTour();
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
