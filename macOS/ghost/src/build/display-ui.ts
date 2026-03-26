import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT_DIR = resolve(import.meta.dir, "..", "..");
const SOURCE_DIR = resolve(ROOT_DIR, "src", "ui-schema");
const OUTPUT_DIR = resolve(ROOT_DIR, "dist", "display-ui");
const ENTRYPOINT = join(SOURCE_DIR, "app.ts");
const OUTPUT_ENTRY = join(OUTPUT_DIR, "app.js");

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const fullPath = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(fullPath) : [fullPath];
  }));
  return nested.flat();
}

async function newestMtimeMs(dir: string): Promise<number> {
  const files = await listFiles(dir);
  if (files.length === 0) return 0;
  const stats = await Promise.all(files.map((file) => stat(file)));
  return stats.reduce((latest, current) => Math.max(latest, current.mtimeMs), 0);
}

export async function needsDisplayUIBuild(): Promise<boolean> {
  try {
    const [sourceMtime, outputStat] = await Promise.all([
      newestMtimeMs(SOURCE_DIR),
      stat(OUTPUT_ENTRY),
    ]);
    return sourceMtime > outputStat.mtimeMs;
  } catch {
    return true;
  }
}

export async function buildDisplayUI(): Promise<void> {
  await rm(OUTPUT_DIR, { recursive: true, force: true });
  await mkdir(OUTPUT_DIR, { recursive: true });

  const result = await Bun.build({
    entrypoints: [ENTRYPOINT],
    outdir: OUTPUT_DIR,
    target: "browser",
    format: "esm",
    splitting: false,
    sourcemap: "external",
    minify: false,
  });

  if (!result.success) {
    const errors = result.logs.map((log) => log.message).join("\n");
    throw new Error(`display UI build failed\n${errors}`);
  }

  await Promise.all([
    cp(join(SOURCE_DIR, "index.html"), join(OUTPUT_DIR, "index.html")),
    cp(join(SOURCE_DIR, "styles"), join(OUTPUT_DIR, "styles"), { recursive: true }),
  ]);
}

export async function ensureDisplayUIBuild(): Promise<void> {
  if (await needsDisplayUIBuild()) {
    await buildDisplayUI();
  }
}

if (import.meta.main) {
  await buildDisplayUI();
}
