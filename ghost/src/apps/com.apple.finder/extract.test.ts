import { describe, test, expect } from "bun:test";
import { extractFinderState } from "./extract.js";
import type { AXNode } from "../types.js";

/** Build a mock AX tree for Finder in List view with multi-cell header */
function makeFinderListViewTree_MultiCellHeader(): AXNode {
  return {
    role: "AXWindow",
    title: "Downloads",
    frame: { x: 100, y: 100, width: 800, height: 500 },
    children: [
      { role: "AXToolbar", children: [] },
      {
        role: "AXSplitGroup",
        children: [
          makeSimpleSidebar(),
          {
            role: "AXScrollArea",
            children: [
              {
                role: "AXOutline",
                label: "list view",
                frame: { x: 233, y: 157, width: 778, height: 386 },
                children: [
                  // Multi-cell header row
                  {
                    role: "AXRow",
                    subrole: "AXOutlineRow",
                    children: [
                      { role: "AXCell", children: [{ role: "AXStaticText", value: "Name" }] },
                      { role: "AXCell", children: [{ role: "AXStaticText", value: "Size" }] },
                      { role: "AXCell", children: [{ role: "AXStaticText", value: "Kind" }] },
                      { role: "AXCell", children: [{ role: "AXStaticText", value: "Date Added" }] },
                    ],
                  },
                  makeFileRow("Codex.dmg", ["156.7 MB", "Disk Image", "Mar 10, 2026"]),
                  makeFileRow("report.pdf", ["2.1 MB", "PDF Document", "Mar 5, 2026"]),
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

/** Build a mock AX tree for Finder in List view with single-cell header (real Finder layout) */
function makeFinderListViewTree_SingleCellHeader(): AXNode {
  return {
    role: "AXWindow",
    title: "Recents",
    frame: { x: 100, y: 100, width: 800, height: 500 },
    children: [
      { role: "AXToolbar", children: [] },
      {
        role: "AXSplitGroup",
        children: [
          makeSimpleSidebar(),
          {
            role: "AXScrollArea",
            children: [
              {
                role: "AXOutline",
                label: "list view",
                frame: { x: 233, y: 157, width: 778, height: 386 },
                children: [
                  // Single-cell header row (real Finder structure)
                  {
                    role: "AXRow",
                    subrole: "AXOutlineRow",
                    children: [
                      {
                        role: "AXCell",
                        children: [
                          { role: "AXStaticText", value: "Name" },
                          { role: "AXStaticText", value: "Kind" },
                          { role: "AXStaticText", value: "Date Last Opened" },
                          { role: "AXImage" },
                        ],
                      },
                    ],
                  },
                  makeFileRow("photo.jpg", ["JPEG image", "Yesterday at 9:55 PM"]),
                  makeFileRow("installer.dmg", ["Disk Image", "Feb 23, 2026 at 10:46 PM"]),
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

/** Build a mock AX tree with Size column */
function makeFinderListViewTree_WithSize(): AXNode {
  return {
    role: "AXWindow",
    title: "Downloads",
    frame: { x: 100, y: 100, width: 800, height: 500 },
    children: [
      { role: "AXToolbar", children: [] },
      {
        role: "AXSplitGroup",
        children: [
          makeSimpleSidebar(),
          {
            role: "AXScrollArea",
            children: [
              {
                role: "AXOutline",
                label: "list view",
                frame: { x: 233, y: 157, width: 778, height: 386 },
                children: [
                  // Single-cell header with Size column
                  {
                    role: "AXRow",
                    subrole: "AXOutlineRow",
                    children: [
                      {
                        role: "AXCell",
                        children: [
                          { role: "AXStaticText", value: "Name" },
                          { role: "AXStaticText", value: "Size" },
                          { role: "AXStaticText", value: "Kind" },
                          { role: "AXStaticText", value: "Date Added" },
                          { role: "AXImage" },
                        ],
                      },
                    ],
                  },
                  makeFileRow("Codex.dmg", ["156.7 MB", "Disk Image", "Mar 10, 2026"]),
                  makeFileRow("report.pdf", ["2.1 MB", "PDF Document", "Mar 5, 2026"]),
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

/** Build a mock AX tree with no header row (just data rows) */
function makeFinderListViewTree_NoHeader(): AXNode {
  return {
    role: "AXWindow",
    title: "Downloads",
    frame: { x: 100, y: 100, width: 800, height: 500 },
    children: [
      { role: "AXToolbar", children: [] },
      {
        role: "AXSplitGroup",
        children: [
          makeSimpleSidebar(),
          {
            role: "AXScrollArea",
            children: [
              {
                role: "AXOutline",
                label: "list view",
                frame: { x: 233, y: 157, width: 778, height: 386 },
                children: [
                  makeFileRow("Codex.dmg", ["156.7 MB", "Disk Image"]),
                  makeFileRow("report.pdf", ["2.1 MB", "PDF Document"]),
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

function makeSimpleSidebar(): AXNode {
  return {
    role: "AXScrollArea",
    children: [
      {
        role: "AXOutline",
        label: "sidebar",
        children: [
          {
            role: "AXRow",
            children: [{ role: "AXCell", children: [{ role: "AXStaticText", value: "Favorites" }] }],
          },
          {
            role: "AXRow",
            capabilities: { selected: true },
            children: [
              {
                role: "AXCell",
                children: [
                  { role: "AXImage", label: "folder" },
                  { role: "AXStaticText", value: "Downloads" },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

function makeFileRow(name: string, values: string[]): AXNode {
  const cells: AXNode[] = [
    {
      role: "AXCell",
      children: [
        { role: "AXImage" },
        { role: "AXTextField", value: name },
      ],
    },
    ...values.map(v => ({
      role: "AXCell" as const,
      children: [{ role: "AXStaticText" as const, value: v }],
    })),
  ];
  return { role: "AXRow", subrole: "AXOutlineRow", children: cells };
}

const windowFrame = { x: 100, y: 100, width: 800, height: 500 };

describe("extractFinderState - list view header detection", () => {
  test("detects single-cell header (real Finder layout)", () => {
    const tree = makeFinderListViewTree_SingleCellHeader();
    const state = extractFinderState(tree, windowFrame);
    expect(state).not.toBeNull();
    expect(state!.viewMode).toBe("list");
    expect(state!.columns).toEqual(["Name", "Kind", "Date Last Opened"]);
    expect(state!.files.length).toBe(2);
    expect(state!.files[0].name).toBe("photo.jpg");
    expect(state!.files[1].name).toBe("installer.dmg");
  });

  test("detects multi-cell header", () => {
    const tree = makeFinderListViewTree_MultiCellHeader();
    const state = extractFinderState(tree, windowFrame);
    expect(state).not.toBeNull();
    expect(state!.columns).toEqual(["Name", "Size", "Kind", "Date Added"]);
    expect(state!.files.length).toBe(2);
  });

  test("works without header row (positional fallback)", () => {
    const tree = makeFinderListViewTree_NoHeader();
    const state = extractFinderState(tree, windowFrame);
    expect(state).not.toBeNull();
    expect(state!.files.length).toBe(2);
    expect(state!.files[0].name).toBe("Codex.dmg");
    // Without headers, first value goes to kind (positional fallback)
    expect(state!.files[0].kind).toBe("156.7 MB");
  });
});

describe("extractFinderState - column-based field assignment", () => {
  test("assigns kind and date using column headers", () => {
    const tree = makeFinderListViewTree_SingleCellHeader();
    const state = extractFinderState(tree, windowFrame);
    expect(state!.files[0].kind).toBe("JPEG image");
    expect(state!.files[0].date).toBe("Yesterday at 9:55 PM");
    expect(state!.files[0].size).toBeUndefined();
  });

  test("assigns size when Size column is present", () => {
    const tree = makeFinderListViewTree_WithSize();
    const state = extractFinderState(tree, windowFrame);
    expect(state!.files[0].name).toBe("Codex.dmg");
    expect(state!.files[0].size).toBe("156.7 MB");
    expect(state!.files[0].kind).toBe("Disk Image");
    expect(state!.files[0].date).toBe("Mar 10, 2026");
  });

  test("assigns size and kind correctly for multi-cell header", () => {
    const tree = makeFinderListViewTree_MultiCellHeader();
    const state = extractFinderState(tree, windowFrame);
    expect(state!.files[0].name).toBe("Codex.dmg");
    expect(state!.files[0].size).toBe("156.7 MB");
    expect(state!.files[0].kind).toBe("Disk Image");
    expect(state!.files[0].date).toBe("Mar 10, 2026");
  });

  test("second file also assigned correctly", () => {
    const tree = makeFinderListViewTree_WithSize();
    const state = extractFinderState(tree, windowFrame);
    expect(state!.files[1].name).toBe("report.pdf");
    expect(state!.files[1].size).toBe("2.1 MB");
    expect(state!.files[1].kind).toBe("PDF Document");
    expect(state!.files[1].date).toBe("Mar 5, 2026");
  });
});

describe("extractFinderState - sidebar preserved", () => {
  test("sidebar is extracted alongside file list", () => {
    const tree = makeFinderListViewTree_SingleCellHeader();
    const state = extractFinderState(tree, windowFrame);
    expect(state!.sidebar.length).toBeGreaterThan(0);
  });
});
