import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  defaultVatMountPolicy,
  loadVatMountConfig,
  normalizeVatMountPolicy,
  saveVatMountConfig,
} from "./config.js";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("VAT mount config", () => {
  test("defaults missing policies to always", () => {
    expect(normalizeVatMountPolicy(undefined)).toEqual(defaultVatMountPolicy());
  });

  test("round-trips persisted mounts through disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ghostui-vat-config-"));
    tempDirs.push(dir);
    const file = join(dir, "vat-mounts.json");

    await saveVatMountConfig([
      {
        path: "/demo",
        driver: "fixed",
        args: ["hello"],
        mountPolicy: { kind: "auto", unmountTimeout: { kind: "seconds", seconds: 30 } },
      },
    ], file);

    await expect(loadVatMountConfig(file)).resolves.toEqual([
      {
        path: "/demo",
        driver: "fixed",
        args: ["hello"],
        mountPolicy: { kind: "auto", unmountTimeout: { kind: "seconds", seconds: 30 } },
      },
    ]);
  });
});
