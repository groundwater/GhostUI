import { describe, expect, test } from "bun:test";
import { parseQuery, queryHasIntrospection } from "./query.js";

describe("queryHasIntrospection", () => {
  test("detects leaf introspection", () => {
    expect(queryHasIntrospection(parseQuery("Button[**]"))).toBe(true);
    expect(queryHasIntrospection(parseQuery("Button[*]"))).toBe(true);
    expect(queryHasIntrospection(parseQuery("Button[subrole,*]"))).toBe(true);
  });

  test("detects nested introspection", () => {
    expect(queryHasIntrospection(parseQuery("Window { Button[**] }"))).toBe(true);
  });

  test("returns false for raw queries", () => {
    expect(queryHasIntrospection(parseQuery("Window { Button }"))).toBe(false);
  });
});

describe("parseQuery — transparent scoped queries", () => {
  test("@Application { Button } parses omitWrapper scope", () => {
    expect(parseQuery("@Application { Button }")).toEqual([{
      tag: "Application",
      omitWrapper: true,
      children: [{ tag: "Button" }],
    }]);
  });

  test("@@Application { Button } also erases ancestor wrappers", () => {
    expect(parseQuery("@@Application { Button }")).toEqual([{
      tag: "Application",
      omitWrapper: true,
      omitAncestors: true,
      children: [{ tag: "Button" }],
    }]);
  });

  test("@@{ Button } aliases @@** { Button }", () => {
    expect(parseQuery("@@{ Button }")).toEqual(parseQuery("@@** { Button }"));
  });

  test("@@ / Button uses the root transparent scope", () => {
    expect(parseQuery("@@ / Button")).toEqual([{
      tag: "**",
      omitWrapper: true,
      omitAncestors: true,
      children: [{ tag: "Button", directChild: true }],
    }]);
  });

  test("X@Application { Button } preserves rename semantics", () => {
    expect(parseQuery("X@Application { Button }")).toEqual([{
      tag: "Application",
      as: "X",
      children: [{ tag: "Button" }],
    }]);
  });
});

describe("parseQuery — backslash elimination segments", () => {
  test("\\Foo\\ parses a transparent elimination chain", () => {
    expect(parseQuery("\\Foo\\")).toEqual([{
      tag: "**",
      children: [{ tag: "Foo", elide: true }],
    }]);
  });

  test("\\Foo\\Bar\\ parses chained elimination segments", () => {
    expect(parseQuery("\\Foo\\Bar\\")).toEqual([{
      tag: "**",
      children: [{
        tag: "Foo",
        elide: true,
        children: [{ tag: "Bar", elide: true }],
      }],
    }]);
  });

  test("Application#Codex\\Group\\* marks Group as an elided path segment", () => {
    expect(parseQuery("Application#Codex\\Group\\*")).toEqual([{
      tag: "Application",
      id: "Codex",
      children: [{
        tag: "Group",
        elide: true,
        children: [{ tag: "*" }],
      }],
    }]);
  });
});

describe("parseQuery — hybrid introspection brackets", () => {
  test("[subrole,*] parses as predicates plus remainder introspection", () => {
    expect(parseQuery("Button[subrole,*]")).toEqual([{
      tag: "Button",
      predicates: [{ attr: "subrole", op: "exists" }],
      introspect: "*",
      introspectRemainder: true,
    }]);
  });

  test("[subrole, **] supports full-value remainder introspection", () => {
    expect(parseQuery("Button[subrole, **]")).toEqual([{
      tag: "Button",
      predicates: [{ attr: "subrole", op: "exists" }],
      introspect: "**",
      introspectRemainder: true,
    }]);
  });

  test("[subrole *] stays an ordinary invalid predicate token", () => {
    expect(parseQuery("Button[subrole *]")).toEqual([{
      tag: "Button",
      predicates: [{ attr: "subrole *", op: "exists" }],
    }]);
  });
});

describe("parseQuery — / direct child operator", () => {
  test("A / B parses as A with directChild B", () => {
    expect(parseQuery("A / B")).toEqual([{
      tag: "A",
      children: [{ tag: "B", directChild: true }],
    }]);
  });

  test("A/B without spaces", () => {
    expect(parseQuery("A/B")).toEqual([{
      tag: "A",
      children: [{ tag: "B", directChild: true }],
    }]);
  });

  test("A / B / C right-associative chain", () => {
    expect(parseQuery("A / B / C")).toEqual([{
      tag: "A",
      children: [{
        tag: "B",
        directChild: true,
        children: [{ tag: "C", directChild: true }],
      }],
    }]);
  });

  test("A / { B C } distributes directChild", () => {
    expect(parseQuery("A / { B C }")).toEqual([{
      tag: "A",
      children: [
        { tag: "B", directChild: true },
        { tag: "C", directChild: true },
      ],
    }]);
  });

  test("X { A / B C } parses as two siblings inside X", () => {
    expect(parseQuery("X { A / B C }")).toEqual([{
      tag: "X",
      children: [
        { tag: "A", children: [{ tag: "B", directChild: true }] },
        { tag: "C" },
      ],
    }]);
  });

  test("A / B { C } — B directChild with brace children", () => {
    expect(parseQuery("A / B { C }")).toEqual([{
      tag: "A",
      children: [{
        tag: "B",
        directChild: true,
        children: [{ tag: "C" }],
      }],
    }]);
  });

  test("A / * — wildcard direct child", () => {
    expect(parseQuery("A / *")).toEqual([{
      tag: "A",
      children: [{ tag: "*", directChild: true }],
    }]);
  });

  test("A / ** — parse error", () => {
    expect(() => parseQuery("A / **")).toThrow();
  });

  test("/ B — parse error (no left operand)", () => {
    expect(() => parseQuery("/ B")).toThrow();
  });
});

describe("parseQuery — // descendant operator", () => {
  test("A // B same as A { B }", () => {
    expect(parseQuery("A // B")).toEqual([{
      tag: "A",
      children: [{ tag: "B" }],
    }]);
  });

  test("A//B without spaces", () => {
    expect(parseQuery("A//B")).toEqual([{
      tag: "A",
      children: [{ tag: "B" }],
    }]);
  });

  test("A // B // C chain", () => {
    expect(parseQuery("A // B // C")).toEqual([{
      tag: "A",
      children: [{
        tag: "B",
        children: [{ tag: "C" }],
      }],
    }]);
  });

  test("A // { B C } distributes (no directChild)", () => {
    expect(parseQuery("A // { B C }")).toEqual([{
      tag: "A",
      children: [
        { tag: "B" },
        { tag: "C" },
      ],
    }]);
  });

  test("A / B // C — mixed operators", () => {
    expect(parseQuery("A / B // C")).toEqual([{
      tag: "A",
      children: [{
        tag: "B",
        directChild: true,
        children: [{ tag: "C" }],
      }],
    }]);
  });

  test("A // ** — parse error", () => {
    expect(() => parseQuery("A // **")).toThrow();
  });

  test("// B — parse error", () => {
    expect(() => parseQuery("// B")).toThrow();
  });
});
