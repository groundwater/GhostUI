import type { AppBundle, AXNode } from "../types.js";
import type { ActionTarget, ActionCommand } from "../traits.js";
import type { SafariAppState } from "./types.js";
import { safariTree } from "./tree.js";
import { extractSafariState } from "./extract.js";
import { findAXNode, findAllAXNodes } from "../ax-utils.js";

function extractLabel(id: string): string {
  const parts = id.split(":");
  if (parts.length < 3) return parts[1] || "";
  return parts.slice(1, -1).join(":");
}

export const safariBundle: AppBundle<SafariAppState> = {
  bundleId: "com.apple.Safari",

  extract(axTree, windowFrame) {
    return extractSafariState(axTree, windowFrame);
  },

  buildTree(geo, state) {
    return safariTree(geo, state ?? undefined);
  },

  resolveAction(target: ActionTarget, axTree: AXNode): ActionCommand | null {
    const label = extractLabel(target.id);

    // Tab press: find matching AXRadioButton in AXTabGroup
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

    // Back/Forward button press: find matching AXButton in AXToolbar
    if (target.action === "press" && target.type === "Button") {
      const toolbar = findAXNode(axTree, n => n.role === "AXToolbar");
      if (toolbar) {
        const buttons = findAllAXNodes(toolbar, n => n.role === "AXButton");
        const match = buttons.find(b => {
          const desc = (b.label ?? b.title ?? "").toLowerCase();
          return desc.includes(label.toLowerCase());
        });
        if (match) {
          return { method: "axAction", label: match.label ?? match.title ?? label, role: "AXButton", action: "AXPress" };
        }
      }
    }

    // URL bar actions: resolve the actual AX label from the live tree
    // The CRDT tree uses label="URL" but macOS AX uses label="smart search field"
    if (target.type === "TextField") {
      const toolbar = findAXNode(axTree, n => n.role === "AXToolbar");
      const urlField = toolbar
        ? findAXNode(toolbar, n => n.role === "AXTextField")
        : findAXNode(axTree, n => n.role === "AXTextField");
      const axLabel = urlField?.label ?? urlField?.title ?? label;

      if (target.action === "set") {
        if (!target.value) return null;
        return { method: "axSetValue", label: axLabel, role: "AXTextField", value: target.value };
      }
      if (target.action === "focus") {
        return { method: "axAction", label: axLabel, role: "AXTextField", action: "AXFocus" };
      }
      if (target.action === "press") {
        return { method: "axAction", label: axLabel, role: "AXTextField", action: "AXPress" };
      }
    }

    // Native overlay button press (e.g. "Allow", "Cancel" on permission dialogs)
    // These buttons live inside AXGroup children of AXTabGroup
    if (target.action === "press" && target.type === "Button") {
      const tabGroup = findAXNode(axTree, n => n.role === "AXTabGroup");
      if (tabGroup) {
        for (const child of tabGroup.children || []) {
          if (child.role === "AXGroup" && child.title) {
            const buttons = findAllAXNodes(child, n => n.role === "AXButton");
            const match = buttons.find(b => (b.title ?? b.label ?? "") === label);
            if (match) {
              return { method: "axAction", label: match.title ?? match.label ?? label, role: "AXButton", action: "AXPress" };
            }
          }
        }
      }
    }

    // Web content actions (Link, Heading, etc.) — resolve via a11y labels
    // For links, the CRDT uses type "Link" but macOS AX uses "AXLink"
    if (target.type === "Link") {
      if (target.action === "press") {
        return { method: "axAction", label, role: "AXLink", action: "AXPress" };
      }
      return null;
    }

    return null; // fall through to defaultResolveAction
  },
};
