import { describe, expect, test } from "bun:test";
import { parsePlistValue } from "./defaults.js";

describe("parsePlistValue", () => {
  test("parses plain string", () => {
    expect(parsePlistValue("Dark")).toBe("Dark");
  });

  test("parses quoted string", () => {
    expect(parsePlistValue('"hello world"')).toBe("hello world");
  });

  test("parses integer", () => {
    expect(parsePlistValue("42")).toBe(42);
  });

  test("parses 1 as true (boolean)", () => {
    expect(parsePlistValue("1")).toBe(true);
  });

  test("parses 0 as false (boolean)", () => {
    expect(parsePlistValue("0")).toBe(false);
  });

  test("parses float", () => {
    expect(parsePlistValue("3.14")).toBe(3.14);
  });

  test("parses simple plist dictionary", () => {
    const input = `{
    autohide = 1;
    tilesize = 48;
    orientation = bottom;
}`;
    const result = parsePlistValue(input) as Record<string, unknown>;
    expect(result.autohide).toBe(true);
    expect(result.tilesize).toBe(48);
    expect(result.orientation).toBe("bottom");
  });

  test("parses plist dictionary with quoted values", () => {
    const input = '{\n    name = "Hello World";\n}';
    const result = parsePlistValue(input) as Record<string, unknown>;
    expect(result.name).toBe("Hello World");
  });

  test("parses plist array", () => {
    const input = '(\n    "com.apple.dock",\n    NSGlobalDomain\n)';
    const result = parsePlistValue(input) as unknown[];
    expect(result).toContain("com.apple.dock");
    expect(result).toContain("NSGlobalDomain");
  });

  test("parses empty array", () => {
    expect(parsePlistValue("(\n)")).toEqual([]);
  });
});
