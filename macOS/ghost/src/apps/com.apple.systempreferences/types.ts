/** State types for System Settings AX extraction */

export interface SidebarItem {
  label: string;
  selected: boolean;
  frame?: string;
}

export interface ContentControl {
  type:
    | "toggle" | "navItem" | "detail" | "text" | "textField" | "button" | "radio"
    | "slider" | "switch" | "link" | "disclosure" | "segmentedControl"
    | "searchField" | "image" | "generic";
  label: string;
  value?: string;
  checked?: boolean;
  chevron?: boolean;
  expanded?: boolean;
  axRole?: string;
  options?: { label: string; selected: boolean }[];
  frame?: string;
}

export interface ContentGroup {
  id?: string;
  heading?: string;
  controls: ContentControl[];
  frame?: string;
}

export interface SheetState {
  title?: string;
  groups: ContentGroup[];
  buttons: string[];  // e.g. ["Done", "Cancel"]
}

export interface SystemSettingsState {
  sidebarItems: SidebarItem[];
  sidebarTruncated?: boolean;
  sidebarSearchValue?: string;
  selectedSidebar: string | null;
  isSubPage: boolean;
  breadcrumb: string[];
  contentTitle: string | null;
  contentGroups: ContentGroup[];
  contentTruncated?: boolean;
  sheet?: SheetState;
}
