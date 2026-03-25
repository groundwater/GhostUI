/**
 * Handles `gui defaults` routes by shelling out to the macOS `defaults` CLI.
 * No native N-API required — pure TypeScript.
 */

const JSON_HEADERS = { "content-type": "application/json", "access-control-allow-origin": "*" } as const;

async function run(args: string[]): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(["defaults", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout: stdout.trimEnd(), exitCode };
}

/** Parse macOS `defaults read` plist output into a JSON-friendly value. */
export function parsePlistValue(raw: string): unknown {
  const trimmed = raw.trim();

  // Boolean
  if (trimmed === "1" || trimmed === "0") return trimmed === "1";

  // Number
  const num = Number(trimmed);
  if (trimmed.length > 0 && !isNaN(num)) return num;

  // Plist dictionary — starts with {
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    // Best effort parse of macOS plist text format
    const entries: Record<string, unknown> = {};
    const inner = trimmed.slice(1, -1).trim();
    // Match key = value; pairs (handles quoted and unquoted keys/values)
    const re = /("(?:[^"\\]|\\.)*"|[^\s=;]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^;]*?)\s*;/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(inner)) !== null) {
      const key = m[1].replace(/^"|"$/g, "");
      const val = m[2].replace(/^"|"$/g, "").trim();
      entries[key] = parsePlistValue(val);
    }
    return entries;
  }

  // Plist array — starts with (
  if (trimmed.startsWith("(") && trimmed.endsWith(")")) {
    const inner = trimmed.slice(1, -1).trim();
    if (inner.length === 0) return [];
    return inner.split(",").map(s => {
      const v = s.trim().replace(/^"|"$/g, "");
      return parsePlistValue(v);
    });
  }

  // Quoted string
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }

  // Plain string
  return trimmed;
}

export async function handleDefaults(req: Request, url: URL): Promise<Response | null> {
  // GET /api/defaults/read?domain=X[&key=Y]
  if (req.method === "GET" && url.pathname === "/api/defaults/read") {
    const domain = url.searchParams.get("domain");
    if (!domain) {
      return new Response(JSON.stringify({ error: "missing domain parameter" }), {
        status: 400, headers: JSON_HEADERS,
      });
    }
    const key = url.searchParams.get("key");
    const args = ["read", domain];
    if (key) args.push(key);
    const { stdout, exitCode } = await run(args);
    if (exitCode !== 0) {
      return new Response(JSON.stringify({ error: stdout || "defaults read failed" }), {
        status: 404, headers: JSON_HEADERS,
      });
    }
    const value = parsePlistValue(stdout);
    return new Response(JSON.stringify(value, null, 2), { headers: JSON_HEADERS });
  }

  // POST /api/defaults/write { domain, key, value, type? }
  if (req.method === "POST" && url.pathname === "/api/defaults/write") {
    const body = await req.json() as { domain: string; key: string; value: string; type?: string };
    if (!body.domain || !body.key || body.value === undefined) {
      return new Response(JSON.stringify({ error: "missing domain, key, or value" }), {
        status: 400, headers: JSON_HEADERS,
      });
    }
    const args = ["write", body.domain, body.key];
    if (body.type) {
      args.push(`-${body.type}`, String(body.value));
    } else {
      args.push(String(body.value));
    }
    const { exitCode, stdout } = await run(args);
    if (exitCode !== 0) {
      return new Response(JSON.stringify({ error: stdout || "defaults write failed" }), {
        status: 400, headers: JSON_HEADERS,
      });
    }
    return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
  }

  // GET /api/defaults/domains
  if (req.method === "GET" && url.pathname === "/api/defaults/domains") {
    const { stdout, exitCode } = await run(["domains"]);
    if (exitCode !== 0) {
      return new Response(JSON.stringify({ error: stdout || "defaults domains failed" }), {
        status: 500, headers: JSON_HEADERS,
      });
    }
    // Output format: "domain1, domain2, domain3\n"
    const domains = stdout.split(",").map(s => s.trim()).filter(Boolean);
    return new Response(JSON.stringify(domains, null, 2), { headers: JSON_HEADERS });
  }

  return null;
}
