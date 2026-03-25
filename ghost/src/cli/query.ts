import type { Predicate, QueryNode } from "./types.js";

const ALIASES: Record<string, string> = {
  App: "Application",
};

/**
 * Recursive descent parser for query language.
 *
 * Grammar:
 *   QueryList = QueryNode*
 *   QueryNode = TypeSpec Predicates? ( '/' RightSide | '//' RightSide | '{' QueryList '}' )?
 *   RightSide = '{' QueryList '}' | QueryNode
 *   TypeSpec  = Name ( '#' Id )? ( ':' Index )?
 *   Name      = [A-Za-z*]+
 *   Index     = [0-9]+
 *
 * '/' = direct child, '//' = any-depth descendant (same as { }).
 * Both are binary, right-associative, higher precedence than space (sibling).
 */
export function parseQuery(input: string): QueryNode[] {
  const tokens = tokenize(input);
  let pos = 0;

  function peek(): string | undefined {
    return tokens[pos];
  }

  function consume(): string {
    return tokens[pos++];
  }

  function parseList(): QueryNode[] {
    const nodes: QueryNode[] = [];
    while (pos < tokens.length && peek() !== "}") {
      nodes.push(parseNode());
    }
    return nodes;
  }

  function parseNode(): QueryNode {
    const spec = consume();
    if (!spec || spec === "{" || spec === "}" || spec === "[" || spec === "]" || spec === "/" || spec === "//") {
      throw new Error(`Unexpected token: ${spec}`);
    }

    const { tag, as: asName, id, index, indexEnd, omitWrapper, omitAncestors } = parseTypeSpec(spec);
    const node: QueryNode = { tag };
    if (omitWrapper) node.omitWrapper = true;
    if (omitAncestors) node.omitAncestors = true;
    if (asName !== undefined) node.as = asName;
    if (id !== undefined) node.id = id;
    if (index !== undefined) node.index = index;
    if (indexEnd !== undefined) node.indexEnd = indexEnd;

    // Consume bracket predicates: [attr], [attr=val], [attr!=val], [attr~=val]
    // Also handles [*] and [**] introspection, comma-separated predicates, and @suppress
    while (peek() === "[") {
      consume(); // eat '['
      const body = consume();
      if (body === undefined || body === "]") {
        throw new Error("Empty predicate");
      }
      if (peek() !== "]") {
        throw new Error("Expected ']'");
      }
      consume(); // eat ']'

      const bracket = parseBracketBody(body);
      if (bracket.introspect) {
        node.introspect = bracket.introspect;
        if (bracket.introspectRemainder) node.introspectRemainder = true;
      }
      if (bracket.predicates.length > 0) {
        if (!node.predicates) node.predicates = [];
        node.predicates.push(...bracket.predicates);
      }
    }

    // Handle / (direct child) and // (any-depth descendant) operators
    if (peek() === "/" || peek() === "//") {
      const op = consume();
      const isDirect = op === "/";

      if (peek() === "{") {
        // A / { B C } or A // { B C } — distribute over brace contents
        consume(); // eat '{'
        node.children = parseList();
        if (peek() !== "}") {
          throw new Error("Expected '}'");
        }
        consume(); // eat '}'
        if (isDirect) {
          for (const child of node.children) {
            child.directChild = true;
          }
        }
      } else {
        // A / B or A // B — right side is a single node (recursive for chaining)
        const child = parseNode();
        if (child.tag === "**") {
          throw new Error(`Cannot use ** with ${op} operator`);
        }
        if (isDirect) child.directChild = true;
        node.children = [child];
      }
    } else if (peek() === "{") {
      consume(); // eat '{'
      node.children = parseList();
      if (peek() !== "}") {
        throw new Error("Expected '}'");
      }
      consume(); // eat '}'
    }

    return node;
  }

  return parseList();
}

/** True when a parsed query contains [*] or [**] introspection anywhere. */
export function queryHasIntrospection(queries: QueryNode[]): boolean {
  for (const q of queries) {
    if (q.introspect) return true;
    if (q.children && queryHasIntrospection(q.children)) return true;
  }
  return false;
}

/** Strip surrounding quotes (double or single) from a string. */
function stripQuotes(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1);
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1);
  }
  return s;
}

/** Find first colon not inside quotes (double or single). Returns -1 if none. */
function findUnquotedColon(s: string): number {
  let inDouble = false;
  let inSingle = false;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '"' && !inSingle) inDouble = !inDouble;
    else if (s[i] === "'" && !inDouble) inSingle = !inSingle;
    else if (s[i] === ':' && !inDouble && !inSingle) return i;
  }
  return -1;
}

function parseTypeSpec(spec: string): {
  tag: string;
  as?: string;
  id?: string;
  index?: number;
  indexEnd?: number;
  omitWrapper?: boolean;
  omitAncestors?: boolean;
} {
  let omitWrapper = false;
  let omitAncestors = false;
  if (spec.startsWith("@@")) {
    omitWrapper = true;
    omitAncestors = true;
    spec = spec.slice(2);
  } else if (spec.startsWith("@")) {
    omitWrapper = true;
    spec = spec.slice(1);
  }

  function withModifiers(result: {
    tag: string;
    as?: string;
    id?: string;
    index?: number;
    indexEnd?: number;
    omitWrapper?: boolean;
    omitAncestors?: boolean;
  }) {
    if (as) result.as = as;
    if (omitWrapper) result.omitWrapper = true;
    if (omitAncestors) result.omitAncestors = true;
    return result;
  }

  // Split on @ first for rename: foo@bar means as="foo", match tag="bar"
  // But @ inside quotes (from #"...") should not split
  let as: string | undefined;
  const atIdx = spec.indexOf("@");
  if (atIdx > 0) {
    // foo@bar... — rename prefix
    as = spec.slice(0, atIdx);
    spec = spec.slice(atIdx + 1);
  }

  if (spec.length === 0) {
    return withModifiers({ tag: "**" });
  }

  // Split on # first: Tag#id or Tag#id:N or Tag#id:N:M
  const hashIdx = spec.indexOf("#");
  let id: string | undefined;
  let remainder: string;

  if (hashIdx !== -1) {
    const rawTag = spec.slice(0, hashIdx);
    remainder = spec.slice(hashIdx + 1);
    const tag = ALIASES[rawTag] || rawTag || "*";

    // Find colon outside of quotes for index spec
    const colonIdx = findUnquotedColon(remainder);
    if (colonIdx === -1) {
      return withModifiers({ tag, id: stripQuotes(remainder) });
    }
    id = stripQuotes(remainder.slice(0, colonIdx));
    return withModifiers({ tag, id, ...parseIndexSpec(remainder.slice(colonIdx + 1), spec) });
  }

  // No # — original logic
  const colonIdx = spec.indexOf(":");
  if (colonIdx === -1) {
    const tag = ALIASES[spec] || spec;
    return withModifiers({ tag });
  }

  const rawTag = spec.slice(0, colonIdx);
  const tag = ALIASES[rawTag] || rawTag;
  const rest = spec.slice(colonIdx + 1);
  return withModifiers({ tag, ...parseIndexSpec(rest, spec) });
}

/** Parse "N" or "N:M" into index (and optional indexEnd). */
function parseIndexSpec(s: string, spec: string): { index: number; indexEnd?: number } {
  const parts = s.split(":");
  for (const p of parts) {
    if (!/^\d+$/.test(p)) {
      throw new Error(`Expected numeric index after ':', got '${p}' in '${spec}'`);
    }
  }
  if (parts.length === 1) {
    return { index: parseInt(parts[0], 10) };
  }
  if (parts.length === 2) {
    return { index: parseInt(parts[0], 10), indexEnd: parseInt(parts[1], 10) };
  }
  throw new Error(`Too many ':' segments in '${spec}'`);
}

function parseBracketBody(body: string): {
  predicates: Predicate[];
  introspect?: "*" | "**";
  introspectRemainder?: boolean;
} {
  if (body === "*" || body === "**") {
    return { predicates: [], introspect: body };
  }

  const predicates: Predicate[] = [];
  let introspect: "*" | "**" | undefined;

  for (const rawPiece of body.split(",")) {
    const piece = rawPiece.trim();
    if (!piece) {
      throw new Error("Empty predicate");
    }
    if (piece === "*" || piece === "**") {
      if (introspect && introspect !== piece) {
        throw new Error("Cannot mix [*] and [**] in the same predicate block");
      }
      introspect = piece;
      continue;
    }
    predicates.push(parsePredicate(piece));
  }

  return {
    predicates,
    introspect,
    introspectRemainder: introspect !== undefined && predicates.length > 0,
  };
}

/** Parse one predicate token. Supports @suppress and rename. */
function parsePredicate(piece: string): Predicate {
    piece = piece.trim();
    let suppress = false;
    let as: string | undefined;

    if (piece.startsWith("@")) {
      // @y or @y=val — suppress prefix (no rename, left side is empty)
      suppress = true;
      piece = piece.slice(1);
    } else {
      // Check for x@y rename: x@y, x@y=val
      const atIdx = piece.indexOf("@");
      if (atIdx > 0) {
        as = piece.slice(0, atIdx);
        piece = piece.slice(atIdx + 1);
      }
    }

    // Try ~= first (two-char op), then != , then =
    for (const op of ["~=", "!=", "="] as const) {
      const idx = piece.indexOf(op);
      if (idx !== -1) {
      const pred: Predicate = {
          attr: piece.slice(0, idx),
          op,
          value: piece.slice(idx + op.length),
        };
        if (suppress) pred.suppress = true;
        if (as) pred.as = as;
        return pred;
      }
    }
    // No operator — existence check
    const pred: Predicate = { attr: piece, op: "exists" };
    if (suppress) pred.suppress = true;
    if (as) pred.as = as;
    return pred;
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;

  while (i < input.length) {
    // skip whitespace
    if (/\s/.test(input[i])) { i++; continue; }

    // / and // operators
    if (input[i] === "/") {
      if (i + 1 < input.length && input[i + 1] === "/") {
        tokens.push("//");
        i += 2;
      } else {
        tokens.push("/");
        i++;
      }
      continue;
    }

    // brackets and braces are their own tokens
    if ("{}[]".includes(input[i])) {
      // inside brackets, capture content as single token
      if (input[i] === "[") {
        tokens.push("[");
        i++;
        const start = i;
        while (i < input.length && input[i] !== "]") i++;
        if (i < input.length) {
          tokens.push(input.slice(start, i)); // bracket body
          tokens.push("]");
          i++;
        }
      } else {
        tokens.push(input[i]);
        i++;
      }
      continue;
    }

    // read a TypeSpec: everything up to whitespace, brace, bracket, or /
    let start = i;
    while (i < input.length && !/[\s{}\[\]\/]/.test(input[i])) {
      // Handle quoted strings within a TypeSpec (e.g. Application#"System Settings")
      if (input[i] === '"') {
        i++; // skip opening quote
        while (i < input.length && input[i] !== '"') i++;
        if (i < input.length) i++; // skip closing quote
      } else if (input[i] === "'") {
        i++; // skip opening quote
        while (i < input.length && input[i] !== "'") i++;
        if (i < input.length) i++; // skip closing quote
      } else {
        i++;
      }
    }
    tokens.push(input.slice(start, i));
  }

  return tokens;
}
