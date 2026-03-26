import { n, resetIdCounter, type NodeDescriptor } from "../../crdt/schema.js";
import type { WindowGeometry } from "../types.js";
import { fmtWinFrame } from "../ax-utils.js";
import type { TerminalAppState, TerminalTab, TerminalPane, TerminalSplit } from "./types.js";

function buildPane(pane: TerminalPane): NodeDescriptor {
  const attrs: Record<string, unknown> = { language: "shell", value: pane.content };
  if (pane.focused) attrs.focused = true;
  if (pane.frame) attrs.frame = pane.frame;
  return n("TextArea", attrs);
}

function buildPaneContent(panes: TerminalPane[], split?: TerminalSplit): NodeDescriptor {
  if (panes.length <= 1) {
    return buildPane(panes[0] ?? { label: "shell", content: "" });
  }

  // Multiple panes = split view
  const direction = split?.direction ?? "h";
  const sizes: (number | null)[] = [];
  if (split?.position != null) {
    sizes.push(split.position);
    for (let i = 1; i < panes.length; i++) sizes.push(null);
  } else {
    for (let i = 0; i < panes.length; i++) sizes.push(null);
  }

  return n("Split", { direction, sizes }, panes.map(buildPane));
}

function buildTabView(tabs: TerminalTab[], paneContent: NodeDescriptor): NodeDescriptor {
  const activeTab = tabs.find(t => t.active);
  const activeId = activeTab ? `tab-${activeTab.label}` : undefined;

  const tabNodes: NodeDescriptor[] = tabs.map(t => n("Tab", {
    label: t.label,
    ...(t.active ? { active: true } : {}),
    ...(t.frame ? { frame: t.frame } : {}),
  }));

  return n("TabView", activeId ? { activeTab: activeId } : {}, [
    ...tabNodes,
    paneContent,
  ]);
}

export function terminalTree(geo?: WindowGeometry, state?: TerminalAppState): NodeDescriptor {
  resetIdCounter();
  const title = state?.title ?? "Terminal";
  const panes = state?.panes ?? [];
  const tabs = state?.tabs ?? [];

  const windowAttrs: Record<string, unknown> = { title };
  if (geo) { windowAttrs.x = geo.x; windowAttrs.y = geo.y; windowAttrs.w = geo.w; windowAttrs.h = geo.h; }
  const screenW = geo?.screenW ?? 1440;
  const screenH = geo?.screenH ?? 900;

  let content: NodeDescriptor = buildPaneContent(panes, state?.split);

  // Wrap in TabView when tabs exist (including synthesized single tab)
  if (tabs.length > 0) {
    content = buildTabView(tabs, content);
  }

  const wx = geo?.x ?? 0;
  const wy = geo?.y ?? 0;
  const ww = geo?.w ?? 1440;
  const wh = geo?.h ?? 900;
  const f = fmtWinFrame;

  const children = [
    n("Application", { bundleId: "com.apple.Terminal", title: "Terminal", frame: f(wx, wy, ww, wh) }, [
      n("Window", windowAttrs, [
        n("Titlebar", { title, frame: f(wx, wy, ww, 28) }),
        content,
      ]),
    ]),
  ];
  return { type: "Display", id: "Display::0", attrs: { screenW: String(screenW), screenH: String(screenH) }, children };
}
