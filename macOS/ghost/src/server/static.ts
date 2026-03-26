import { resolve, join } from "path";

const DISPLAY_UI_DIR = resolve(import.meta.dir, "..", "..", "dist", "display-ui");
const ASSETS_DIR = resolve(import.meta.dir, "..", "assets");
const APPS_DIR = resolve(import.meta.dir, "..", "apps");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".eot": "application/vnd.ms-fontobject",
};

function getMime(path: string): string {
  const ext = path.slice(path.lastIndexOf("."));
  return MIME_TYPES[ext] || "application/octet-stream";
}

export function handleStatic(req: Request): Response | null {
  const url = new URL(req.url);
  const displayPageMatch = /^\/display\/(\d+)\/?$/.exec(url.pathname);

  // ── Display UI at /display/<n> ──
  if (displayPageMatch) {
    const file = Bun.file(join(DISPLAY_UI_DIR, "index.html"));
    return new Response(file, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (url.pathname.startsWith("/display/")) {
    const relPath = url.pathname.slice("/display/".length);
    if (/^\d+\/?$/.test(relPath)) return null;
    if (relPath.includes("..")) return null;
    const file = Bun.file(join(DISPLAY_UI_DIR, relPath));
    return new Response(file, {
      headers: {
        "content-type": getMime(relPath),
        "cache-control": "no-cache",
      },
    });
  }

  // ── App bundle assets at /apps/<bundleId>/* ──
  if (url.pathname.startsWith("/apps/")) {
    const relPath = url.pathname.slice("/apps/".length);
    if (relPath.includes("..")) return null;
    const file = Bun.file(join(APPS_DIR, relPath));
    return new Response(file, {
      headers: {
        "content-type": getMime(relPath),
        "cache-control": "no-cache",
      },
    });
  }

  // ── Assets at /assets/* ──
  if (url.pathname.startsWith("/assets/")) {
    const relPath = url.pathname.slice("/assets/".length);
    if (relPath.includes("..")) return null;
    const file = Bun.file(join(ASSETS_DIR, relPath));
    return new Response(file, {
      headers: {
        "content-type": getMime(relPath),
        "cache-control": "public, max-age=86400",
      },
    });
  }

  // Redirect root-ish entry points to /display/0
  if (url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/display" || url.pathname === "/display/") {
    return Response.redirect("/display/0", 302);
  }

  return null;
}
