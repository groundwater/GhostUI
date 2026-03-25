import type { AXNode, WindowFrame } from "../types.js";
import { findAXNode, findAllAXNodes, fmtFrame } from "../ax-utils.js";
import type { ExplorerItem, ExplorerState, VSCodeLayout, EditorState, EditorGroup, EditorTab, PanelState, PanelTab, TerminalGroup, TerminalInstance } from "./types.js";

function iconForFile(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: "ts", js: "js", json: "json", md: "md", html: "html",
    css: "css", swift: "swift", py: "py", rs: "rust", go: "go",
    toml: "toml", yaml: "yaml", yml: "yaml", icns: "image",
  };
  if (name === "Makefile") return "makefile";
  if (name === ".gitignore") return "git";
  return map[ext || ""] || "file";
}

/** Extract VS Code explorer state from the raw AX tree */
export function extractExplorerState(axRoot: AXNode): ExplorerState {
  const explorerBtn = findAXNode(axRoot, n =>
    n.role === "AXRadioButton" && ((n.title || "") + (n.label || "")).includes("Explorer")
  );

  if (explorerBtn && explorerBtn.value === "0") {
    return { visible: false, items: [] };
  }

  const outline = findAXNode(axRoot, n =>
    n.role === "AXOutline" && ((n.label || "") === "Files Explorer" || (n.title || "") === "Files Explorer")
  );

  if (!outline) {
    return { visible: explorerBtn?.value === "1", items: [] };
  }

  const rows = findAllAXNodes(outline, n => n.role === "AXRow" && !!(n.label || n.title));

  if (rows.length === 0) {
    return { visible: true, items: [] };
  }

  const firstPathGroup = findAXNode(rows[0], n =>
    n.role === "AXGroup" && (n.label || "").startsWith("~/")
  );
  const rootPath = firstPathGroup?.label?.replace(/ •.*$/, "")?.replace(/\/[^/]+$/, "") || "";

  const items: ExplorerItem[] = [];

  for (const row of rows) {
    const label = row.label || row.title || "";
    if (!label) continue;

    const innerGroup = row.children?.[0];
    const innerChildCount = innerGroup?.children?.length ?? 0;
    const isFolder = innerChildCount >= 3;

    const expanded = isFolder ? (row.capabilities?.expanded ?? false) : undefined;
    const selected = row.capabilities?.selected ?? false;

    const pathGroup = findAXNode(row, n =>
      n.role === "AXGroup" && (n.label || "").startsWith("~/")
    );
    const fullPath = pathGroup?.label?.replace(/ •.*$/, "") || "";
    let depth = 0;
    if (rootPath && fullPath.startsWith(rootPath + "/")) {
      const relative = fullPath.slice(rootPath.length + 1);
      depth = relative.split("/").length - 1;
    }

    const icon = isFolder ? "folder" : iconForFile(label);

    items.push({
      label,
      isFolder,
      ...(expanded !== undefined ? { expanded } : {}),
      ...(selected ? { selected } : {}),
      depth,
      icon,
      frame: fmtFrame(row.frame),
    });
  }

  return { visible: true, items };
}

/** Extract VS Code pane layout by finding splitter elements in the AX tree. */
export function extractVSCodeLayout(axRoot: AXNode, windowFrame: WindowFrame): VSCodeLayout {
  const TITLE_BAR = 35;
  const STATUS_BAR = 22;
  const ACTIVITY_BAR = 48;

  const contentTop = windowFrame.y + TITLE_BAR;
  const contentBottom = windowFrame.y + windowFrame.height - STATUS_BAR;
  const contentHeight = contentBottom - contentTop;
  const contentWidth = windowFrame.width - ACTIVITY_BAR;

  if (contentHeight <= 0 || contentWidth <= 0) {
    return { sidebarWidth: 0, panelHeight: 0 };
  }

  const vSplitters: AXNode[] = [];
  const hSplitters: AXNode[] = [];

  const collectSplitters = (node: AXNode) => {
    if (node.role === "AXGroup" && node.frame) {
      const f = node.frame;
      if (f.width <= 8 && f.height > contentHeight * 0.8) {
        vSplitters.push(node);
      }
      if (f.height <= 8 && f.width > contentWidth * 0.3) {
        hSplitters.push(node);
      }
    }
    for (const child of node.children || []) {
      collectSplitters(child);
    }
  };
  collectSplitters(axRoot);

  const activityBarRight = windowFrame.x + ACTIVITY_BAR;
  const windowCenter = windowFrame.x + windowFrame.width / 2;

  const sidebarSplitters = vSplitters.filter(n => {
    const x = n.frame!.x;
    return x > activityBarRight && x < windowCenter;
  });

  let sidebarWidth = 0;
  if (sidebarSplitters.length > 0) {
    const splitter = sidebarSplitters.reduce((a, b) => a.frame!.x > b.frame!.x ? a : b);
    sidebarWidth = Math.round(splitter.frame!.x - activityBarRight);
    if (sidebarWidth < 0) sidebarWidth = 0;
  }

  const editorLeft = activityBarRight + sidebarWidth;
  const editorWidth = windowFrame.x + windowFrame.width - editorLeft;
  const panelSplitters = hSplitters.filter(n => {
    const f = n.frame!;
    return Math.abs(f.x - editorLeft) < 20
      && f.width > editorWidth * 0.7
      && f.y > contentTop + 50
      && f.y < contentBottom;
  });

  let panelHeight = 0;
  if (panelSplitters.length > 0) {
    const splitter = panelSplitters.reduce((a, b) => a.frame!.y < b.frame!.y ? a : b);
    panelHeight = Math.round(contentBottom - splitter.frame!.y);
    if (panelHeight < 0) panelHeight = 0;
  }

  return { sidebarWidth, panelHeight };
}

/** Extract editor tab groups and their split layout from the AX tree. */
export function extractEditorState(
  axRoot: AXNode,
  windowFrame: WindowFrame,
  layout: VSCodeLayout
): EditorState {
  const TITLE_BAR = 35;
  const ACTIVITY_BAR = 48;

  const activityBarRight = windowFrame.x + ACTIVITY_BAR;
  const editorLeft = activityBarRight + layout.sidebarWidth;
  const editorRight = windowFrame.x + windowFrame.width;
  const tabBarTop = windowFrame.y + TITLE_BAR;

  const editorTabGroups: AXNode[] = [];
  findAllAXNodes(axRoot, node => {
    if (node.role !== "AXTabGroup" || !node.frame) return false;
    const f = node.frame;
    if ((node.title || "") !== "") return false;
    if (f.x < editorLeft - 10) return false;
    if (f.x > editorRight) return false;
    if (Math.abs(f.y - tabBarTop) > 20) return false;
    return true;
  }, editorTabGroups);

  if (editorTabGroups.length === 0) {
    return { groups: [], splitSizes: [null], direction: "h" };
  }

  editorTabGroups.sort((a, b) => a.frame!.x - b.frame!.x);

  const groups: EditorGroup[] = [];
  const groupXPositions: number[] = [];

  for (const tg of editorTabGroups) {
    const tabs: EditorTab[] = [];
    for (const child of tg.children || []) {
      if (child.role !== "AXRadioButton") continue;
      const rawTitle = child.title || child.label || "";
      if (!rawTitle) continue;

      const label = rawTitle.replace(/,\s*Editor Group \d+$/, "").trim();
      if (!label) continue;

      const active = child.capabilities?.selected === true;
      const icon = iconForFile(label);
      tabs.push({ label, icon, ...(active ? { active: true } : {}), frame: fmtFrame(child.frame) });
    }
    if (tabs.length > 0) {
      groups.push({ tabs, frame: fmtFrame(tg.frame) });
      groupXPositions.push(tg.frame!.x);
    }
  }

  // Extract content for each editor group from AXList nodes below the tab strip
  for (let gi = 0; gi < groups.length; gi++) {
    const tg = editorTabGroups[gi];
    const tgFrame = tg.frame!;
    const contentTop = tgFrame.y + tgFrame.height; // below the tab bar

    // Find AXList with AXGroup children within this editor group's horizontal bounds
    const contentList = findAXNode(axRoot, node => {
      if (node.role !== "AXList" || !node.frame) return false;
      const f = node.frame;
      // Must be below tab strip and within horizontal bounds
      if (f.y < contentTop - 5) return false;
      if (f.x < tgFrame.x - 10 || f.x > tgFrame.x + tgFrame.width) return false;
      // Must have AXGroup children (text lines)
      const hasGroupChildren = (node.children || []).some(c => c.role === "AXGroup");
      return hasGroupChildren;
    });

    if (contentList) {
      const lines: string[] = [];
      for (const child of contentList.children || []) {
        if (child.role !== "AXGroup") continue;
        const textNode = findAXNode(child, n => n.role === "AXStaticText");
        lines.push(textNode?.value ?? "");
      }
      // Trim trailing blank lines
      while (lines.length > 0 && /^[\xa0\s]*$/.test(lines[lines.length - 1])) {
        lines.pop();
      }
      if (lines.length > 0) {
        groups[gi].content = lines.join("\n");
      }
    }
  }

  if (groups.length <= 1) {
    return { groups, splitSizes: [null], direction: "h" };
  }

  const splitSizes: (number | null)[] = [];
  for (let i = 0; i < groups.length; i++) {
    const left = groupXPositions[i];
    const right = i + 1 < groups.length ? groupXPositions[i + 1] : editorRight;
    splitSizes.push(Math.round(right - left));
  }
  splitSizes[splitSizes.length - 1] = null;

  return { groups, splitSizes, direction: "h" };
}

/** Extract VS Code panel state (panel tabs + terminal tabs/splits) from AX tree */
export function extractPanelState(
  axRoot: AXNode,
  windowFrame: WindowFrame,
  layout: VSCodeLayout
): PanelState {
  const STATUS_BAR = 22;
  const contentBottom = windowFrame.y + windowFrame.height - STATUS_BAR;
  const panelTop = contentBottom - layout.panelHeight;

  // --- Panel tabs ---
  const allSwitchers = findAllAXNodes(axRoot, node => {
    if (node.role !== "AXTabGroup") return false;
    const label = node.label || node.title || "";
    return label.includes("Active View Switcher");
  });
  const panelTabGroup = allSwitchers.length > 0
    ? allSwitchers.reduce((best, n) => {
        const bw = best.frame?.width ?? 0;
        const nw = n.frame?.width ?? 0;
        return nw > bw ? n : best;
      })
    : undefined;

  const tabs: PanelTab[] = [];
  if (panelTabGroup) {
    for (const child of panelTabGroup.children || []) {
      if (child.role !== "AXRadioButton") continue;
      const rawLabel = child.title || child.label || "";
      if (!rawLabel) continue;
      const label = rawLabel.replace(/\s*\(.*\)$/, "").toUpperCase();
      const active = child.capabilities?.selected === true;
      tabs.push({ label, ...(active ? { active: true } : {}), frame: fmtFrame(child.frame) });
    }
  }

  // --- Terminal tabs ---
  const terminalList = findAXNode(axRoot, node =>
    node.role === "AXList" && (node.label || node.title || "") === "Terminal tabs"
  );

  const terminalGroups: TerminalGroup[] = [];
  let activeTerminalGroup: number | undefined;
  const terminalRegex = /^Terminal (\d+) (.+?)(?:, split (\d+) of (\d+))?$/;

  if (terminalList) {
    const entries: { id: number; label: string; splitIndex?: number; splitTotal?: number; selected: boolean; frame?: string }[] = [];

    const termItems = findAllAXNodes(terminalList, node =>
      node.role === "AXGroup" && terminalRegex.test(node.label || node.title || "")
    );

    for (const item of termItems) {
      const rawLabel = item.label || item.title || "";
      const match = terminalRegex.exec(rawLabel);
      if (!match) continue;

      const id = parseInt(match[1], 10);
      const shell = match[2];
      const splitIndex = match[3] ? parseInt(match[3], 10) : undefined;
      const splitTotal = match[4] ? parseInt(match[4], 10) : undefined;
      const selected = item.capabilities?.selected === true;

      entries.push({ id, label: shell, splitIndex, splitTotal, selected, frame: fmtFrame(item.frame) });
    }

    let i = 0;
    while (i < entries.length) {
      const entry = entries[i];
      if (entry.splitIndex != null && entry.splitTotal != null) {
        const group: TerminalInstance[] = [];
        let isActive = false;
        const total = entry.splitTotal;
        for (let j = 0; j < total && (i + j) < entries.length; j++) {
          const e = entries[i + j];
          if (e.splitIndex !== j + 1 || e.splitTotal !== total) break;
          group.push({ id: e.id, label: e.label, frame: e.frame });
          if (e.selected) isActive = true;
        }
        if (isActive) activeTerminalGroup = terminalGroups.length;
        terminalGroups.push({ terminals: group });
        i += group.length;
      } else {
        if (entry.selected) activeTerminalGroup = terminalGroups.length;
        terminalGroups.push({ terminals: [{ id: entry.id, label: entry.label, frame: entry.frame }] });
        i++;
      }
    }
  }

  // Fallback: single-terminal mode — no "Terminal tabs" list visible
  if (terminalGroups.length === 0) {
    const termFields = findAllAXNodes(axRoot, node =>
      node.role === "AXTextField"
      && /^Terminal \d+,/.test(node.label || "")
    );
    for (const field of termFields) {
      const match = /^Terminal (\d+), (.+?) /.exec(field.label || "");
      if (match) {
        const id = parseInt(match[1], 10);
        const label = match[2];
        terminalGroups.push({ terminals: [{ id, label, frame: fmtFrame(field.frame) }] });
        if (field.capabilities?.focused) {
          activeTerminalGroup = terminalGroups.length - 1;
        }
      }
    }
    if (terminalGroups.length > 0 && activeTerminalGroup === undefined) {
      activeTerminalGroup = 0;
    }
  }

  // Detect active terminal from focused AXTextField
  if (activeTerminalGroup === undefined && terminalGroups.length > 0) {
    const focusedField = findAXNode(axRoot, node =>
      node.role === "AXTextField"
      && (node.label || "").startsWith("Terminal ")
      && node.capabilities?.focused === true
    );
    if (focusedField) {
      const focusMatch = /^Terminal (\d+),/.exec(focusedField.label || "");
      if (focusMatch) {
        const focusedId = parseInt(focusMatch[1], 10);
        for (let gi = 0; gi < terminalGroups.length; gi++) {
          if (terminalGroups[gi].terminals.some(t => t.id === focusedId)) {
            activeTerminalGroup = gi;
            break;
          }
        }
      }
    }
  }

  // --- Terminal content extraction ---
  {
    const contentLists = findAllAXNodes(axRoot, node => {
      if (node.role !== "AXList") return false;
      const label = node.label || node.title || "";
      if (label === "Terminal tabs") return false;
      if (!node.frame || node.frame.y < panelTop) return false;
      const hasGroupChildren = (node.children || []).some(c => c.role === "AXGroup");
      return hasGroupChildren;
    });

    if (contentLists.length > 0) {
      contentLists.sort((a, b) => (a.frame?.x ?? 0) - (b.frame?.x ?? 0));

      let targetGroup = activeTerminalGroup !== undefined
        ? terminalGroups[activeTerminalGroup]
        : undefined;
      if (!targetGroup) {
        targetGroup = terminalGroups.find(g => g.terminals.length === contentLists.length);
      }

      if (targetGroup) {
        for (let i = 0; i < Math.min(contentLists.length, targetGroup.terminals.length); i++) {
          const contentList = contentLists[i];
          const lines: string[] = [];
          for (const child of contentList.children || []) {
            if (child.role !== "AXGroup") continue;
            const textNode = findAXNode(child, n => n.role === "AXStaticText");
            lines.push(textNode?.value ?? "");
          }

          while (lines.length > 0 && /^[\xa0\s]*$/.test(lines[lines.length - 1])) {
            lines.pop();
          }

          if (lines.length > 0) {
            targetGroup.terminals[i].content = lines.join("\n");
          }
        }
      }
    }
  }

  return { tabs, terminalGroups, activeTerminalGroup };
}
