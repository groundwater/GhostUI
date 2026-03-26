import { describe, expect, test } from "bun:test";
import { handleStatic } from "./static.js";
import { handleCLI } from "./cli.js";
import { createDaemonAuthContext, isProtectedDaemonPath } from "./auth.js";
import { DEFAULT_DOC_PATH } from "../crdt/doc-paths.js";
import * as Y from "yjs";

function makeStore(paths: string[] = []): {
  get(path: string): Y.Doc | undefined;
  getOrCreate(path: string): Y.Doc;
  paths(): string[];
} {
  const docs = new Map<string, Y.Doc>();
  for (const path of paths) docs.set(path, new Y.Doc());
  return {
    get(path: string) {
      return docs.get(path);
    },
    getOrCreate(path: string) {
      let doc = docs.get(path);
      if (!doc) {
        doc = new Y.Doc();
        docs.set(path, doc);
      }
      return doc;
    },
    paths() {
      return [...docs.keys()];
    },
  };
}

describe("display route cleanup", () => {
  test("root redirects to /display/0", () => {
    const res = handleStatic(new Request("http://localhost:7861/"));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(302);
    expect(res!.headers.get("location")).toBe("/display/0");
  });
});

describe("CLI doc path defaults", () => {
  test("tree defaults strictly to /display/0", async () => {
    const store = makeStore(["/other"]);

    const res = handleCLI(new Request("http://localhost:7861/cli/tree"), store as never) as Response;
    expect(res.status).toBe(404);
    expect(await res.text()).toContain(DEFAULT_DOC_PATH);
  });
});

describe("daemon auth", () => {
  test("protects CLI and operator API routes but leaves icon and websocket paths open", () => {
    expect(isProtectedDaemonPath("/cli/tree")).toBe(true);
    expect(isProtectedDaemonPath("/api/trigger")).toBe(true);
    expect(isProtectedDaemonPath("/api/icon")).toBe(false);
    expect(isProtectedDaemonPath("/api/display/list")).toBe(true);
    expect(isProtectedDaemonPath("/crdt")).toBe(false);
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
