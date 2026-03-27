import { n, resetIdCounter, type NodeDescriptor } from "../../crdt/schema.js";
import type { WindowGeometry } from "../types.js";
import { fmtWinFrame } from "../ax-utils.js";
import type { SystemSettingsState, ContentGroup, ContentControl, SheetState } from "./types.js";

/** Icon lookup for known sidebar labels */
const SIDEBAR_ICONS: Record<string, string> = {
  "Sign in, with your Apple Account": "account",
  "Apple ID": "account",
  "Wi‑Fi": "radio-tower",
  "Wi-Fi": "radio-tower",
  "Bluetooth": "plug",
  "Network": "globe",
  "Energy": "zap",
  "General": "gear",
  "Accessibility": "person",
  "Appearance": "paintcan",
  "Siri": "hubot",
  "Control Center": "dashboard",
  "Desktop & Dock": "layout",
  "Displays": "device-desktop",
  "Screen Saver": "mirror",
  "Spotlight": "search",
  "Wallpaper": "screen-full",
  "Notifications": "bell",
  "Sound": "unmute",
  "Focus": "eye",
  "Screen Time": "watch",
  "Lock Screen": "lock",
  "Privacy & Security": "shield",
  "Login Password": "key",
  "Users & Groups": "organization",
  "Internet Accounts": "mail",
  "Game Center": "game",
};

/** Helper: create a node descriptor with an explicit stable ID */
function sn(id: string, type: string, attrsOrChildren?: Record<string, unknown> | NodeDescriptor[], children?: NodeDescriptor[]): NodeDescriptor {
  if (Array.isArray(attrsOrChildren)) {
    return { type, id, children: attrsOrChildren };
  }
  return { type, id, attrs: attrsOrChildren || undefined, children };
}

/** Build sidebar from extracted state */
function settingsSidebar(state: SystemSettingsState): NodeDescriptor {
  const items: NodeDescriptor[] = [];

  for (let i = 0; i < state.sidebarItems.length; i++) {
    const item = state.sidebarItems[i];
    const icon = SIDEBAR_ICONS[item.label];
    const attrs: Record<string, unknown> = { label: item.label };
    if (icon) attrs.icon = icon;
    if (item.selected) attrs.selected = true;
    if (item.frame) attrs.frame = item.frame;
    items.push(sn(`ListItem:${item.label}:${i}`, "ListItem", attrs));
  }

  const scrollChildren: NodeDescriptor[] = [sn("sidebar-list", "VStack", {}, items)];
  if (state.sidebarTruncated) {
    scrollChildren.push(sn("sidebar-more", "More", { direction: "down", scrollTarget: "sidebar-scroll" }));
  }

  const searchAttrs: Record<string, unknown> = { placeholder: "Search" };
  if (state.sidebarSearchValue) searchAttrs.value = state.sidebarSearchValue;

  return sn("sidebar", "VStack", {}, [
    sn("sidebar-search", "TextField", searchAttrs),
    sn("sidebar-scroll", "Scroll", {}, scrollChildren),
  ]);
}

/** Get the next global index for a tag:label combination */
function nextTagIndex(tagCounters: Map<string, number>, tag: string, label: string): number {
  const key = `${tag}:${label}`;
  const idx = tagCounters.get(key) ?? 0;
  tagCounters.set(key, idx + 1);
  return idx;
}

/** Render a single content control using global tag counters for stable IDs */
function renderControl(control: ContentControl, tagCounters: Map<string, number>): NodeDescriptor | null {
  const result = renderControlInner(control, tagCounters);
  if (result && control.frame) {
    result.attrs = result.attrs || {};
    (result.attrs as Record<string, unknown>).frame = control.frame;
  }
  return result;
}

function renderControlInner(control: ContentControl, tagCounters: Map<string, number>): NodeDescriptor | null {
  switch (control.type) {
    case "toggle": {
      const idx = nextTagIndex(tagCounters, "Toggle", control.label);
      return sn(`Toggle:${control.label}:${idx}`, "Toggle", {
        label: control.label,
        checked: control.checked ?? false,
      });
    }

    case "switch": {
      const idx = nextTagIndex(tagCounters, "Toggle", control.label);
      return sn(`Toggle:${control.label}:${idx}`, "Toggle", {
        label: control.label,
        checked: control.checked ?? false,
      });
    }

    case "navItem": {
      const idx = nextTagIndex(tagCounters, "ListItem", control.label);
      const attrs: Record<string, unknown> = { label: control.label };
      if (control.value) attrs.detail = control.value;
      attrs.chevron = true;
      return sn(`ListItem:${control.label}:${idx}`, "ListItem", attrs);
    }

    case "detail": {
      const idx = nextTagIndex(tagCounters, "ListItem", control.label);
      const attrs: Record<string, unknown> = { label: control.label };
      if (control.value) attrs.detail = control.value;
      if (control.axRole) attrs.axRole = control.axRole;
      return sn(`ListItem:${control.label}:${idx}`, "ListItem", attrs);
    }

    case "button": {
      const idx = nextTagIndex(tagCounters, "Button", control.label);
      return sn(`Button:${control.label}:${idx}`, "Button", { label: control.label });
    }

    case "textField": {
      const idx = nextTagIndex(tagCounters, "TextField", control.label);
      const attrs: Record<string, unknown> = { label: control.label };
      if (control.value) attrs.value = control.value;
      return sn(`TextField:${control.label}:${idx}`, "TextField", attrs);
    }

    case "searchField": {
      const idx = nextTagIndex(tagCounters, "TextField", control.label);
      const attrs: Record<string, unknown> = { label: control.label };
      if (control.value) attrs.value = control.value;
      attrs.placeholder = control.label;
      return sn(`TextField:${control.label}:${idx}`, "TextField", attrs);
    }

    case "text": {
      const truncLabel = control.label.slice(0, 40);
      const idx = nextTagIndex(tagCounters, "Text", truncLabel);
      return sn(`Text:${truncLabel}:${idx}`, "Text", { value: control.label });
    }

    case "radio": {
      const idx = nextTagIndex(tagCounters, "ListItem", control.label);
      const selected = control.options?.find((o) => o.selected);
      const attrs: Record<string, unknown> = { label: control.label };
      if (selected) attrs.detail = selected.label;
      return sn(`ListItem:${control.label}:${idx}`, "ListItem", attrs);
    }

    case "segmentedControl": {
      const idx = nextTagIndex(tagCounters, "ListItem", control.label);
      const selected = control.options?.find((o) => o.selected);
      const attrs: Record<string, unknown> = { label: control.label };
      if (selected) attrs.detail = selected.label;
      return sn(`ListItem:${control.label}:${idx}`, "ListItem", attrs);
    }

    case "slider": {
      const idx = nextTagIndex(tagCounters, "Slider", control.label);
      const attrs: Record<string, unknown> = { label: control.label };
      if (control.value) attrs.value = control.value;
      return sn(`Slider:${control.label}:${idx}`, "Slider", attrs);
    }

    case "link": {
      const idx = nextTagIndex(tagCounters, "Link", control.label);
      return sn(`Link:${control.label}:${idx}`, "Button", {
        label: control.label,
        icon: "link-external",
      });
    }

    case "disclosure": {
      const idx = nextTagIndex(tagCounters, "TreeItem", control.label);
      return sn(`TreeItem:${control.label}:${idx}`, "TreeItem", {
        label: control.label,
        expanded: control.expanded ?? false,
      });
    }

    case "image": {
      const idx = nextTagIndex(tagCounters, "Image", control.label);
      return sn(`Image:${control.label}:${idx}`, "Image", { name: control.label });
    }

    case "generic": {
      const tag = control.axRole ? control.axRole.replace("AX", "") : "Control";
      const idx = nextTagIndex(tagCounters, tag, control.label);
      const attrs: Record<string, unknown> = { label: control.label };
      if (control.value) attrs.detail = control.value;
      if (control.axRole) attrs.axRole = control.axRole;
      return sn(`${tag}:${control.label}:${idx}`, "ListItem", attrs);
    }

    default:
      return null;
  }
}

/** Render a content group as a card */
function renderGroup(group: ContentGroup, groupIdx: number, tagCounters: Map<string, number>): NodeDescriptor {
  const children: NodeDescriptor[] = [];
  let sepCount = 0;
  const groupId = group.id || group.heading || String(groupIdx);

  if (group.heading) {
    children.push(sn(`grp-${groupId}-heading`, "Heading", { value: group.heading, level: 2 }));
  }

  for (let i = 0; i < group.controls.length; i++) {
    const node = renderControl(group.controls[i], tagCounters);
    if (!node) continue;
    if (children.length > 0 && children[children.length - 1].type !== "Heading") {
      children.push(sn(`grp-${groupId}-sep-${sepCount++}`, "Separator"));
    }
    children.push(node);
  }

  const groupAttrs: Record<string, unknown> = { gap: 0 };
  if (group.frame) groupAttrs.frame = group.frame;
  return sn(`grp-${groupId}`, "VStack", groupAttrs, children);
}

/** Render a sheet overlay as a Sheet node with its content groups and action buttons */
function renderSheet(sheet: SheetState, tagCounters: Map<string, number>): NodeDescriptor {
  const children: NodeDescriptor[] = [];

  for (let i = 0; i < sheet.groups.length; i++) {
    children.push(renderGroup(sheet.groups[i], i, tagCounters));
  }

  // Render action buttons (Done, Cancel, etc.)
  for (let i = 0; i < sheet.buttons.length; i++) {
    const label = sheet.buttons[i];
    const idx = nextTagIndex(tagCounters, "Button", label);
    children.push(sn(`Button:${label}:${idx}`, "Button", { label }));
  }

  const attrs: Record<string, unknown> = { gap: 12 };
  if (sheet.title) attrs.title = sheet.title;
  return sn("sheet-dialog", "Sheet", attrs, children);
}

/** Build the full settings tree from extracted state */
export function settingsTree(
  geo: WindowGeometry | undefined,
  state?: SystemSettingsState,
): NodeDescriptor {
  resetIdCounter();

  const screenW = geo?.screenW ?? 1440;
  const screenH = geo?.screenH ?? 900;
  const windowAttrs: Record<string, unknown> = { title: state?.contentTitle || "System Settings" };
  if (geo) { windowAttrs.x = geo.x; windowAttrs.y = geo.y; windowAttrs.w = geo.w; windowAttrs.h = geo.h; }

  // Sidebar
  let sidebar: NodeDescriptor;
  if (state && state.sidebarItems.length > 0) {
    sidebar = settingsSidebar(state);
  } else {
    sidebar = sn("sidebar", "VStack", {}, [
      sn("sidebar-search", "TextField", { placeholder: "Search" }),
      sn("sidebar-scroll", "Scroll", {}),
    ]);
  }

  // Content
  const tagCounters = new Map<string, number>();
  let contentScroll: NodeDescriptor;
  if (state) {
    const contentChildren: NodeDescriptor[] = [];

    if (state.contentTitle) {
      const headerChildren: NodeDescriptor[] = [];
      if (state.isSubPage && state.breadcrumb.length > 0) {
        headerChildren.push(sn("back-btn", "Button", { label: state.breadcrumb[0], icon: "chevron-left" }));
      }
      headerChildren.push(sn("content-title", "Heading", { value: state.contentTitle, level: 1 }));
      contentChildren.push(sn("content-header", "VStack", {}, headerChildren));
    }

    for (let i = 0; i < state.contentGroups.length; i++) {
      contentChildren.push(renderGroup(state.contentGroups[i], i, tagCounters));
    }

    const scrollChildren: NodeDescriptor[] = [
      sn("content-body", "VStack", { gap: 20 }, contentChildren),
    ];
    if (state.contentTruncated) {
      scrollChildren.push(sn("content-more", "More", { direction: "down", scrollTarget: "content-scroll" }));
    }
    contentScroll = sn("content-scroll", "Scroll", {}, scrollChildren);
  } else {
    contentScroll = sn("content-scroll", "Scroll", {});
  }

  // Build Window children: titlebar + split, plus Sheet if active
  const windowChildren: NodeDescriptor[] = [
    sn("settings-titlebar", "Titlebar", {}),
    sn("settings-split", "Split", { direction: "h", sizes: [220, null] }, [
      sidebar,
      contentScroll,
    ]),
  ];

  // Sheet as a direct Window child so modal blocking collapses siblings
  if (state?.sheet) {
    windowChildren.push(renderSheet(state.sheet, tagCounters));
  }

  return sn("Display::0", "Display", { screenW: String(screenW), screenH: String(screenH) }, [
    sn("settings-app", "Application", { bundleId: "com.apple.systempreferences", title: "System Settings", frame: fmtWinFrame(geo?.x ?? 0, geo?.y ?? 0, geo?.w ?? 1440, geo?.h ?? 900) }, [
      sn("settings-window", "Window", windowAttrs, windowChildren),
    ]),
  ]);
}
