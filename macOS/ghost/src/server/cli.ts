import type { CRDTStore } from "../crdt/store.js";
import * as Y from "yjs";
import { existsSync, readFileSync, watch } from "fs";
import { DEFAULT_DOC_PATH } from "../crdt/doc-paths.js";

export function handleCLI(req: Request, store: CRDTStore): Response | Promise<Response> | null {
  const url = new URL(req.url);

  if (req.method === "GET" && url.pathname.startsWith("/cli/tree")) {
    return handleTree(url, store);
  }

  if (req.method === "GET" && url.pathname === "/cli/log") {
    return handleLog(url);
  }

  return null;
}

const APP_LOG_PATH = "/tmp/ghostui-app.log";
const DAEMON_LOG_PATH = "/tmp/ghostui-daemon.log";
const DEFAULT_LOG_LAST = 20;
const MAX_LOG_LAST = 5000;

interface LogSource {
  label: string;
  path: string;
}

function defaultLogSources(): LogSource[] {
  return [
    { label: "app", path: APP_LOG_PATH },
    { label: "daemon", path: DAEMON_LOG_PATH },
  ];
}

function readSourceLines(source: LogSource): string[] {
  if (!existsSync(source.path)) return [];
  const text = readFileSync(source.path, "utf8");
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.map(line => `[${source.label}] ${line}`);
}

function readMergedLogLines(): string[] {
  const lines: string[] = [];
  for (const source of defaultLogSources()) {
    lines.push(...readSourceLines(source));
  }
  return lines;
}

function handleLog(url: URL): Response {
  const follow = url.searchParams.get("follow") === "1";
  const lastParam = Number(url.searchParams.get("last") || DEFAULT_LOG_LAST);
  const last = Number.isFinite(lastParam)
    ? Math.max(0, Math.min(MAX_LOG_LAST, Math.trunc(lastParam)))
    : DEFAULT_LOG_LAST;

  const sources = defaultLogSources();
  if (sources.every(source => !existsSync(source.path))) {
    return new Response(`Log file not found: ${sources.map(source => source.path).join(", ")}`, { status: 404 });
  }

  if (!follow) {
    const lines = readMergedLogLines();
    const out = last > 0 && lines.length > last ? lines.slice(-last) : lines;
    return new Response(out.join("\n"), {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  let watchers: ReturnType<typeof watch>[] = [];
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const offsets = new Map<string, number>();
      watchers = sources
        .filter(source => existsSync(source.path))
        .map((source) => {
          const initialLines = readSourceLines(source);
          const initial = last > 0 && initialLines.length > last ? initialLines.slice(-last) : initialLines;
          if (initial.length > 0) {
            controller.enqueue(encoder.encode(initial.join("\n") + "\n"));
          }
          offsets.set(source.path, readFileSync(source.path, "utf8").length);
          return watch(source.path, () => {
            try {
              if (!existsSync(source.path)) return;
              const text = readFileSync(source.path, "utf8");
              const prev = offsets.get(source.path) ?? 0;
              const nextChunk = text.length >= prev ? text.slice(prev) : text;
              offsets.set(source.path, text.length);
              if (!nextChunk) return;
              const lines = nextChunk
                .split(/\r?\n/)
                .filter(line => line.length > 0)
                .map(line => `[${source.label}] ${line}`);
              if (lines.length > 0) {
                controller.enqueue(encoder.encode(lines.join("\n") + "\n"));
              }
            } catch {}
          });
        });

    },
    cancel() {
      for (const watcher of watchers) watcher.close();
      watchers = [];
    },
  });

  return new Response(stream, {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache" },
  });
}

/** Recursively convert a Y.Map tree node to a plain JSON object. */
export function yMapToJSON(ymap: Y.Map<unknown>): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  const tag = ymap.get("_tag") as string | undefined;
  if (tag) obj._tag = tag;

  const text = ymap.get("_text") as string | undefined;
  if (text) obj._text = text;

  for (const [key, value] of ymap.entries()) {
    if (key === "_tag" || key === "_text" || key === "_children") continue;
    obj[key] = value;
  }

  const ychildren = ymap.get("_children") as Y.Array<Y.Map<unknown>> | undefined;
  if (ychildren && ychildren.length > 0) {
    const children: Record<string, unknown>[] = [];
    for (let i = 0; i < ychildren.length; i++) {
      children.push(yMapToJSON(ychildren.get(i)));
    }
    obj._children = children;
  }

  return obj;
}

/** Find a node by hierarchical path (slash-separated tag/title names). */
function findByPath(root: Y.Map<unknown>, path: string): Y.Map<unknown> | null {
  if (!path || path === "/") return root;

  const segments = path.split("/").filter(Boolean);
  let current = root;

  for (const seg of segments) {
    const children = current.get("_children") as Y.Array<Y.Map<unknown>> | undefined;
    if (!children) return null;

    let found = false;
    for (let i = 0; i < children.length; i++) {
      const child = children.get(i);
      const tag = child.get("_tag") as string;
      const title = child.get("title") as string | undefined;
      if (tag === seg || title === seg) {
        current = child;
        found = true;
        break;
      }
    }
    if (!found) return null;
  }

  return current;
}

/** BFS search: find first node matching tag or title. */
function findByTagOrTitle(root: Y.Map<unknown>, name: string): Y.Map<unknown> | null {
  const queue: Y.Map<unknown>[] = [root];
  while (queue.length > 0) {
    const node = queue.shift()!;
    const tag = node.get("_tag") as string;
    const title = node.get("title") as string | undefined;
    if (tag === name || title === name) return node;
    const children = node.get("_children") as Y.Array<Y.Map<unknown>> | undefined;
    if (children) {
      for (let i = 0; i < children.length; i++) {
        queue.push(children.get(i));
      }
    }
  }
  return null;
}

function handleTree(url: URL, store: CRDTStore): Response {
  // /cli/tree → list docs or show first doc
  // /cli/tree?doc=/app/Finder/window/BenderVM → specific doc
  // /cli/tree?doc=...&path=Toolbar → subtree within doc

  const docPath = url.searchParams.get("doc");
  const subPath = url.searchParams.get("path") || "";

  // If no doc specified, try first available or list paths
  let doc: ReturnType<CRDTStore["get"]>;
  if (docPath) {
    doc = store.get(docPath);
    if (!doc) {
      return new Response(`No document at path: ${docPath}\nAvailable: ${store.paths().join(", ")}`, { status: 404 });
    }
  } else {
    doc = store.get(DEFAULT_DOC_PATH);
    if (!doc) {
      return new Response(`No document at path: ${DEFAULT_DOC_PATH}`, { status: 404 });
    }
  }

  const root = doc.getMap("root");

  if (subPath) {
    // Try hierarchical path first, then BFS search by tag/title
    const node = findByPath(root, subPath) ?? findByTagOrTitle(root, subPath);
    if (!node) {
      return new Response(`Path not found: ${subPath}`, { status: 404 });
    }
    return new Response(JSON.stringify(yMapToJSON(node), null, 2), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  const json = yMapToJSON(root);
  if (!json._tag) {
    return new Response("Empty document", { status: 404 });
  }

  return new Response(JSON.stringify(json, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
