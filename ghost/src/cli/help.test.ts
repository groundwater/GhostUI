import { describe, expect, test } from "bun:test";
import {
  findHelpTopic,
  findNearestHelpTopic,
  listHelpTopics,
  renderHelpIndex,
  renderHelpTopic,
  renderRootHelp,
  renderUsage,
  renderUnknownHelpTopic,
} from "./help.js";
import { listSkillTargets, renderSkill, renderSkillList } from "./skills.js";

describe("cli help rendering", () => {
  test("renders a short top-level landing page", () => {
    const help = renderRootHelp();

    expect(help).toContain("gui - query and interact with the macOS GUI");
    expect(help).toContain("gui ca script -");
    expect(help).toContain("gui gfx <subcommand>");
    expect(help).not.toContain("gui ca highlight -");
    expect(help).toContain("gui vat <subcommand>");
    expect(help).not.toContain("gui draw script -");
    expect(help).toContain("gui help [topic]");
    expect(help).toContain("gui skill <target>");
    expect(help).toContain("gui rec <mode>");
    expect(help).toContain("Run `gui help` for the full index.");
  });

  test("renders a detailed help index with command and concept topics", () => {
    const help = renderHelpIndex();

    expect(help).toContain("gui help - command and skill reference");
    expect(help).toContain("gui help query");
    expect(help).toContain("gui help ca");
    expect(help).toContain("gui help gfx");
    expect(help).not.toContain("gui help draw");
    expect(help).toContain("gui help rec");
    expect(help).toContain("gui help query-language");
    expect(help).toContain("gui help vat");
    expect(help).toContain("gui help vat mount");
    expect(help).toContain("gui help vat mounts");
    expect(help).toContain("gui help vat policy");
    expect(help).toContain("gui help vat unmount");
    expect(help).toContain("gui help vat query");
    expect(help).toContain("gui help vat watch");
    expect(help).toContain("gui skill claude");
    expect(help).toContain("gui skill codex");
  });

  test("vat help documents the daemon-owned VAT entrypoint", () => {
    const help = renderHelpTopic("vat");

    expect(help).toContain("gui vat mount /Some/Path <driver> [args...]");
    expect(help).toContain("gui vat mounts");
    expect(help).toContain("gui vat policy /Some/Path always|disabled|auto <never|seconds>");
    expect(help).toContain("gui vat unmount /Some/Path");
    expect(help).toContain("gui vat query '<query>'");
    expect(help).toContain("gui vat watch [--once] [--filter <kinds>] '<query>'");
    expect(help).toContain("gui vat mount /demo fixed hello world");
    expect(help).toContain("gui vat mount /demo a11y 'Application#com.apple.TextEdit { Window }'");
    expect(help).toContain("gui vat mount /demo live 'Application#com.apple.TextEdit { Window }'");
    expect(help).toContain("gui vat unmount /demo");
    expect(help).toContain("The a11y driver snapshots raw accessibility trees with a GUIML query");
    expect(help).toContain("The live driver preserves the previous processed live-tree prototype under an honest name.");
    expect(help).toContain("The mounted path becomes the wrapper tag in the printed GUIML.");
    expect(help).toContain("VAT mounts are persisted in the daemon-owned mount table.");
    expect(help).toContain("may lazily activate auto mounts");
    expect(help).toContain("gui vat watch refetches VAT query results");
  });

  test("vat mount help documents the mount entrypoint", () => {
    const help = renderHelpTopic("vat mount");

    expect(help).toContain("gui vat mount /Some/Path <driver> [args...]");
    expect(help).toContain("gui vat mount /demo fixed hello world");
    expect(help).toContain("gui vat mount /demo a11y 'Application#com.apple.TextEdit { Window }'");
    expect(help).toContain("gui vat mount /demo live 'Application#com.apple.TextEdit { Window }'");
    expect(help).toContain("gui vat unmount /demo");
    expect(help).toContain("The a11y driver snapshots raw accessibility trees with a GUIML query");
    expect(help).toContain("The live driver preserves the previous processed live-tree prototype under an honest name.");
    expect(help).toContain("The mounted path becomes the wrapper tag in the printed GUIML.");
    expect(help).toContain("New mounts default to the always policy; change that with gui vat policy.");
    expect(help).toContain("smoke test");
  });

  test("vat mounts help documents metadata-only listings", () => {
    const help = renderHelpTopic("vat mounts");

    expect(help).toContain("gui vat mounts");
    expect(help).toContain("Mount listings do not include the mounted trees themselves.");
    expect(help).toContain("Use --json or --text before the VAT subcommand to force machine-readable or human-readable output; pipe stdout to default to JSON.");
  });

  test("vat policy help documents policy changes", () => {
    const help = renderHelpTopic("vat policy");

    expect(help).toContain("gui vat policy /Some/Path always");
    expect(help).toContain("gui vat policy /Some/Path auto <seconds>");
    expect(help).toContain("always mounts eagerly and stays active.");
    expect(help).toContain("auto activates lazily on VAT queries");
    expect(help).not.toContain("path reads");
  });

  test("vat query help documents the union root behavior", () => {
    const help = renderHelpTopic("vat query");

    expect(help).toContain("gui vat query '<query>'");
    expect(help).toContain("union of all mounted VAT trees");
    expect(help).toContain("Introspection queries like [*] and [**] are supported here.");
  });

  test("vat watch help documents streaming behavior and filter kinds", () => {
    const help = renderHelpTopic("vat watch");

    expect(help).toContain("gui vat watch [--once] [--filter <kinds>] '<query>'");
    expect(help).toContain("--filter accepts a comma-separated subset of added, removed, updated.");
    expect(help).toContain("no initial payload");
    expect(help).toContain("source vat.watch");
  });

  test("ca help reflects the supported primitive kinds", () => {
    const help = renderHelpTopic("ca");

    expect(help).toContain("\"kind\":\"rect\"");
    expect(help).toContain("\"kind\":\"xray\"");
    expect(help).toContain("`DrawScript = { coordinateSpace: \"screen\"; timeout?: number; items: Array<{ kind: \"rect\" | \"line\" | \"xray\"; ... }> }`");
    expect(help).toContain("\"timeout\":1200");
    expect(help).toContain("\"direction\":\"leftToRight\"");
    expect(help).toContain("\"animation\":{\"durMs\":650}");
    expect(help).toContain("Without timeout");
    expect(help).toContain("xray-only sessions auto-finish from that duration");
    expect(help).toContain("xray capture requires Screen Recording permission");
    expect(help).toContain("current xray MVP is single-display");
    expect(help).toContain("timeout still controls the attached route lifetime");
    expect(help).toContain("Supports rect, line, and xray items");
    expect(help).toContain("gui ca script -");
    expect(help).not.toContain("gui ca highlight [--timeout <ms>] -");
    expect(help).not.toContain("gui ax query --only --app Terminal '@@{Button[subrole~=DecrementPage]}' | gui ca highlight -");
    expect(help).not.toContain("gui draw script -");
    expect(renderHelpTopic("draw")).toContain("Unknown help topic: draw");
  });

  test("gfx help documents the public visual annotation command family", () => {
    const help = renderHelpTopic("gfx");

    expect(help).toContain("gui gfx outline [--timeout <ms>] -");
    expect(help).toContain("gui gfx scan [--timeout <ms>] -");
    expect(help).toContain("gui gfx xray [--timeout <ms>] -");
    expect(help).toContain("gui gfx spotlight [--timeout <ms>] -");
    expect(help).toContain("gui gfx arrow [--timeout <ms>] -");
    expect(help).toContain("gui gfx text [--timeout <ms>] \"<text>\" -");
    expect(help).toContain("share the same target contract");
    expect(help).toContain("only drives the red scan-line overlay");
    expect(help).toContain("Duplicate bounds are deduplicated");
    expect(help).toContain("`gfx write` is intentionally not shipped.");
    expect(help).not.toContain("gui gfx write");
  });

  test("resolves canonical help topics and rejects removed AX shorthand", () => {
    expect(findHelpTopic("q")?.id).toBe("query");
    expect(renderHelpTopic("q")).toContain("gui help query");
    expect(renderHelpTopic("q")).toContain("gui q '<query>'");
    expect(findHelpTopic("crdt q")?.id).toBe("crdt query");
    expect(renderHelpTopic("crdt q")).toContain("gui crdt q '<query>'");

    expect(findHelpTopic("vat")?.id).toBe("vat");
    expect(findHelpTopic("vat mount")?.id).toBe("vat mount");
    expect(findHelpTopic("vat mounts")?.id).toBe("vat mounts");
    expect(findHelpTopic("vat policy")?.id).toBe("vat policy");
    expect(findHelpTopic("vat unmount")?.id).toBe("vat unmount");
    expect(findHelpTopic("vat query")?.id).toBe("vat query");
    expect(findHelpTopic("vat watch")?.id).toBe("vat watch");
    expect(findHelpTopic("mount")).toBeUndefined();

    expect(findHelpTopic("ax q")).toBeUndefined();
    expect(renderHelpTopic("ax q")).toContain("Unknown help topic: ax q");
    expect(renderHelpTopic("ax q")).not.toContain("gui ax q");
  });

  test("ax snapshot topic is registered and has correct flags", () => {
    expect(findHelpTopic("ax snapshot")?.id).toBe("ax snapshot");
    const help = renderHelpTopic("ax snapshot");
    expect(help).toContain("--pid");
    expect(help).toContain("--depth");
    expect(help).toContain("gui ax snapshot");
  });

  test("ax tree topic documents --pid and --depth flags", () => {
    expect(findHelpTopic("ax tree")?.id).toBe("ax tree");
    const help = renderHelpTopic("ax tree");
    expect(help).toContain("--pid");
    expect(help).toContain("--depth");
  });

  test("ax query topic documents explicit scope selectors", () => {
    const help = renderHelpTopic("ax query");
    expect(help).toContain("--focused");
    expect(help).toContain("--app <bundle|name>");
    expect(help).toContain("--all");
    expect(help).toContain("--gui");
    expect(help).toContain("--visible");
    expect(help).toContain("--pid");
    expect(help).toContain("--only");
    expect(help).toContain("--each");
    expect(help).toContain("--json");
    expect(help).toContain("nested GUIML");
    expect(help).toContain("one merged GUIML tree containing all matches");
    expect(help).toContain("one GUIML tree per match separated by blank lines");
    expect(help).toContain("serialized AX query match objects");
    expect(help).toContain("Choose exactly one scope selector:");
    expect(help).toContain("  --gui");
    expect(help).toContain("  --visible");
    expect(help).toContain("  --focused");
    expect(help).toContain("  --pid <pid>");
    expect(help).toContain("  --app <bundle|name>");
    expect(help).toContain("  --all");
    expect(help).toContain("gui ax query --all [--json | --ndjson | --guiml] [--first | --only | --each] '<query>'");
    expect(help).toContain("--gui searches regular apps, matching the existing dock-icon style app set.");
    expect(help).toContain("--visible searches the regular apps that also have visible GUI windows.");
    expect(help).toContain("Use exactly one of --all, --gui, or --visible as the app-wide scope selector.");
    expect(help).toContain("--gui and --visible are invalid with stdin-refined AX queries.");
    expect(help).toContain("--gui and --visible are invalid with --focused, --pid, and --app.");
    expect(help).toContain("gui ax query --gui [--json | --ndjson | --guiml] [--first | --only | --each] '<query>'");
    expect(help).toContain("gui ax query --visible [--json | --ndjson | --guiml] [--first | --only | --each] '<query>'");
    expect(help).toContain("GUIML output supports introspection queries like [*] or [**], and hybrid comma forms like [title,*].");
    expect(help).toContain("JSON and NDJSON also preserve them in serialized AX matches.");
    expect(help).toContain("`Text` is the one broad text-control alias");
    expect(help).toContain("gui ax query --gui 'Application'");
    expect(help).toContain("gui ax query --visible 'Application'");
    expect(help).toContain("gui ax cursor | gui ax query 'Text'");
    expect(help).not.toContain("gui ax cursor | gui ax query 'Input'");
    expect(help).toContain("relative to that payload");
    expect(help).not.toContain("gui ax query --all --gui 'Application'");
    expect(help).not.toContain("gui ax query --all --visible 'Window'");
    expect(help).not.toContain("gui ax q does not support introspection queries like [*] or [**].");
  });

  test("query-language topic does not redirect AX introspection to CRDT", () => {
    const help = renderHelpTopic("query-language");
    expect(help).toContain("Queries support [*] and [**] for introspection, plus comma-only hybrid forms like [title,*] or [title,**]. AX GUIML output renders them too.");
    expect(help).toContain("`Text` is the one broad text-control alias");
    expect(help).not.toContain("Use gui crdt q for introspection output");
  });

  test("ax events topic documents --pid and --bundle flags", () => {
    expect(findHelpTopic("ax events")?.id).toBe("ax events");
    const help = renderHelpTopic("ax events");
    expect(help).toContain("--pid");
    expect(help).toContain("--bundle");
  });

  test("ax parent topic lists snapshot in usage", () => {
    const help = renderHelpTopic("ax");
    expect(help).toContain("gui ax snapshot");
    expect(help).toContain("--pid");
    expect(help).toContain("--depth");
    expect(help).toContain("gui ax actions -");
    expect(help).toContain("gui ax type - '<value>'");
    expect(help).toContain("gui ax hover -");
    expect(help).not.toContain("gui ax click <query>");
    expect(help).not.toContain("gui ax focus '<query>'");
    expect(help).not.toContain("gui ax perform '<query>' <AXAction>");
  });

  test("ax action topics document stdin-consuming forms", () => {
    expect(renderHelpTopic("ax query")).toContain("`AXCursor = { type: \"ax.cursor\"; target: AXTarget; selection?: { location: number; length: number } }`");
    expect(renderHelpTopic("ax query")).toContain("`AXTarget = { type: \"ax.target\"; pid: number; point: { x: number; y: number }; role: string; bounds?: { x: number; y: number; width: number; height: number }; ... }`");
    expect(renderHelpTopic("ax query")).toContain("`AXQueryMatch = { type: \"ax.query-match\"; pid: number; node: PlainNode; target?: AXTarget; targetError?: string }`");

    expect(renderHelpTopic("ax actions")).toContain("gui ax actions -");
    expect(renderHelpTopic("ax actions")).toContain("gui ax query --only 'Button#Save' | gui ax actions -");
    expect(renderHelpTopic("ax actions")).toContain("literal JSON AX target-bearing payload");
    expect(renderHelpTopic("ax actions")).toContain("`AXCursor = { type: \"ax.cursor\"; target: AXTarget; selection?: { location: number; length: number } }`");
    expect(renderHelpTopic("ax actions")).toContain("`AXTarget = { type: \"ax.target\"; pid: number; point: { x: number; y: number }; role: string; bounds?: { x: number; y: number; width: number; height: number }; ... }`");
    expect(renderHelpTopic("ax actions")).toContain("`AXQueryMatch = { type: \"ax.query-match\"; pid: number; node: PlainNode; target?: AXTarget; targetError?: string }`");
    expect(renderHelpTopic("ax actions")).not.toContain("gui ax actions 'Button#Save'");

    expect(renderHelpTopic("ax type")).toContain("gui ax type - '<value>'");
    expect(renderHelpTopic("ax type")).toContain("gui ax query --only 'TextField#Name' | gui ax type - 'Ada'");
    expect(renderHelpTopic("ax type")).toContain("gui ax cursor | gui ax type - 'foo'");
    expect(renderHelpTopic("ax type")).toContain("literal JSON AX cursor or other AX target-bearing payload");
    expect(renderHelpTopic("ax type")).toContain("`AXCursor = { type: \"ax.cursor\"; target: AXTarget; selection?: { location: number; length: number } }`");
    expect(renderHelpTopic("ax type")).toContain("`AXTarget = { type: \"ax.target\"; pid: number; point: { x: number; y: number }; role: string; bounds?: { x: number; y: number; width: number; height: number }; ... }`");
    expect(renderHelpTopic("ax type")).toContain("`AXQueryMatch = { type: \"ax.query-match\"; pid: number; node: PlainNode; target?: AXTarget; targetError?: string }`");
    expect(renderHelpTopic("ax type")).not.toContain("gui ax type 'TextField#Name' 'Ada'");

    expect(findHelpTopic("ax focus-window")?.id).toBe("ax focus-window");
    expect(findHelpTopic("ax window")).toBeUndefined();
    expect(renderHelpTopic("ax focus-window")).toContain("gui ax focus-window '<json>'");
    expect(renderHelpTopic("ax focus-window")).toContain("gui ax cursor | gui ax focus-window -");
    expect(renderHelpTopic("ax focus-window")).toContain("gui ax query --only 'TextField#Name' | gui ax focus-window - | gui ax select -");
    expect(renderHelpTopic("ax focus-window")).toContain("`AXCursor = { type: \"ax.cursor\"; target: AXTarget; selection?: { location: number; length: number } }`");
    expect(renderHelpTopic("ax focus-window")).toContain("`AXTarget = { type: \"ax.target\"; pid: number; point: { x: number; y: number }; role: string; bounds?: { x: number; y: number; width: number; height: number }; ... }`");
    expect(renderHelpTopic("ax focus-window")).toContain("`AXQueryMatch = { type: \"ax.query-match\"; pid: number; node: PlainNode; target?: AXTarget; targetError?: string }`");
    expect(renderHelpTopic("ax focus-window")).toContain("containing AX window or sheet");

    expect(renderHelpTopic("ax select")).toContain("gui ax cursor | gui ax select");
    expect(renderHelpTopic("ax select")).toContain("gui ax select -");
    expect(renderHelpTopic("ax select")).toContain("gui ax select '<json>'");
    expect(renderHelpTopic("ax select")).toContain("`AXCursor = { type: \"ax.cursor\"; target: AXTarget; selection?: { location: number; length: number } }`");
    expect(renderHelpTopic("ax select")).toContain("pbpaste | gui ax focus-window - | gui ax select -");
    expect(renderHelpTopic("ax select")).toContain("saved selection range or caret");

    expect(renderHelpTopic("ax hover")).toContain("gui ax hover -");
    expect(renderHelpTopic("ax hover")).toContain("gui ax query --only 'Button#Save' | gui ax hover -");
    expect(renderHelpTopic("ax hover")).toContain("literal JSON AX target-bearing payload");
    expect(renderHelpTopic("ax hover")).not.toContain("gui ax hover 'Button#Save'");

    expect(renderHelpTopic("ax click")).toContain("gui ax click -");
    expect(renderHelpTopic("ax click")).toContain("literal JSON AX target-bearing payload");
    expect(renderHelpTopic("ax press")).toContain("gui ax press -");
    expect(renderHelpTopic("ax press")).toContain("AXPress directly");

    expect(renderHelpTopic("ax focus")).toContain("gui ax focus -");
    expect(renderHelpTopic("ax focus")).toContain("literal JSON AX target-bearing payload");

    expect(renderHelpTopic("ax cursor")).toContain("gui ax cursor");
    expect(renderHelpTopic("ax cursor")).toContain("ax.cursor");

    expect(renderHelpTopic("ax perform")).toContain("gui ax perform <AXAction> -");
    expect(renderHelpTopic("ax perform")).toContain("literal JSON AX target-bearing payload");
    expect(renderHelpTopic("ax with")).toContain("Unknown help topic: ax with");
  });

  test("actor and cg topics document the AX passthrough demo path", () => {
    expect(renderHelpTopic("actor run move")).toContain("gui actor run <name>.move [--to <x> <y> | -] [--style purposeful|fast|slow|wandering] [--timeout <ms>]");
    expect(renderHelpTopic("actor run move")).toContain("gui ax query --only 'Button#Save' | gui actor run pointer.main.move - | gui cg click -");
    expect(renderHelpTopic("actor run move")).toContain("`AXCursor = { type: \"ax.cursor\"; target: AXTarget; selection?: { location: number; length: number } }`");
    expect(renderHelpTopic("actor run click")).toContain("gui actor run <name>.click [--button left|right|middle] [--at <x> <y> | -] [--timeout <ms>]");
    expect(renderHelpTopic("actor run click")).toContain("gui ax query --only 'Button#Save' | gui actor run pointer.main.click - | gui cg click -");
    expect(renderHelpTopic("actor run click")).toContain("`AXCursor = { type: \"ax.cursor\"; target: AXTarget; selection?: { location: number; length: number } }`");
    expect(renderHelpTopic("cg move")).toContain("gui cg move -");
    expect(renderHelpTopic("cg move")).toContain("gui ax query --only 'Button#Save' | gui cg move -");
    expect(renderHelpTopic("cg move")).toContain("`AXCursor = { type: \"ax.cursor\"; target: AXTarget; selection?: { location: number; length: number } }`");
    expect(renderHelpTopic("cg click")).toContain("gui cg click - [--button left|right|middle]");
    expect(renderHelpTopic("cg click")).toContain("gui ax query --only 'Button#Save' | gui cg click -");
    expect(renderHelpTopic("cg click")).toContain("`AXCursor = { type: \"ax.cursor\"; target: AXTarget; selection?: { location: number; length: number } }`");
    expect(renderHelpTopic("cg doubleclick")).toContain("gui cg doubleclick - [--button left|right|middle]");
    expect(renderHelpTopic("cg doubleclick")).toContain("gui ax query --only 'Button#Save' | gui cg doubleclick -");
    expect(renderHelpTopic("cg doubleclick")).toContain("`AXCursor = { type: \"ax.cursor\"; target: AXTarget; selection?: { location: number; length: number } }`");
    expect(renderHelpTopic("cg drag")).toContain("gui cg drag (<fromPayload> | -) (<toPayload> | -) [--button left|right|middle]");
    expect(renderHelpTopic("cg drag")).toContain("gui cg drag - '{\"type\":\"ax.target\"");
    expect(renderHelpTopic("cg drag")).toContain("| gui cg drag - -");
    expect(renderHelpTopic("cg drag")).toContain("`AXCursor = { type: \"ax.cursor\"; target: AXTarget; selection?: { location: number; length: number } }`");
    expect(renderHelpTopic("cg scroll")).toContain("gui cg scroll - --dx <n> --dy <n>");
    expect(renderHelpTopic("cg scroll")).toContain("gui ax query --only 'ScrollArea' | gui cg scroll - --dx 0 --dy -240");
    expect(renderHelpTopic("cg scroll")).toContain("`AXCursor = { type: \"ax.cursor\"; target: AXTarget; selection?: { location: number; length: number } }`");
    expect(renderHelpTopic("cg mousepos")).toContain("shared AX target-style JSON payload");
    expect(renderHelpTopic("cg mousepos")).toContain("gui cg mousepos | gui cg click -");
    expect(renderHelpTopic("cg mousepos")).toContain("gui cg mousepos | gui ax at -");
    expect(renderHelpTopic("ax at")).toContain("gui ax at -");
    expect(renderHelpTopic("ax at")).toContain("gui cg mousepos | gui ax at -");
    expect(renderHelpTopic("ax at")).toContain("`AXCursor = { type: \"ax.cursor\"; target: AXTarget; selection?: { location: number; length: number } }`");
    expect(renderHelpTopic("rec")).toContain("AX target-bearing payload with usable bounds");
    expect(renderHelpTopic("rec image")).toContain("gui rec image -");
    expect(renderHelpTopic("rec image")).toContain("gui ax query --focused --only 'Window' | gui rec image - --out shot.png");
    expect(renderHelpTopic("rec image")).toContain("AX target-bearing payload from stdin");
    expect(renderHelpTopic("rec image")).toContain("`AXCursor = { type: \"ax.cursor\"; target: AXTarget; selection?: { location: number; length: number } }`");
    expect(renderHelpTopic("rec filmstrip")).toContain("gui rec filmstrip - --grid <cols>x<rows>");
    expect(renderHelpTopic("rec filmstrip")).toContain("gui ax query --focused --only 'ScrollArea' | gui rec filmstrip - --grid 3x2 --every 2s --out strip.png");
    expect(renderHelpTopic("rec filmstrip")).toContain("AX target-bearing payload from stdin");
    expect(renderHelpTopic("rec filmstrip")).toContain("`AXCursor = { type: \"ax.cursor\"; target: AXTarget; selection?: { location: number; length: number } }`");
  });

  test("ax action usage no longer advertises inline query forms", () => {
    expect(renderUsage("ax click")).toContain("gui ax click -");
    expect(renderUsage("ax click")).not.toContain("<query>");

    expect(renderUsage("ax set")).toContain("gui ax set \"text\" -");
    expect(renderUsage("ax set")).not.toContain("gui ax set <query>");

    expect(renderUsage("ax perform")).toContain("gui ax perform <AXAction> -");
    expect(renderUsage("ax perform")).not.toContain("gui ax perform '<query>'");

    expect(renderUsage("ax focus")).toContain("gui ax focus -");
    expect(renderUsage("ax focus")).not.toContain("gui ax focus '<query>'");
  });

  test("cg windows topic documents --layer filtering", () => {
    expect(findHelpTopic("cg windows")?.id).toBe("cg windows");
    const help = renderHelpTopic("cg windows");
    expect(help).toContain("--layer");
  });

  test("cg window-at topic is registered with coordinate usage", () => {
    expect(findHelpTopic("cg window-at")?.id).toBe("cg window-at");
    const help = renderHelpTopic("cg window-at");
    expect(help).toContain("<x> <y>");
    expect(help).toContain("--layer");
    expect(help).toContain("gui cg window-at -");
    expect(help).toContain("gui cg mousepos | gui cg window-at - | gui window focus -");
  });

  test("window topics document CG window JSON stdin forms", () => {
    expect(renderHelpTopic("window focus")).toContain("gui window focus -");
    expect(renderHelpTopic("window focus")).toContain("gui cg mousepos | gui cg window-at - | gui window focus -");
    expect(renderHelpTopic("window focus")).toContain("`RawCGWindow = { pid: number; cgWindowId?: number; windowNumber?: number; x: number; y: number; w: number; h: number; layer?: number; title?: string; owner?: string }`");
    expect(renderHelpTopic("window focus")).toContain("`RawCGWindow[]` is also accepted when it contains exactly one element.");
    expect(renderHelpTopic("window drag")).toContain("gui window drag - <toX> <toY>");
    expect(renderHelpTopic("window drag")).toContain("gui cg mousepos | gui cg window-at - | gui window drag - 120 90");
    expect(renderHelpTopic("window drag")).toContain("`RawCGWindow = { pid: number; cgWindowId?: number; windowNumber?: number; x: number; y: number; w: number; h: number; layer?: number; title?: string; owner?: string }`");
    expect(renderHelpTopic("window drag")).toContain("`RawCGWindow[]` is also accepted when it contains exactly one element.");
  });

  test("json-input topics include concrete TypeScript payload shapes", () => {
    expect(renderHelpTopic("ca")).toContain("coordinateSpace: \"screen\"");
    expect(renderHelpTopic("ax click")).toContain("type: \"ax.target\"");
    expect(renderHelpTopic("ax click")).toContain("type: \"ax.query-match\"");
    expect(renderHelpTopic("cg window-at")).toContain("type: \"ax.cursor\"");
    expect(renderHelpTopic("rec")).toContain("selection?: { location: number; length: number }");
  });

  test("registers the actor help subtree", () => {
    expect(findHelpTopic("actor")?.id).toBe("actor");
    expect(findHelpTopic("actor run")?.id).toBe("actor run");
    expect(findHelpTopic("actor run move")?.id).toBe("actor run move");
    expect(renderHelpTopic("actor run")).toContain("gui actor run <name>.move");
    expect(renderHelpTopic("actor run move")).toContain("gui actor run <name>.move [--to <x> <y> | -]");
  });

  test("finds the nearest actor help topic from argv-like tokens", () => {
    expect(findNearestHelpTopic(["actor", "run", "pointer.main.move"])?.id).toBe("actor run move");
    expect(findNearestHelpTopic(["actor", "run", "pointer.main.move", "--help"])?.id).toBe("actor run move");
    expect(findNearestHelpTopic(["actor", "kill", "pointer.main"])?.id).toBe("actor kill");
    expect(findNearestHelpTopic(["actor", "pointer.main", "run", "move"])?.id).toBe("actor run move");
    expect(findNearestHelpTopic(["actor", "pointer.main", "kill"])?.id).toBe("actor kill");
    expect(findNearestHelpTopic(["actor", "spawn", "pointer", "pointer.main"])?.id).toBe("actor spawn");
  });

  test("finds explicit actor help topics", () => {
    expect(findNearestHelpTopic(["actor", "run"])?.id).toBe("actor run");
    expect(findNearestHelpTopic(["actor", "run", "move"])?.id).toBe("actor run move");
    expect(findNearestHelpTopic(["actor", "kill"])?.id).toBe("actor kill");
  });

  test("registers the rec help subtree", () => {
    expect(findHelpTopic("rec")?.id).toBe("rec");
    expect(findHelpTopic("rec image")?.id).toBe("rec image");
    expect(findHelpTopic("rec filmstrip")?.id).toBe("rec filmstrip");
    expect(renderHelpTopic("rec")).toContain("gui rec image --rect");
    expect(renderHelpTopic("rec filmstrip")).toContain("--grid <cols>x<rows>");
    expect(renderHelpTopic("rec video")).toContain("No shipped `gui rec video` command.");
    expect(renderHelpTopic("rec video")).toContain("Use `gui rec image` for single frames");
    expect(renderHelpTopic("rec video")).not.toContain("gui rec video --window");
  });

  test("finds the nearest rec help topic from argv-like tokens", () => {
    expect(findNearestHelpTopic(["rec", "image", "--help"])?.id).toBe("rec image");
    expect(findNearestHelpTopic(["rec", "filmstrip", "--grid", "3x3"])?.id).toBe("rec filmstrip");
    expect(findNearestHelpTopic(["rec", "video"])?.id).toBe("rec video");
  });

  test("exposes the help topic registry", () => {
    const ids = listHelpTopics().map((topic) => topic.id);

    expect(ids).toContain("query");
    expect(ids).toContain("ca");
    expect(ids).not.toContain("draw");
    expect(ids).toContain("ax query");
    expect(ids).toContain("rec");
    expect(ids).toContain("rec filmstrip");
    expect(ids).toContain("skill claude");
    expect(ids).toContain("skills");
  });

  test("suggests nearby topics for unknown help lookups", () => {
    const rendered = renderUnknownHelpTopic("quer");

    expect(rendered).toContain("Unknown help topic: quer");
    expect(rendered).toContain("gui help query");
  });
});

describe("cli skill surface", () => {
  test("lists the supported skill targets", () => {
    expect(listSkillTargets()).toEqual(["claude", "codex"]);
    expect(renderSkillList()).toContain("claude");
    expect(renderSkillList()).toContain("codex");
  });

  test("renders a stable skill payload with GhostUI command guidance", () => {
    const skill = renderSkill("claude");

    expect(skill).toContain("# GhostUI skill: Claude");
    expect(skill).toContain("## Mission");
    expect(skill).toContain("## Command map");
    expect(skill).toContain("## Operating rules");
    expect(skill).toContain("## Verification");
    expect(skill).toContain("## Failure modes");
    expect(skill).toContain("gui crdt");
    expect(skill).toContain("gui ax click");
    expect(skill).toContain("gui cg key");
  });

  test("renders a useful error for unknown skill targets", () => {
    const skill = renderSkill("wat");

    expect(skill).toContain("Unknown skill target: wat");
    expect(skill).toContain("gui skill list");
  });
});
