import type { AXNode, WindowFrame } from "../types.js";
import { findAXNode, findAllAXNodes } from "../ax-utils.js";
import type { FinderAppState, FinderSidebarSection, FinderSidebarItem, FinderFileItem, FinderToolbar, FinderToolbarItem, FinderViewMode, FinderPreviewInfo } from "./types.js";

/** Extract Finder.app state from the raw AX tree */
export function extractFinderState(axRoot: AXNode, windowFrame: WindowFrame): FinderAppState | null {
  const title = axRoot.title ?? "Finder";

  // --- Sidebar ---
  const sidebarOutline = findAXNode(axRoot, n => n.role === "AXOutline" && n.label === "sidebar");
  const sidebar = extractSidebar(sidebarOutline);

  // --- Toolbar (extract first to detect view mode) ---
  const toolbar = extractToolbar(axRoot);

  // --- Detect view mode from AX tree structure ---
  const viewMode = detectViewMode(axRoot);

  // --- Content area (files) ---
  const { files, columns } = extractContent(axRoot, viewMode);

  // --- Preview/Info panel (Gallery view) ---
  const preview = extractPreviewPanel(axRoot);

  return { title, sidebar, files, toolbar, columns, viewMode, preview };
}

/** Detect Finder view mode from the AX tree content area */
function detectViewMode(axRoot: AXNode): FinderViewMode {
  // List view: AXOutline labeled "list view"
  const listOutline = findAXNode(axRoot, n =>
    n.role === "AXOutline" && n.label === "list view"
  );
  if (listOutline) return "list";

  // Icon view: AXList with subrole AXCollectionList labeled "icon view"
  const iconList = findAXNode(axRoot, n =>
    n.role === "AXList" && n.label === "icon view"
  );
  if (iconList) return "icon";

  // Column view: AXBrowser labeled "column view"
  const columnBrowser = findAXNode(axRoot, n =>
    n.role === "AXBrowser" && n.label === "column view"
  );
  if (columnBrowser) return "column";

  // Gallery view: AXList with subrole AXCollectionList labeled "gallery view"
  const galleryList = findAXNode(axRoot, n =>
    n.role === "AXList" && n.label === "gallery view"
  );
  if (galleryList) return "gallery";

  return "list"; // default fallback
}

/** Extract content items based on view mode */
function extractContent(axRoot: AXNode, viewMode: FinderViewMode): { files: FinderFileItem[]; columns: string[] } {
  switch (viewMode) {
    case "list":
      return extractListView(axRoot);
    case "icon":
      return extractIconView(axRoot);
    case "column":
      return extractColumnView(axRoot);
    case "gallery":
      return extractGalleryView(axRoot);
  }
}

function extractSidebar(outline: AXNode | undefined): FinderSidebarSection[] {
  if (!outline) return [];

  const sections: FinderSidebarSection[] = [];
  let currentSection: FinderSidebarSection | null = null;

  const rows = (outline.children || []).filter(c => c.role === "AXRow");
  for (const row of rows) {
    const cell = (row.children || []).find(c => c.role === "AXCell");
    if (!cell) continue;

    const textNodes = findAllAXNodes(cell, n => n.role === "AXStaticText");
    const label = textNodes[0]?.value ?? "";
    if (!label) continue;

    // Section headers have no image child and their text is a category name
    const hasImage = (cell.children || []).some(c => c.role === "AXImage");
    const hasButton = (cell.children || []).some(c => c.role === "AXButton");

    if (!hasImage && !hasButton) {
      // This is a section header
      currentSection = { header: label, items: [] };
      sections.push(currentSection);
    } else {
      // This is a sidebar item
      const imageNode = (cell.children || []).find(c => c.role === "AXImage");
      const ejectButton = (cell.children || []).find(c => c.role === "AXButton" && c.label === "eject");

      const item: FinderSidebarItem = {
        label,
        selected: row.capabilities?.selected ?? false,
      };
      if (imageNode?.label) item.icon = imageNode.label;
      if (ejectButton) item.hasEject = true;

      if (currentSection) {
        currentSection.items.push(item);
      } else {
        // Items before any header go into an unnamed section
        currentSection = { header: "", items: [item] };
        sections.push(currentSection);
      }
    }
  }

  return sections;
}

/** Detect whether a row is a column header row.
 *  Finder list-view headers can appear as:
 *  - One cell containing multiple AXStaticText children (column names) + an AXImage
 *  - Multiple cells each containing a single AXStaticText child */
function isHeaderRow(cells: AXNode[]): boolean {
  if (cells.length === 0) return false;

  // Multi-cell header: every cell has exactly 1 AXStaticText child
  if (cells.length > 1) {
    return cells.every(c => {
      const children = c.children || [];
      return children.length === 1 && children[0].role === "AXStaticText";
    });
  }

  // Single-cell header: one cell containing multiple AXStaticText children (column names)
  // and no AXTextField (data rows have AXTextField for the file name)
  const children = cells[0].children || [];
  const staticTexts = children.filter(c => c.role === "AXStaticText");
  const hasTextField = children.some(c => c.role === "AXTextField");
  return staticTexts.length >= 2 && !hasTextField;
}

/** Extract column names from a header row */
function extractColumns(cells: AXNode[]): string[] {
  const columns: string[] = [];
  if (cells.length > 1) {
    // Multi-cell header
    for (const c of cells) {
      const text = (c.children || [])[0]?.value ?? "";
      if (text) columns.push(text);
    }
  } else if (cells.length === 1) {
    // Single-cell header: multiple AXStaticText children are column names
    for (const child of cells[0].children || []) {
      if (child.role === "AXStaticText" && child.value) {
        columns.push(child.value);
      }
    }
  }
  return columns;
}

/** Known column name patterns and their corresponding FinderFileItem field.
 *  Matched case-insensitively. */
const COLUMN_FIELD_MAP: Record<string, keyof FinderFileItem> = {
  "name": "name",
  "size": "size",
  "kind": "kind",
  "type": "kind",
};

/** Determine the field name for a column based on its header text.
 *  Returns the FinderFileItem key, or undefined if not recognized. */
function columnToField(columnName: string): keyof FinderFileItem | undefined {
  const lower = columnName.toLowerCase();
  // Check exact matches first
  if (COLUMN_FIELD_MAP[lower]) return COLUMN_FIELD_MAP[lower];
  // Date-like columns (Date Modified, Date Created, Date Added, Date Last Opened, etc.)
  if (lower.startsWith("date") || lower.includes("modified") || lower.includes("created") || lower.includes("added") || lower.includes("opened")) return "date";
  return undefined;
}

/** Extract files from List view (AXOutline with AXRow/AXCell children) */
function extractListView(axRoot: AXNode): { files: FinderFileItem[]; columns: string[] } {
  const outline = findAXNode(axRoot, n =>
    n.role === "AXOutline" && n.label === "list view"
  );
  if (!outline) return { files: [], columns: [] };

  const rows = (outline.children || []).filter(c => c.role === "AXRow");
  let columns: string[] = [];
  const files: FinderFileItem[] = [];

  for (const row of rows) {
    const cells = (row.children || []).filter(c => c.role === "AXCell");
    if (cells.length === 0) continue;

    // Detect and extract column header row
    if (columns.length === 0 && isHeaderRow(cells)) {
      columns = extractColumns(cells);
      continue;
    }

    // Data row: extract file info using column headers for semantic assignment
    const item: FinderFileItem = { name: "" };

    // Collect AXStaticText values from cells (skipping the name cell)
    const staticValues: string[] = [];
    for (const c of cells) {
      const children = c.children || [];
      const hasTextField = children.some(ch => ch.role === "AXTextField");
      for (const child of children) {
        if (child.role === "AXTextField" && child.value) {
          item.name = child.value;
        } else if (child.role === "AXStaticText" && child.value && !hasTextField) {
          staticValues.push(child.value);
        }
      }
    }

    // Assign static values using column headers (skip "Name" column)
    const nonNameColumns = columns.filter(c => c.toLowerCase() !== "name");
    for (let i = 0; i < staticValues.length; i++) {
      const col = nonNameColumns[i];
      if (col) {
        const field = columnToField(col);
        if (field && field !== "name" && !item[field]) {
          (item as FinderFileItem & Record<string, string | undefined>)[field] = staticValues[i];
          continue;
        }
      }
      // Fallback: assign positionally (kind, then date)
      if (!item.kind) {
        item.kind = staticValues[i];
      } else if (!item.date) {
        item.date = staticValues[i];
      } else if (!item.size) {
        item.size = staticValues[i];
      }
    }

    if (item.name) files.push(item);
  }

  return { files, columns };
}

/** Extract files from Icon view (AXList/CollectionList -> AXList/SectionList -> AXGroup -> AXImage) */
function extractIconView(axRoot: AXNode): { files: FinderFileItem[]; columns: string[] } {
  const iconList = findAXNode(axRoot, n =>
    n.role === "AXList" && n.label === "icon view"
  );
  return { files: extractGroupItems(iconList), columns: [] };
}

/** Extract files from Column view (AXBrowser -> AXScrollArea -> AXList -> AXGroup) */
function extractColumnView(axRoot: AXNode): { files: FinderFileItem[]; columns: string[] } {
  const browser = findAXNode(axRoot, n =>
    n.role === "AXBrowser" && n.label === "column view"
  );
  if (!browser) return { files: [], columns: [] };

  // Column view can have multiple columns of AXList, each containing AXGroup items.
  // Find all AXList children (within nested scroll areas).
  const allLists = findAllAXNodes(browser, n => n.role === "AXList");
  const files: FinderFileItem[] = [];

  for (const list of allLists) {
    const groups = (list.children || []).filter(c => c.role === "AXGroup");
    for (const group of groups) {
      const item = extractGroupItem(group);
      if (item) files.push(item);
    }
  }

  return { files, columns: [] };
}

/** Extract files from Gallery view (same structure as Icon view: AXList/CollectionList) */
function extractGalleryView(axRoot: AXNode): { files: FinderFileItem[]; columns: string[] } {
  const galleryList = findAXNode(axRoot, n =>
    n.role === "AXList" && n.label === "gallery view"
  );
  return { files: extractGroupItems(galleryList), columns: [] };
}

/** Extract file items from an AXList containing AXGroup children (used by Icon and Gallery views).
 *  Walks into nested AXList (SectionList) containers. */
function extractGroupItems(listNode: AXNode | undefined): FinderFileItem[] {
  if (!listNode) return [];

  const files: FinderFileItem[] = [];
  collectGroupItems(listNode, files);
  return files;
}

/** Recursively collect file items from AXGroup nodes within AXList containers */
function collectGroupItems(node: AXNode, files: FinderFileItem[]): void {
  for (const child of node.children || []) {
    if (child.role === "AXGroup") {
      const item = extractGroupItem(child);
      if (item) files.push(item);
    } else if (child.role === "AXList") {
      // Nested list (e.g. SectionList inside CollectionList)
      collectGroupItems(child, files);
    }
  }
}

/** Extract a single file item from an AXGroup node.
 *  The group may contain AXImage (with title/label = filename) and/or AXTextField. */
function extractGroupItem(group: AXNode): FinderFileItem | null {
  const children = group.children || [];

  // Try AXTextField first (Column view uses this for the filename)
  const textField = children.find(c => c.role === "AXTextField");
  if (textField?.value) {
    const imageNode = children.find(c => c.role === "AXImage");
    return {
      name: textField.value,
      icon: imageNode?.label || undefined,
    };
  }

  // Try AXImage (Icon/Gallery view: image title or label is the filename)
  const imageNode = children.find(c => c.role === "AXImage");
  if (imageNode) {
    const name = imageNode.title || imageNode.label || "";
    if (name) {
      return { name, icon: imageNode.label || undefined };
    }
  }

  // Try the group's own identifier/label as a name
  const name = group.identifier || group.label || "";
  if (name) {
    return { name };
  }

  return null;
}

/** Extract the preview/info panel shown in Gallery view.
 *  Located at AXScrollArea[id=previewPaneScrollView] inside the content split. */
function extractPreviewPanel(axRoot: AXNode): FinderPreviewInfo | undefined {
  const pane = findAXNode(axRoot, n =>
    n.role === "AXScrollArea" && n.identifier === "previewPaneScrollView"
  );
  if (!pane) return undefined;

  const children = pane.children || [];

  // First AXStaticText after AXImage is the file name
  let name = "";
  let sizeAndKind: string | undefined;
  let created: string | undefined;
  let modified: string | undefined;
  let dimensions: string | undefined;
  let hasTagEditor = false;

  for (const child of children) {
    if (child.role === "AXStaticText") {
      const val = child.value ?? "";
      const id = child.identifier ?? "";

      if (!name && !id) {
        // First unlabeled static text = file name
        name = val;
      } else if (id === "sizeAndKind") {
        sizeAndKind = val;
      } else if (id === "metaCreatedValue") {
        created = val;
      } else if (id === "metaModifiedValue") {
        modified = val;
      } else if (!id && val && val !== "Information" && val !== "Created" && val !== "Modified" && val !== "Tags") {
        // Unlabeled text that isn't a known heading — likely dimensions
        if (!dimensions) dimensions = val;
      }
    } else if (child.role === "AXScrollArea") {
      // Tag editor is inside a nested scroll area
      const tf = findAXNode(child, n => n.role === "AXTextField" && n.label === "tag editor");
      if (tf) hasTagEditor = true;
    }
  }

  if (!name) return undefined;

  return { name, sizeAndKind, created, modified, dimensions, hasTagEditor };
}

function extractToolbar(axRoot: AXNode): FinderToolbar {
  const toolbar: FinderToolbar = { items: [] };

  const tbNode = findAXNode(axRoot, n => n.role === "AXToolbar");
  if (!tbNode) return toolbar;

  // View mode popup button
  const viewPopup = findAXNode(tbNode, n => n.role === "AXPopUpButton" && (n.label?.includes("view") ?? false));
  if (viewPopup?.value) {
    toolbar.viewMode = viewPopup.value.replace(/^as\s+/, "");
  }

  // Group menu button
  const groupBtn = findAXNode(tbNode, n => n.role === "AXMenuButton" && n.label === "Group");
  if (groupBtn) {
    toolbar.groupBy = groupBtn.value ?? undefined;
  }

  // Search field: when the user clicks the Search button, an AXTextField with
  // subrole AXSearchField appears in the toolbar. It replaces the Search button.
  // Note: the inactive Search button is AXButton with subrole AXSearchField,
  // so we must check role === AXTextField (or AXSearchField for other apps).
  const searchField = findAXNode(tbNode, n =>
    n.role === "AXTextField" && n.subrole === "AXSearchField"
  ) ?? findAXNode(tbNode, n =>
    n.role === "AXSearchField"
  ) ?? findAXNode(axRoot, n =>
    n.role === "AXTextField" && n.subrole === "AXSearchField"
  ) ?? findAXNode(axRoot, n =>
    n.role === "AXSearchField"
  );
  if (searchField) {
    toolbar.searchActive = true;
    toolbar.searchValue = searchField.value ?? undefined;
    toolbar.searchPlaceholder = searchField.placeholder ?? undefined;
  } else {
    // Search button (only show when search field is not active).
    // The Search button may have role AXButton with subrole AXSearchField,
    // or just label "Search".
    const searchBtn = findAXNode(tbNode, n =>
      n.role === "AXButton" && (n.label === "Search" || n.subrole === "AXSearchField")
    );
    if (searchBtn) {
      toolbar.searchVisible = true;
    }
  }

  // Collect all actionable toolbar items (walking into AXGroup wrappers)
  collectToolbarItems(tbNode.children || [], toolbar.items);

  return toolbar;
}

/** Recursively collect actionable items from toolbar children, flattening AXGroup wrappers. */
function collectToolbarItems(children: AXNode[], out: FinderToolbarItem[]): void {
  for (const child of children) {
    // AXTextField with subrole AXSearchField → SearchField item
    if (child.role === "AXTextField" && child.subrole === "AXSearchField") {
      out.push({ type: "SearchField", label: child.placeholder || "", value: child.value });
      continue;
    }
    // AXSearchField as a primary role (some apps use this directly)
    if (child.role === "AXSearchField") {
      out.push({ type: "SearchField", label: child.placeholder || child.label || "", value: child.value });
      continue;
    }
    switch (child.role) {
      case "AXButton":
        out.push({ type: "Button", label: child.label || child.title || "" });
        break;
      case "AXPopUpButton":
        out.push({ type: "PopUpButton", label: child.label || child.title || "", value: child.value });
        break;
      case "AXMenuButton":
        out.push({ type: "MenuButton", label: child.label || child.title || "", value: child.value });
        break;
      case "AXRadioGroup":
        out.push(extractRadioGroup(child));
        break;
      case "AXGroup":
        // Flatten: walk into AXGroup wrappers to find actionable items
        collectToolbarItems(child.children || [], out);
        break;
      // Skip non-actionable roles (AXStaticText, AXImage, etc.)
    }
  }
}

/** Extract a RadioGroup with its RadioButton children */
function extractRadioGroup(radioGroup: AXNode): FinderToolbarItem {
  const radioChildren: FinderToolbarItem[] = [];
  for (const child of radioGroup.children || []) {
    if (child.role === "AXRadioButton") {
      radioChildren.push({
        type: "Button",
        label: child.label || child.title || "",
        value: child.value,
      });
    }
  }
  return { type: "RadioGroup", label: radioGroup.label || radioGroup.title || "", children: radioChildren };
}
