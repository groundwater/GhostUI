/**
 * Regression test for issue #156: scoped queries must not leak sibling applications.
 *
 * The root cause was collectObscuredWindows() injecting all obscured windows
 * from the entire tree into every query result (fixed in #152). This test
 * ensures the fix holds and no new paths reintroduce the leak.
 */
import { filterTree, bfsFirst } from "./filter.js";
import { parseQuery } from "./query.js";
import { toGUIML } from "./guiml.js";
import type { PlainNode } from "./types.js";

let failures = 0;

function check(label: string, ok: boolean) {
  if (!ok) {
    console.error(`FAIL: ${label}`);
    failures++;
  } else {
    console.log(`PASS: ${label}`);
  }
}

// Realistic tree structure matching daemon PlainNode output
function makeTree(): PlainNode {
  return {
    _tag: "Display",
    type: "Display",
    id: "Display::0",
    screenW: 1024,
    screenH: 873,
    frontApp: "com.apple.Safari",
    _children: [
      {
        _tag: "MenuBar",
        id: "MenuBar::0",
        type: "MenuBar",
        _children: [
          { _tag: "MenuBarItem", id: "MenuBarItem:Clock:0", label: "Clock" },
        ],
      },
      {
        _tag: "Application",
        id: "app:com.apple.Safari",
        type: "Application",
        bundleId: "com.apple.Safari",
        title: "Safari",
        foreground: "true",
        _children: [
          {
            _tag: "Window",
            id: "Window::0",
            type: "Window",
            title: "Google",
            x: 0, y: 25, w: 1024, h: 823,
            _children: [
              {
                _tag: "Toolbar",
                id: "Toolbar::0",
                _children: [
                  { _tag: "Button", id: "Button:Back:0", title: "Back" },
                  { _tag: "TextField", id: "TextField::0", value: "google.com" },
                ],
              },
              { _tag: "WebArea", id: "WebArea::0", title: "Google" },
            ],
          },
        ],
      },
      {
        _tag: "Application",
        id: "app:com.apple.Terminal",
        type: "Application",
        bundleId: "com.apple.Terminal",
        title: "Terminal",
        _children: [
          {
            _tag: "Window",
            id: "Window::0",
            type: "Window",
            title: "GhostUI — -zsh — 123×49",
            x: 100, y: 100, w: 800, h: 600,
            obscured: "100",
            _children: [
              { _tag: "ScrollArea", id: "ScrollArea::0", _children: [
                { _tag: "TextArea", id: "TextArea::0" },
              ]},
            ],
          },
        ],
      },
      {
        _tag: "Application",
        id: "app:com.apple.finder",
        type: "Application",
        bundleId: "com.apple.finder",
        title: "Finder",
        _children: [
          {
            _tag: "Window",
            id: "Window::0",
            type: "Window",
            title: "Documents",
            x: 50, y: 50, w: 900, h: 700,
            obscured: "80",
            _children: [
              { _tag: "Table", id: "Table::0" },
            ],
          },
        ],
      },
    ],
  };
}

function noLeak(guiml: string, ...shouldNotContain: string[]): boolean {
  for (const term of shouldNotContain) {
    if (guiml.includes(term)) return false;
  }
  return true;
}

// Test 1: Scoped query by bundleId — siblings must not appear
{
  const queries = parseQuery("Application#com.apple.Safari{**}");
  const { nodes } = filterTree(makeTree(), queries);
  const guiml = toGUIML(nodes);
  check("bundleId scope excludes Terminal", noLeak(guiml, "Terminal"));
  check("bundleId scope excludes Finder", noLeak(guiml, "Finder"));
  check("bundleId scope excludes MenuBar", noLeak(guiml, "MenuBar"));
  check("bundleId scope includes Safari", guiml.includes("Safari"));
}

// Test 2: Scoped query by title — siblings must not appear
{
  const queries = parseQuery("Application#Safari{**}");
  const { nodes } = filterTree(makeTree(), queries);
  const guiml = toGUIML(nodes);
  check("title scope excludes Terminal", noLeak(guiml, "Terminal"));
  check("title scope excludes Finder", noLeak(guiml, "Finder"));
}

// Test 3: Ancestor wrapper must not contain original Display properties
{
  const queries = parseQuery("Application#com.apple.Safari{**}");
  const { nodes } = filterTree(makeTree(), queries);
  // The Display wrapper should not leak screenW, frontApp, etc.
  const displayWrapper = nodes[0];
  check("wrapper has no screenW", displayWrapper.screenW === undefined);
  check("wrapper has no frontApp", displayWrapper.frontApp === undefined);
  check("wrapper has no type", displayWrapper.type === undefined);
}

// Test 4: bfsFirst pipeline doesn't reintroduce siblings
{
  const queries = parseQuery("Application#com.apple.Safari{**}");
  const { nodes } = filterTree(makeTree(), queries);
  const bfsed = bfsFirst(nodes, 100);
  const guiml = toGUIML(bfsed);
  check("bfsFirst excludes Terminal", noLeak(guiml, "Terminal"));
}

// Test 5: Non-matching query returns empty
{
  const queries = parseQuery("Application#com.example.MissingApp{**}");
  const { nodes } = filterTree(makeTree(), queries);
  check("non-matching returns empty", nodes.length === 0);
}

// Test 6: Multiple queries only return their own matches
{
  const queries = parseQuery("Application#com.apple.Safari Application#com.apple.Terminal");
  const { nodes } = filterTree(makeTree(), queries);
  const guiml = toGUIML(nodes);
  check("multi-query has Safari", guiml.includes("Safari"));
  check("multi-query has Terminal", guiml.includes("Terminal"));
  check("multi-query excludes Finder", noLeak(guiml, "Finder"));
}

// Test 7: No scope (no {**}) — still no sibling leak
{
  const queries = parseQuery("Application#com.apple.Safari");
  const { nodes } = filterTree(makeTree(), queries);
  const guiml = toGUIML(nodes);
  check("no-scope excludes Terminal", noLeak(guiml, "Terminal"));
}

// Test 8: Wildcard tag with ID scope
{
  const queries = parseQuery("*#com.apple.Safari{**}");
  const { nodes } = filterTree(makeTree(), queries);
  const guiml = toGUIML(nodes);
  check("wildcard tag excludes Terminal", noLeak(guiml, "Terminal"));
}

// Test 9: Predicate-based scope
{
  const queries = parseQuery("Application[title=Safari]{**}");
  const { nodes } = filterTree(makeTree(), queries);
  const guiml = toGUIML(nodes);
  check("predicate scope excludes Terminal", noLeak(guiml, "Terminal"));
}

// Test 10: Querying an obscured app shows collapsed summary, not full tree (#157)
{
  const queries = parseQuery("Application#com.apple.Terminal{**}");
  const { nodes } = filterTree(makeTree(), queries);
  const guiml = toGUIML(nodes);
  check("#157: obscured query target shows truncation marker", guiml.includes("obscured"));
  check("#157: obscured query target hides ScrollArea", noLeak(guiml, "ScrollArea"));
  check("#157: obscured query target hides TextArea", noLeak(guiml, "TextArea"));
  // Window attrs like obscured= and type= should NOT leak into output
  check("#157: no leaked obscured= attr on Window", !guiml.includes('obscured="'));
}

// Test 11: Obscured Finder app also collapses (#157)
{
  const queries = parseQuery("Application#com.apple.finder{**}");
  const { nodes } = filterTree(makeTree(), queries);
  const guiml = toGUIML(nodes);
  check("#157: obscured Finder shows truncation marker", guiml.includes("obscured"));
  check("#157: obscured Finder hides Table", noLeak(guiml, "Table"));
}

if (failures > 0) {
  console.error(`\n${failures} test(s) FAILED`);
  process.exit(1);
}
console.log(`\nAll tests passed`);
