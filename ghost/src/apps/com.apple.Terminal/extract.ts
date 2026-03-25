import type { AXNode, WindowFrame } from "../types.js";
import { findAXNode, findAllAXNodes, fmtFrame } from "../ax-utils.js";
import type { TerminalAppState, TerminalPane, TerminalTab, TerminalSplit } from "./types.js";

/** Trim trailing blank lines from terminal content */
function trimTrailingBlanks(text: string): string {
  return text.replace(/\n+$/, "");
}

/** Extract Terminal.app state from the raw AX tree */
export function extractTerminalState(axRoot: AXNode, windowFrame: WindowFrame): TerminalAppState | null {
  const title = axRoot.title ?? "";

  // Find the AXSplitGroup that contains terminal panes
  const splitGroup = findAXNode(axRoot, n => n.role === "AXSplitGroup");
  if (!splitGroup) return null;

  // Detect split: AXSplitter presence indicates panes are split
  const splitter = findAXNode(splitGroup, n => n.role === "AXSplitter");
  let split: TerminalSplit | undefined;
  if (splitter) {
    // Determine split direction from splitter dimensions
    // Wide + short = horizontal split (panes stacked vertically)
    // Tall + narrow = vertical split (panes side by side)
    const sf = splitter.frame;
    let direction: "h" | "v" = "h"; // default horizontal (top/bottom)
    if (sf && sf.width > sf.height) {
      direction = "h"; // horizontal splitter = vertical pane layout
    } else if (sf) {
      direction = "v"; // vertical splitter = horizontal pane layout
    }
    const position = splitter.value ? parseInt(splitter.value, 10) : undefined;
    split = { direction, position };
  }

  // Each AXScrollArea inside the split group is a terminal pane
  const scrollAreas = findAllAXNodes(splitGroup, n => n.role === "AXScrollArea");

  const panes: TerminalPane[] = [];
  for (const area of scrollAreas) {
    const textArea = findAXNode(area, n => n.role === "AXTextArea");
    if (!textArea) continue;

    const content = trimTrailingBlanks(textArea.value ?? "");
    const label = textArea.label ?? "shell";
    const focused = textArea.capabilities?.focused === true || area.capabilities?.focused === true;
    panes.push({ label, content, focused: focused || undefined, frame: fmtFrame(area.frame) });
  }

  if (panes.length === 0) return null;

  // Extract tabs from AXTabGroup (present when >1 tab open, or even with 1 visible tab)
  const tabGroup = findAXNode(axRoot, n => n.role === "AXTabGroup");
  const tabs: TerminalTab[] = [];
  if (tabGroup) {
    const radioButtons = findAllAXNodes(tabGroup, n => n.role === "AXRadioButton");
    for (const rb of radioButtons) {
      tabs.push({
        label: rb.title ?? "",
        active: rb.value === "1",
        frame: fmtFrame(rb.frame),
      });
    }
  }
  // Single tab: synthesize from window title
  if (tabs.length === 0) {
    tabs.push({ label: title, active: true });
  }

  return { title, tabs, panes, split };
}
