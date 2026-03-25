// VS Code app-specific types

export interface ExplorerItem {
  label: string;
  isFolder: boolean;
  expanded?: boolean;
  selected?: boolean;
  depth: number;
  icon: string;
  frame?: string;
}

export interface ExplorerState {
  visible: boolean;
  items: ExplorerItem[];
}

export interface VSCodeLayout {
  sidebarWidth: number;
  panelHeight: number;
}

export interface EditorTab {
  label: string;
  icon: string;
  active?: boolean;
  frame?: string;
}

export interface EditorGroup {
  tabs: EditorTab[];
  content?: string;
  frame?: string;
}

export interface EditorState {
  groups: EditorGroup[];
  splitSizes: (number | null)[];
  direction: "h" | "v";
}

export interface PanelTab {
  label: string;
  active?: boolean;
  frame?: string;
}

export interface TerminalInstance {
  id: number;
  label: string;
  content?: string;
  frame?: string;
}

export interface TerminalGroup {
  terminals: TerminalInstance[];
}

export interface PanelState {
  tabs: PanelTab[];
  terminalGroups: TerminalGroup[];
  activeTerminalGroup?: number;
}

export interface VSCodeState {
  explorer?: ExplorerState;
  layout?: VSCodeLayout;
  editor?: EditorState;
  panel?: PanelState;
}
