import { n, resetIdCounter, type NodeDescriptor } from "../../crdt/schema.js";
import type { WindowGeometry } from "../types.js";
import { fmtWinFrame } from "../ax-utils.js";
import type { VSCodeState, EditorGroup, EditorState, PanelState } from "./types.js";

/** Map file extension to language name for TextArea */
function languageForFile(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    json: "json", md: "markdown", html: "html", css: "css",
    swift: "swift", py: "python", rs: "rust", go: "go",
    toml: "toml", yaml: "yaml", yml: "yaml", sh: "shell", bash: "shell",
    c: "c", cpp: "cpp", h: "c", hpp: "cpp", java: "java",
    rb: "ruby", php: "php", sql: "sql", xml: "xml",
  };
  if (name === "Makefile") return "makefile";
  if (name === "Dockerfile") return "dockerfile";
  return map[ext || ""] || "text";
}

const f = fmtWinFrame;

/** Build a single TabView for an editor group */
function buildTabView(group: EditorGroup, gx: number, gy: number, gw: number, gh: number): NodeDescriptor {
  const TAB_H = 35;
  const activeTab = group.tabs.find(t => t.active);
  const activeId = activeTab ? `tab-${activeTab.label}` : undefined;
  const children: NodeDescriptor[] = group.tabs.map(t => n("Tab", {
    label: t.label,
    icon: t.icon,
    ...(t.active ? { active: true } : {}),
    closable: true,
    ...(t.frame ? { frame: t.frame } : { frame: f(gx, gy, gw, TAB_H) }),
  }));

  if (group.content) {
    const lang = activeTab ? languageForFile(activeTab.label) : "text";
    children.push(n("TextArea", { language: lang, value: group.content, frame: f(gx, gy + TAB_H, gw, gh - TAB_H) }));
  }

  return n("TabView", activeId ? { activeTab: activeId, frame: f(gx, gy, gw, gh) } : { frame: f(gx, gy, gw, gh) }, children);
}

/** Build the editor area from real editor state.
 *  Always wraps in a Split so the CRDT node type stays stable when
 *  transitioning between 1 and N editor groups (avoids layout flash).
 */
function buildEditorArea(editor: EditorState | undefined, ex: number, ey: number, ew: number, eh: number): NodeDescriptor[] {
  if (!editor || editor.groups.length === 0) {
    return [n("Split", { direction: "h", sizes: [null], frame: f(ex, ey, ew, eh) }, [n("TabView", { frame: f(ex, ey, ew, eh) })])];
  }

  // Compute per-group positions
  const groups: NodeDescriptor[] = [];
  let cx = ex;
  for (let i = 0; i < editor.groups.length; i++) {
    const gw = editor.splitSizes[i] ?? (ew - (cx - ex));
    groups.push(buildTabView(editor.groups[i], cx, ey, gw, eh));
    cx += gw;
  }

  return [n("Split", { direction: editor.direction, sizes: editor.splitSizes, frame: f(ex, ey, ew, eh) }, groups)];
}

/** Map shell name to a codicon icon */
function terminalIcon(shell: string): string {
  if (shell === "bash") return "terminal-bash";
  if (shell === "pwsh" || shell === "powershell") return "terminal-powershell";
  return "terminal";
}

/** Build the terminal list sidebar (vertical list with tree-drawing chars for splits) */
function buildTerminalList(panel: PanelState, lx: number, ly: number, lw: number, lh: number): NodeDescriptor {
  const items: NodeDescriptor[] = [];
  const activeGroupIdx = panel.activeTerminalGroup;
  const itemH = 22;
  let cy = ly;

  for (let gi = 0; gi < panel.terminalGroups.length; gi++) {
    const group = panel.terminalGroups[gi];
    const isActiveGroup = gi === activeGroupIdx;

    for (let ti = 0; ti < group.terminals.length; ti++) {
      const term = group.terminals[ti];
      let prefix = "";
      if (group.terminals.length > 1) {
        if (ti === 0) prefix = "┌ ";
        else if (ti === group.terminals.length - 1) prefix = "└ ";
        else prefix = "├ ";
      }
      items.push(n("ListItem", {
        label: `${prefix}${term.label}`,
        icon: terminalIcon(term.label),
        ...(isActiveGroup && ti === 0 ? { selected: true } : {}),
        frame: f(lx, cy, lw, itemH),
      }));
      cy += itemH;
    }
  }

  return n("VStack", { frame: f(lx, ly, lw, lh) }, items);
}

/** Build the panel area from real panel state or nothing */
function buildPanelArea(panel: PanelState | undefined, px: number, py: number, pw: number, ph: number): NodeDescriptor[] {
  if (!panel) return [];

  const TAB_H = 35;
  const activeTab = panel.tabs.find(t => t.active);
  const activeTabId = activeTab ? `tab-${activeTab.label.toLowerCase().replace(/ /g, "-")}` : undefined;

  const panelTabs: NodeDescriptor[] = panel.tabs.map((t, i) =>
    n("Tab", {
      label: t.label,
      ...(t.active ? { active: true } : {}),
      ...(t.frame ? { frame: t.frame } : { frame: f(px, py, pw, TAB_H) }),
    })
  );

  // Build terminal content + sidebar when terminal tab is active
  if (activeTab?.label === "TERMINAL" && panel.terminalGroups.length > 0) {
    const activeGroup = panel.terminalGroups[panel.activeTerminalGroup ?? 0];
    const contentTop = py + TAB_H;
    const contentH = ph - TAB_H;
    const listW = 120;
    const termW = pw - listW;

    // Terminal content area
    let terminalContent: NodeDescriptor;
    if (activeGroup && activeGroup.terminals.length > 1) {
      const paneW = Math.floor(termW / activeGroup.terminals.length);
      const sizes: (number | null)[] = activeGroup.terminals.map(() => null);
      terminalContent = n("Split", { direction: "h", sizes, frame: f(px, contentTop, termW, contentH) }, activeGroup.terminals.map((t, i) =>
        n("VStack", { frame: f(px + i * paneW, contentTop, paneW, contentH) }, [
          n("TextArea", { language: "shell", ...(t.content !== undefined ? { value: t.content } : {}), frame: f(px + i * paneW, contentTop, paneW, contentH) }),
        ])
      ));
    } else {
      const term = activeGroup?.terminals[0];
      terminalContent = n("VStack", { frame: f(px, contentTop, termW, contentH) }, [
        n("TextArea", { language: "shell", ...(term?.content !== undefined ? { value: term.content } : {}), frame: f(px, contentTop, termW, contentH) }),
      ]);
    }

    const termList = buildTerminalList(panel, px + termW, contentTop, listW, contentH);

    return [n("TabView", { ...(activeTabId ? { activeTab: activeTabId } : {}), frame: f(px, py, pw, ph) }, [
      ...panelTabs,
      n("Split", { direction: "h", sizes: [null, listW], frame: f(px, contentTop, pw, contentH) }, [
        terminalContent,
        termList,
      ]),
    ])];
  }

  return [n("TabView", { ...(activeTabId ? { activeTab: activeTabId } : {}), frame: f(px, py, pw, ph) }, panelTabs)];
}

export function vscodeTree(geo?: WindowGeometry, state?: VSCodeState): NodeDescriptor {
  resetIdCounter();
  const explorer = state?.explorer;
  const layout = state?.layout;
  const editor = state?.editor;
  const panel = state?.panel;

  const screenW = geo?.screenW ?? 1440;
  const screenH = geo?.screenH ?? 900;

  // Window geometry
  const wx = geo?.x ?? 0;
  const wy = geo?.y ?? 0;
  const ww = geo?.w ?? 1440;
  const wh = geo?.h ?? 900;

  const windowAttrs: Record<string, unknown> = { title: "index.ts — GhostUI", frame: f(wx, wy, ww, wh) };
  if (geo) { windowAttrs.x = geo.x; windowAttrs.y = geo.y; windowAttrs.w = geo.w; windowAttrs.h = geo.h; }

  // Layout constants
  const TITLE_BAR = 35;
  const STATUS_BAR_H = 22;
  const ACTIVITY_BAR_W = 48;
  const sidebarVisible = explorer ? explorer.visible : true;
  const sidebarWidth = layout ? layout.sidebarWidth : (sidebarVisible ? 260 : 0);
  const splitSizes = [ACTIVITY_BAR_W, sidebarWidth, null];
  const panelHeight = layout ? layout.panelHeight : 200;

  // Regions
  const contentTop = wy + TITLE_BAR;
  const contentH = wh - TITLE_BAR - STATUS_BAR_H;
  const abLeft = wx;
  const sbLeft = wx + ACTIVITY_BAR_W;
  const editorLeft = sbLeft + sidebarWidth;
  const editorW = ww - ACTIVITY_BAR_W - sidebarWidth;
  const editorH = contentH - panelHeight;
  const panelTop = contentTop + editorH;
  const statusTop = wy + wh - STATUS_BAR_H;

  // Activity bar buttons: evenly spaced, 5 top + spacer + 2 bottom
  const abBtnSize = 48;
  const abButtons = [
    n("Button", { icon: "files", frame: f(abLeft, contentTop, abBtnSize, abBtnSize) }),
    n("Button", { icon: "search", frame: f(abLeft, contentTop + abBtnSize, abBtnSize, abBtnSize) }),
    n("Button", { icon: "source-control", frame: f(abLeft, contentTop + abBtnSize * 2, abBtnSize, abBtnSize) }),
    n("Button", { icon: "debug", frame: f(abLeft, contentTop + abBtnSize * 3, abBtnSize, abBtnSize) }),
    n("Button", { icon: "extensions", frame: f(abLeft, contentTop + abBtnSize * 4, abBtnSize, abBtnSize) }),
    n("Spacer", { frame: f(abLeft, contentTop + abBtnSize * 5, abBtnSize, contentH - abBtnSize * 7) }),
    n("Button", { icon: "account", frame: f(abLeft, statusTop - abBtnSize * 2, abBtnSize, abBtnSize) }),
    n("Button", { icon: "gear", frame: f(abLeft, statusTop - abBtnSize, abBtnSize, abBtnSize) }),
  ];

  // Sidebar interior
  const sidebarToolbarH = 35;
  const sidebarContentTop = contentTop + sidebarToolbarH;
  const sidebarContentH = contentH - sidebarToolbarH;

  // Explorer items from real data
  const explorerItems: NodeDescriptor[] = (explorer?.items ?? []).map(item => n("TreeItem", {
    label: item.label,
    icon: item.icon,
    ...(item.isFolder && item.expanded !== undefined ? { expanded: item.expanded } : {}),
    ...(item.selected ? { selected: true } : {}),
    depth: item.depth,
    ...(item.frame ? { frame: item.frame } : {}),
  }));

  // Hardcoded sidebar items without AX frames — estimate from position
  const sectionH = 22;
  const sidebarItems: NodeDescriptor[] = [
    n("SectionHeader", { label: "GHOSTUI", frame: f(sbLeft, sidebarContentTop, sidebarWidth, sectionH) }, [
      n("Button", { icon: "new-file", frame: f(sbLeft + sidebarWidth - 90, sidebarContentTop, 18, sectionH) }),
      n("Button", { icon: "new-folder", frame: f(sbLeft + sidebarWidth - 72, sidebarContentTop, 18, sectionH) }),
      n("Button", { icon: "refresh", frame: f(sbLeft + sidebarWidth - 54, sidebarContentTop, 18, sectionH) }),
      n("Button", { icon: "collapse-all", frame: f(sbLeft + sidebarWidth - 36, sidebarContentTop, 18, sectionH) }),
      n("Button", { icon: "ellipsis", frame: f(sbLeft + sidebarWidth - 18, sidebarContentTop, 18, sectionH) }),
    ]),
    ...explorerItems,
    n("Separator", { frame: f(sbLeft, sidebarContentTop + sectionH + explorerItems.length * sectionH, sidebarWidth, 1) }),
    n("SectionHeader", { label: "OUTLINE", frame: f(sbLeft, sidebarContentTop + sectionH + explorerItems.length * sectionH + 1, sidebarWidth, sectionH) }),
    n("TreeItem", { label: "PORT", icon: "constant", depth: 0 }),
    n("TreeItem", { label: "GHOSTUI_API", icon: "constant", depth: 0 }),
    n("TreeItem", { label: "DEFAULT_DOC", icon: "constant", depth: 0 }),
    n("TreeItem", { label: "store", icon: "variable", depth: 0 }),
    n("TreeItem", { label: "server", icon: "variable", depth: 0 }),
    n("TreeItem", { label: "waitForGhostUI()", icon: "function", depth: 0 }),
    n("Separator"),
    n("SectionHeader", { label: "TIMELINE" }),
  ];

  // Status bar items — distribute across the bar
  const sbItemW = 80;
  const sbItems: NodeDescriptor[] = [
    n("Button", { icon: "remote", label: "Remote", frame: f(wx, statusTop, sbItemW, STATUS_BAR_H) }),
    n("Button", { icon: "git-branch", label: "main", frame: f(wx + sbItemW, statusTop, sbItemW, STATUS_BAR_H) }),
    n("Button", { icon: "sync", label: "Synchronize Changes", frame: f(wx + sbItemW * 2, statusTop, sbItemW * 2, STATUS_BAR_H) }),
    n("Button", { icon: "error", label: "0 Errors", frame: f(wx + sbItemW * 4, statusTop, sbItemW, STATUS_BAR_H) }),
    n("Button", { icon: "warning", label: "0 Warnings", frame: f(wx + sbItemW * 5, statusTop, sbItemW, STATUS_BAR_H) }),
    n("Spacer", { frame: f(wx + sbItemW * 6, statusTop, ww - sbItemW * 12, STATUS_BAR_H) }),
    n("Text", { value: "Ln 42, Col 15", frame: f(wx + ww - sbItemW * 6, statusTop, sbItemW, STATUS_BAR_H) }),
    n("Text", { value: "Spaces: 2", frame: f(wx + ww - sbItemW * 5, statusTop, sbItemW, STATUS_BAR_H) }),
    n("Text", { value: "UTF-8", frame: f(wx + ww - sbItemW * 4, statusTop, 50, STATUS_BAR_H) }),
    n("Text", { value: "LF", frame: f(wx + ww - sbItemW * 3, statusTop, 30, STATUS_BAR_H) }),
    n("Text", { value: "TypeScript", frame: f(wx + ww - sbItemW * 2, statusTop, sbItemW, STATUS_BAR_H) }),
    n("Button", { icon: "feedback", label: "Feedback", frame: f(wx + ww - sbItemW, statusTop, sbItemW / 2, STATUS_BAR_H) }),
    n("Button", { icon: "bell", label: "Notifications", frame: f(wx + ww - sbItemW / 2, statusTop, sbItemW / 2, STATUS_BAR_H) }),
  ];

  const children = [
    n("Application", { bundleId: "com.microsoft.VSCode", title: "Visual Studio Code", frame: f(wx, wy, ww, wh) }, [
      n("Window", windowAttrs, [
        n("Titlebar", { title: "index.ts — GhostUI", frame: f(wx, wy, ww, TITLE_BAR) }),
        n("Split", { direction: "h", sizes: splitSizes, frame: f(wx, contentTop, ww, contentH) }, [
          n("VStack", { name: "ActivityBar", gap: 0, frame: f(abLeft, contentTop, ACTIVITY_BAR_W, contentH) }, abButtons),

          n("VStack", { name: "Sidebar", frame: f(sbLeft, contentTop, sidebarWidth, contentH) }, [
            n("Toolbar", { frame: f(sbLeft, contentTop, sidebarWidth, sidebarToolbarH) }, [
              n("Heading", { value: "EXPLORER", level: 3, frame: f(sbLeft, contentTop, sidebarWidth, sidebarToolbarH) }),
            ]),
            n("Scroll", { frame: f(sbLeft, sidebarContentTop, sidebarWidth, sidebarContentH) }, [
              n("VStack", { name: "FileTree", frame: f(sbLeft, sidebarContentTop, sidebarWidth, sidebarContentH) }, sidebarItems),
            ]),
          ]),

          n("Split", { name: "EditorPanel", direction: "v", sizes: panelHeight > 0 ? [null, panelHeight] : [null], frame: f(editorLeft, contentTop, editorW, contentH) }, [
            ...buildEditorArea(editor, editorLeft, contentTop, editorW, editorH),
            ...((panelHeight > 0) ? buildPanelArea(panel, editorLeft, panelTop, editorW, panelHeight) : []),
          ]),
        ]),

        n("StatusBar", { frame: f(wx, statusTop, ww, STATUS_BAR_H) }, sbItems),
      ]),
    ]),
  ];
  return { type: "Display", id: "Display::0", attrs: { screenW: String(screenW), screenH: String(screenH), frame: f(0, 0, screenW, screenH) }, children };
}
