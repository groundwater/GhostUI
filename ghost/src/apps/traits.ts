// ── Trait definitions: what actions each node type supports ──

export const TRAITS: Record<string, string[]> = {
  MenuBarItem: ["press", "hover"],
  MenuItem:    ["press", "hover"],
  Button:      ["press"],
  PopUpButton: ["press"],
  MenuButton:  ["press"],
  ComboBox:    ["press", "focus", "set"],
  RadioButton: ["press"],
  Tab:         ["press"],
  Toggle:      ["press"],
  TreeItem:    ["press"],
  ListItem:    ["press", "set"],
  Row:         ["press"],
  Cell:        ["press"],
  TextField:   ["focus", "set", "type"],
  TextArea:    ["set", "type"],
  SearchField: ["focus", "set", "type"],
  Slider:      ["set"],
  More:        ["scroll"],
  Link:        ["press"],
}

// ── Action target: web UI → daemon ──

export interface ActionTarget {
  app: string;     // bundleId, e.g. "com.microsoft.VSCode"
  type: string;    // node type, e.g. "MenuItem"
  id: string;      // CRDT node ID, e.g. "MenuItem:File:0"
  action: string;  // trait action, e.g. "press" or "hover"
  value?: string;  // value for "set" action
  axRole?: string; // original AX role, e.g. "AXPopUpButton" when schema type differs
  x?: number;      // center x coordinate (for pointer-based actions like rightclick)
  y?: number;      // center y coordinate (for pointer-based actions like rightclick)
}

// ── Action command: daemon → GhostUI Swift ──

export type ActionCommand =
  | { method: "axAction"; label: string; role?: string; action: string; nth?: number; parent?: string }
  | { method: "axHover"; label: string; role?: string; nth?: number; parent?: string }
  | { method: "axSetValue"; label?: string; role?: string; value: string; nth?: number; parent?: string }
  | { method: "axTypeValue"; label?: string; role?: string; value: string; nth?: number; parent?: string }
  | { method: "pointer"; x: number; y: number; action: "click" | "rightClick" }
  | { method: "keyboard"; keys?: string[]; modifiers?: string[]; text?: string }

// ── Node type → AX role mapping ──

const TYPE_TO_AX_ROLE: Record<string, string> = {
  MenuBarItem: "AXMenuBarItem",
  MenuItem:    "AXMenuItem",
  Button:      "AXButton",
  PopUpButton: "AXPopUpButton",
  MenuButton:  "AXMenuButton",
  ComboBox:    "AXComboBox",
  Tab:         "AXTab",
  Toggle:      "AXCheckBox",
  TreeItem:    "AXRow",
  ListItem:    "AXRow",
  Row:         "AXRow",
  Cell:        "AXCell",
  TextField:   "AXTextField",
  TextArea:    "AXTextArea",
  SearchField: "AXSearchField",
  Slider:      "AXSlider",
  Link:        "AXLink",
}

// ── Extract label and sibling index from CRDT node ID ──
// ID format: "Tag:titleOrLabel:siblingIndex"

function labelFromId(id: string): string {
  const parts = id.split(":");
  // parts[0] = tag, parts[last] = index, middle = label (may contain colons)
  if (parts.length < 3) return parts[1] || "";
  return parts.slice(1, -1).join(":");
}

function nthFromId(id: string): number | undefined {
  const parts = id.split(":");
  if (parts.length < 2) return undefined;
  const last = parts[parts.length - 1];
  const n = parseInt(last, 10);
  return isNaN(n) ? undefined : n;
}

// ── Default resolver for nodes without bundle-specific handling ──

// ── Follow-up queries: after an action, what query shows the result? ──

const FOLLOW_UP: Record<string, Record<string, string>> = {
  MenuBarItem: { press: "Menu { MenuItem }" },
  MenuItem:    { press: "Sheet { * } Dialog { * } Window { Toolbar { * } }" },
  PopUpButton: { press: "Menu { MenuItem }" },
  MenuButton:  { press: "Menu { MenuItem }" },
};

export function defaultFollowUp(type: string, action: string, axRole?: string): string | null {
  // Right-click always shows a context menu regardless of node type
  if (action === "rightclick") return "Menu { MenuItem }";
  // PopUpButton elements mapped to ListItem still open a dropdown menu
  if (type === "ListItem" && axRole === "AXPopUpButton" && action === "press") {
    return "Menu { MenuItem }";
  }
  return FOLLOW_UP[type]?.[action] ?? null;
}

// ── Default resolver for nodes without bundle-specific handling ──

export function defaultResolveAction(target: ActionTarget): ActionCommand | null {
  const label = labelFromId(target.id);
  const role = target.axRole || TYPE_TO_AX_ROLE[target.type];
  const nth = nthFromId(target.id);

  // rightclick is purely coordinate-based, skip label/role requirements
  if (target.action === "rightclick") {
    if (target.x == null || target.y == null) return null;
    return { method: "pointer", x: target.x, y: target.y, action: "rightClick" };
  }

  // When label is empty, we can still target by role + nth index.
  // This handles elements that lack title/label/value (e.g. Calendar TextFields).
  if (!label && !role) return null;
  if (!label && target.action !== "set" && target.action !== "type" && nth === undefined) return null;

  switch (target.action) {
    case "press":
      return { method: "axAction", label, role, action: "AXPress", ...(nth !== undefined && !label ? { nth } : {}) };
    case "hover":
      return { method: "axHover", label, role, ...(nth !== undefined && !label ? { nth } : {}) };
    case "focus":
      return { method: "axAction", label, role, action: "AXFocus", ...(nth !== undefined && !label ? { nth } : {}) };
    case "set":
      if (!target.value) return null;
      return { method: "axSetValue", label: label || undefined, role, value: target.value, ...(nth !== undefined && !label ? { nth } : {}) };
    case "type":
      if (!target.value) return null;
      return { method: "axTypeValue", label: label || undefined, role, value: target.value, ...(nth !== undefined && !label ? { nth } : {}) };
    case "contextMenu":
      return { method: "axAction", label, role, action: "AXShowMenu", ...(nth !== undefined && !label ? { nth } : {}) };
    default:
      return null;
  }
}
