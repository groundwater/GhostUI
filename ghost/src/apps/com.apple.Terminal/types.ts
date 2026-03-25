export interface TerminalTab {
  label: string;
  active: boolean;
  frame?: string;
}

export interface TerminalPane {
  label: string;
  content: string;
  focused?: boolean;
  frame?: string;
}

export interface TerminalSplit {
  direction: "h" | "v";
  /** Splitter position in pixels (from AXSplitter value) */
  position?: number;
}

export interface TerminalAppState {
  title: string;
  tabs: TerminalTab[];
  panes: TerminalPane[];
  split?: TerminalSplit;
}
