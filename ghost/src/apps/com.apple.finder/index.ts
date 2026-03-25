import type { AppBundle, AXNode } from "../types.js";
import type { ActionTarget, ActionCommand } from "../traits.js";
import type { FinderAppState } from "./types.js";
import { finderTree } from "./tree.js";
import { extractFinderState } from "./extract.js";
import { findAXNode, findAllAXNodes } from "../ax-utils.js";

function extractLabel(id: string): string {
  const parts = id.split(":");
  if (parts.length < 3) return parts[1] || "";
  return parts.slice(1, -1).join(":");
}

export const finderBundle: AppBundle<FinderAppState> = {
  bundleId: "com.apple.finder",

  extract(axTree, windowFrame) {
    return extractFinderState(axTree, windowFrame);
  },

  buildTree(geo, state) {
    return finderTree(geo, state ?? undefined);
  },

  followUpQuery(target: ActionTarget): string | null {
    switch (target.type) {
      case "MenuItem":
        // After a menu item click, show sheet/dialog content (e.g. confirmation
        // prompts) or the window content (toolbar + file list) for view changes.
        return "Sheet { * } Dialog { * } Window { Toolbar { Button, SearchField }, Split { ListItem } }";
      case "MenuBarItem":
        // Opening a menu — show menu contents (default behavior)
        return "Menu { MenuItem }";
      case "Button": {
        const label = extractLabel(target.id);
        if (label === "Search") {
          // After clicking Search, show the search field that appears in the toolbar
          return "Toolbar { SearchField }";
        }
        return null;
      }
      default:
        return null;
    }
  },

  resolveAction(target: ActionTarget, axTree: AXNode): ActionCommand | null {
    const label = extractLabel(target.id);

    // Sidebar item click: find matching AXRow in sidebar outline
    if (target.action === "press" && target.type === "ListItem") {
      const sidebarOutline = findAXNode(axTree, n => n.role === "AXOutline" && n.label === "sidebar");
      if (sidebarOutline) {
        const rows = findAllAXNodes(sidebarOutline, n => n.role === "AXRow");
        for (const row of rows) {
          const textNode = findAXNode(row, n => n.role === "AXStaticText" && n.value === label);
          if (textNode) {
            return { method: "axAction", label, role: "AXRow", action: "AXPress" };
          }
        }
      }
    }

    // Search field actions (set/type text into the search field)
    if (target.type === "SearchField" && (target.action === "set" || target.action === "type")) {
      return target.action === "set"
        ? { method: "axSetValue", role: "AXSearchField", value: target.value ?? "" }
        : { method: "axTypeValue", role: "AXSearchField", value: target.value ?? "" };
    }
    if (target.type === "SearchField" && target.action === "press") {
      return { method: "axAction", label: "", role: "AXSearchField", action: "AXPress" };
    }
    if (target.type === "SearchField" && target.action === "focus") {
      return { method: "axAction", label: "", role: "AXSearchField", action: "AXFocus" };
    }

    // Toolbar buttons
    if (target.action === "press" && target.type === "Button") {
      return { method: "axAction", label, role: "AXButton", action: "AXPress" };
    }

    // Toolbar PopUpButton (e.g. view mode selector)
    if (target.action === "press" && target.type === "PopUpButton") {
      return { method: "axAction", label, role: "AXPopUpButton", action: "AXPress" };
    }

    // Toolbar MenuButton (e.g. Group, Action)
    if (target.action === "press" && target.type === "MenuButton") {
      return { method: "axAction", label, role: "AXMenuButton", action: "AXPress" };
    }

    // RadioButton (view mode selector on some Finder toolbar configurations)
    if (target.action === "press" && target.type === "RadioButton") {
      return { method: "axAction", label, role: "AXRadioButton", action: "AXPress" };
    }

    // File list item click
    if (target.action === "press" && target.type === "ListItem") {
      return { method: "axAction", label, role: "AXTextField", action: "AXPress" };
    }

    return null;
  },
};
