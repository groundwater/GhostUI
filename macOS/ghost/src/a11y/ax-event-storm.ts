#!/usr/bin/env bun
/**
 * AX event storm harness.
 *
 * Spawns N concurrent `gui ax events` listeners, fires multiple concurrent
 * stimulus workers, samples CPU usage, and prints an aggregated JSON summary.
 *
 * Usage:
 *   bun run src/a11y/ax-event-storm.ts
 *   bun run src/a11y/ax-event-storm.ts --listeners 4 --stim tab --stim enter
 *   bun run src/a11y/ax-event-storm.ts --stim type --stim drag --duration 10
 *   bun run src/a11y/ax-event-storm.ts --stim tab --stim enter --stim drag --repeat 50
 */

import { existsSync } from "fs";
import { resolve } from "path";

// -- Types ------------------------------------------------------------------

type StimKind = "tab" | "enter" | "type" | "drag" | "click";

type Options = {
  guiPath: string;
  listeners: number;
  durationS: number;
  warmupMs: number;
  intervalMs: number;
  repeat: number;
  stims: StimKind[];
  text: string;
  pid: string;
  bundle: string;
  cpuIntervalMs: number;
};

interface EvLine {
  type?: string;
  pid?: number;
  bundleId?: string;
  ts?: number;
  [k: string]: unknown;
}

interface CpuSample {
  ts: number;
  entries: { pid: number; name: string; cpu: number }[];
}

interface FrontmostApp {
  pid?: number;
  name?: string;
  bundleId?: string;
}

interface CGWindowEntry {
  pid?: number;
  cgWindowId?: number;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  layer?: number;
  owner?: string;
  title?: string;
}

// -- Help -------------------------------------------------------------------

function usage(): never {
  console.error(
    [
      "ax-event-storm -- multi-listener, multi-stimulus AX stress harness",
      "",
      "Usage:",
      "  bun run src/a11y/ax-event-storm.ts [options]",
      "",
      "Options:",
      "  --gui <path>         Path to gui binary (default: .build/.../gui)",
      "  --listeners <n>      Number of concurrent event listeners (default: 3)",
      "  --duration <s>       Total capture duration in seconds (default: 5)",
      "  --warmup-ms <n>      Delay before stimulus starts in ms (default: 400)",
      "  --interval-ms <n>    Delay between stimulus iterations in ms (default: 30)",
      "  --repeat <n>         Stimulus iteration count per worker (default: 20)",
      "  --stim <kind>        Stimulus kind; repeatable (tab, enter, type, drag, click)",
      "  --text <value>       Text payload for --stim type (default: storm)",
      "  --pid <pid>          Filter events by pid",
      "  --bundle <bundleId>  Filter events by bundle",
      "  --cpu-interval <ms>  CPU sampling interval in ms (default: 500)",
      "  -h, --help           Show this help",
      "",
      "Stimulus kinds:",
      "  tab    -- sends gui cg key tab",
      "  enter  -- sends gui cg key return",
      "  type   -- types --text one char at a time via gui cg key",
      "  drag   -- repeatedly drags the frontmost regular window with gui window drag",
      "  click  -- repeatedly clicks inside the frontmost regular window to trigger temp ancestor observers",
      "",
      "Examples:",
      "  bun run src/a11y/ax-event-storm.ts --stim tab --stim enter --repeat 30",
      "  bun run src/a11y/ax-event-storm.ts --listeners 5 --stim drag --duration 8",
      "  bun run src/a11y/ax-event-storm.ts --stim type --text hello --stim tab",
    ].join("\n"),
  );
  process.exit(1);
}

// -- Arg parsing ------------------------------------------------------------

const VALID_STIMS = new Set<string>(["tab", "enter", "type", "drag", "click"]);

function parseArgs(argv: string[]): Options {
  const defaultGui = resolve(
    import.meta.dir,
    "../../../../.build/GhostUI.app/Contents/MacOS/gui",
  );
  const opts: Options = {
    guiPath: defaultGui,
    listeners: 3,
    durationS: 5,
    warmupMs: 400,
    intervalMs: 30,
    repeat: 20,
    stims: [],
    text: "storm",
    pid: "",
    bundle: "",
    cpuIntervalMs: 500,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--gui":
        opts.guiPath = argv[++i] || usage();
        break;
      case "--listeners":
        opts.listeners = Number(argv[++i]);
        break;
      case "--duration":
        opts.durationS = Number(argv[++i]);
        break;
      case "--warmup-ms":
        opts.warmupMs = Number(argv[++i]);
        break;
      case "--interval-ms":
        opts.intervalMs = Number(argv[++i]);
        break;
      case "--repeat":
        opts.repeat = Number(argv[++i]);
        break;
      case "--stim": {
        const kind = argv[++i];
        if (!kind || !VALID_STIMS.has(kind)) {
          console.error(`Invalid --stim value: ${kind}`);
          usage();
        }
        opts.stims.push(kind as StimKind);
        break;
      }
      case "--text":
        opts.text = argv[++i] || usage();
        break;
      case "--pid":
        opts.pid = argv[++i] || usage();
        break;
      case "--bundle":
        opts.bundle = argv[++i] || usage();
        break;
      case "--cpu-interval":
        opts.cpuIntervalMs = Number(argv[++i]);
        break;
      case "-h":
      case "--help":
        usage();
        break;
      default:
        console.error(`Unknown arg: ${a}`);
        usage();
    }
  }

  if (!Number.isFinite(opts.listeners) || opts.listeners < 1) usage();
  if (!Number.isFinite(opts.durationS) || opts.durationS <= 0) usage();
  if (!Number.isFinite(opts.warmupMs) || opts.warmupMs < 0) usage();
  if (!Number.isFinite(opts.intervalMs) || opts.intervalMs < 0) usage();
  if (!Number.isFinite(opts.repeat) || opts.repeat < 1) usage();
  if (!Number.isFinite(opts.cpuIntervalMs) || opts.cpuIntervalMs < 100) usage();
  if (!existsSync(opts.guiPath)) {
    throw new Error(`gui binary not found: ${opts.guiPath}`);
  }
  if (opts.stims.length === 0) {
    opts.stims = ["tab"];
  }
  return opts;
}

// -- Stream line reader -----------------------------------------------------

async function readLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onLine(line);
    }
  }
  if (buf.trim()) onLine(buf);
}

// -- Counters ---------------------------------------------------------------

const byType = new Map<string, number>();
const byPid = new Map<string, number>();
const byBundle = new Map<string, number>();
const perListener = new Map<number, number>();
let totalEvents = 0;
let parseErrors = 0;

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function record(ev: EvLine, listenerIdx: number): void {
  totalEvents++;
  bump(byType, ev.type ?? "<unknown>");
  if (ev.pid != null) bump(byPid, String(ev.pid));
  if (ev.bundleId) bump(byBundle, ev.bundleId);
  perListener.set(listenerIdx, (perListener.get(listenerIdx) ?? 0) + 1);
}

function sortedEntries(m: Map<string, number>, limit = 15): [string, number][] {
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

// -- Listeners --------------------------------------------------------------

type Listener = {
  proc: ReturnType<typeof Bun.spawn>;
  drainPromise: Promise<void>;
};

async function stopProcess(
  proc: ReturnType<typeof Bun.spawn>,
  graceMs = 1000,
): Promise<void> {
  proc.kill();
  const exited = proc.exited.then(() => true);
  const graceful = await Promise.race([
    exited,
    delay(graceMs).then(() => false),
  ]);
  if (!graceful) {
    proc.kill("SIGKILL");
    await proc.exited;
  }
}

function spawnListener(opts: Options, idx: number): Listener {
  const evArgs = ["ax", "events"];
  if (opts.pid) evArgs.push("--pid", opts.pid);
  if (opts.bundle) evArgs.push("--bundle", opts.bundle);

  const proc = Bun.spawn([opts.guiPath, ...evArgs], {
    stdout: "pipe",
    stderr: "ignore",
  });

  const drainPromise = proc.stdout
    ? readLines(proc.stdout, (line) => {
        if (line.startsWith("[native-ax]")) {
          return;
        }
        try {
          record(JSON.parse(line) as EvLine, idx);
        } catch {
          parseErrors++;
        }
      })
    : Promise.resolve();

  return { proc, drainPromise };
}

// -- Stimulus workers -------------------------------------------------------

const delay = (ms: number) => Bun.sleep(ms);

async function runKey(gui: string, key: string): Promise<void> {
  const p = Bun.spawn([gui, "cg", "key", key], {
    stdout: "ignore",
    stderr: "ignore",
  });
  const code = await p.exited;
  if (code !== 0) {
    throw new Error(`gui cg key ${key} failed with exit code ${code}`);
  }
}

async function runJsonCommand<T>(cmd: string[]): Promise<T> {
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = proc.stdout ? await new Response(proc.stdout).text() : "";
  const stderr = proc.stderr ? await new Response(proc.stderr).text() : "";
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`${cmd.join(" ")} failed with exit code ${code}: ${stderr.trim()}`);
  }
  const clean = stdout
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.startsWith("[native-ax]"))
    .join("\n");
  return JSON.parse(clean) as T;
}

async function pickDragWindow(gui: string): Promise<Required<Pick<CGWindowEntry, "cgWindowId" | "x" | "y" | "w" | "h">>> {
  const frontmost = await runJsonCommand<FrontmostApp>([gui, "ws", "frontmost"]);
  const windows = await runJsonCommand<CGWindowEntry[]>([gui, "cg", "windows"]);
  const frontmostName = frontmost.name?.toLowerCase() ?? "";
  const preferred = windows.find((window) =>
    typeof window.cgWindowId === "number" &&
    typeof window.x === "number" &&
    typeof window.y === "number" &&
    typeof window.w === "number" &&
    typeof window.h === "number" &&
    (window.layer ?? 0) === 0 &&
    (window.owner?.toLowerCase() ?? "") === frontmostName &&
    (window.w ?? 0) >= 200 &&
    (window.h ?? 0) >= 120,
  );
  if (preferred?.cgWindowId !== undefined &&
      preferred.x !== undefined &&
      preferred.y !== undefined &&
      preferred.w !== undefined &&
      preferred.h !== undefined) {
    return preferred as Required<Pick<CGWindowEntry, "cgWindowId" | "x" | "y" | "w" | "h">>;
  }
  throw new Error(`No draggable layer-0 CG window found for frontmost app ${frontmost.name ?? "<unknown>"}`);
}

async function pickClickablePoint(gui: string): Promise<{ x: number; y: number }> {
  const target = await pickDragWindow(gui);
  return {
    x: Math.round(target.x + Math.max(80, target.w * 0.5)),
    y: Math.round(target.y + Math.max(80, target.h * 0.35)),
  };
}

async function stimTab(opts: Options): Promise<number> {
  let fired = 0;
  for (let i = 0; i < opts.repeat; i++) {
    await runKey(opts.guiPath, "tab");
    fired++;
    if (opts.intervalMs > 0 && i + 1 < opts.repeat) await delay(opts.intervalMs);
  }
  return fired;
}

async function stimEnter(opts: Options): Promise<number> {
  let fired = 0;
  for (let i = 0; i < opts.repeat; i++) {
    await runKey(opts.guiPath, "return");
    fired++;
    if (opts.intervalMs > 0 && i + 1 < opts.repeat) await delay(opts.intervalMs);
  }
  return fired;
}

async function stimType(opts: Options): Promise<number> {
  let fired = 0;
  const chars = opts.text.split("");
  for (let round = 0; round < opts.repeat; round++) {
    for (const ch of chars) {
      await runKey(opts.guiPath, ch);
      fired++;
    }
    if (opts.intervalMs > 0 && round + 1 < opts.repeat)
      await delay(opts.intervalMs);
  }
  return fired;
}

async function stimDrag(opts: Options): Promise<number> {
  const target = await pickDragWindow(opts.guiPath);
  let fired = 0;
  const path: Array<[number, number]> = [
    [Math.round(target.x + 40), Math.round(target.y + 40)],
    [Math.round(target.x + Math.max(60, target.w - 80)), Math.round(target.y + 50)],
    [Math.round(target.x + 60), Math.round(target.y + Math.max(80, target.h - 80))],
    [Math.round(target.x + Math.max(80, target.w - 100)), Math.round(target.y + Math.max(100, target.h - 90))],
  ];
  for (let round = 0; round < opts.repeat; round++) {
    for (const [toX, toY] of path) {
      const p = Bun.spawn(
        [opts.guiPath, "window", "drag", String(target.cgWindowId), String(toX), String(toY)],
        { stdout: "ignore", stderr: "ignore" },
      );
      const code = await p.exited;
      if (code !== 0) {
        throw new Error(`gui window drag failed with exit code ${code}`);
      }
      fired++;
      await delay(20);
    }
    if (opts.intervalMs > 0 && round + 1 < opts.repeat)
      await delay(opts.intervalMs);
  }
  return fired;
}

async function stimClick(opts: Options): Promise<number> {
  const point = await pickClickablePoint(opts.guiPath);
  let fired = 0;
  for (let i = 0; i < opts.repeat; i++) {
    const p = Bun.spawn(
      [opts.guiPath, "cg", "click", String(point.x), String(point.y)],
      { stdout: "ignore", stderr: "ignore" },
    );
    const code = await p.exited;
    if (code !== 0) {
      throw new Error(`gui cg click failed with exit code ${code}`);
    }
    fired++;
    if (opts.intervalMs > 0 && i + 1 < opts.repeat) await delay(opts.intervalMs);
  }
  return fired;
}

async function runStim(
  kind: StimKind,
  opts: Options,
): Promise<{ kind: string; actions: number }> {
  let actions: number;
  switch (kind) {
    case "tab":
      actions = await stimTab(opts);
      break;
    case "enter":
      actions = await stimEnter(opts);
      break;
    case "type":
      actions = await stimType(opts);
      break;
    case "drag":
      actions = await stimDrag(opts);
      break;
    case "click":
      actions = await stimClick(opts);
      break;
    default:
      throw new Error(`Unknown stim kind: ${kind}`);
  }
  return { kind, actions };
}

// -- CPU sampling -----------------------------------------------------------

const cpuSamples: CpuSample[] = [];

async function sampleCpu(): Promise<CpuSample> {
  // ps aux for GhostUI, gui, and bun processes
  const proc = Bun.spawn(
    [
      "/bin/ps",
      "-eo",
      "pid,pcpu,comm",
    ],
    { stdout: "pipe", stderr: "ignore" },
  );
  const raw = await new Response(proc.stdout).text();
  await proc.exited;

  const entries: CpuSample["entries"] = [];
  const interesting = ["ghostui", "gui", "bun", "node"];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("PID")) continue;
    const parts = trimmed.split(/\s+/, 3);
    if (parts.length < 3) continue;
    const pid = Number(parts[0]);
    const cpu = Number(parts[1]);
    const comm = parts[2].toLowerCase();
    const basename = comm.split("/").pop() ?? comm;
    if (interesting.some((pat) => basename.includes(pat))) {
      entries.push({ pid, name: parts[2], cpu });
    }
  }
  return { ts: Date.now(), entries };
}

// -- Main -------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  console.error(
    `[storm] listeners=${opts.listeners} stims=[${opts.stims.join(",")}] ` +
      `repeat=${opts.repeat} duration=${opts.durationS}s`,
  );

  // 1) Spawn N listeners
  const listeners: Listener[] = [];
  for (let i = 0; i < opts.listeners; i++) {
    listeners.push(spawnListener(opts, i));
  }

  // 2) CPU sampler
  let cpuRunning = true;
  const cpuLoop = (async () => {
    while (cpuRunning) {
      try {
        cpuSamples.push(await sampleCpu());
      } catch {
        // ignore transient ps failures
      }
      await delay(opts.cpuIntervalMs);
    }
  })();

  // 3) Run stimulus with guaranteed teardown
  let stimResults: { kind: string; actions: number }[] = [];
  let stimElapsedMs = 0;
  let measureEnd = 0;
  let runError: string | undefined;
  const runStart = performance.now();
  let stimulusStart = 0;

  try {
    await delay(opts.warmupMs);
    stimulusStart = performance.now();

    console.error(`[storm] firing ${opts.stims.length} stimulus worker(s)...`);

    stimResults = await Promise.all(
      opts.stims.map((kind) => runStim(kind, opts)),
    );

    stimElapsedMs = performance.now() - stimulusStart;
    console.error(
      `[storm] stimuli done in ${(stimElapsedMs / 1000).toFixed(2)}s`,
    );

    const totalMs = opts.durationS * 1000;
    const elapsed = performance.now() - runStart;
    const remaining = Math.max(0, totalMs - elapsed);
    if (remaining > 0) {
      console.error(
        `[storm] draining for ${(remaining / 1000).toFixed(1)}s...`,
      );
      await delay(remaining);
    }
    measureEnd = performance.now();
  } catch (error) {
    measureEnd = performance.now();
    if (stimulusStart > 0 && stimElapsedMs === 0) {
      stimElapsedMs = measureEnd - stimulusStart;
    }
    runError = error instanceof Error ? error.message : String(error);
  } finally {
    cpuRunning = false;
    await cpuLoop;

    for (const l of listeners) {
      await stopProcess(l.proc);
    }
    await Promise.all(listeners.map((l) => l.drainPromise.catch(() => {})));
  }

  // 7) Aggregate CPU stats
  const cpuByProcess = new Map<string, { samples: number; totalCpu: number }>();
  for (const sample of cpuSamples) {
    for (const entry of sample.entries) {
      const key = `${entry.name}[${entry.pid}]`;
      const prev = cpuByProcess.get(key) ?? { samples: 0, totalCpu: 0 };
      prev.samples++;
      prev.totalCpu += entry.cpu;
      cpuByProcess.set(key, prev);
    }
  }
  const totalCpuSamples = cpuSamples.length;
  const cpuSummary = [...cpuByProcess.entries()]
    .map(([name, s]) => ({
      process: name,
      activeSamples: s.samples,
      totalSamples: totalCpuSamples,
      avgCpu: totalCpuSamples > 0
        ? Number((s.totalCpu / totalCpuSamples).toFixed(1))
        : 0,
      peakCpu: 0 as number, // filled below
    }))
    .sort((a, b) => b.avgCpu - a.avgCpu)
    .slice(0, 10);

  // Fill peak CPU
  for (const entry of cpuSummary) {
    let peak = 0;
    for (const sample of cpuSamples) {
      for (const e of sample.entries) {
        const key = `${e.name}[${e.pid}]`;
        if (key === entry.process && e.cpu > peak) peak = e.cpu;
      }
    }
    entry.peakCpu = peak;
  }

  // 8) Build per-listener breakdown
  const listenerBreakdown: { listener: number; events: number }[] = [];
  for (let i = 0; i < opts.listeners; i++) {
    listenerBreakdown.push({ listener: i, events: perListener.get(i) ?? 0 });
  }

  // 9) JSON summary
  const wallS = (measureEnd - runStart) / 1000;
  const summary = {
    config: {
      guiPath: opts.guiPath,
      listeners: opts.listeners,
      stims: opts.stims,
      repeat: opts.repeat,
      intervalMs: opts.intervalMs,
      durationS: opts.durationS,
      warmupMs: opts.warmupMs,
      text: opts.stims.includes("type") ? opts.text : undefined,
    },
    timing: {
      wallSeconds: Number(wallS.toFixed(2)),
      stimulusMs: Number(stimElapsedMs.toFixed(0)),
      cpuSamples: cpuSamples.length,
    },
    events: {
      totalDelivered: totalEvents,
      listenerCount: opts.listeners,
      perListenerAvg: opts.listeners > 0
        ? Number((totalEvents / opts.listeners).toFixed(1))
        : 0,
      parseErrors,
      deliveredPerSecond: wallS > 0 ? Number((totalEvents / wallS).toFixed(1)) : 0,
      perListener: listenerBreakdown,
    },
    stimulus: stimResults,
    topEventTypes: sortedEntries(byType),
    topPids: sortedEntries(byPid),
    topBundles: sortedEntries(byBundle),
    cpu: cpuSummary,
    error: runError,
  };

  console.log(JSON.stringify(summary, null, 2));
}

await main();
