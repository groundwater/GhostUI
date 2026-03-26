#!/usr/bin/env bun
/**
 * AX event throughput harness.
 *
 * Spawns `gui ax events`, optionally fires stimulus keys, counts JSON event
 * lines by type / pid / bundleId, and prints a summary.
 *
 * Usage:
 *   bun run bench:ax-events                       # passive listen, 5 s
 *   bun run bench:ax-events -- --duration 10       # passive listen, 10 s
 *   bun run bench:ax-events -- --stim tab --n 20   # 20× tab key, then drain
 *   bun run bench:ax-events -- --stim tab --n 50 --pid 1234
 */

import { spawn } from "bun";
import { resolve } from "node:path";

// ── CLI flags ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);

function flag(name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}

const GUI = flag("gui", resolve(import.meta.dir, "../../../../.build/GhostUI.app/Contents/MacOS/gui"));
const DURATION_S = Number(flag("duration", "5"));
const STIM_KEY = flag("stim", "");          // e.g. "tab", "space"
const STIM_N = Number(flag("n", "10"));
const FILTER_PID = flag("pid", "");
const FILTER_BUNDLE = flag("bundle", "");

// ── Types ──────────────────────────────────────────────────────────────
interface EvLine {
  type?: string;
  pid?: number;
  bundleId?: string;
  ts?: number;
  [k: string]: unknown;
}

// ── Counters ───────────────────────────────────────────────────────────
const byType = new Map<string, number>();
const byPid = new Map<number, number>();
const byBundle = new Map<string, number>();
let totalLines = 0;
let parseErrors = 0;
let firstTs = 0;
let lastTs = 0;

function record(ev: EvLine) {
  totalLines++;
  const t = ev.type ?? "<unknown>";
  byType.set(t, (byType.get(t) ?? 0) + 1);
  if (ev.pid != null) byPid.set(ev.pid, (byPid.get(ev.pid) ?? 0) + 1);
  if (ev.bundleId) byBundle.set(ev.bundleId, (byBundle.get(ev.bundleId) ?? 0) + 1);
  if (ev.ts) {
    if (!firstTs) firstTs = ev.ts;
    lastTs = ev.ts;
  }
}

// ── Event listener ─────────────────────────────────────────────────────
const evArgs = ["ax", "events"];
if (FILTER_PID) evArgs.push("--pid", FILTER_PID);
if (FILTER_BUNDLE) evArgs.push("--bundle", FILTER_BUNDLE);

const listener = spawn({
  cmd: [GUI, ...evArgs],
  stdout: "pipe",
  stderr: "ignore",
});

const decoder = new TextDecoder();
let buf = "";

async function drain() {
  const reader = listener.stdout.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        record(JSON.parse(line) as EvLine);
      } catch {
        parseErrors++;
      }
    }
  }
}

const drainPromise = drain();

// ── Stimulus ───────────────────────────────────────────────────────────
async function stimulate() {
  if (!STIM_KEY) return;
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // small settle time for event listener to connect
  await delay(500);
  console.error(`[stim] firing ${STIM_N}× "gui cg key ${STIM_KEY}" …`);
  for (let i = 0; i < STIM_N; i++) {
    const p = spawn({ cmd: [GUI, "cg", "key", STIM_KEY], stdout: "ignore", stderr: "ignore" });
    await p.exited;
    // small gap so events aren't coalesced at the OS level
    await delay(30);
  }
  console.error(`[stim] done`);
}

// ── Orchestration ──────────────────────────────────────────────────────
const t0 = performance.now();

stimulate().then(async () => {
  // after stimulus (or immediately if passive), wait for remaining duration
  const elapsed = (performance.now() - t0) / 1000;
  const remaining = Math.max(0, DURATION_S - elapsed);
  if (remaining > 0) {
    console.error(`[harness] draining for ${remaining.toFixed(1)}s …`);
    await new Promise((r) => setTimeout(r, remaining * 1000));
  }
  listener.kill();
  await drainPromise.catch(() => {});
  printSummary();
});

// ── Summary ────────────────────────────────────────────────────────────
function sortedEntries<K>(m: Map<K, number>): [K, number][] {
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function printSummary() {
  const wallS = (performance.now() - t0) / 1000;
  const spanS = firstTs && lastTs ? (lastTs - firstTs) / 1000 : 0;

  console.log("\n─── AX event throughput ───");
  console.log(`  wall time:     ${wallS.toFixed(2)}s`);
  console.log(`  event span:    ${spanS.toFixed(2)}s`);
  console.log(`  total events:  ${totalLines}`);
  console.log(`  parse errors:  ${parseErrors}`);
  if (totalLines && wallS) {
    console.log(`  ev/s (wall):   ${(totalLines / wallS).toFixed(1)}`);
  }
  if (totalLines && spanS) {
    console.log(`  ev/s (span):   ${(totalLines / spanS).toFixed(1)}`);
  }

  if (byType.size) {
    console.log("\n  by type:");
    for (const [k, v] of sortedEntries(byType)) console.log(`    ${k}: ${v}`);
  }
  if (byPid.size) {
    console.log("\n  by pid:");
    for (const [k, v] of sortedEntries(byPid)) console.log(`    ${k}: ${v}`);
  }
  if (byBundle.size) {
    console.log("\n  by bundle:");
    for (const [k, v] of sortedEntries(byBundle)) console.log(`    ${k}: ${v}`);
  }
  console.log("");
}
