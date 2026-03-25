import { describe, expect, test } from "bun:test";
import {
  ACTOR_NAME_RE,
  ActorApiError,
  normalizeActorRunRequest,
  normalizeActorSpawnRequest,
  parseActorRunCLIArgs,
  parseActorSpawnCLIArgs,
} from "./protocol.js";

describe("actor protocol", () => {
  test("accepts the documented actor name grammar", () => {
    expect(ACTOR_NAME_RE.test("pointer")).toBe(true);
    expect(ACTOR_NAME_RE.test("pointer.main")).toBe(true);
    expect(ACTOR_NAME_RE.test("Pointer")).toBe(false);
    expect(ACTOR_NAME_RE.test(".pointer")).toBe(false);
  });

  test("parses CLI spawn and run arguments", () => {
    expect(parseActorSpawnCLIArgs(["pointer", "pointer.main", "--duration-scale", "0"])).toEqual({
      type: "pointer",
      name: "pointer.main",
      durationScale: 0,
    });

    expect(parseActorRunCLIArgs("move", ["--to", "840", "420", "--style", "wandering", "--timeout", "5000"])).toEqual({
      timeoutMs: 5000,
      action: {
        kind: "move",
        to: { x: 840, y: 420 },
        style: "wandering",
      },
    });

    expect(parseActorRunCLIArgs("click", ["--button", "right", "--at", "30", "40"])).toEqual({
      action: {
        kind: "click",
        button: "right",
        at: { x: 30, y: 40 },
      },
      timeoutMs: undefined,
    });
  });

  test("normalizes JSON requests", () => {
    expect(normalizeActorSpawnRequest({ type: "pointer", name: "pointer" })).toEqual({
      type: "pointer",
      name: "pointer",
      durationScale: 1,
    });

    expect(normalizeActorRunRequest({ kind: "narrate", text: "hello", timeoutMs: 1500 })).toEqual({
      action: { kind: "narrate", text: "hello" },
      timeoutMs: 1500,
    });
  });

  test("rejects bad inputs with typed actor errors", () => {
    expect(() => parseActorRunCLIArgs("scroll", ["--dx", "0"])).toThrow(ActorApiError);
    expect(() => normalizeActorSpawnRequest({ type: "bogus", name: "pointer" })).toThrow(ActorApiError);
    expect(() => normalizeActorRunRequest({ kind: "teleport" })).toThrow(ActorApiError);
  });
});
