import { existsSync } from "fs";
import { resolve } from "path";

export type LiveProducerMode = "json" | "ndjson";

export interface LiveCommandResult {
  producerExitCode: number;
  producerStderr: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface LiveLiteralCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function normalizeOutput(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function resolveBundledGUIPath(): string {
  const explicit = process.env.GHOSTUI_TEST_GUI_PATH?.trim();
  const helperPath = explicit && explicit.length > 0
    ? explicit
    : resolve(process.cwd(), "../../.build/GhostUI.app/Contents/Helpers/GhostUICLI.app/Contents/MacOS/gui");
  if (!existsSync(helperPath)) {
    throw new Error(`Bundled gui helper not found at ${helperPath}`);
  }
  return helperPath;
}

export function resolveLiveEnabled(): boolean {
  return process.env.GHOSTUI_ENABLE_LIVE_PIPE_TESTS === "1";
}

export function buildFocusedWindowProducerArgs(
  mode: LiveProducerMode,
  cardinality: "first" | "only" | "each",
  query = "Window",
): string[] {
  const framingFlag = mode === "json" ? "--json" : "--ndjson";
  const cardinalityFlag = `--${cardinality}`;
  return ["ax", "query", "--focused", framingFlag, cardinalityFlag, query];
}

export async function runBundledPipeline(
  producerArgs: string[],
  consumerArgs: string[],
): Promise<LiveCommandResult> {
  const guiPath = resolveBundledGUIPath();
  const producer = Bun.spawn({
    cmd: [guiPath, ...producerArgs],
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const consumer = Bun.spawn({
    cmd: [guiPath, ...consumerArgs],
    stdin: producer.stdout,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });

  const [producerStderr, producerExitCode, stdout, stderr, exitCode] = await Promise.all([
    new Response(producer.stderr).text(),
    producer.exited,
    new Response(consumer.stdout).text(),
    new Response(consumer.stderr).text(),
    consumer.exited,
  ]);

  return {
    producerExitCode,
    producerStderr,
    exitCode,
    stdout,
    stderr,
  };
}

export async function runBundledShellPipeline(
  stages: string[][],
): Promise<LiveLiteralCommandResult> {
  const guiPath = resolveBundledGUIPath();
  const pipeline = stages
    .map((args) => [shellQuote(guiPath), ...args.map(shellQuote)].join(" "))
    .join(" | ");
  const proc = Bun.spawn({
    cmd: ["/bin/zsh", "-lc", pipeline],
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
    cwd: process.cwd(),
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

export async function runBundledLiteralCommand(
  args: string[],
  stdinText: string,
): Promise<LiveLiteralCommandResult> {
  const guiPath = resolveBundledGUIPath();
  const command = [shellQuote(guiPath), ...args.map(shellQuote)].join(" ");
  const script = `${command} <<'EOF'\n${stdinText}\nEOF`;
  const proc = Bun.spawn({
    cmd: ["/bin/zsh", "-lc", script],
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
    cwd: process.cwd(),
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

export function expectCanonicalPayloadShape(payload: unknown): void {
  if (!payload || typeof payload !== "object") {
    throw new Error("expected canonical gui.payload object");
  }
  const record = payload as Record<string, unknown>;
  if (record.type !== "gui.payload") {
    throw new Error(`expected gui.payload type, received ${String(record.type)}`);
  }
  if (record.version !== 1) {
    throw new Error(`expected gui.payload version 1, received ${String(record.version)}`);
  }
  if (record.source !== "ax.query") {
    throw new Error(`expected ax.query source, received ${String(record.source)}`);
  }
}
