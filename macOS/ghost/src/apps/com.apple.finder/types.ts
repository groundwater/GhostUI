export interface FinderSidebarSection {
  header: string;
  items: FinderSidebarItem[];
}

export interface FinderSidebarItem {
  label: string;
  icon?: string;
  selected?: boolean;
  hasEject?: boolean;
}

export type FinderViewMode = "list" | "icon" | "column" | "gallery";

export interface FinderFileItem {
  name: string;
  size?: string;
  kind?: string;
  date?: string;
  icon?: string;
}

export interface FinderToolbarItem {
  type: "Button" | "PopUpButton" | "MenuButton" | "RadioGroup" | "SearchField";
  label: string;
  value?: string;
  children?: FinderToolbarItem[];   // RadioGroup contains RadioButton children
}

export interface FinderToolbar {
  viewMode?: string;
  groupBy?: string;
  searchVisible?: boolean;
  searchActive?: boolean;
  searchValue?: string;
  searchPlaceholder?: string;
  items: FinderToolbarItem[];
}

export interface FinderPreviewInfo {
  name: string;
  sizeAndKind?: string;
  created?: string;
  modified?: string;
  dimensions?: string;
  hasTagEditor?: boolean;
}

export interface FinderAppState {
  title: string;
  sidebar: FinderSidebarSection[];
  files: FinderFileItem[];
  toolbar: FinderToolbar;
  columns?: string[];
  viewMode: FinderViewMode;
  preview?: FinderPreviewInfo;
}
