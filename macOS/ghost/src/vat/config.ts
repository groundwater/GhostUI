import { homedir } from "os";
import { dirname, join } from "path";
import { mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import type { VatMountPolicy, VatPersistedMount, VatUnmountTimeout } from "./types.js";

const VAT_CONFIG_VERSION = 1;
const VAT_CONFIG_ENV = "GHOSTUI_VAT_MOUNTS_FILE";

interface VatConfigFile {
  version: number;
  mounts: VatPersistedMount[];
}

export function defaultVatMountPolicy(): VatMountPolicy {
  return { kind: "always" };
}

export function resolveVatMountConfigPath(): string {
  const overridden = process.env[VAT_CONFIG_ENV]?.trim();
  if (overridden) {
    return overridden;
  }
  return join(homedir(), "Library", "Application Support", "GhostUI", "vat-mounts.json");
}

export function normalizeVatUnmountTimeout(value: unknown): VatUnmountTimeout {
  if (!value || typeof value !== "object") {
    throw new Error("VAT auto policy requires an unmountTimeout object");
  }
  const kind = (value as { kind?: unknown }).kind;
  if (kind === "never") {
    return { kind: "never" };
  }
  if (kind === "seconds") {
    const seconds = (value as { seconds?: unknown }).seconds;
    if (!Number.isInteger(seconds) || Number(seconds) <= 0) {
      throw new Error("VAT auto unmount timeout seconds must be a positive integer");
    }
    return { kind: "seconds", seconds: Number(seconds) };
  }
  throw new Error(`Unknown VAT unmount timeout kind: ${String(kind)}`);
}

export function normalizeVatMountPolicy(value: unknown): VatMountPolicy {
  if (!value || typeof value !== "object") {
    return defaultVatMountPolicy();
  }
  const kind = (value as { kind?: unknown }).kind;
  if (kind === "always") {
    return { kind: "always" };
  }
  if (kind === "disabled") {
    return { kind: "disabled" };
  }
  if (kind === "auto") {
    return {
      kind: "auto",
      unmountTimeout: normalizeVatUnmountTimeout((value as { unmountTimeout?: unknown }).unmountTimeout),
    };
  }
  throw new Error(`Unknown VAT mount policy kind: ${String(kind)}`);
}

export function normalizeVatPersistedMount(value: unknown): VatPersistedMount {
  if (!value || typeof value !== "object") {
    throw new Error("VAT mount entry must be an object");
  }
  const path = (value as { path?: unknown }).path;
  const driver = (value as { driver?: unknown }).driver;
  const rawArgs = (value as { args?: unknown }).args;
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new Error("VAT mount path must start with /");
  }
  if (typeof driver !== "string" || !driver) {
    throw new Error("VAT mount driver is required");
  }
  const args = Array.isArray(rawArgs) ? rawArgs.filter((arg): arg is string => typeof arg === "string") : [];
  return {
    path,
    driver,
    args,
    mountPolicy: normalizeVatMountPolicy((value as { mountPolicy?: unknown }).mountPolicy),
  };
}

export async function loadVatMountConfig(
  path = resolveVatMountConfigPath(),
): Promise<VatPersistedMount[]> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<VatConfigFile>;
    if (parsed.version !== VAT_CONFIG_VERSION) {
      throw new Error(`Unsupported VAT mount config version: ${String(parsed.version)}`);
    }
    if (!Array.isArray(parsed.mounts)) {
      throw new Error("VAT mount config requires a mounts array");
    }
    return parsed.mounts.map(normalizeVatPersistedMount);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if ("code" in (error as object) && (error as { code?: string }).code === "ENOENT") {
      return [];
    }
    throw new Error(`Unable to load VAT mount config ${path}: ${message}`);
  }
}

export async function saveVatMountConfig(
  mounts: VatPersistedMount[],
  path = resolveVatMountConfigPath(),
): Promise<void> {
  const normalized = mounts.map(normalizeVatPersistedMount);
  await mkdir(dirname(path), { recursive: true });
  const payload = JSON.stringify({ version: VAT_CONFIG_VERSION, mounts: normalized }, null, 2) + "\n";
  const tempPath = `${path}.tmp`;
  await writeFile(tempPath, payload, "utf8");
  await rename(tempPath, path);
}

export async function clearVatMountConfig(path = resolveVatMountConfigPath()): Promise<void> {
  await rm(path, { force: true });
}
