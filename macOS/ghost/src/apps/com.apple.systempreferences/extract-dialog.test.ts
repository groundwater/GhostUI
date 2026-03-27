import { describe, it, expect } from "bun:test";
import { extractSystemSettingsState } from "./extract.js";
import type { AXNode } from "../types.js";

describe("extractSystemSettingsState with AXDialog", () => {
  it("extracts an AXDialog modal overlay on top of a split group", () => {
    const axTree: AXNode = {
      role: "AXWindow",
      title: "Screen Time",
      children: [
        {
          role: "AXGroup",
          children: [
            {
              role: "AXSplitGroup",
              children: [
                // Sidebar pane
                {
                  role: "AXGroup",
                  children: [
                    { role: "AXTextField", label: "Search" },
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
                                  children: [
                                    { role: "AXStaticText", value: "Screen Time" },
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
                          children: [
                            { role: "AXStaticText", value: "App & Website Activity" },
                            { role: "AXButton", title: "App & Website Activity" },
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
        // Modal dialog overlaying the window
        {
          role: "AXDialog",
          children: [
            {
              role: "AXGroup",
              children: [
                { role: "AXStaticText", value: "Keep track of your screen time?" },
                { role: "AXStaticText", value: "Screen Time gives you a detailed report..." },
                { role: "AXButton", label: "Not Now" },
                { role: "AXButton", label: "Turn On App & Website Activity" },
              ],
            },
          ],
        },
      ],
    };

    const state = extractSystemSettingsState(axTree);
    expect(state).not.toBeNull();
    expect(state!.sheet).not.toBeUndefined();
    expect(state!.sheet!.buttons).toContain("Not Now");
    expect(state!.sheet!.buttons).toContain("Turn On App & Website Activity");
  });

  it("extracts an AXDialog when it is the tree root (no split group)", () => {
    const axTree: AXNode = {
      role: "AXDialog",
      title: "Screen Time",
      children: [
        {
          role: "AXGroup",
          children: [
            { role: "AXStaticText", value: "Keep track of your screen time?" },
            { role: "AXButton", label: "Not Now" },
            { role: "AXButton", label: "Turn On App & Website Activity" },
          ],
        },
      ],
    };

    const state = extractSystemSettingsState(axTree);
    expect(state).not.toBeNull();
    expect(state!.sheet).not.toBeUndefined();
    expect(state!.sheet!.buttons).toContain("Not Now");
    expect(state!.sheet!.buttons).toContain("Turn On App & Website Activity");
  });

  it("still extracts AXSheet as before", () => {
    const axTree: AXNode = {
      role: "AXWindow",
      title: "Network",
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
                                  children: [
                                    { role: "AXStaticText", value: "Network" },
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
                      children: [],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          role: "AXSheet",
          children: [
            {
              role: "AXGroup",
              children: [
                { role: "AXButton", label: "Done" },
                { role: "AXButton", label: "Cancel" },
              ],
            },
          ],
        },
      ],
    };

    const state = extractSystemSettingsState(axTree);
    expect(state).not.toBeNull();
    expect(state!.sheet).not.toBeUndefined();
    expect(state!.sheet!.buttons).toContain("Done");
    expect(state!.sheet!.buttons).toContain("Cancel");
  });

  it("extracts sheet buttons that use title instead of label (e.g. OK/Cancel)", () => {
    const axTree: AXNode = {
      role: "AXWindow",
      title: "Network",
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
                                  children: [
                                    { role: "AXStaticText", value: "Network" },
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
                      children: [],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          role: "AXSheet",
          children: [
            {
              role: "AXGroup",
              children: [
                {
                  role: "AXScrollArea",
                  children: [
                    {
                      role: "AXGroup",
                      children: [
                        { role: "AXStaticText", value: "IP Address" },
                        { role: "AXTextField", value: "192.168.1.100" },
                      ],
                    },
                  ],
                },
                // Buttons with title (not label) — common in System Settings sheets
                { role: "AXButton", title: "Cancel" },
                { role: "AXButton", title: "OK" },
              ],
            },
          ],
        },
      ],
    };

    const state = extractSystemSettingsState(axTree);
    expect(state).not.toBeNull();
    expect(state!.sheet).not.toBeUndefined();
    expect(state!.sheet!.buttons).toContain("Cancel");
    expect(state!.sheet!.buttons).toContain("OK");
  });

  it("extracts sheet buttons nested inside AXOpaqueProviderGroup", () => {
    const axTree: AXNode = {
      role: "AXWindow",
      title: "Network",
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
                                  children: [
                                    { role: "AXStaticText", value: "Network" },
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
                    { role: "AXScrollArea", children: [] },
                  ],
                },
              ],
            },
          ],
        },
        {
          role: "AXSheet",
          children: [
            {
              role: "AXOpaqueProviderGroup",
              children: [
                {
                  role: "AXScrollArea",
                  children: [
                    {
                      role: "AXGroup",
                      children: [
                        { role: "AXSwitch", label: "Limit IP Address Tracking" },
                      ],
                    },
                  ],
                },
                { role: "AXButton", title: "Cancel" },
                { role: "AXButton", title: "OK" },
              ],
            },
          ],
        },
      ],
    };

    const state = extractSystemSettingsState(axTree);
    expect(state).not.toBeNull();
    expect(state!.sheet).not.toBeUndefined();
    expect(state!.sheet!.buttons).toContain("Cancel");
    expect(state!.sheet!.buttons).toContain("OK");
    // The switch from the scroll area should be in groups, not in buttons
    expect(state!.sheet!.groups.length).toBeGreaterThan(0);
  });
});
