export interface HelpTopic {
  id: string;
  title: string;
  summary: string;
  aliases: string[];
  usage: string[];
  examples: string[];
  notes?: string[];
  related?: string[];
}

const DRAW_SCRIPT_JSON_TYPE_NOTE = [
  "TypeScript payload shape:",
  "    `DrawScript = { coordinateSpace: \"screen\"; timeout?: number; items: Array<{ kind: \"rect\" | \"line\" | \"xray\" | \"spotlight\"; ... }> }`",
].join("\n");
const AX_TARGET_JSON_TYPE_NOTE = [
  "TypeScript payload shapes:",
  "    `AXCursor = { type: \"ax.cursor\"; target: AXTarget; selection?: { location: number; length: number } }`",
  "    `AXTarget = { type: \"ax.target\"; pid: number; point: { x: number; y: number }; role: string; bounds?: { x: number; y: number; width: number; height: number }; ... }`",
  "    `AXQueryMatch = { type: \"ax.query-match\"; pid: number; node: PlainNode; target?: AXTarget; targetError?: string }`",
].join("\n");
const AX_TARGET_BEARING_JSON_TYPE_NOTE = [
  "TypeScript payload shapes:",
  "    `AXCursor = { type: \"ax.cursor\"; target: AXTarget; selection?: { location: number; length: number } }`",
  "    `AXTarget = { type: \"ax.target\"; pid: number; point: { x: number; y: number }; role: string; bounds?: { x: number; y: number; width: number; height: number }; ... }`",
  "    `AXQueryMatch = { type: \"ax.query-match\"; pid: number; node: PlainNode; target?: AXTarget; targetError?: string }`",
].join("\n");
const AX_CURSOR_JSON_TYPE_NOTE = [
  "TypeScript payload shape:",
  "    `AXCursor = { type: \"ax.cursor\"; target: AXTarget; selection?: { location: number; length: number } }`",
].join("\n");
const CG_WINDOW_JSON_TYPE_NOTE = [
  "TypeScript payload shapes:",
  "    `RawCGWindow = { pid: number; cgWindowId?: number; windowNumber?: number; x: number; y: number; w: number; h: number; layer?: number; title?: string; owner?: string }`",
  "    `RawCGWindow[]` is also accepted when it contains exactly one element.",
].join("\n");

const HELP_TOPICS: HelpTopic[] = [
  {
    id: "query",
    title: "Query the live UI tree",
    summary: "Filter the live daemon-backed UI tree with the query language.",
    aliases: ["q"],
    usage: [
      "gui query '<query>'",
      "gui q '<query>'",
      "gui query '<query>' --first N",
      "gui query '<query>' --scan [durationMs]",
    ],
    examples: [
      "gui query 'Application { Window }'",
      "gui q 'Button#Save' --first 5",
      "gui query 'Button#Save' --scan 750",
    ],
    notes: [
      "Writes GUIML to stdout.",
      "Use --app <name|bundleId> when the target app is not frontmost.",
    ],
    related: ["query-language", "output", "ids", "crdt query"],
  },
  {
    id: "ca",
    title: "Render overlay scripts",
    summary: "Send a JSON draw script to the native overlay runtime. timeout controls non-xray attachment lifetime; xray-only sessions auto-finish from animation.durMs.",
    aliases: [],
    usage: [
      "gui ca script -",
    ],
    examples: [
      "echo '{\"items\":[{\"kind\":\"rect\",\"rect\":{\"x\":420,\"y\":240,\"width\":240,\"height\":140}}]}' | gui ca script -",
      "echo '{\"timeout\":1200,\"items\":[{\"kind\":\"line\",\"line\":{\"from\":{\"x\":220,\"y\":240},\"to\":{\"x\":760,\"y\":240}}}]}' | gui ca script -",
      "echo '{\"items\":[{\"kind\":\"rect\",\"rect\":{\"x\":100,\"y\":100,\"width\":400,\"height\":300}}]}' | gui ca script -",
      "echo '{\"items\":[{\"kind\":\"xray\",\"rect\":{\"x\":100,\"y\":100,\"width\":400,\"height\":300},\"direction\":\"leftToRight\",\"animation\":{\"durMs\":650}}]}' | gui ca script -",
    ],
    notes: [
      "Reads JSON from stdin, validates it, and stays attached to the daemon route until the draw script ends or the process is closed.",
      DRAW_SCRIPT_JSON_TYPE_NOTE,
      "Without timeout, the overlay stays up until you terminate the attached client or the HTTP route closes.",
      "Set timeout in milliseconds to auto-close the route and clear the attached overlay.",
      "For xray items, animation.durMs controls the sweep speed and xray-only sessions auto-finish from that duration.",
      "xray capture requires Screen Recording permission.",
      "The current xray MVP is single-display.",
      "timeout still controls the attached route lifetime for the command session.",
      "Supports rect, line, xray, and spotlight items in screen coordinates.",
    ],
    related: ["output"],
  },
  {
    id: "gfx",
    title: "Render visual annotation overlays",
    summary: "Resolve one AX/VAT target-bearing payload from stdin and render it through the public visual-annotation command family.",
    aliases: [],
    usage: [
      "gui gfx outline -",
      "gui gfx scan [--duration <milliseconds>] -",
      "gui gfx xray [--duration <milliseconds>] -",
      "gui gfx spotlight [--duration <milliseconds>] -",
      "gui gfx arrow [--color <hex>] [--size <points>] [--length <pixels>] [--duration <milliseconds>] [--target <anchor>] [--from <x> <y>] -",
    ],
    examples: [
      "gui ax query --only --app Terminal '@@{Button[subrole~=DecrementPage]}' | gui gfx outline -",
      "gui vat query 'Window[frame]' | gui gfx scan --duration 750 -",
      "gui vat query 'Window[frame]' | gui gfx xray -",
      "gui vat query 'Window[frame]' | gui gfx spotlight --duration 900 -",
      "gui vat query 'Window[frame]' | gui gfx arrow -",
    ],
    notes: [
      "Reads exactly one AX/VAT target-bearing JSON payload from stdin.",
      "`outline`, `xray`, `spotlight`, and `arrow` share the same target contract: VAT query payloads expand over every bounds-bearing descendant in deterministic traversal order, while AX payloads render once from their single target bounds.",
      "`scan` resolves the same AX/VAT bounds but only drives the red scan-line overlay; it does not add outline/highlight rects.",
      "`spotlight` does not outline the target. It computes the union of all resolved bounds and dims the complement outside that union.",
      "`spotlight` accepts --duration and defaults to 1200ms, matching the other non-scan/xray overlay lifetimes.",
      "`arrow` defaults to color `#FF3B30`, size `6`, length `100`, duration `400`, and target `center`. Use --target with center, topleft, topright, bottomleft, bottomright, left, top, right, or bottom to pick the anchor point on the resolved target rect. Use --from <x> <y> to override the starting point and ignore --length.",
      AX_TARGET_BEARING_JSON_TYPE_NOTE,
      "`scan` defaults to 500ms. `xray` defaults to 650ms. `spotlight` and `outline` default to 1200ms. `arrow` defaults to 400ms.",
      "Duplicate bounds are deduplicated before rendering so the same rect is not annotated twice.",
      "`gfx write` is intentionally not shipped.",
    ],
    related: ["ca", "output"],
  },
  {
    id: "print",
    title: "Print a single property",
    summary: "Print one property value from the live UI tree.",
    aliases: ["p"],
    usage: [
      "gui print <selector>... .property",
      "gui p <selector>... .property",
    ],
    examples: [
      "gui print Button#Save .value",
      "gui p Window#Main Button#Save .enabled",
    ],
    notes: [
      "Writes the matched path to stderr and the property value to stdout.",
      "The final argument must be a .property token.",
    ],
    related: ["query", "output"],
  },
  {
    id: "window",
    title: "Window actions",
    summary: "Focus or drag windows by cgWindowId.",
    aliases: [],
    usage: [
      "gui window focus <cgWindowId>",
      "gui window drag <cgWindowId> <toX> <toY>",
    ],
    examples: [
      "gui window focus 13801",
      "gui window drag 13801 120 90",
    ],
    related: ["window focus", "window drag", "crdt", "cg windows"],
  },
  {
    id: "window focus",
    title: "Focus a window",
    summary: "Queue focus for a window identified by cgWindowId.",
    aliases: [],
    usage: ["gui window focus <cgWindowId>", "gui window focus -"],
    examples: ["gui window focus 13801", "gui cg mousepos | gui cg window-at - | gui window focus -"],
    notes: [
      "Pass `-` to read one JSON CG window payload from stdin, such as the output of gui cg window-at.",
      CG_WINDOW_JSON_TYPE_NOTE,
    ],
    related: ["window", "cg window-at", "cg mousepos"],
  },
  {
    id: "window drag",
    title: "Drag a window",
    summary: "Queue a drag for a window identified by cgWindowId.",
    aliases: [],
    usage: ["gui window drag <cgWindowId> <toX> <toY>", "gui window drag - <toX> <toY>"],
    examples: ["gui window drag 13801 120 90", "gui cg mousepos | gui cg window-at - | gui window drag - 120 90"],
    notes: [
      "Pass `-` to read one JSON CG window payload from stdin, such as the output of gui cg window-at.",
      CG_WINDOW_JSON_TYPE_NOTE,
    ],
    related: ["window", "cg window-at", "cg mousepos"],
  },
  {
    id: "actor",
    title: "Visual actor actions",
    summary: "Spawn, run, list, and kill daemon-owned overlay actors.",
    aliases: [],
    usage: [
      "gui actor spawn pointer <name> [--duration-scale <scale>]",
      "gui actor run <name>.<action> ...",
      "gui actor kill <name>",
      "gui actor list",
    ],
    examples: [
      "gui actor spawn pointer pointer.main",
      "gui actor run pointer.main.move --to 840 420 --style purposeful",
      "gui actor run pointer.main.click --at 840 420",
      "gui actor run pointer.main.narrate --text \"Opening Settings\"",
      "gui actor kill pointer.main",
    ],
    notes: [
      "Actors are overlay-only animation objects. They do not move the real cursor or emit OS input.",
      "A newer run on the same actor preempts the older in-flight action.",
      "durationScale 0 is valid for tests and makes actions complete immediately.",
    ],
    related: ["display", "output"],
  },
  {
    id: "actor spawn",
    title: "Spawn an actor",
    summary: "Create a named daemon-owned actor instance.",
    aliases: [],
    usage: ["gui actor spawn pointer <name> [--duration-scale <scale>]"],
    examples: [
      "gui actor spawn pointer pointer.main",
      "gui actor spawn pointer pointer.main --duration-scale 0",
    ],
    related: ["actor", "actor run", "actor kill", "actor list"],
  },
  {
    id: "actor list",
    title: "List live actors",
    summary: "Print the currently loaded actor instances.",
    aliases: [],
    usage: ["gui actor list"],
    examples: ["gui actor list"],
    related: ["actor"],
  },
  {
    id: "actor kill",
    title: "Kill an actor",
    summary: "Cancel any in-flight action and unload the actor instance.",
    aliases: [],
    usage: ["gui actor kill <name>"],
    examples: ["gui actor kill pointer.main"],
    related: ["actor", "actor run"],
  },
  {
    id: "actor run",
    title: "Run one actor action",
    summary: "Execute one semantic action against a named actor instance.",
    aliases: [],
    usage: [
      "gui actor run <name>.move --to <x> <y> [--style purposeful|fast|slow|wandering] [--timeout <ms>]",
      "gui actor run <name>.click [--button left|right|middle] [--at <x> <y>] [--timeout <ms>]",
      "gui actor run <name>.drag --to <x> <y> [--timeout <ms>]",
      "gui actor run <name>.scroll --dx <n> --dy <n> [--timeout <ms>]",
      "gui actor run <name>.think [--for <ms>] [--timeout <ms>]",
      "gui actor run <name>.narrate --text \"<text>\" [--timeout <ms>]",
      "gui actor run <name>.dismiss [--timeout <ms>]",
    ],
    examples: [
      "gui actor run pointer.main.move --to 840 420",
      "gui actor run pointer.main.click --button right",
      "gui actor run pointer.main.narrate --text \"Opening Settings\"",
    ],
    notes: [
      "Use --help or -h at any actor leaf to get the nearest specific actor usage.",
      "A newer run on the same actor preempts the older in-flight action.",
    ],
    related: ["actor", "actor run move", "actor run click", "actor run drag", "actor run scroll", "actor run think", "actor run narrate", "actor run dismiss"],
  },
  {
    id: "actor run move",
    title: "Run move",
    summary: "Move a visual pointer actor to one desktop coordinate or one piped from AX JSON.",
    aliases: [],
    usage: ["gui actor run <name>.move [--to <x> <y> | -] [--style purposeful|fast|slow|wandering] [--timeout <ms>]"],
    examples: [
      "gui actor run pointer.main.move --to 840 420 --style purposeful",
      "gui ax query --only 'Button#Save' | gui actor run pointer.main.move - | gui cg click -",
    ],
    notes: [
      "When passed `-`, the command reads one AX target-bearing payload from stdin, moves the actor to `target.point`, then re-emits that same payload on stdout after the move finishes.",
      AX_TARGET_BEARING_JSON_TYPE_NOTE,
      "When stdout is a TTY, passthrough mode stays quiet and only drives the animation.",
    ],
    related: ["actor run"],
  },
  {
    id: "actor run click",
    title: "Run click",
    summary: "Animate a click at the current actor position, an explicit coordinate, or one piped from AX JSON.",
    aliases: [],
    usage: ["gui actor run <name>.click [--button left|right|middle] [--at <x> <y> | -] [--timeout <ms>]"],
    examples: [
      "gui actor run pointer.main.click --at 840 420 --button right",
      "gui ax query --only 'Button#Save' | gui actor run pointer.main.click - | gui cg click -",
    ],
    notes: [
      "When passed `-`, the command reads one AX target-bearing payload from stdin, animates the pointer click, then re-emits that same payload on stdout after the click impact delay.",
      AX_TARGET_BEARING_JSON_TYPE_NOTE,
      "When stdout is a TTY, passthrough mode stays quiet and only drives the animation.",
    ],
    related: ["actor run"],
  },
  {
    id: "actor run drag",
    title: "Run drag",
    summary: "Animate a drag from the actor's current position to a destination.",
    aliases: [],
    usage: ["gui actor run <name>.drag --to <x> <y> [--timeout <ms>]"],
    examples: ["gui actor run pointer.main.drag --to 1200 480"],
    related: ["actor run"],
  },
  {
    id: "actor run scroll",
    title: "Run scroll",
    summary: "Animate a scroll gesture at the actor's current position.",
    aliases: [],
    usage: ["gui actor run <name>.scroll --dx <n> --dy <n> [--timeout <ms>]"],
    examples: ["gui actor run pointer.main.scroll --dx 0 --dy -480"],
    related: ["actor run"],
  },
  {
    id: "actor run think",
    title: "Run think",
    summary: "Animate a brief thinking state for the actor.",
    aliases: [],
    usage: ["gui actor run <name>.think [--for <ms>] [--timeout <ms>]"],
    examples: ["gui actor run pointer.main.think --for 1200"],
    related: ["actor run"],
  },
  {
    id: "actor run narrate",
    title: "Run narrate",
    summary: "Animate a narration bubble near the actor.",
    aliases: [],
    usage: ["gui actor run <name>.narrate --text \"<text>\" [--timeout <ms>]"],
    examples: ["gui actor run pointer.main.narrate --text \"Opening Settings\""],
    related: ["actor run"],
  },
  {
    id: "actor run dismiss",
    title: "Run dismiss",
    summary: "Hide a loaded actor without unloading it.",
    aliases: [],
    usage: ["gui actor run <name>.dismiss [--timeout <ms>]"],
    examples: ["gui actor run pointer.main.dismiss"],
    related: ["actor run"],
  },
  {
    id: "img",
    title: "Capture an element screenshot",
    summary: "Screenshot a matched element as PNG.",
    aliases: [],
    usage: [
      "gui img <query>",
      "gui img <query> --out file.png",
    ],
    examples: [
      "gui img 'Button#Save' --out save.png",
      "gui img 'Window#Main' | open -f -a Preview",
    ],
    notes: [
      "Writes PNG bytes to stdout unless --out is set.",
      "Falls back to AX lookup when the matched node has no frame geometry.",
    ],
    related: ["query", "output", "ax"],
  },
  {
    id: "rec",
    title: "Capture rects and windows",
    summary: "Capture still images or filmstrips from a rect, cgWindowId, or one piped bounds-bearing target payload.",
    aliases: [],
    usage: [
      "gui rec image --rect <x,y,w,h> [--frame-size <w>x<h>] [--format png|jpeg|heic] [--out <path>]",
      "gui rec image --window <cgWindowId> [--frame-size <w>x<h>] [--format png|jpeg|heic] [--out <path>]",
      "gui rec image - [--frame-size <w>x<h>] [--format png|jpeg|heic] [--out <path>]",
      "gui rec filmstrip --rect <x,y,w,h> --grid <cols>x<rows> [--every <duration> | --fps <n> | --duration <duration> --frames <n>] [--frame-size <w>x<h>] [--format png|jpeg|heic] [--out <path>]",
      "gui rec filmstrip --window <cgWindowId> --grid <cols>x<rows> [--every <duration> | --fps <n> | --duration <duration> --frames <n>] [--frame-size <w>x<h>] [--format png|jpeg|heic] [--out <path>]",
      "gui rec filmstrip - --grid <cols>x<rows> [--every <duration> | --fps <n> | --duration <duration> --frames <n>] [--frame-size <w>x<h>] [--format png|jpeg|heic] [--out <path>]",
    ],
    examples: [
      "gui rec image --window 13801 --out window.png",
      "gui ax query --focused --only 'Window' | gui rec image - --out shot.png",
      "gui rec filmstrip --window 13801 --grid 3x3 --every 5s --frame-size 320x200 --out strip.png",
      "gui ax query --focused --only 'ScrollArea' | gui rec filmstrip - --grid 3x2 --every 2s --out strip.png",
      "gui rec filmstrip --rect 40,60,1200,800 --grid 4x2 --duration 40s --frames 8 --format jpeg --out strip.jpg",
    ],
    notes: [
      "First slice ships image and filmstrip only. video remains intentionally unshipped until the native recorder exists.",
      "image and filmstrip write artifact bytes to stdout unless --out is set.",
      "Use gui cg windows to discover cgWindowId values for --window.",
      "The piped/literal payload form requires one AX target-bearing payload with usable bounds.",
      AX_TARGET_BEARING_JSON_TYPE_NOTE,
    ],
    related: ["rec image", "rec filmstrip", "cg windows", "output"],
  },
  {
    id: "rec image",
    title: "Capture one still image",
    summary: "Capture one rect, cgWindowId, or one bounds-bearing target payload as png, jpeg, or heic.",
    aliases: [],
    usage: [
      "gui rec image --rect <x,y,w,h> [--frame-size <w>x<h>] [--format png|jpeg|heic] [--out <path>]",
      "gui rec image --window <cgWindowId> [--frame-size <w>x<h>] [--format png|jpeg|heic] [--out <path>]",
      "gui rec image - [--frame-size <w>x<h>] [--format png|jpeg|heic] [--out <path>]",
    ],
    examples: [
      "gui rec image --window 13801 --out window.png",
      "gui rec image --rect 100,120,1440,900 --frame-size 1280x800 --format heic --out shot.heic",
      "gui ax query --focused --only 'Window' | gui rec image - --out shot.png",
    ],
    notes: [
      "Exactly one of --rect, --window, or `-` is required.",
      "png is the default format.",
      "Without --out, artifact bytes are written to stdout.",
      "When passed `-`, the command reads one AX target-bearing payload from stdin and captures its bounds as a rect.",
      AX_TARGET_BEARING_JSON_TYPE_NOTE,
    ],
    related: ["rec", "rec filmstrip", "output"],
  },
  {
    id: "rec filmstrip",
    title: "Capture one composed filmstrip",
    summary: "Capture a timed filmstrip from a rect, cgWindowId, or one bounds-bearing target payload.",
    aliases: [],
    usage: [
      "gui rec filmstrip --rect <x,y,w,h> --grid <cols>x<rows> [--every <duration> | --fps <n> | --duration <duration> --frames <n>] [--frame-size <w>x<h>] [--format png|jpeg|heic] [--out <path>]",
      "gui rec filmstrip --window <cgWindowId> --grid <cols>x<rows> [--every <duration> | --fps <n> | --duration <duration> --frames <n>] [--frame-size <w>x<h>] [--format png|jpeg|heic] [--out <path>]",
      "gui rec filmstrip - --grid <cols>x<rows> [--every <duration> | --fps <n> | --duration <duration> --frames <n>] [--frame-size <w>x<h>] [--format png|jpeg|heic] [--out <path>]",
    ],
    examples: [
      "gui rec filmstrip --window 13801 --grid 3x3 --every 5s --frame-size 320x200 --out strip.png",
      "gui rec filmstrip --rect 40,60,1200,800 --grid 4x2 --duration 40s --frames 8 --format jpeg --out strip.jpg",
      "gui ax query --focused --only 'ScrollArea' | gui rec filmstrip - --grid 3x2 --every 2s --out strip.png",
    ],
    notes: [
      "Exactly one timing mode is required: --every, --fps, or --duration with --frames.",
      "In v1, --frames must equal the grid cell count when used with --duration.",
      "Without --out, the final composed still image is written to stdout.",
      "When passed `-`, the command reads one AX target-bearing payload from stdin and captures its bounds as a rect.",
      AX_TARGET_BEARING_JSON_TYPE_NOTE,
    ],
    related: ["rec", "rec image", "output"],
  },
  {
    id: "rec video",
    title: "Planned video capture",
    summary: "The `gui rec video` command is not shipped yet.",
    aliases: [],
    usage: ["No shipped `gui rec video` command."],
    examples: [
      "gui rec image --window 13801 --out window.png",
      "gui rec filmstrip --window 13801 --grid 3x3 --every 5s --out strip.png",
    ],
    notes: [
      "`gui rec video` currently exits with a not-shipped error.",
      "Use `gui rec image` for single frames or `gui rec filmstrip` for timed multi-frame capture.",
      "Do not build video on the current full-screen screenshot path; wait for the native recorder contract.",
    ],
    related: ["rec", "rec image", "rec filmstrip"],
  },
  {
    id: "crdt",
    title: "Inspect the live CRDT tree",
    summary: "Dump or query the daemon-owned live document.",
    aliases: [],
    usage: [
      "gui crdt",
      "gui crdt query '<query>'",
      "gui crdt q '<query>'",
      "gui crdt leases",
    ],
    examples: [
      "gui crdt",
      "gui crdt query 'Application { Window }' --first 10",
      "gui crdt leases",
    ],
    notes: ["gui crdt with no subcommand dumps the full raw document as GUIML."],
    related: ["crdt query", "crdt leases", "query", "output", "ids"],
  },
  {
    id: "crdt query",
    title: "Query the CRDT tree",
    summary: "Run a query against the raw CRDT tree.",
    aliases: ["crdt q"],
    usage: [
      "gui crdt query '<query>'",
      "gui crdt q '<query>'",
      "gui crdt query '<query>' --first N",
    ],
    examples: [
      "gui crdt q 'Application { Window }' --first 10",
      "gui crdt query 'Button[*]'",
      "gui crdt query 'Button[**]' --first 3",
    ],
    notes: ["Introspection queries like [*] and [**] are supported here."],
    related: ["crdt", "query-language", "output"],
  },
  {
    id: "crdt leases",
    title: "Inspect active leases",
    summary: "Dump active focus and position window leases as JSON.",
    aliases: [],
    usage: ["gui crdt leases"],
    examples: ["gui crdt leases"],
    related: ["crdt", "output"],
  },
  {
    id: "vat",
    title: "Virtual access tables",
    summary: "Manage daemon-owned virtual access table mounts and query their union.",
    aliases: [],
    usage: [
      "gui vat mount /Some/Path <driver> [args...]",
      "gui vat mounts",
      "gui vat policy /Some/Path always|disabled|auto <never|seconds>",
      "gui vat unmount /Some/Path",
      "gui vat query '<query>'",
      "gui vat watch [--once] [--filter <kinds>] '<query>'",
    ],
    examples: [
      "gui vat mount /demo fixed hello world",
      "gui vat mount /demo a11y 'Application#com.apple.TextEdit { Window }'",
      "gui vat mount /demo live 'Application#com.apple.TextEdit { Window }'",
      "gui vat policy /demo auto 30",
      "gui vat unmount /demo",
      "gui vat query 'Application { Window }'",
      "gui vat watch --filter updated 'Window { Button }'",
    ],
    notes: [
      "The fixed driver remains a smoke test.",
      "The a11y driver snapshots raw accessibility trees with a GUIML query and mounts the projected result.",
      "The live driver preserves the previous processed live-tree prototype under an honest name.",
      "The mounted path becomes the wrapper tag in the printed GUIML.",
      "VAT mounts are persisted in the daemon-owned mount table.",
      "gui vat query runs the query over the union of active VAT trees and may lazily activate auto mounts.",
      "gui vat watch refetches VAT query results when AX observer activity suggests a touched VAT mount may have changed.",
      "Use --json or --text before the VAT subcommand to force machine-readable or human-readable output; pipe stdout to default to JSON.",
    ],
    related: ["vat mount", "vat mounts", "vat policy", "vat unmount", "vat query", "vat watch", "output"],
  },
  {
    id: "vat mount",
    title: "Mount a virtual access table entry",
    summary: "Create a daemon-owned VAT mount with a driver-backed virtual tree.",
    aliases: [],
    usage: [
      "gui vat mount /Some/Path <driver> [args...]",
    ],
    examples: [
      "gui vat mount /demo fixed hello world",
      "gui vat mount /demo a11y 'Application#com.apple.TextEdit { Window }'",
      "gui vat mount /demo live 'Application#com.apple.TextEdit { Window }'",
    ],
    notes: [
      "The fixed driver remains a smoke test.",
      "The a11y driver snapshots raw accessibility trees with a GUIML query and mounts the projected result.",
      "The live driver preserves the previous processed live-tree prototype under an honest name.",
      "The mounted path becomes the wrapper tag in the printed GUIML.",
      "Mount creates or replaces a persisted VAT table entry.",
      "New mounts default to the always policy; change that with gui vat policy.",
      "To remove a mount later, gui vat unmount /demo.",
    ],
    related: ["vat", "vat mounts", "vat policy", "vat unmount", "vat query", "output"],
  },
  {
    id: "vat mounts",
    title: "List VAT mounts",
    summary: "Print the persisted VAT mount table with live activation status.",
    aliases: [],
    usage: ["gui vat mounts"],
    examples: ["gui vat mounts"],
    notes: [
      "Mount listings do not include the mounted trees themselves.",
      "Use --json or --text before the VAT subcommand to force machine-readable or human-readable output; pipe stdout to default to JSON.",
    ],
    related: ["vat", "vat mount", "vat policy", "vat unmount", "vat query", "output"],
  },
  {
    id: "vat policy",
    title: "Update VAT mount policy",
    summary: "Change how a persisted VAT mount activates and auto-unmounts.",
    aliases: [],
    usage: [
      "gui vat policy /Some/Path always",
      "gui vat policy /Some/Path disabled",
      "gui vat policy /Some/Path auto never",
      "gui vat policy /Some/Path auto <seconds>",
    ],
    examples: [
      "gui vat policy /demo always",
      "gui vat policy /demo disabled",
      "gui vat policy /demo auto 30",
    ],
    notes: [
      "always mounts eagerly and stays active.",
      "disabled keeps the table entry but never activates it.",
      "auto activates lazily on VAT queries and can auto-unmount after inactivity.",
    ],
    related: ["vat", "vat mount", "vat mounts", "vat unmount", "vat query", "output"],
  },
  {
    id: "vat unmount",
    title: "Unmount a VAT path",
    summary: "Remove a persisted VAT mount entry by path.",
    aliases: [],
    usage: ["gui vat unmount /Some/Path"],
    examples: ["gui vat unmount /demo"],
    notes: [
      "Unmounting removes the persisted entry and tears down any active runtime mount for that path.",
    ],
    related: ["vat", "vat mount", "vat mounts", "vat policy", "vat query", "output"],
  },
  {
    id: "vat query",
    title: "Query mounted VAT trees",
    summary: "Run a GUIML query across the union of all mounted VAT trees.",
    aliases: [],
    usage: ["gui vat query '<query>'"],
    examples: ["gui vat query 'Application { Window }'"],
    notes: [
      "Queries run against the union root built from every mounted VAT tree.",
      "Introspection queries like [*] and [**] are supported here.",
    ],
    related: ["vat", "vat mount", "vat mounts", "vat watch", "query-language", "output"],
  },
  {
    id: "vat watch",
    title: "Watch mounted VAT queries",
    summary: "Stream VAT query changes as mounts refresh from AX observer triggers.",
    aliases: [],
    usage: ["gui vat watch [--once] [--filter <kinds>] '<query>'"],
    examples: [
      "gui vat watch 'Application { Window }'",
      "gui vat watch --once --filter updated 'Window { Button }'",
    ],
    notes: [
      "The daemon emits no initial payload; the stream stays quiet until the first qualifying change.",
      "--filter accepts a comma-separated subset of added, removed, updated.",
      "JSON mode emits NDJSON with source vat.watch. Text mode prints a compact change summary followed by the new rendered VAT query result.",
    ],
    related: ["vat", "vat query", "output"],
  },
  {
    id: "ax",
    title: "Inspect the raw AX tree",
    summary: "Inspect or act on raw accessibility trees.",
    aliases: [],
    usage: [
      "gui ax snapshot [--pid <pid>] [--depth <n>]",
      "gui ax tree [--pid <pid>] [--depth <n>]",
      "gui ax query (--focused | --pid <pid> | --app <bundle|name> | --all | --gui | --visible) [--json | --ndjson | --guiml] [--first | --only | --each] '<query>'",
      "gui ax cursor",
      "gui ax at <x> <y> [--pid <pid>]",
      "gui ax actions -",
      "gui ax perform <AXAction> -",
      "gui ax click -",
      "gui ax set \"text\" -",
      "gui ax type - '<value>'",
      "gui ax focus-window [- | <json>]",
      "gui ax select [- | <json>]",
      "gui ax hover -",
      "gui ax focus -",
      "gui ax menu-at <x> <y> [--pid <pid>]",
      "gui ax events [--pid <pid>] [--bundle <bundleId>]",
      "gui ax bench-observers [--pid <pid> | --app <bundle|name>] [--iterations <n>] [--mode <app|windows|focused>] [--json]",
    ],
    examples: [
      "gui ax snapshot",
      "gui ax snapshot --pid 1234 --depth 5",
      "gui ax tree",
      "gui ax query --focused --only 'Button#Save'",
      "gui ax cursor",
      "gui ax at 400 300",
      "gui ax query --only 'Button#Save' | gui ax actions -",
      "gui ax query --only 'Button#Save' | gui ax click -",
      "gui ax query --only 'Button#Save' | gui ax perform AXPress -",
      "gui ax query --only 'TextField#Name' | gui ax type - 'Ada'",
      "gui ax query --only 'TextField#Name' | gui ax focus -",
      "gui ax cursor | gui ax focus-window - | gui ax select -",
      "gui ax query --only 'Button#Save' | gui ax hover -",
      "gui ax menu-at 400 300",
      "gui ax bench-observers --app TextEdit --iterations 200 --mode focused --json",
    ],
    notes: [
      "gui ax query requires one explicit scope selector, unless --gui or --visible is used on its own to imply app-wide search.",
      "Other AX commands still use the frontmost app by default unless they accept an explicit --pid or AX target-bearing payload input.",
      "AX action commands consume exactly one target-bearing payload from stdin. Use gui ax query to select, then pipe into the action.",
      "Use gui query or gui crdt query when you want GhostUI's normalized document instead of raw AX.",
    ],
    related: ["ax snapshot", "ax tree", "ax query", "ax at", "ax actions", "ax perform", "ax click", "ax set", "ax type", "ax focus-window", "ax select", "ax hover", "ax focus", "ax menu-at", "ax events", "ax bench-observers"],
  },
  {
    id: "ax snapshot",
    title: "Raw AX snapshot as JSON",
    summary: "Dump the raw AX tree as JSON from the snapshot endpoint.",
    aliases: [],
    usage: [
      "gui ax snapshot",
      "gui ax snapshot [--pid <pid>] [--depth <n>]",
    ],
    examples: [
      "gui ax snapshot",
      "gui ax snapshot --pid 1234",
      "gui ax snapshot --depth 3",
    ],
    notes: [
      "Outputs raw JSON from /api/ax/snapshot.",
      "Use gui ax tree for a human-readable formatted version.",
    ],
    related: ["ax", "ax tree", "output"],
  },
  {
    id: "ax tree",
    title: "Dump the raw AX tree",
    summary: "Print the raw accessibility tree in a human-readable format.",
    aliases: [],
    usage: [
      "gui ax tree",
      "gui ax tree [--pid <pid>] [--depth <n>]",
    ],
    examples: [
      "gui ax tree",
      "gui ax tree --pid 1234",
      "gui ax tree --depth 3",
    ],
    notes: [
      "Use --pid to inspect a specific process instead of the frontmost app.",
      "Use --depth to limit tree traversal depth.",
    ],
    related: ["ax", "ax snapshot", "output"],
  },
  {
    id: "ax query",
    title: "Query the raw AX tree",
    summary: "Search raw AX nodes in one explicit scope, or refine relative to one piped AX cursor / AX target-bearing payload.",
    aliases: [],
    usage: [
      "gui ax query --focused [--json | --ndjson | --guiml] [--first | --only | --each] '<query>'",
      "gui ax query --pid <pid> [--json | --ndjson | --guiml] [--first | --only | --each] '<query>'",
      "gui ax query --app <bundle|name> [--json | --ndjson | --guiml] [--first | --only | --each] '<query>'",
      "gui ax query --all [--json | --ndjson | --guiml] [--first | --only | --each] '<query>'",
      "gui ax query --gui [--json | --ndjson | --guiml] [--first | --only | --each] '<query>'",
      "gui ax query --visible [--json | --ndjson | --guiml] [--first | --only | --each] '<query>'",
      "gui ax cursor | gui ax query [--json | --ndjson] [--first | --only | --each] '<query>'",
    ],
    examples: [
      "gui ax query --all 'Window { Button }'",
      "gui ax query --gui 'Application'",
      "gui ax query --visible 'Application'",
      "gui ax query --focused --only 'Button#Save'",
      "gui ax query --all --each 'Window { Button }'",
      "gui ax query --app Terminal --first 'Button'",
      "gui ax query --pid 1234 'Button'",
      "gui ax cursor | gui ax query 'Text'",
    ],
    notes: [
      "GUIML output supports introspection queries like [*] or [**], and hybrid comma forms like [title,*]. JSON and NDJSON also preserve them in serialized AX matches.",
      "Use literal tags by default. `Text` is the one broad text-control alias and matches `TextField`, `TextArea`, `SearchField`, and `ComboBox`. `Input` is not special.",
      "Without a cardinality flag, AX query prints one merged GUIML tree containing all matches.",
      "Use --first to print only the first matched GUIML tree, --only to require exactly one match, and --each to print one GUIML tree per match separated by blank lines.",
      "Default output is nested GUIML on a TTY, JSON when piped, and NDJSON when piped with --each.",
      "JSON and NDJSON emit serialized AX query match objects. When a match can produce a stable AX target, it is included as `target`.",
      AX_TARGET_BEARING_JSON_TYPE_NOTE,
      "Choose exactly one scope selector:",
      "  --gui",
      "  --visible",
      "  --focused",
      "  --pid <pid>",
      "  --app <bundle|name>",
      "  --all",
      "--gui searches regular apps, matching the existing dock-icon style app set.",
      "--visible searches the regular apps that also have visible GUI windows.",
      "Use exactly one of --all, --gui, or --visible as the app-wide scope selector.",
      "When stdin carries one AX target-bearing payload and no explicit scope flag is provided, the query runs relative to that payload instead of doing a fresh unrelated app-wide search.",
      "--gui and --visible are invalid with stdin-refined AX queries.",
      "--gui and --visible are invalid with --focused, --pid, and --app.",
      "stdin-refined AX query currently supports JSON and NDJSON output only.",
      "--focused keeps the current frontmost-app behavior explicit.",
      "--app resolves a running app by exact bundle id, exact name, or unique substring match without changing focus.",
      "--all searches across running apps instead of defaulting silently to the frontmost app.",
    ],
    related: ["ax", "query-language", "output"],
  },
  {
    id: "ax cursor",
    title: "Return the active text cursor payload",
    summary: "Return the focused text-editable AX target plus selected range / caret when available.",
    aliases: [],
    usage: ["gui ax cursor"],
    examples: [
      "gui ax cursor",
      "gui ax cursor | gui ax query --only 'Text'",
      "gui ax cursor | gui ax type - 'foo'",
    ],
    notes: [
      "Returns an `ax.cursor` JSON payload for the currently focused text-editable element.",
      "When selection length is 0, the payload represents a caret insertion point.",
      "Use this as the narrow text-edit prototype path instead of the older replace-all `ax type` behavior on arbitrary targets.",
    ],
    related: ["ax", "ax query", "ax type"],
  },
  {
    id: "ax focus-window",
    title: "Refocus the containing window",
    summary: "Focus the containing AX window or sheet for one AX target-bearing payload, then pass the original payload through.",
    aliases: [],
    usage: ["gui ax focus-window -", "gui ax focus-window '<json>'"],
    examples: [
      "gui ax cursor | gui ax focus-window -",
      "gui ax query --only 'TextField#Name' | gui ax focus-window - | gui ax select -",
    ],
    notes: [
      "Consumes one AX target-bearing payload from stdin or a literal JSON payload.",
      AX_TARGET_BEARING_JSON_TYPE_NOTE,
      "Focuses the containing AXWindow or AXSheet via AX-native plumbing, then re-emits the original payload unchanged.",
    ],
    related: ["ax", "ax cursor", "ax select", "window focus"],
  },
  {
    id: "ax select",
    title: "Restore an AX cursor selection",
    summary: "Restore the saved selection or caret for one AX cursor payload, then pass the payload through unchanged.",
    aliases: [],
    usage: ["gui ax select", "gui ax select -", "gui ax select '<json>'"],
    examples: [
      "gui ax cursor | gui ax select",
      "pbpaste | gui ax focus-window - | gui ax select -",
    ],
    notes: [
      "Consumes one `ax.cursor` payload from stdin or a literal JSON payload.",
      AX_CURSOR_JSON_TYPE_NOTE,
      "Restores the saved selection range or caret on the target AX text element without mutating the text value.",
      "Useful after gui ax focus-window when you want to restore a cursor position in the refocused window.",
    ],
    related: ["ax", "ax cursor", "ax focus-window", "ax type"],
  },
  {
    id: "ax click",
    title: "Click via AX",
    summary: "Consume one AX target-bearing payload from stdin or a literal JSON payload and click it.",
    aliases: [],
    usage: ["gui ax click -"],
    examples: ["gui ax query --only 'Button#Save' | gui ax click -"],
    notes: [
      "Also accepts a literal JSON AX target-bearing payload in place of `-`.",
      AX_TARGET_JSON_TYPE_NOTE,
    ],
    related: ["ax", "ax query"],
  },
  {
    id: "ax press",
    title: "Press via AX",
    summary: "Consume one AX target-bearing payload from stdin or a literal JSON payload and call AXPress semantically.",
    aliases: [],
    usage: ["gui ax press -"],
    examples: ["gui ax query --only 'Button#Save' | gui ax press -"],
    notes: [
      "Also accepts a literal JSON AX target-bearing payload in place of `-`.",
      AX_TARGET_JSON_TYPE_NOTE,
      "Uses AXPress directly instead of synthesizing a pointer click.",
    ],
    related: ["ax", "ax click", "ax perform", "ax query"],
  },
  {
    id: "ax set",
    title: "Set a value via AX",
    summary: "Consume one AX target-bearing payload from stdin or a literal JSON payload and set its value.",
    aliases: [],
    usage: ["gui ax set \"text\" -"],
    examples: ["gui ax query --only 'TextField#Name' | gui ax set 'Ada' -"],
    notes: [
      "The target slot also accepts a literal JSON AX target-bearing payload.",
      AX_TARGET_JSON_TYPE_NOTE,
    ],
    related: ["ax", "ax query"],
  },
  {
    id: "ax hover",
    title: "Hover via AX",
    summary: "Consume one AX target-bearing payload from stdin or a literal JSON payload and hover it.",
    aliases: [],
    usage: ["gui ax hover -"],
    examples: ["gui ax query --only 'Button#Save' | gui ax hover -"],
    notes: [
      "Also accepts a literal JSON AX target-bearing payload in place of `-`.",
      AX_TARGET_JSON_TYPE_NOTE,
    ],
    related: ["ax", "ax query"],
  },
  {
    id: "ax events",
    title: "Stream AX events",
    summary: "Stream live AX observer events as JSON lines, with optional pid/bundle filtering.",
    aliases: [],
    usage: [
      "gui ax events",
      "gui ax events [--pid <pid>] [--bundle <bundleId>]",
    ],
    examples: [
      "gui ax events",
      "gui ax events --pid 1234",
      "gui ax events --bundle com.apple.finder",
    ],
    notes: [
      "Filtering is applied client-side: the full stream is received and unwanted events are discarded.",
      "Use --pid to filter to a specific process, --bundle for a specific bundle ID.",
    ],
    related: ["ax", "output"],
  },
  {
    id: "ax bench-observers",
    title: "Benchmark native AX observer registration",
    summary: "Measure AXObserverCreate/AddNotification/RemoveNotification attempts inside the bundled gui process.",
    aliases: [],
    usage: [
      "gui ax bench-observers",
      "gui ax bench-observers [--pid <pid> | --app <bundle|name>] [--iterations <n>] [--mode <app|windows|focused>] [--json]",
    ],
    examples: [
      "gui ax bench-observers",
      "gui ax bench-observers --app TextEdit --mode focused",
      "gui ax bench-observers --pid 1234 --iterations 500 --mode windows --json",
    ],
    notes: [
      "Runs inside the bundled gui process so you can measure native AX observer registration attempts on the same CLI path you normally use.",
      "Current AX trust may still block registration attempts; failed runs can still report api-disabled or similar native errors.",
      "Defaults to the frontmost PID when --pid and --app are omitted.",
      "Use --app to resolve a running app by exact bundle id, exact name, or unique substring match.",
      "--mode app benchmarks app-level notifications, --mode windows benchmarks current windows, and --mode focused benchmarks the current focused text target when present.",
      "--json prints the raw native benchmark payload; default TTY output is a short human summary.",
    ],
    related: ["ax", "ax events", "ws frontmost", "output"],
  },
  {
    id: "ax at",
    title: "Hit-test AX element at screen coordinate",
    summary: "Return the deepest AX element whose frame contains the given screen point or a piped shared target payload.",
    aliases: [],
    usage: [
      "gui ax at <x> <y>",
      "gui ax at -",
      "gui ax at <x> <y> [--pid <pid>]",
      "gui ax at - [--pid <pid>]",
    ],
    examples: [
      "gui ax at 400 300",
      "gui ax at 840 420 --pid 1234",
      "gui cg mousepos | gui ax at -",
    ],
    notes: [
      "Uses the frontmost app's AX tree when --pid is omitted.",
      "When stdin is `-`, consumes one AX target-bearing payload and reuses its point.",
      AX_TARGET_BEARING_JSON_TYPE_NOTE,
      "Returns null when no element frame contains the point.",
    ],
    related: ["ax", "ax menu-at"],
  },
  {
    id: "ax actions",
    title: "List AX actions for a matched element",
    summary: "Return the known AX actions for one AX target-bearing payload from stdin or a literal JSON payload.",
    aliases: [],
    usage: ["gui ax actions -"],
    examples: [
      "gui ax query --only 'Button#Save' | gui ax actions -",
    ],
    notes: [
      "Also accepts a literal JSON AX target-bearing payload in place of `-`.",
      AX_TARGET_JSON_TYPE_NOTE,
      "Action set is inferred from element role when the N-API snapshot does not enumerate them.",
    ],
    related: ["ax", "ax perform", "ax query"],
  },
  {
    id: "ax perform",
    title: "Perform a named AX action",
    summary: "Call a specific AXAction on one AX target-bearing payload from stdin or a literal JSON payload.",
    aliases: [],
    usage: ["gui ax perform <AXAction> -"],
    examples: [
      "gui ax query --only 'Button#Save' | gui ax perform AXPress -",
    ],
    notes: [
      "The target slot also accepts a literal JSON AX target-bearing payload.",
      AX_TARGET_JSON_TYPE_NOTE,
      "Calls axPerformAction directly — no pointer-click fallback (unlike ax click).",
      "Use gui ax actions to discover valid action names for an element.",
    ],
    related: ["ax", "ax actions", "ax click"],
  },
  {
    id: "ax type",
    title: "Type text into a matched element via AX",
    summary: "Type text into one AX cursor or other AX target-bearing payload from stdin or a literal JSON payload.",
    aliases: [],
    usage: ["gui ax type - '<value>'"],
    examples: [
      "gui ax query --only 'TextField#Name' | gui ax type - 'Ada'",
      "gui ax cursor | gui ax type - 'foo'",
    ],
    notes: [
      "The target slot also accepts a literal JSON AX cursor or other AX target-bearing payload.",
      AX_TARGET_BEARING_JSON_TYPE_NOTE,
      "When passed an `ax.cursor`, the prototype path replaces the current selection or inserts at the caret.",
      "When passed a plain AX target or AX query match, the older fallback still clicks the element center, selects all existing text (cmd+a), then types the value.",
      "For raw keyboard injection without element focus, use gui cg key.",
    ],
    related: ["ax", "ax focus", "cg key"],
  },
  {
    id: "ax focus",
    title: "Focus a matched AX element",
    summary: "Send AXFocus or AXRaise to one AX target-bearing payload from stdin or a literal JSON payload.",
    aliases: [],
    usage: ["gui ax focus -"],
    examples: [
      "gui ax query --only 'TextField#Name' | gui ax focus -",
    ],
    notes: [
      "Also accepts a literal JSON AX target-bearing payload in place of `-`.",
      AX_TARGET_JSON_TYPE_NOTE,
      "Falls back to a pointer click at the element center when AXFocus fails.",
      "Windows receive AXRaise instead of AXFocus.",
    ],
    related: ["ax", "ax type", "ax click"],
  },
  {
    id: "ax menu-at",
    title: "Get AXMenu tree at screen coordinate",
    summary: "Return the AXMenu node from the floating context-menu window at (x, y).",
    aliases: [],
    usage: [
      "gui ax menu-at <x> <y>",
      "gui ax menu-at <x> <y> [--pid <pid>]",
    ],
    examples: [
      "gui ax menu-at 400 300",
      "gui ax menu-at 840 420 --pid 1234",
    ],
    notes: [
      "Examines high-layer (≥ 101) windows at the point. Returns null when no menu is present.",
      "Use gui cg windows --layer 101 to discover menu-layer windows by coordinate.",
    ],
    related: ["ax", "ax at"],
  },
  {
    id: "cg",
    title: "Raw CG input and windows",
    summary: "Send raw CG pointer events, keyboard input, or inspect raw CGWindowList state.",
    aliases: [],
    usage: [
      "gui cg windows [--layer <n>]",
      "gui cg window-at <x> <y> [--layer <n>]",
      "gui cg move <x> <y>",
      "gui cg move -",
      "gui cg click <x> <y> [--button left|right|middle]",
      "gui cg click - [--button left|right|middle]",
      "gui cg doubleclick <x> <y> [--button left|right|middle]",
      "gui cg doubleclick - [--button left|right|middle]",
      "gui cg drag (<fromX> <fromY> | <fromPayload> | -) (<toX> <toY> | <toPayload> | -) [--button left|right|middle]",
      "gui cg scroll <x> <y> --dx <n> --dy <n>",
      "gui cg scroll - --dx <n> --dy <n>",
      "gui cg key <combo|key|text>",
      "gui cg keydown <key> [--mods cmd,shift,alt,ctrl]",
      "gui cg keyup <key> [--mods cmd,shift,alt,ctrl]",
      "gui cg moddown <mod>...",
      "gui cg modup <mod>...",
      "gui cg mousepos",
      "gui cg mousestate",
      "gui cg type <query> \"text\"",
    ],
    examples: [
      "gui cg windows --layer 101",
      "gui cg window-at 400 300",
      "gui cg move 400 300",
      "gui ax query --only 'Button#Save' | gui cg move -",
      "gui cg click 400 300",
      "gui cg click 400 300 --button right",
      "gui cg doubleclick 400 300",
      "gui ax query --only 'Button#Save' | gui cg doubleclick -",
      "gui cg drag 400 300 800 300",
      "{ gui ax query --focused --only 'SliderThumb'; gui ax query --focused --only 'Button#Done'; } | gui cg drag - -",
      "gui cg scroll 400 300 --dx 0 --dy -240",
      "gui ax query --only 'ScrollArea' | gui cg scroll - --dx 0 --dy -240",
      "gui cg key cmd+n",
      "gui cg key return",
      "gui cg keydown a --mods cmd,shift",
      "gui cg keyup a",
      "gui cg moddown cmd",
      "gui cg modup cmd",
      "gui cg mousepos",
      "gui cg mousestate",
      "gui cg type 'TextField#Name' 'Ada'",
    ],
    related: ["cg move", "cg click", "cg doubleclick", "cg drag", "cg scroll", "cg key", "cg keydown", "cg keyup", "cg moddown", "cg modup", "cg mousepos", "cg mousestate", "cg type", "cg windows", "cg window-at", "ax", "output"],
  },
  {
    id: "cg key",
    title: "Send raw keyboard input",
    summary: "Send a key combo, special key, or text string via CGEvent.",
    aliases: [],
    usage: ["gui cg key <combo|key|text>"],
    examples: [
      "gui cg key cmd+n",
      "gui cg key return",
      "gui cg key 'Hello World'",
    ],
    related: ["cg"],
  },
  {
    id: "cg type",
    title: "Focus then type via CG",
    summary: "Focus a raw AX match and type text via CGEvent keystrokes.",
    aliases: [],
    usage: ["gui cg type <query> \"text\""],
    examples: ["gui cg type 'TextField#Name' 'Ada'"],
    related: ["cg", "ax query"],
  },
  {
    id: "cg windows",
    title: "Dump raw CG windows",
    summary: "Print raw CGWindowList data as JSON.",
    aliases: [],
    usage: [
      "gui cg windows",
      "gui cg windows [--layer <n>]",
    ],
    examples: [
      "gui cg windows",
      "gui cg windows --layer 101",
    ],
    notes: [
      "Use --layer to filter client-side to a specific CG window layer.",
    ],
    related: ["cg", "cg window-at", "output"],
  },
  {
    id: "cg window-at",
    title: "Find raw CG window at screen coordinate",
    summary: "Return the first CG window whose bounds contain the given screen point.",
    aliases: [],
    usage: [
      "gui cg window-at <x> <y>",
      "gui cg window-at <x> <y> [--layer <n>]",
      "gui cg window-at - [--layer <n>]",
    ],
    examples: [
      "gui cg window-at 400 300",
      "gui cg window-at 840 420 --layer 101",
      "gui cg mousepos | gui cg window-at - | gui window focus -",
    ],
    notes: [
      "Use --layer to restrict the search to a specific CG window layer.",
      "Useful for menu detection when paired with gui ax menu-at.",
      "Pass `-` to read one shared point/target JSON payload from stdin, such as gui cg mousepos output.",
      AX_TARGET_BEARING_JSON_TYPE_NOTE,
    ],
    related: ["cg", "cg windows", "cg mousepos", "window focus", "window drag", "ax menu-at"],
  },
  {
    id: "cg move",
    title: "Move the mouse pointer",
    summary: "Move the cursor to a screen coordinate without clicking, or one piped from AX JSON.",
    aliases: [],
    usage: ["gui cg move <x> <y>", "gui cg move -"],
    examples: ["gui cg move 400 300", "gui ax query --only 'Button#Save' | gui cg move -"],
    notes: [
      "When passed `-`, the command reads one AX target-bearing payload from stdin and moves to `target.point`.",
      AX_TARGET_BEARING_JSON_TYPE_NOTE,
    ],
    related: ["cg", "cg click"],
  },
  {
    id: "cg click",
    title: "Click at a screen coordinate",
    summary: "Send a mouse-down/up click pair at the given screen point or one piped from AX JSON.",
    aliases: [],
    usage: ["gui cg click <x> <y> [--button left|right|middle]", "gui cg click - [--button left|right|middle]"],
    examples: [
      "gui cg click 400 300",
      "gui cg click 400 300 --button right",
      "gui ax query --only 'Button#Save' | gui cg click -",
    ],
    notes: [
      "Defaults to the left button when --button is omitted.",
      "When passed `-`, the command reads one AX target-bearing payload from stdin and clicks `target.point`.",
      AX_TARGET_BEARING_JSON_TYPE_NOTE,
    ],
    related: ["cg", "cg doubleclick", "cg move"],
  },
  {
    id: "cg doubleclick",
    title: "Double-click at a screen coordinate",
    summary: "Send two rapid click pairs at the given screen point or one piped from AX JSON.",
    aliases: [],
    usage: ["gui cg doubleclick <x> <y> [--button left|right|middle]", "gui cg doubleclick - [--button left|right|middle]"],
    examples: [
      "gui cg doubleclick 400 300",
      "gui ax query --only 'Button#Save' | gui cg doubleclick -",
    ],
    notes: [
      "Defaults to the left button when --button is omitted.",
      "When passed `-`, the command reads one AX target-bearing payload from stdin and double-clicks `target.point`.",
      AX_TARGET_BEARING_JSON_TYPE_NOTE,
    ],
    related: ["cg", "cg click"],
  },
  {
    id: "cg drag",
    title: "Drag between two screen coordinates",
    summary: "Press the mouse at the from point, move to the to point, then release, with each endpoint resolved from coordinates or AX JSON.",
    aliases: [],
    usage: [
      "gui cg drag <fromX> <fromY> <toX> <toY> [--button left|right|middle]",
      "gui cg drag (<fromPayload> | -) (<toPayload> | -) [--button left|right|middle]",
    ],
    examples: [
      "gui cg drag 400 300 800 300",
      "gui cg drag - '{\"type\":\"ax.target\",\"pid\":1,\"point\":{\"x\":800,\"y\":300},\"role\":\"AXButton\"}'",
      "{ gui ax query --focused --only 'SliderThumb'; gui ax query --focused --only 'Button#Done'; } | gui cg drag - -",
    ],
    notes: [
      "Defaults to the left button when --button is omitted.",
      "Each endpoint may be an explicit `<x> <y>` pair, a literal JSON AX target-bearing payload, or `-`.",
      AX_TARGET_BEARING_JSON_TYPE_NOTE,
      "Each `-` consumes one AX target-bearing payload from stdin in order. `gui cg drag - -` therefore expects exactly two stdin payloads, such as back-to-back NDJSON lines.",
    ],
    related: ["cg", "cg click"],
  },
  {
    id: "cg scroll",
    title: "Scroll at a screen coordinate",
    summary: "Inject a scroll wheel event at the given position or one piped from AX JSON.",
    aliases: [],
    usage: ["gui cg scroll <x> <y> --dx <n> --dy <n>", "gui cg scroll - --dx <n> --dy <n>"],
    examples: [
      "gui cg scroll 400 300 --dx 0 --dy -240",
      "gui ax query --only 'ScrollArea' | gui cg scroll - --dx 0 --dy -240",
    ],
    notes: [
      "--dx is the horizontal delta; --dy is the vertical delta.",
      "Negative --dy scrolls down; positive scrolls up.",
      "When passed `-`, the command reads one AX target-bearing payload from stdin and scrolls at `target.point`.",
      AX_TARGET_BEARING_JSON_TYPE_NOTE,
    ],
    related: ["cg", "cg click"],
  },
  {
    id: "cg keydown",
    title: "Send a key-down CGEvent",
    summary: "Post only the key-down half of a CGKeyboard event, leaving the key held.",
    aliases: [],
    usage: ["gui cg keydown <key> [--mods cmd,shift,alt,ctrl]"],
    examples: [
      "gui cg keydown a",
      "gui cg keydown a --mods cmd,shift",
      "gui cg keydown return",
    ],
    notes: [
      "Does not release the key — pair with gui cg keyup to complete the stroke.",
      "--mods accepts a comma-separated list: cmd, shift, alt, ctrl.",
    ],
    related: ["cg", "cg keyup", "cg key", "cg moddown"],
  },
  {
    id: "cg keyup",
    title: "Send a key-up CGEvent",
    summary: "Post only the key-up half of a CGKeyboard event.",
    aliases: [],
    usage: ["gui cg keyup <key> [--mods cmd,shift,alt,ctrl]"],
    examples: [
      "gui cg keyup a",
      "gui cg keyup return",
    ],
    notes: [
      "Releases a key that was pressed with gui cg keydown.",
      "--mods accepts a comma-separated list: cmd, shift, alt, ctrl.",
    ],
    related: ["cg", "cg keydown", "cg key", "cg modup"],
  },
  {
    id: "cg moddown",
    title: "Press modifier keys down",
    summary: "Post modifier key-down events for each named modifier.",
    aliases: [],
    usage: ["gui cg moddown <mod>..."],
    examples: [
      "gui cg moddown cmd",
      "gui cg moddown cmd shift",
    ],
    notes: [
      "Valid modifiers: cmd, shift, alt, ctrl.",
      "Pair with gui cg modup to release.",
    ],
    related: ["cg", "cg modup", "cg keydown"],
  },
  {
    id: "cg modup",
    title: "Release modifier keys",
    summary: "Post modifier key-up events for each named modifier.",
    aliases: [],
    usage: ["gui cg modup <mod>..."],
    examples: [
      "gui cg modup cmd",
      "gui cg modup cmd shift",
    ],
    notes: [
      "Valid modifiers: cmd, shift, alt, ctrl.",
      "Releases modifiers held with gui cg moddown.",
    ],
    related: ["cg", "cg moddown", "cg keyup"],
  },
  {
    id: "cg mousepos",
    title: "Get current mouse position",
    summary: "Return the current cursor position as a shared AX target-style JSON payload.",
    aliases: [],
    usage: ["gui cg mousepos"],
    examples: [
      "gui cg mousepos",
      "gui cg mousepos | gui cg click -",
      "gui cg mousepos | gui ax at -",
    ],
    notes: [
      "Position is in screen coordinates (top-left origin).",
      "Emits an `ax.target` payload so downstream `gui cg ... -` and `gui ax at -` can consume it directly.",
    ],
    related: ["cg", "cg mousestate", "cg move", "cg click", "ax at"],
  },
  {
    id: "cg mousestate",
    title: "Get current mouse position and button state",
    summary: "Return cursor position and pressed button state as JSON.",
    aliases: [],
    usage: ["gui cg mousestate"],
    examples: ["gui cg mousestate"],
    notes: [
      "Returns {x, y, buttons: {left, right, middle}}.",
      "Buttons reflect hardware state at the moment of the call.",
    ],
    related: ["cg", "cg mousepos", "cg move"],
  },
  {
    id: "ws",
    title: "Workspace state",
    summary: "Inspect NSWorkspace apps, frontmost app, and screen geometry.",
    aliases: [],
    usage: [
      "gui ws apps",
      "gui ws frontmost",
      "gui ws screen",
    ],
    examples: [
      "gui ws apps",
      "gui ws frontmost",
      "gui ws screen",
    ],
    related: ["ws apps", "ws frontmost", "ws screen", "output"],
  },
  {
    id: "ws apps",
    title: "List workspace apps",
    summary: "Print running NSWorkspace applications as JSON.",
    aliases: [],
    usage: ["gui ws apps"],
    examples: ["gui ws apps"],
    related: ["ws", "output"],
  },
  {
    id: "ws frontmost",
    title: "Show the frontmost app",
    summary: "Print the current NSWorkspace frontmost app as JSON.",
    aliases: [],
    usage: ["gui ws frontmost"],
    examples: ["gui ws frontmost"],
    related: ["ws", "output"],
  },
  {
    id: "ws screen",
    title: "Show screen geometry",
    summary: "Print display frame geometry as JSON.",
    aliases: [],
    usage: ["gui ws screen"],
    examples: ["gui ws screen"],
    related: ["ws", "output"],
  },
  {
    id: "pb",
    title: "Clipboard operations",
    summary: "Read, write, list types, and clear the clipboard.",
    aliases: [],
    usage: [
      "gui pb read",
      "gui pb read --type <uti>",
      "gui pb write \"text\"",
      "gui pb types",
      "gui pb clear",
    ],
    examples: [
      "gui pb read",
      "gui pb write 'hello'",
      "gui pb types",
    ],
    related: ["pb read", "pb write", "pb types", "pb clear", "output"],
  },
  {
    id: "pb read",
    title: "Read the clipboard",
    summary: "Read plain text or a specific UTI from the clipboard.",
    aliases: [],
    usage: [
      "gui pb read",
      "gui pb read --type <uti>",
    ],
    examples: [
      "gui pb read",
      "gui pb read --type public.utf8-plain-text",
    ],
    related: ["pb", "output"],
  },
  {
    id: "pb write",
    title: "Write the clipboard",
    summary: "Write plain text to the clipboard.",
    aliases: [],
    usage: ["gui pb write \"text\""],
    examples: ["gui pb write 'hello'"],
    related: ["pb"],
  },
  {
    id: "pb types",
    title: "List clipboard types",
    summary: "List clipboard UTI types as JSON.",
    aliases: [],
    usage: ["gui pb types"],
    examples: ["gui pb types"],
    related: ["pb", "output"],
  },
  {
    id: "pb clear",
    title: "Clear the clipboard",
    summary: "Clear clipboard contents.",
    aliases: [],
    usage: ["gui pb clear"],
    examples: ["gui pb clear"],
    related: ["pb"],
  },
  {
    id: "display",
    title: "Display inspection",
    summary: "Inspect display geometry, scale, and ids.",
    aliases: [],
    usage: [
      "gui display list",
      "gui display main",
      "gui display <id>",
    ],
    examples: [
      "gui display list",
      "gui display main",
      "gui display 69696969",
    ],
    related: ["display list", "display main", "display show", "output"],
  },
  {
    id: "display list",
    title: "List displays",
    summary: "Print all displays with geometry and scale as JSON.",
    aliases: [],
    usage: ["gui display list"],
    examples: ["gui display list"],
    related: ["display", "output"],
  },
  {
    id: "display main",
    title: "Show the main display",
    summary: "Print main display info as JSON.",
    aliases: [],
    usage: ["gui display main"],
    examples: ["gui display main"],
    related: ["display", "output"],
  },
  {
    id: "display show",
    title: "Show a display by id",
    summary: "Print display info for a specific CGDirectDisplayID as JSON.",
    aliases: ["display id"],
    usage: ["gui display <id>"],
    examples: ["gui display 69696969"],
    related: ["display", "output"],
  },
  {
    id: "defaults",
    title: "macOS defaults",
    summary: "Read and write macOS preference domains.",
    aliases: [],
    usage: [
      "gui defaults read <domain> [key]",
      "gui defaults write <domain> <key> <value> [-bool|-int|-float|-string]",
      "gui defaults domains",
    ],
    examples: [
      "gui defaults read com.apple.finder",
      "gui defaults read com.apple.finder AppleShowAllFiles",
      "gui defaults domains",
    ],
    related: ["defaults read", "defaults write", "defaults domains", "output"],
  },
  {
    id: "defaults read",
    title: "Read defaults",
    summary: "Read one key or dump a whole preference domain.",
    aliases: [],
    usage: ["gui defaults read <domain> [key]"],
    examples: [
      "gui defaults read com.apple.finder",
      "gui defaults read com.apple.finder AppleShowAllFiles",
    ],
    related: ["defaults", "output"],
  },
  {
    id: "defaults write",
    title: "Write defaults",
    summary: "Write one defaults value, with an optional type flag.",
    aliases: [],
    usage: ["gui defaults write <domain> <key> <value> [-bool|-int|-float|-string]"],
    examples: [
      "gui defaults write com.apple.finder AppleShowAllFiles true -bool",
      "gui defaults write com.apple.dock tilesize 48 -int",
    ],
    related: ["defaults"],
  },
  {
    id: "defaults domains",
    title: "List defaults domains",
    summary: "List all preference domains as JSON.",
    aliases: [],
    usage: ["gui defaults domains"],
    examples: ["gui defaults domains"],
    related: ["defaults", "output"],
  },
  {
    id: "log",
    title: "Log tailing",
    summary: "Tail or fetch app and daemon logs.",
    aliases: [],
    usage: [
      "gui log",
      "gui log --last N",
    ],
    examples: [
      "gui log --last 20",
      "gui log",
    ],
    notes: ["gui log follows the stream unless --last is provided."],
    related: ["output"],
  },
  {
    id: "skill",
    title: "Agent skills",
    summary: "List or print copy-paste operating skills for agents.",
    aliases: ["agent"],
    usage: [
      "gui skill list",
      "gui skill claude",
      "gui skill codex",
    ],
    examples: [
      "gui skill list",
      "gui skill claude",
      "gui skill codex",
    ],
    related: ["skill list", "skill claude", "skill codex", "query", "ax"],
  },
  {
    id: "skill list",
    title: "List skill targets",
    summary: "List available skill targets.",
    aliases: [],
    usage: ["gui skill list"],
    examples: ["gui skill list"],
    related: ["skill"],
  },
  {
    id: "skill claude",
    title: "Print the Claude skill",
    summary: "Print the GhostUI operating skill formatted for Claude.",
    aliases: [],
    usage: ["gui skill claude"],
    examples: ["gui skill claude"],
    related: ["skill", "skills"],
  },
  {
    id: "skill codex",
    title: "Print the Codex skill",
    summary: "Print the GhostUI operating skill formatted for Codex.",
    aliases: [],
    usage: ["gui skill codex"],
    examples: ["gui skill codex"],
    related: ["skill", "skills"],
  },
  {
    id: "query-language",
    title: "Query language",
    summary: "Syntax guide for the UI query language.",
    aliases: ["query language", "query syntax"],
    usage: ["gui help query-language"],
    examples: [
      "Application { Window }",
      "@Application { Window }",
      "@@Application { Window }",
      "@@{ Button }",
      "@@ / Button",
      "Button#Save",
      "Button[title=Save]",
      "Button[*]",
      "Button[**]",
    ],
    notes: [
      "Use Tag#Id, predicates like [title=Save], and scopes like Parent { Child }.",
      "Use literal tags by default. `Text` is the one broad text-control alias and matches `TextField`, `TextArea`, `SearchField`, and `ComboBox`. `Input` is not special.",
      "Prefix with @ to hide the matched wrapper in output, or @@ to also erase its ancestors from the rendered hierarchy.",
      "Nth selectors use :N, for example Button:0.",
      "Queries support [*] and [**] for introspection, plus comma-only hybrid forms like [title,*] or [title,**]. AX GUIML output renders them too.",
    ],
    related: ["query", "crdt query", "ax query", "ids"],
  },
  {
    id: "output",
    title: "Output contracts",
    summary: "Explain stdout and stderr conventions.",
    aliases: [],
    usage: ["gui help output"],
    examples: [
      "GUIML on stdout for gui query and gui crdt query",
      "JSON on stdout for gui cg windows, gui ws frontmost, gui pb types, and gui display list",
      "PNG on stdout for gui img without --out",
      "Capture bytes on stdout for gui rec image and gui rec filmstrip without --out",
    ],
    notes: [
      "Action commands usually print machine-readable output to stdout and status text like ok or queued to stderr.",
      "VAT commands print readable summaries on a TTY and JSON when stdout is piped.",
      "gui print writes the matched path to stderr and the property value to stdout.",
    ],
    related: ["query", "print", "img", "rec", "ax", "cg", "ws", "pb", "display", "defaults", "log"],
  },
  {
    id: "ids",
    title: "Node ids",
    summary: "Explain the Tag:Label:Index node id format.",
    aliases: ["id", "node ids", "node id"],
    usage: ["gui help ids"],
    examples: [
      "MenuBarItem:File:2",
      "Button:Save:0",
    ],
    notes: [
      "Rendered GUIML often collapses ids to #Label or #bundleId forms for readability.",
      "Quoted ids are supported for labels with spaces, for example ListItem#'iCloud Drive'.",
    ],
    related: ["query-language", "query", "crdt query"],
  },
  {
    id: "skills",
    title: "Skill output",
    summary: "Explain how to print agent-facing skills from gui.",
    aliases: [],
    usage: [
      "gui help skills",
      "gui skill list",
      "gui skill claude",
      "gui skill codex",
    ],
    examples: [
      "gui skill list",
      "gui skill claude",
    ],
    notes: [
      "Skills are copy-paste prompts for agent tools, not human help pages.",
      "Use gui help <topic> for command docs and gui skill <target> for agent prompts.",
    ],
    related: ["skill", "skill list", "skill claude", "skill codex"],
  },
];

const TOPIC_BY_NAME = new Map<string, HelpTopic>();
for (const topic of HELP_TOPICS) {
  TOPIC_BY_NAME.set(normalizeTopicName(topic.id), topic);
  for (const alias of topic.aliases) {
    TOPIC_BY_NAME.set(normalizeTopicName(alias), topic);
  }
}

function normalizeTopicName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function formatSection(title: string, lines: string[]): string {
  return [title + ":", ...lines.map((line) => `  ${line}`)].join("\n");
}

function uniqueTopics(topics: HelpTopic[]): HelpTopic[] {
  const seen = new Set<string>();
  const deduped: HelpTopic[] = [];
  for (const topic of topics) {
    if (seen.has(topic.id)) continue;
    seen.add(topic.id);
    deduped.push(topic);
  }
  return deduped;
}

export function listHelpTopics(): HelpTopic[] {
  return [...HELP_TOPICS];
}

function normalizeActorHelpTokens(tokens: string[]): string[] {
  if (tokens[0] !== "actor") {
    return tokens;
  }

  if (tokens.length === 1) {
    return ["actor"];
  }

  if (tokens[1] === "spawn") {
    return ["actor", "spawn"];
  }

  if (tokens[1] === "list") {
    return ["actor", "list"];
  }

  if (tokens[1] === "kill") {
    return ["actor", "kill"];
  }

  if (tokens[1] === "run") {
    if (tokens.length >= 3) {
      const target = tokens[2]!;
      const splitAt = target.lastIndexOf(".");
      if (splitAt > 0 && splitAt < target.length - 1) {
        return ["actor", "run", target.slice(splitAt + 1)];
      }
      return ["actor", "run", target];
    }
    return ["actor", "run"];
  }

  if (tokens.length < 3) {
    return ["actor"];
  }

  if (tokens[2] === "kill") {
    return ["actor", "kill"];
  }

  if (tokens[2] === "run") {
    if (tokens.length >= 4) {
      return ["actor", "run", tokens[3]!];
    }
    return ["actor", "run"];
  }

  return ["actor"];
}

export function findHelpTopic(name: string): HelpTopic | undefined {
  if (!name.trim()) return undefined;
  const normalized = normalizeActorHelpTokens(name.trim().split(/\s+/));
  return TOPIC_BY_NAME.get(normalizeTopicName(normalized.join(" ")));
}

export function findNearestHelpTopic(tokens: string[]): HelpTopic | undefined {
  const cleaned = tokens
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && token !== "--help" && token !== "-h");
  if (cleaned.length === 0) {
    return undefined;
  }

  const normalized = normalizeActorHelpTokens(cleaned);
  for (let count = normalized.length; count > 0; count--) {
    const topic = findHelpTopic(normalized.slice(0, count).join(" "));
    if (topic) {
      return topic;
    }
  }
  return undefined;
}

export function suggestHelpTopics(name: string): HelpTopic[] {
  const normalized = normalizeTopicName(name);
  if (!normalized) return [];
  const matches = HELP_TOPICS.filter((topic) => {
    if (normalizeTopicName(topic.id).includes(normalized)) return true;
    return topic.aliases.some((alias) => normalizeTopicName(alias).includes(normalized));
  });
  return uniqueTopics(matches).slice(0, 5);
}

export function renderHelpIndex(): string {
  return [
    "gui help - command and skill reference",
    "",
    renderRootHelp(),
    "",
    formatSection("Detailed topics", [
      "gui help query",
      "gui help ca",
      "gui help gfx",
      "gui help print",
      "gui help window",
      "gui help actor",
      "gui help img",
      "gui help rec",
      "gui help crdt",
      "gui help vat",
      "gui help vat mount",
      "gui help vat mounts",
      "gui help vat policy",
      "gui help vat unmount",
      "gui help vat query",
      "gui help vat watch",
      "gui help ax",
      "gui help cg",
      "gui help ws",
      "gui help pb",
      "gui help display",
      "gui help defaults",
      "gui help log",
      "gui help query-language",
      "gui help output",
      "gui help ids",
      "gui help skills",
    ]),
    "",
    formatSection("Skill targets", [
      "gui skill list",
      "gui skill claude",
      "gui skill codex",
    ]),
  ].join("\n");
}

export function renderRootHelp(): string {
  return [
    "gui - query and interact with the macOS GUI",
    "",
    formatSection("Core commands", [
      "gui query '<query>'         Query the live UI tree (alias: gui q)",
      "gui vat <subcommand>        Mount/query virtual access tables",
      "gui ca script -             Render a JSON draw overlay from stdin",
      "gui gfx <subcommand>        Render public visual-annotation overlays",
      "gui print <selector>...     Print one property (alias: gui p)",
      "gui img <query>             Screenshot a matched element",
      "gui rec <mode>              Capture a rect or cgWindowId",
      "gui window <subcommand>     Focus or drag windows by cgWindowId",
      "gui actor run <name>.<…>    Animate a named overlay actor",
    ]),
    "",
    formatSection("Raw trees and actions", [
      "gui ax <subcommand>         Query or act on the frontmost raw AX tree",
      "gui cg <subcommand>         Send raw CG input or inspect windows",
      "gui ws <subcommand>         Inspect NSWorkspace state",
    ]),
    "",
    formatSection("State and system", [
      "gui crdt <subcommand>       Dump/query the live CRDT document",
      "gui pb <subcommand>         Read or write clipboard state",
      "gui display <subcommand>    Inspect displays",
      "gui defaults <subcommand>   Read or write macOS defaults",
      "gui log [--last N]          Tail app and daemon logs",
    ]),
    "",
    formatSection("Docs and skills", [
      "gui help [topic]            Show the help index or a detailed page",
      "gui skill list              List agent skill targets",
      "gui skill <target>          Print a copy-paste operating skill",
    ]),
    "",
    formatSection("Global flags", [
      "--app <name|bundleId>       Bring an app to the foreground before executing a command",
    ]),
    "",
    formatSection("Start here", [
      "gui help query",
      "gui help vat",
      "gui help ax",
      "gui help query-language",
      "gui skill claude",
    ]),
    "",
    "Run `gui help` for the full index.",
  ].join("\n");
}

export function renderUsage(name: string): string {
  const topic = findHelpTopic(name);
  if (!topic) {
    return "Run `gui help` to list topics.";
  }

  return [
    formatSection("Usage", topic.usage),
    "",
    `Run \`gui help ${topic.id}\` for examples and notes.`,
  ].join("\n");
}

export function renderUnknownHelpTopic(name: string): string {
  const suggestions = suggestHelpTopics(name);
  const lines = [`Unknown help topic: ${name}`];
  if (suggestions.length > 0) {
    lines.push("");
    lines.push(formatSection("Maybe you want", suggestions.map((topic) => `gui help ${topic.id}`)));
  }
  lines.push("");
  lines.push("Run `gui help` to list topics.");
  return lines.join("\n");
}

export function renderHelpTopic(name: string): string {
  const topic = findHelpTopic(name);
  if (!topic) {
    return renderUnknownHelpTopic(name);
  }

  const parts = [
    `gui help ${topic.id}`,
    topic.title,
    `Summary: ${topic.summary}`,
  ];

  if (topic.aliases.length > 0) {
    parts.push(formatSection("Aliases", topic.aliases));
  }

  parts.push(formatSection("Usage", topic.usage));
  parts.push(formatSection("Examples", topic.examples));

  if (topic.notes && topic.notes.length > 0) {
    parts.push(formatSection("Notes", topic.notes));
  }

  if (topic.related && topic.related.length > 0) {
    parts.push(formatSection("Related", topic.related.map((item) => `gui help ${item}`)));
  }

  return parts.join("\n\n");
}
