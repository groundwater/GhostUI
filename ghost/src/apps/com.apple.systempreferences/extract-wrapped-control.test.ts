import { describe, it, expect } from "bun:test";
import { extractSystemSettingsState } from "./extract.js";
import type { AXNode } from "../types.js";

describe("extractSystemSettingsState — wrapped interactive controls", () => {
  /**
   * Reproduces issue #130: Lock Screen's "Turn display off when inactive"
   * setting has its AXPopUpButton wrapped in an AXOpaqueProviderGroup,
   * so the control was being dropped from the CRDT tree.
   */
  it("extracts a PopUpButton wrapped in an AXOpaqueProviderGroup within a group", () => {
    const axTree: AXNode = {
      role: "AXWindow",
      title: "Lock Screen",
      children: [
        {
          role: "AXGroup",
          children: [
            {
              role: "AXSplitGroup",
              children: [
                // Sidebar
                {
                  role: "AXGroup",
                  children: [
                    {
                      role: "AXScrollArea",
                      children: [
                        {
                          role: "AXOutline",
                          children: [
                            {
                              role: "AXRow",
                              children: [
                                {
                                  role: "AXCell",
                                  capabilities: { selected: true },
                                  children: [
                                    { role: "AXStaticText", value: "Lock Screen" },
                                  ],
                                },
                              ],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
                { role: "AXSplitter" },
                // Content pane
                {
                  role: "AXGroup",
                  children: [
                    {
                      role: "AXScrollArea",
                      children: [
                        {
                          role: "AXGroup",
                          frame: { x: 0, y: 0, width: 400, height: 200 },
                          children: [
                            // Row 1: direct sibling pattern (works today)
                            {
                              role: "AXStaticText",
                              value: "Start Screen Saver when inactive",
                            },
                            {
                              role: "AXPopUpButton",
                              value: "For 5 minutes",
                              frame: { x: 200, y: 10, width: 150, height: 30 },
                            },
                            // Row 2: wrapped in AXOpaqueProviderGroup (issue #130)
                            {
                              role: "AXStaticText",
                              value: "Turn display off when inactive",
                            },
                            {
                              role: "AXOpaqueProviderGroup",
                              frame: { x: 200, y: 50, width: 150, height: 30 },
                              children: [
                                {
                                  role: "AXPopUpButton",
                                  value: "For 10 minutes",
                                  frame: { x: 200, y: 50, width: 150, height: 30 },
                                },
                              ],
                            },
                            // Row 3: a warning text
                            {
                              role: "AXStaticText",
                              value: "Warning Never letting your display turn off may reduce its lifespan.",
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const state = extractSystemSettingsState(axTree);
    expect(state).not.toBeNull();

    // Flatten all controls across groups
    const allControls = state!.contentGroups.flatMap((g) => g.controls);

    // "Start Screen Saver when inactive" should be a detail with AXPopUpButton
    const screenSaver = allControls.find(
      (c) => c.label === "Start Screen Saver when inactive",
    );
    expect(screenSaver).not.toBeUndefined();
    expect(screenSaver!.type).toBe("detail");
    expect(screenSaver!.value).toBe("For 5 minutes");

    // "Turn display off when inactive" should also be a detail with AXPopUpButton
    const displayOff = allControls.find(
      (c) => c.label === "Turn display off when inactive",
    );
    expect(displayOff).not.toBeUndefined();
    expect(displayOff!.type).toBe("detail");
    expect(displayOff!.value).toBe("For 10 minutes");

    // The label "Turn display off when inactive" should NOT appear as a standalone Text control
    const strayText = allControls.find(
      (c) => c.type === "text" && c.label === "Turn display off when inactive",
    );
    expect(strayText).toBeUndefined();
  });

  it("extracts a PopUpButton wrapped in an AXGroup within a group", () => {
    const axTree: AXNode = {
      role: "AXWindow",
      title: "Lock Screen",
      children: [
        {
          role: "AXGroup",
          children: [
            {
              role: "AXSplitGroup",
              children: [
                {
                  role: "AXGroup",
                  children: [
                    {
                      role: "AXScrollArea",
                      children: [
                        {
                          role: "AXOutline",
                          children: [
                            {
                              role: "AXRow",
                              children: [
                                {
                                  role: "AXCell",
                                  capabilities: { selected: true },
                                  children: [
                                    { role: "AXStaticText", value: "Lock Screen" },
                                  ],
                                },
                              ],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
                { role: "AXSplitter" },
                {
                  role: "AXGroup",
                  children: [
                    {
                      role: "AXScrollArea",
                      children: [
                        {
                          role: "AXGroup",
                          frame: { x: 0, y: 0, width: 400, height: 100 },
                          children: [
                            {
                              role: "AXStaticText",
                              value: "Turn display off when inactive",
                            },
                            {
                              role: "AXGroup",
                              frame: { x: 200, y: 10, width: 150, height: 30 },
                              children: [
                                {
                                  role: "AXPopUpButton",
                                  value: "For 10 minutes",
                                  frame: { x: 200, y: 10, width: 150, height: 30 },
                                },
                              ],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const state = extractSystemSettingsState(axTree);
    expect(state).not.toBeNull();

    const allControls = state!.contentGroups.flatMap((g) => g.controls);

    const displayOff = allControls.find(
      (c) => c.label === "Turn display off when inactive",
    );
    expect(displayOff).not.toBeUndefined();
    expect(displayOff!.type).toBe("detail");
    expect(displayOff!.value).toBe("For 10 minutes");
  });

  it("extracts controls wrapped in AXOpaqueProviderGroup at scroll area level", () => {
    const axTree: AXNode = {
      role: "AXWindow",
      title: "Lock Screen",
      children: [
        {
          role: "AXGroup",
          children: [
            {
              role: "AXSplitGroup",
              children: [
                {
                  role: "AXGroup",
                  children: [
                    {
                      role: "AXScrollArea",
                      children: [
                        {
                          role: "AXOutline",
                          children: [
                            {
                              role: "AXRow",
                              children: [
                                {
                                  role: "AXCell",
                                  capabilities: { selected: true },
                                  children: [
                                    { role: "AXStaticText", value: "Lock Screen" },
                                  ],
                                },
                              ],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
                { role: "AXSplitter" },
                {
                  role: "AXGroup",
                  children: [
                    {
                      role: "AXScrollArea",
                      children: [
                        // Text directly in scroll area, followed by opaque group
                        {
                          role: "AXStaticText",
                          value: "Turn display off when inactive",
                        },
                        {
                          role: "AXOpaqueProviderGroup",
                          frame: { x: 200, y: 10, width: 150, height: 30 },
                          children: [
                            {
                              role: "AXPopUpButton",
                              value: "For 10 minutes",
                              frame: { x: 200, y: 10, width: 150, height: 30 },
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const state = extractSystemSettingsState(axTree);
    expect(state).not.toBeNull();

    const allControls = state!.contentGroups.flatMap((g) => g.controls);

    const displayOff = allControls.find(
      (c) => c.label === "Turn display off when inactive",
    );
    expect(displayOff).not.toBeUndefined();
    expect(displayOff!.type).toBe("detail");
    expect(displayOff!.value).toBe("For 10 minutes");

    // Should NOT appear as a heading
    const headingGroup = state!.contentGroups.find(
      (g) => g.heading === "Turn display off when inactive",
    );
    expect(headingGroup).toBeUndefined();
  });
});
