import { describe, expect, test } from "bun:test";
import { parseQuery } from "./query.js";
import { findIntrospect, renderQueryResult } from "./introspection.js";
import type { PlainNode } from "./types.js";

describe("findIntrospect", () => {
  test("finds nested introspection mode", () => {
    const queries = parseQuery("Window { Button[*] }");
    expect(findIntrospect(queries)).toBe("*");
  });

  test("returns undefined when query has no introspection", () => {
    const queries = parseQuery("Window { Button }");
    expect(findIntrospect(queries)).toBeUndefined();
  });
});

describe("renderQueryResult", () => {
  const nodes: PlainNode[] = [
    { _tag: "Button", _id: "Button:Save:0", title: "Save", checked: true },
  ];

  test("[*] renders attr names only", () => {
    const out = renderQueryResult(nodes, parseQuery("Button[*]"));
    expect(out).toBe("<Button#Save title checked />");
  });

  test("[**] preserves attr values", () => {
    const out = renderQueryResult(nodes, parseQuery("Button[**]"));
    expect(out).toBe('<Button#Save title="Save" checked />');
  });

  test("plain queries use normal GUIML rendering", () => {
    const out = renderQueryResult(nodes, parseQuery("Button"));
    expect(out).toBe('<Button#Save title="Save" checked />');
  });
});
