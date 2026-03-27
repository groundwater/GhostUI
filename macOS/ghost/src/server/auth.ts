const AUTH_BEARER_PREFIX = "Bearer ";

function jsonHeaders(extra: Record<string, string> = {}): HeadersInit {
  return {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    ...extra,
  };
}

export function isProtectedDaemonPath(pathname: string): boolean {
  if (pathname.startsWith("/cli/")) return true;
  if (!pathname.startsWith("/api/")) return false;
  if (pathname === "/api/icon") return false;
  return true;
}

export interface DaemonAuthContext {
  readonly secret: string | null;
  authorize(req: Request, url: URL): Response | null;
}

export function createDaemonAuthContext(secretFromEnv = process.env.GHOSTUI_AUTH_SECRET): DaemonAuthContext {
  const trimmed = secretFromEnv?.trim() || "";
  const secret = trimmed.length > 0 ? trimmed : null;

  return {
    secret,
    authorize(req, url) {
      if (!secret) return null;
      if (req.method === "OPTIONS") return null;
      if (!isProtectedDaemonPath(url.pathname)) return null;

      const authHeader = req.headers.get("authorization") || "";
      if (!authHeader.startsWith(AUTH_BEARER_PREFIX)) {
        return new Response(JSON.stringify({ error: "Missing Authorization bearer token" }), {
          status: 401,
          headers: jsonHeaders({ "www-authenticate": "Bearer" }),
        });
      }
      if (authHeader.slice(AUTH_BEARER_PREFIX.length) !== secret) {
        return new Response(JSON.stringify({ error: "Invalid Authorization bearer token" }), {
          status: 401,
          headers: jsonHeaders({ "www-authenticate": "Bearer" }),
        });
      }
      return null;
    },
  };
}
