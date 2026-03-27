import { describe, expect, test } from "bun:test";
import { handleStatic } from "./static.js";
import { handleCLI } from "./cli.js";
import { createDaemonAuthContext, isProtectedDaemonPath } from "./auth.js";

describe("display route cleanup", () => {
  test("root no longer serves a browser display entrypoint", () => {
    const res = handleStatic(new Request("http://localhost:7861/"));
    expect(res).toBeNull();
  });
});

describe("daemon auth", () => {
  test("protects CLI and operator API routes but leaves icon paths open", () => {
    expect(isProtectedDaemonPath("/cli/log")).toBe(true);
    expect(isProtectedDaemonPath("/api/trigger")).toBe(true);
    expect(isProtectedDaemonPath("/api/icon")).toBe(false);
    expect(isProtectedDaemonPath("/api/display/list")).toBe(true);
  });

  test("stays open when no daemon auth secret is configured", () => {
    const auth = createDaemonAuthContext(undefined);
    const req = new Request("http://localhost:7861/api/trigger", { method: "POST" });
    expect(auth.authorize(req, new URL(req.url))).toBeNull();
  });

  test("requires a matching bearer token when daemon auth is configured", async () => {
    const auth = createDaemonAuthContext("top-secret");
    const missing = new Request("http://localhost:7861/api/trigger", { method: "POST" });
    const wrong = new Request("http://localhost:7861/api/trigger", {
      method: "POST",
      headers: { authorization: "Bearer nope" },
    });
    const good = new Request("http://localhost:7861/api/trigger", {
      method: "POST",
      headers: { authorization: "Bearer top-secret" },
    });

    const missingResponse = auth.authorize(missing, new URL(missing.url));
    const wrongResponse = auth.authorize(wrong, new URL(wrong.url));

    expect(missingResponse?.status).toBe(401);
    expect(wrongResponse?.status).toBe(401);
    expect(await missingResponse?.text()).toContain("Missing Authorization");
    expect(await wrongResponse?.text()).toContain("Invalid Authorization");
    expect(auth.authorize(good, new URL(good.url))).toBeNull();
  });

  test("leaves OPTIONS requests open for preflight", () => {
    const auth = createDaemonAuthContext("top-secret");
    const req = new Request("http://localhost:7861/api/input", { method: "OPTIONS" });
    expect(auth.authorize(req, new URL(req.url))).toBeNull();
  });
});
