import { resolve } from "node:path";

type BenchmarkMode = "app" | "windows" | "focused";

interface NativeBenchResult {
  pid: number;
  mode: BenchmarkMode;
  iterations: number;
  createObserverMs: number;
  addNotificationsMs: number;
  removeNotificationsMs: number;
  totalRegistrations: number;
  successCount: number;
  failureCount: number;
  failuresByCode: Record<string, number>;
  targetCount: number;
}

interface NativeBenchApi {
  axBenchmarkObserverNotifications(opts: {
    pid: number;
    iterations?: number;
    mode?: BenchmarkMode;
  }): NativeBenchResult;
  axGetFrontmostPid?(): number;
}

function loadNativeModule(): NativeBenchApi {
  const candidates = [
    resolve(import.meta.dir, "../../native/build/Release/ghostui_ax.node"),
    resolve(import.meta.dir, "../../../native/build/Release/ghostui_ax.node"),
    resolve(process.execPath, "../Frameworks/ghostui_ax.node"),
    resolve(import.meta.dir, "../../../.build/GhostUI.app/Contents/Resources/ghost/native/build/Release/ghostui_ax.node"),
    resolve(process.execPath, "../../Resources/ghost/native/build/Release/ghostui_ax.node"),
  ];

  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      return require(candidate) as NativeBenchApi;
    } catch (error) {
      errors.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(`Failed to load native AX module:\n${errors.join("\n")}`);
}

function printHelp(): void {
  console.log(`Usage: bun run src/a11y/ax-native-observer-bench.ts [--pid <pid>] [--iterations <count>] [--mode <app|windows|focused>]

Benchmarks native AXObserverCreate/AddNotification/RemoveNotification costs.

Options:
  --pid <pid>           Target application PID. Defaults to the frontmost PID when available.
  --iterations <count>  Number of benchmark loops per mode. Default: 100
  --mode <mode>         Run a single mode. Default: run app, windows, focused
  --help                Show this help
`);
}

function parseArgs(argv: string[]): { pid?: number; iterations?: number; mode?: BenchmarkMode; help: boolean } {
  const parsed: { pid?: number; iterations?: number; mode?: BenchmarkMode; help: boolean } = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--pid") {
      const value = argv[++i];
      if (!value) throw new Error("--pid requires a value");
      parsed.pid = Number.parseInt(value, 10);
      continue;
    }
    if (arg === "--iterations") {
      const value = argv[++i];
      if (!value) throw new Error("--iterations requires a value");
      parsed.iterations = Number.parseInt(value, 10);
      continue;
    }
    if (arg === "--mode") {
      const value = argv[++i];
      if (value !== "app" && value !== "windows" && value !== "focused") {
        throw new Error("--mode must be app, windows, or focused");
      }
      parsed.mode = value;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

const native = loadNativeModule();
const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
  process.exit(0);
}

const pid = args.pid ?? native.axGetFrontmostPid?.();
if (!pid || pid <= 0) {
  throw new Error("No target PID provided and no frontmost PID available");
}

const iterations = args.iterations && args.iterations > 0 ? args.iterations : 100;
const modes: BenchmarkMode[] = args.mode ? [args.mode] : ["app", "windows", "focused"];
const results = modes.map((mode) =>
  native.axBenchmarkObserverNotifications({ pid, iterations, mode }),
);

console.log(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
