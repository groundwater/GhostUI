import { n, resetIdCounter, type NodeDescriptor } from "../../crdt/schema.js";
import type { WindowGeometry } from "../types.js";
import { fmtWinFrame } from "../ax-utils.js";
import type { FinderAppState } from "./types.js";

function buildSidebar(state: FinderAppState): NodeDescriptor {
  const items: NodeDescriptor[] = [];

  for (const section of state.sidebar) {
    if (section.header) {
      items.push(n("SectionHeader", { label: section.header }));
    }
    for (const item of section.items) {
      const attrs: Record<string, unknown> = { label: item.label };
      if (item.icon) attrs.icon = item.icon;
      if (item.selected) attrs.selected = true;
      if (item.hasEject) attrs.eject = true;
      items.push(n("ListItem", attrs));
    }
  }

  return n("Scroll", { axis: "v" }, items);
}

function buildFileList(state: FinderAppState): NodeDescriptor {
  const items: NodeDescriptor[] = [];

  for (const file of state.files) {
    const attrs: Record<string, unknown> = { label: file.name };
    if (file.size) attrs.size = file.size;
    if (file.kind) attrs.detail = file.kind;
    if (file.date) attrs.date = file.date;
    items.push(n("ListItem", attrs));
  }

  return n("Scroll", { axis: "v" }, items);
}

function buildPreviewPanel(state: FinderAppState): NodeDescriptor | null {
  const p = state.preview;
  if (!p) return null;

  const children: NodeDescriptor[] = [];
  children.push(n("Heading", { value: p.name }));
  if (p.sizeAndKind) children.push(n("Text", { value: p.sizeAndKind, identifier: "sizeAndKind" }));
  if (p.created) children.push(n("Text", { value: p.created, label: "Created" }));
  if (p.modified) children.push(n("Text", { value: p.modified, label: "Modified" }));
  if (p.dimensions) children.push(n("Text", { value: p.dimensions, label: "Dimensions" }));
  if (p.hasTagEditor) children.push(n("TextField", { placeholder: "Add Tags...", label: "tag editor" }));

  return n("Scroll", { axis: "v", identifier: "previewPane" }, children);
}

function buildToolbar(state: FinderAppState): NodeDescriptor {
  const children: NodeDescriptor[] = [];

  for (const item of state.toolbar.items) {
    switch (item.type) {
      case "PopUpButton": {
        const attrs: Record<string, unknown> = { label: item.label };
        if (item.value) attrs.value = item.value;
        children.push(n("PopUpButton", attrs));
        break;
      }
      case "MenuButton": {
        const attrs: Record<string, unknown> = { label: item.label };
        if (item.value) attrs.value = item.value;
        children.push(n("MenuButton", attrs));
        break;
      }
      case "RadioGroup": {
        const radioChildren: NodeDescriptor[] = [];
        for (const rc of item.children || []) {
          const attrs: Record<string, unknown> = { label: rc.label };
          if (rc.value) attrs.value = rc.value;
          radioChildren.push(n("RadioButton", attrs));
        }
        const attrs: Record<string, unknown> = {};
        if (item.label) attrs.label = item.label;
        children.push(n("RadioGroup", attrs, radioChildren));
        break;
      }
      case "SearchField": {
        const attrs: Record<string, unknown> = {};
        if (item.value) attrs.value = item.value;
        if (item.label) attrs.placeholder = item.label;
        children.push(n("SearchField", attrs));
        break;
      }
      case "Button":
      default: {
        const attrs: Record<string, unknown> = { label: item.label };
        children.push(n("Button", attrs));
        break;
      }
    }
  }

  return n("Toolbar", {}, children);
}

export function finderTree(geo?: WindowGeometry, state?: FinderAppState): NodeDescriptor {
  resetIdCounter();
  const title = state?.title ?? "Finder";

  const windowAttrs: Record<string, unknown> = { title };
  if (geo) {
    windowAttrs.x = geo.x;
    windowAttrs.y = geo.y;
    windowAttrs.w = geo.w;
    windowAttrs.h = geo.h;
  }
  const screenW = geo?.screenW ?? 1440;
  const screenH = geo?.screenH ?? 900;

  const wx = geo?.x ?? 0;
  const wy = geo?.y ?? 0;
  const ww = geo?.w ?? 1440;
  const wh = geo?.h ?? 900;
  const f = fmtWinFrame;

  const windowChildren: NodeDescriptor[] = [
    n("Titlebar", { title, frame: f(wx, wy, ww, 28) }),
  ];

  if (state) {
    windowChildren.push(buildToolbar(state));
    const splitChildren: NodeDescriptor[] = [
      buildSidebar(state),
      buildFileList(state),
    ];
    const preview = buildPreviewPanel(state);
    if (preview) splitChildren.push(preview);
    windowChildren.push(
      n("Split", { direction: "h" }, splitChildren)
    );
  }

  const children = [
    n("Application", { bundleId: "com.apple.finder", title: "Finder", frame: f(wx, wy, ww, wh) }, [
      n("Window", windowAttrs, windowChildren),
    ]),
  ];

  return {
    type: "Display",
    id: "Display::0",
    attrs: { screenW: String(screenW), screenH: String(screenH) },
    children,
  };
}
