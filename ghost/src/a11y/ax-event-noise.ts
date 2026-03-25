import { existsSync } from "fs";
import { resolve } from "path";

type Options = {
  guiPath: string;
  durationMs: number;
  intervalMs: number;
  repeat: number;
  warmupMs: number;
  mode?: string;
  text?: string;
  stimulus?: string;
  eventArgs: string[];
};

type EventSample = {
  type?: string;
  pid?: number;
  bundleId?: string;
};

function usage(): never {
  console.error([
    "Usage:",
    "  bun run src/a11y/ax-event-noise.ts [options]",
    "",
    "Options:",
    "  --gui <path>            Path to gui binary",
    "  --duration-ms <n>       Total capture duration (default 2000)",
    "  --warmup-ms <n>         Delay before stimulus starts (default 250)",
    "  --interval-ms <n>       Delay between stimulus iterations (default 25)",
    "  --repeat <n>            Stimulus iteration count (default 25)",
    "  --mode <tab|enter|type> Built-in stimulus mode",
    "  --text <value>          Text payload for --mode type",
    "  --stimulus <command>    Arbitrary shell command to run per iteration",
    "  --pid <pid>             Forwarded to `gui ax events`",
    "  --bundle <bundleId>     Forwarded to `gui ax events`",
    "",
    "Examples:",
    "  bun run src/a11y/ax-event-noise.ts --mode tab --repeat 100",
    "  bun run src/a11y/ax-event-noise.ts --mode type --text hello --repeat 20",
    "  bun run src/a11y/ax-event-noise.ts --stimulus '.build/GhostUI.app/Contents/MacOS/gui cg key tab' --repeat 100",
  ].join("\n"));
  process.exit(1);
}

function parseArgs(argv: string[]): Options {
  const defaultGui = resolve(import.meta.dir, "../../../.build/GhostUI.app/Contents/MacOS/gui");
  const options: Options = {
    guiPath: defaultGui,
    durationMs: 2000,
    intervalMs: 25,
    repeat: 25,
    warmupMs: 250,
    eventArgs: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--gui":
        options.guiPath = argv[++i] || usage();
        break;
      case "--duration-ms":
        options.durationMs = Number(argv[++i]);
        break;
      case "--warmup-ms":
        options.warmupMs = Number(argv[++i]);
        break;
      case "--interval-ms":
        options.intervalMs = Number(argv[++i]);
        break;
      case "--repeat":
        options.repeat = Number(argv[++i]);
        break;
      case "--mode":
        options.mode = argv[++i] || usage();
        break;
      case "--text":
        options.text = argv[++i] || usage();
        break;
      case "--stimulus":
        options.stimulus = argv[++i] || usage();
        break;
      case "--pid":
      case "--bundle":
        options.eventArgs.push(arg, argv[++i] || usage());
        break;
      case "-h":
      case "--help":
        usage();
        break;
      default:
        console.error(`Unknown arg: ${arg}`);
        usage();
    }
  }

  if (!Number.isFinite(options.durationMs) || options.durationMs <= 0) usage();
  if (!Number.isFinite(options.warmupMs) || options.warmupMs < 0) usage();
  if (!Number.isFinite(options.intervalMs) || options.intervalMs < 0) usage();
  if (!Number.isFinite(options.repeat) || options.repeat < 0) usage();
  if (!existsSync(options.guiPath)) {
    throw new Error(`gui binary not found: ${options.guiPath}`);
  }
  if (!options.mode && !options.stimulus) {
    options.mode = "tab";
  }
  if (options.mode === "type" && !options.text) {
    options.text = "noise";
  }
  return options;
}

function builtInStimulus(options: Options): string[] {
  switch (options.mode) {
    case "tab":
      return [options.guiPath, "cg", "key", "tab"];
    case "enter":
      return [options.guiPath, "cg", "key", "return"];
    case "type":
      return [options.guiPath, "cg", "key", options.text || "noise"];
    default:
      throw new Error(`Unknown built-in mode: ${options.mode}`);
  }
}

async function runStimulusOnce(options: Options): Promise<void> {
  if (options.stimulus) {
    const proc = Bun.spawn(["/bin/zsh", "-lc", options.stimulus], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const code = await proc.exited;
    if (code !== 0) {
      throw new Error(`Stimulus command failed with exit code ${code}`);
    }
    return;
  }

  const proc = Bun.spawn(builtInStimulus(options), {
    stdout: "ignore",
    stderr: "ignore",
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`Built-in stimulus failed with exit code ${code}`);
  }
}

async function sleep(ms: number): Promise<void> {
  await Bun.sleep(ms);
}

async function readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line.trim()) onLine(line);
    }
  }
  if (buffer.trim()) onLine(buffer);
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) || 0) + 1);
}

function topEntries(map: Map<string, number>, limit = 10): Array<[string, number]> {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const eventCounts = new Map<string, number>();
  const pidCounts = new Map<string, number>();
  const bundleCounts = new Map<string, number>();
  let totalEvents = 0;
  let malformedLines = 0;

  const eventsProc = Bun.spawn([options.guiPath, "ax", "events", ...options.eventArgs], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdoutTask = eventsProc.stdout
    ? readLines(eventsProc.stdout, (line) => {
      try {
        const sample = JSON.parse(line) as EventSample;
        totalEvents += 1;
        bump(eventCounts, sample.type || "<unknown>");
        if (sample.pid !== undefined) bump(pidCounts, String(sample.pid));
        if (sample.bundleId) bump(bundleCounts, sample.bundleId);
      } catch {
        malformedLines += 1;
      }
    })
    : Promise.resolve();

  const stderrTask = eventsProc.stderr
    ? new Response(eventsProc.stderr).text()
    : Promise.resolve("");

  await sleep(options.warmupMs);
  const start = performance.now();

  for (let i = 0; i < options.repeat; i += 1) {
    await runStimulusOnce(options);
    if (options.intervalMs > 0 && i + 1 < options.repeat) {
      await sleep(options.intervalMs);
    }
  }

  const elapsedDuringStimulus = performance.now() - start;
  const remaining = Math.max(0, options.durationMs - options.warmupMs - elapsedDuringStimulus);
  if (remaining > 0) {
    await sleep(remaining);
  }

  eventsProc.kill();
  await eventsProc.exited;
  await stdoutTask;
  const stderr = await stderrTask;

  const captureSeconds = options.durationMs / 1000;
  console.log(JSON.stringify({
    guiPath: options.guiPath,
    mode: options.mode || null,
    stimulus: options.stimulus || null,
    repeat: options.repeat,
    intervalMs: options.intervalMs,
    durationMs: options.durationMs,
    totalEvents,
    malformedLines,
    eventsPerSecond: Number((totalEvents / captureSeconds).toFixed(2)),
    topEventTypes: topEntries(eventCounts),
    topPids: topEntries(pidCounts),
    topBundles: topEntries(bundleCounts),
    stderr: stderr.trim() || undefined,
  }, null, 2));
}

await main();
