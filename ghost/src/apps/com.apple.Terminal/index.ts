import type { AppBundle, AXNode } from "../types.js";
import type { ActionTarget, ActionCommand } from "../traits.js";
import type { TerminalAppState } from "./types.js";
import { terminalTree } from "./tree.js";
import { extractTerminalState } from "./extract.js";
import { findAXNode, findAllAXNodes } from "../ax-utils.js";

function extractLabel(id: string): string {
  const parts = id.split(":");
  if (parts.length < 3) return parts[1] || "";
  return parts.slice(1, -1).join(":");
}

export const terminalBundle: AppBundle<TerminalAppState> = {
  bundleId: "com.apple.Terminal",

  extract(axTree, windowFrame) {
    return extractTerminalState(axTree, windowFrame);
  },

  buildTree(geo, state) {
    return terminalTree(geo, state ?? undefined);
  },

  resolveAction(target: ActionTarget, axTree: AXNode): ActionCommand | null {
    const label = extractLabel(target.id);

    // Tab press: find matching AXRadioButton in AXTabGroup and AXPress it
    if (target.action === "press" && target.type === "Tab") {
      const tabGroup = findAXNode(axTree, n => n.role === "AXTabGroup");
      if (tabGroup) {
        const buttons = findAllAXNodes(tabGroup, n => n.role === "AXRadioButton");
        const match = buttons.find(b => b.title === label);
        if (match) {
          return { method: "axAction", label, role: "AXRadioButton", action: "AXPress" };
        }
      }
      return null;
    }

    // TextArea set: type text via keyboard (Terminal ignores AXSetValue)
    if (target.action === "set" && target.type === "TextArea") {
      if (!target.value) return null;
      return { method: "keyboard", text: target.value };
    }

    // TextArea focus: click the AXTextArea to focus a specific pane
    if (target.action === "focus" && target.type === "TextArea") {
      return { method: "axAction", label: "shell", role: "AXTextArea", action: "AXPress" };
    }

    return null; // fall through to defaultResolveAction
  },
};
