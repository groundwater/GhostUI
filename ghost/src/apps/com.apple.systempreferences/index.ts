import type { AppBundle, AXNode } from "../types.js";
import type { ActionTarget, ActionCommand } from "../traits.js";
import { extractSystemSettingsState } from "./extract.js";
import { settingsTree } from "./tree.js";
import type { SystemSettingsState } from "./types.js";
import { findAXNode, findAllAXNodes } from "../ax-utils.js";

/** Extract label from CRDT node ID (Tag:Label:Index → Label) */
function extractLabel(id: string): string {
  const parts = id.split(":");
  if (parts.length < 3) return parts[1] || "";
  return parts.slice(1, -1).join(":");
}

/** Quote a label for use in a query selector */
function q(label: string): string {
  if (/[\s"#\[\]{}]/.test(label)) return `"${label}"`;
  return label;
}

const TOGGLE_ROLES = new Set(["AXCheckBox", "AXSwitch"]);

/** Map of CRDT ID prefixes to AX roles. Generic controls rendered by tree.ts
 *  encode the original AX role in the ID (e.g. "RadioButton:Output:0"). */
const ID_PREFIX_TO_AX_ROLE: Record<string, string> = {
  RadioButton: "AXRadioButton",
  TabButton: "AXRadioButton",
  Segment: "AXRadioButton",
};

/** Infer the AX role from a CRDT node ID prefix (Tag:Label:Index). */
function inferAxRoleFromId(id: string): string | null {
  const prefix = id.split(":")[0];
  return ID_PREFIX_TO_AX_ROLE[prefix] ?? null;
}

/**
 * Find an AX control of a given role that has a preceding AXStaticText sibling
 * with the matching label. This handles controls like AXPopUpButton whose label
 * comes from a separate AXStaticText element rather than the control itself.
 */
function findSiblingControl(root: AXNode, label: string, targetRole: string): AXNode | undefined {
  function walk(node: AXNode): AXNode | undefined {
    const children = node.children;
    if (!children) return undefined;
    for (let i = 1; i < children.length; i++) {
      const child = children[i];
      if (child.role !== targetRole) continue;
      const prev = children[i - 1];
      if (prev.role === "AXStaticText") {
        const txt = prev.value || prev.label || "";
        if (txt === label) return child;
      }
    }
    for (const child of children) {
      const found = walk(child);
      if (found) return found;
    }
    return undefined;
  }
  return walk(root);
}

/**
 * Find an AXGroup that contains an AXStaticText child with the given label.
 * These are "navItem" rows in System Settings — groups that contain a label
 * and optionally a chevron/disclosure button.
 */
function findNavGroup(root: AXNode, label: string): AXNode | undefined {
  function walk(node: AXNode): AXNode | undefined {
    const children = node.children;
    if (!children) return undefined;
    // Check if this group is a nav row with the label
    if (node.role === "AXGroup" && node.frame) {
      const hasLabel = children.some(
        (c) => c.role === "AXStaticText" && (c.value === label || c.label === label)
      );
      if (hasLabel) return node;
    }
    for (const child of children) {
      const found = walk(child);
      if (found) return found;
    }
    return undefined;
  }
  return walk(root);
}

/**
 * Find an AXCheckBox/AXSwitch that lacks its own label but has a preceding
 * AXStaticText sibling whose value matches `label`. This pattern is common
 * in System Settings where the label text is a separate element.
 */
function findSiblingToggle(root: AXNode, label: string): AXNode | undefined {
  function walk(node: AXNode): AXNode | undefined {
    const children = node.children;
    if (!children) return undefined;
    for (let i = 1; i < children.length; i++) {
      const child = children[i];
      if (!TOGGLE_ROLES.has(child.role)) continue;
      // Check if the element already has an identifying label
      if (child.title === label || child.label === label) continue;
      // Check the preceding sibling for a matching text
      const prev = children[i - 1];
      if (prev.role === "AXStaticText") {
        const txt = prev.value || prev.label || "";
        if (txt === label || txt.startsWith(label)) {
          return child;
        }
      }
    }
    // Recurse into children
    for (const child of children) {
      const found = walk(child);
      if (found) return found;
    }
    return undefined;
  }
  return walk(root);
}

export const systemPreferencesBundle: AppBundle<SystemSettingsState> = {
  bundleId: "com.apple.systempreferences",

  extract(axTree, _windowFrame) {
    return extractSystemSettingsState(axTree);
  },

  buildTree(geo, state) {
    return settingsTree(geo, state ?? undefined);
  },

  followUpQuery(target: ActionTarget): string | null {
    const label = extractLabel(target.id);

    switch (target.type) {
      case "ListItem":
        // PopUpButton ListItems open a dropdown menu
        if (target.axRole === "AXPopUpButton") {
          return "Menu { MenuItem }";
        }
        // Navigation: show what loaded on the new page
        return `VStack#content-body { * }`;

      case "Toggle":
        return `Toggle#${q(label)}[**]`;

      case "Button":
        // Navigation buttons (back, sub-page links like Display, VoiceOver, etc.)
        // all navigate to a new page — show the content body that appeared.
        return `VStack#content-body { * }`;

      case "TextField":
        // Sidebar search: show filtered sidebar items after search
        if (target.id === "sidebar-search") {
          return `VStack#sidebar { * }`;
        }
        return `TextField#${q(label)}`;

      case "TreeItem":
        return `TreeItem#${q(label)}`;

      case "More":
        return `VStack#content-body { * }`;

      default:
        return null;
    }
  },

  resolveAction(target: ActionTarget, axTree: AXNode): ActionCommand | null {
    const label = extractLabel(target.id);

    // Back button: press the toolbar Back button
    if (target.action === "press" && target.id === "back-btn") {
      return { method: "axAction", label: "Back", role: "AXButton", action: "AXPress" };
    }

    // More scroll: scroll the enclosing scroll area
    if (target.action === "scroll" && target.type === "More") {
      // Direction is encoded in the More node attrs; default to down
      return { method: "axAction", label: "", role: "AXScrollArea", action: "AXScrollDownByPage" };
    }

    // Sidebar search field: has non-standard ID "sidebar-search" (no colon-delimited label).
    // The AX element may be AXTextField or AXSearchField depending on macOS version.
    // Setting to empty string clears the search.
    if ((target.action === "set" || target.action === "type") && target.id === "sidebar-search") {
      const value = target.value ?? "";
      // Find the search field in the sidebar — try AXSearchField first, then AXTextField
      const searchField = findAXNode(axTree, (n) => n.role === "AXSearchField")
        || findAXNode(axTree, (n) => n.role === "AXTextField" && !n.title && !n.label);
      const role = searchField?.role || "AXSearchField";
      if (target.action === "type") {
        return { method: "axTypeValue", role, value };
      }
      return { method: "axSetValue", role, value };
    }

    // Sidebar search field: click to focus
    if (target.action === "press" && target.id === "sidebar-search") {
      const searchField = findAXNode(axTree, (n) => n.role === "AXSearchField")
        || findAXNode(axTree, (n) => n.role === "AXTextField" && !n.title && !n.label);
      if (searchField?.frame) {
        const cx = Math.round(searchField.frame.x + searchField.frame.width / 2);
        const cy = Math.round(searchField.frame.y + searchField.frame.height / 2);
        return { method: "pointer", x: cx, y: cy, action: "click" };
      }
      const role = searchField?.role || "AXSearchField";
      return { method: "axAction", label: "", role, action: "AXFocus" };
    }

    // TextField set: use AX setValue directly
    if (target.action === "set" && target.type === "TextField") {
      if (!target.value && target.value !== "") return null;
      const field = findAXNode(axTree, (n) =>
        n.role === "AXTextField" && n.value === label
      );
      if (field) {
        return { method: "axSetValue", label, role: "AXTextField", value: target.value! };
      }
    }

    // Slider set: axSetValue with AXSlider role
    if (target.action === "set" && target.id.startsWith("Slider:")) {
      if (!target.value) return null;
      return { method: "axSetValue", label, role: "AXSlider", value: target.value };
    }

    // Disclosure press: AXPress on AXDisclosureTriangle
    if (target.action === "press" && target.type === "TreeItem" && target.id.startsWith("TreeItem:")) {
      return { method: "axAction", label, role: "AXDisclosureTriangle", action: "AXPress" };
    }

    // Link press: AXPress on AXLink
    if (target.action === "press" && target.id.startsWith("Link:")) {
      return { method: "axAction", label, role: "AXLink", action: "AXPress" };
    }

    // Generic controls: role-agnostic AXPress
    const genericPrefixes = ["Slider:", "PopUpButton:", "ScrollArea:", "Cell:", "Row:"];
    if (target.action === "press" && genericPrefixes.some(p => target.id.startsWith(p))) {
      return { method: "axAction", label, action: "AXPress" };
    }

    // Toggle press: System Settings uses AXSwitch (not AXCheckBox) for toggles.
    // Resolve to the correct AX role by checking the live tree.
    if (target.action === "press" && target.type === "Toggle") {
      // Try direct label/title/value match first
      const switchEl = findAXNode(axTree, (n) =>
        n.role === "AXSwitch" && (n.title === label || n.label === label || n.value === label)
      );
      if (switchEl) {
        return { method: "axAction", label, role: "AXSwitch", action: "AXPress" };
      }
      const checkEl = findAXNode(axTree, (n) =>
        n.role === "AXCheckBox" && (n.title === label || n.label === label || n.value === label)
      );
      if (checkEl) {
        return { method: "axAction", label, role: "AXCheckBox", action: "AXPress" };
      }

      // Sibling-label match: many System Settings toggles have no own label —
      // the label comes from a preceding AXStaticText sibling. Find the text
      // sibling with matching value, then pick the next AXCheckBox sibling.
      const matchingSwitch = findSiblingToggle(axTree, label);
      if (matchingSwitch?.frame) {
        const cx = Math.round(matchingSwitch.frame.x + matchingSwitch.frame.width / 2);
        const cy = Math.round(matchingSwitch.frame.y + matchingSwitch.frame.height / 2);
        return { method: "pointer", x: cx, y: cy, action: "click" };
      }
    }

    // ListItem press: these nodes map to various AX elements depending on
    // the original content control type (navItem, detail, radio, etc.).
    // The label comes from surrounding AXStaticText, not the control itself,
    // so the default AXRow-based resolver can't find them.
    if (target.action === "press" && target.type === "ListItem") {
      // Infer axRole from the CRDT node ID prefix when it's not explicitly set.
      // Generic controls rendered by the fallback in tree.ts encode the AX role
      // in the ID prefix (e.g. "RadioButton:Output:0" → AXRadioButton).
      const effectiveAxRole = target.axRole || inferAxRoleFromId(target.id);

      // If the CRDT node carries an axRole (or we inferred one), find the
      // specific control type.
      if (effectiveAxRole) {
        const axRole = effectiveAxRole;
        // Try direct label match first (some controls have their own label)
        const direct = findAXNode(axTree, (n) =>
          n.role === axRole && (n.title === label || n.label === label)
        );
        if (direct?.frame) {
          const cx = Math.round(direct.frame.x + direct.frame.width / 2);
          const cy = Math.round(direct.frame.y + direct.frame.height / 2);
          return { method: "pointer", x: cx, y: cy, action: "click" };
        }
        // Find by preceding sibling text pattern: AXStaticText(label) followed by control
        const siblingMatch = findSiblingControl(axTree, label, axRole);
        if (siblingMatch?.frame) {
          const cx = Math.round(siblingMatch.frame.x + siblingMatch.frame.width / 2);
          const cy = Math.round(siblingMatch.frame.y + siblingMatch.frame.height / 2);
          return { method: "pointer", x: cx, y: cy, action: "click" };
        }
      }

      // navItem / generic: find the AXGroup containing AXStaticText with the label
      // and a "Show Detail" button or disclosure indicator, then click its center.
      const navGroup = findNavGroup(axTree, label);
      if (navGroup?.frame) {
        const cx = Math.round(navGroup.frame.x + navGroup.frame.width / 2);
        const cy = Math.round(navGroup.frame.y + navGroup.frame.height / 2);
        return { method: "pointer", x: cx, y: cy, action: "click" };
      }

      // Sidebar ListItems: these are AXRow > AXCell > AXStaticText in an AXOutline.
      // The default resolver handles these since AXRow child text search works.
      // Fall through to default.
    }

    return null; // fall through to defaultResolveAction
  },
};
