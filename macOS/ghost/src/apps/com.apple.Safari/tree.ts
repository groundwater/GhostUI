import { n, resetIdCounter, type NodeDescriptor } from "../../crdt/schema.js";
import type { WindowGeometry, AXNode } from "../types.js";
import { fmtWinFrame } from "../ax-utils.js";
import type { SafariAppState, SafariTab } from "./types.js";

/** AX roles that carry semantic meaning for web content */
const WEB_ROLE_MAP: Record<string, string> = {
  AXLink: "Link",
  AXHeading: "Heading",
  AXButton: "Button",
  AXTextField: "TextField",
  AXTextArea: "TextArea",
  AXImage: "Image",
  AXStaticText: "StaticText",
  AXList: "List",
  AXTable: "Table",
  AXRow: "Row",
  AXCell: "Cell",
  AXCheckBox: "CheckBox",
  AXRadioButton: "RadioButton",
  AXPopUpButton: "PopUpButton",
  AXComboBox: "ComboBox",
  AXGroup: "Group",
  AXScrollArea: "ScrollArea",
  AXWebArea: "WebArea",
};

const SEMANTIC_WEB_TAGS = new Set(Object.values(WEB_ROLE_MAP));

/** Convert an AX web content node to a CRDT NodeDescriptor */
function axWebNodeToDescriptor(ax: AXNode, siblingIndex = 0): NodeDescriptor | null {
  const tag = WEB_ROLE_MAP[ax.role] || ax.role?.replace(/^AX/, "");
  if (!tag) return null;

  const attrs: Record<string, unknown> = {};
  if (ax.title) attrs.label = ax.title;
  if (ax.label && ax.label !== ax.title) attrs.label = ax.label;
  if (ax.value) attrs.value = ax.value;
  if (ax.frame) {
    attrs.frame = `(${Math.round(ax.frame.x)},${Math.round(ax.frame.y)},${Math.round(ax.frame.width)},${Math.round(ax.frame.height)})`;
  }

  // Recursively convert children, collapsing non-semantic containers
  const children = collectWebChildren(ax.children || []);

  const label = (attrs.label as string) || (attrs.value as string) || "";
  const id = `${tag}:${label}:${siblingIndex}`;

  return {
    type: tag,
    id,
    attrs: Object.keys(attrs).length > 0 ? attrs : undefined,
    children: children.length > 0 ? children : undefined,
  };
}

/** Collect semantic children from AX web nodes, promoting children of non-semantic containers */
function collectWebChildren(axChildren: AXNode[]): NodeDescriptor[] {
  const result: NodeDescriptor[] = [];
  const tagCounts: Record<string, number> = {};

  for (const child of axChildren) {
    if (!child.role) continue;
    const tag = WEB_ROLE_MAP[child.role] || child.role.replace(/^AX/, "");

    if (SEMANTIC_WEB_TAGS.has(tag)) {
      const idx = tagCounts[tag] ?? 0;
      tagCounts[tag] = idx + 1;
      const desc = axWebNodeToDescriptor(child, idx);
      if (desc) result.push(desc);
    } else {
      // Non-semantic: promote children
      const promoted = collectWebChildren(child.children || []);
      for (const node of promoted) {
        const idx = tagCounts[node.type] ?? 0;
        tagCounts[node.type] = idx + 1;
        result.push({ ...node, id: `${node.type}:${(node.attrs?.label as string) || ""}:${idx}` });
      }
    }
  }

  return result;
}

function buildTabView(tabs: SafariTab[], content: NodeDescriptor): NodeDescriptor {
  const activeTab = tabs.find(t => t.active);
  const activeId = activeTab ? `tab-${activeTab.label}` : undefined;

  const tabNodes: NodeDescriptor[] = tabs.map(t => n("Tab", {
    label: t.label,
    ...(t.active ? { active: true } : {}),
    ...(t.frame ? { frame: t.frame } : {}),
  }));

  return n("TabView", activeId ? { activeTab: activeId } : {}, [
    ...tabNodes,
    content,
  ]);
}

/** Convert an AXWebArea subtree to CRDT NodeDescriptors */
function buildWebContent(webContent: unknown): NodeDescriptor[] {
  if (!webContent) return [];
  const axNode = webContent as AXNode;
  // Convert children of WebArea (skip the WebArea wrapper itself)
  return collectWebChildren(axNode.children || []);
}

/** Convert native Safari overlay AXNodes (permission dialogs, find bars) to CRDT NodeDescriptors */
function buildNativeOverlays(overlays: unknown[] | undefined): NodeDescriptor[] {
  if (!overlays || overlays.length === 0) return [];
  const result: NodeDescriptor[] = [];

  for (const overlay of overlays) {
    const ax = overlay as AXNode;
    const overlayChildren: NodeDescriptor[] = [];

    // Render the overlay title as a Text node
    if (ax.title) {
      overlayChildren.push(n("Text", { label: ax.title }));
    }

    // Render interactive children (buttons, etc.) as native nodes
    for (const child of ax.children || []) {
      if (child.role === "AXButton") {
        const label = child.title ?? child.label ?? "";
        overlayChildren.push(n("Button", {
          label,
          ...(child.frame ? { frame: `(${Math.round(child.frame.x)},${Math.round(child.frame.y)},${Math.round(child.frame.width)},${Math.round(child.frame.height)})` } : {}),
        }));
      } else if (child.role === "AXStaticText") {
        overlayChildren.push(n("Text", { label: child.value ?? child.title ?? "" }));
      }
    }

    const attrs: Record<string, unknown> = {};
    if (ax.title) attrs.label = ax.title;
    if (ax.frame) {
      attrs.frame = `(${Math.round(ax.frame.x)},${Math.round(ax.frame.y)},${Math.round(ax.frame.width)},${Math.round(ax.frame.height)})`;
    }

    result.push(n("NativeOverlay", attrs, overlayChildren));
  }

  return result;
}

export function safariTree(geo?: WindowGeometry, state?: SafariAppState): NodeDescriptor {
  resetIdCounter();
  const title = state?.title ?? "Safari";
  const tabs = state?.tabs ?? [];
  const toolbar = state?.toolbar ?? { url: "", canGoBack: false, canGoForward: false };

  const windowAttrs: Record<string, unknown> = { title };
  if (geo) { windowAttrs.x = geo.x; windowAttrs.y = geo.y; windowAttrs.w = geo.w; windowAttrs.h = geo.h; }
  const screenW = geo?.screenW ?? 1440;
  const screenH = geo?.screenH ?? 900;

  const wx = geo?.x ?? 0;
  const wy = geo?.y ?? 0;
  const ww = geo?.w ?? 1440;
  const wh = geo?.h ?? 900;
  const f = fmtWinFrame;

  // Toolbar: URL bar + nav buttons
  const toolbarChildren: NodeDescriptor[] = [];
  if (toolbar.canGoBack) {
    toolbarChildren.push(n("Button", { label: "Back" }));
  }
  if (toolbar.canGoForward) {
    toolbarChildren.push(n("Button", { label: "Forward" }));
  }
  toolbarChildren.push(n("TextField", {
    label: "URL",
    value: toolbar.url,
    ...(toolbar.frame ? { frame: toolbar.frame } : {}),
  }));

  const toolbarNode = n("Toolbar", {
    ...(toolbar.frame ? { frame: toolbar.frame } : {}),
  }, toolbarChildren);

  // Content area: render web content from a11y tree, plus any native overlays
  const webNodes = buildWebContent(state?.webContent);
  const overlayNodes = buildNativeOverlays(state?.nativeOverlays);
  const contentArea = n("VStack", {}, [...overlayNodes, ...webNodes]);

  // Wrap in TabView
  const tabView = tabs.length > 0 ? buildTabView(tabs, contentArea) : contentArea;

  const children = [
    n("Application", { bundleId: "com.apple.Safari", title: "Safari", frame: f(wx, wy, ww, wh) }, [
      n("Window", windowAttrs, [
        n("Titlebar", { title, frame: f(wx, wy, ww, 28) }),
        toolbarNode,
        tabView,
      ]),
    ]),
  ];
  return { type: "Display", id: "Display::0", attrs: { screenW: String(screenW), screenH: String(screenH) }, children };
}
