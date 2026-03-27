export interface SafariTab {
  label: string;
  active: boolean;
  frame?: string;
}

export interface SafariToolbar {
  url: string;
  canGoBack: boolean;
  canGoForward: boolean;
  frame?: string;
}

export interface SafariAppState {
  title: string;
  tabs: SafariTab[];
  toolbar: SafariToolbar;
  /** Raw AX subtree for the web content area (AXWebArea and its children) */
  webContent?: unknown;
  /** Native Safari overlay nodes (permission dialogs, find bars, etc.) from AXTabGroup siblings of AXWebArea */
  nativeOverlays?: unknown[];
}
