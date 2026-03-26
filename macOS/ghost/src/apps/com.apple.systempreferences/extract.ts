/**
 * Extract System Settings state from the macOS accessibility tree.
 *
 * AX structure (observed on macOS Sequoia):
 *   AXWindow
 *     AXGroup/AXHostingView          ← main content host
 *       AXSplitGroup
 *         AXGroup                    ← sidebar pane
 *           AXTextField              ← search
 *           AXScrollArea
 *             AXOutline
 *               AXRow → AXCell → AXStaticText (label) or AXGroup (separator)
 *         AXSplitter
 *         AXGroup                    ← content pane
 *           AXGroup
 *             AXScrollArea           ← scrollable content
 *               AXGroup / AXHeading / AXStaticText / AXCheckBox / AXPopUpButton ...
 *     AXToolbar
 *       AXGroup → AXGroup → AXButton/AXSegment label="Back"
 *     AXStaticText val=<window title>
 */

import type { AXNode } from "../types.js";
import { findAXNode, findAllAXNodes, fmtFrame } from "../ax-utils.js";
import type {
  SystemSettingsState,
  SheetState,
  SidebarItem,
  ContentGroup,
  ContentControl,
} from "./types.js";

// ── Label derivation ──

/** Roles whose preceding AXStaticText sibling is consumed as their label */
const LABEL_CONSUMING_ROLES = new Set([
  "AXPopUpButton",
  "AXCheckBox",
  "AXRadioGroup",
  "AXSlider",
  "AXSwitch",
  "AXSegmentedControl",
  "AXComboBox",
  "AXIncrementor",
]);

/** Container roles that may wrap a label-consuming control */
const CONTAINER_ROLES = new Set(["AXGroup", "AXOpaqueProviderGroup"]);

/**
 * Check if a container node wraps a label-consuming interactive control
 * (directly or one level deep). Returns the first such control if found.
 */
function findWrappedInteractiveControl(node: AXNode): AXNode | null {
  for (const child of node.children || []) {
    if (LABEL_CONSUMING_ROLES.has(child.role)) return child;
    // One level deeper — a wrapper inside a wrapper
    if (CONTAINER_ROLES.has(child.role)) {
      for (const gc of child.children || []) {
        if (LABEL_CONSUMING_ROLES.has(gc.role)) return gc;
      }
    }
  }
  return null;
}

function deriveLabel(node: AXNode, siblings?: AXNode[], index?: number): string {
  // 1. title or label from node itself
  if (node.title) return node.title;
  if (node.label) return node.label;
  // 2. preceding AXStaticText sibling — walk backwards past non-text elements
  //    (e.g. AXStaticText "Alert volume" → AXButton "Decrease" → AXSlider)
  if (siblings && index != null && index > 0) {
    for (let i = index - 1; i >= 0; i--) {
      const prev = siblings[i];
      if (prev.role === "AXStaticText") {
        const txt = prev.value || prev.label || "";
        if (txt) return txt;
      }
      // Stop if we hit another label-consuming control — its label text
      // belongs to it, not to us.
      if (LABEL_CONSUMING_ROLES.has(prev.role)) break;
    }
  }
  // 3. short value
  if (node.value && node.value.length < 80) return node.value;
  return "";
}

// ── Sidebar extraction ──

function extractSidebar(splitGroup: AXNode): { items: SidebarItem[]; truncated: boolean; searchValue?: string } {
  const sidebarPane = splitGroup.children?.find((c) => c.role === "AXGroup");
  if (!sidebarPane) return { items: [], truncated: false };

  // Capture sidebar search field value (AXTextField or AXSearchField)
  const searchField = findAXNode(sidebarPane, (n) =>
    n.role === "AXTextField" || n.role === "AXSearchField"
  );
  const searchValue = searchField?.value || undefined;

  const scrollArea = findAXNode(sidebarPane, (n) => n.role === "AXScrollArea");
  const outline = scrollArea
    ? findAXNode(scrollArea, (n) => n.role === "AXOutline")
    : findAXNode(sidebarPane, (n) => n.role === "AXOutline");
  if (!outline) return { items: [], truncated: false, searchValue };

  const rows = (outline.children || []).filter((c) => c.role === "AXRow");
  const items: SidebarItem[] = [];

  for (const row of rows) {
    const cell = row.children?.find((c) => c.role === "AXCell");
    if (!cell) continue;

    const staticText = findAXNode(cell, (n) => n.role === "AXStaticText");
    if (!staticText?.value) continue;

    items.push({
      label: staticText.value,
      selected: row.capabilities?.selected === true || cell.capabilities?.selected === true,
      frame: fmtFrame(row.frame),
    });
  }

  const truncated = isScrollTruncated(scrollArea);
  return { items, truncated, searchValue };
}

/** Check if `node` is a descendant of `ancestor` */
function isDescendant(node: AXNode, ancestor: AXNode): boolean {
  for (const child of ancestor.children || []) {
    if (child === node) return true;
    if (isDescendant(node, child)) return true;
  }
  return false;
}

/** Check if a scroll area has more content that isn't materialized */
function isScrollTruncated(scrollArea: AXNode | null | undefined): boolean {
  if (!scrollArea?.capabilities) return false;
  const caps = scrollArea.capabilities;
  if (!caps.canScroll) return false;
  // If scroll value < 0.99, there's more content in that direction
  if (caps.scrollValueV != null && caps.scrollValueV < 0.99) return true;
  if (caps.scrollValueH != null && caps.scrollValueH < 0.99) return true;
  return false;
}

// ── Sub-page detection ──

function detectSubPage(
  axTree: AXNode,
  selectedSidebar: string | null,
): { isSubPage: boolean; breadcrumb: string[] } {
  const windowTitle = axTree.title || "";

  const toolbar = findAXNode(axTree, (n) => n.role === "AXToolbar");
  const backButton = toolbar
    ? findAXNode(toolbar, (n) => n.role === "AXButton" && n.label === "Back")
    : null;

  const isSubPage =
    backButton != null &&
    selectedSidebar != null &&
    windowTitle !== "" &&
    windowTitle !== selectedSidebar;

  const breadcrumb: string[] = [];
  if (isSubPage && selectedSidebar) {
    breadcrumb.push(selectedSidebar);
    if (windowTitle) breadcrumb.push(windowTitle);
  }

  return { isSubPage, breadcrumb };
}

// ── Content extraction ──

function extractListRows(listNode: AXNode): ContentControl[] {
  const rows = (listNode.children || []).filter((c) => c.role === "AXRow");
  const controls: ContentControl[] = [];
  for (const row of rows) {
    const cell = row.children?.find((c) => c.role === "AXCell");
    const searchRoot = cell || row;

    const textField = findAXNode(searchRoot, (n) => n.role === "AXTextField");
    if (textField) {
      const val = textField.value || "";
      if (val) controls.push({ type: "textField", label: val, value: val, frame: fmtFrame(row.frame) });
      continue;
    }

    const text = findAXNode(searchRoot, (n) => n.role === "AXStaticText");
    if (text) {
      const label = text.value || text.label || "";
      if (label) controls.push({ type: "text", label, frame: fmtFrame(row.frame) });
    }
  }
  return controls;
}

/** Extract controls from a single scroll area's children */
function extractScrollAreaChildren(scrollArea: AXNode, groups: ContentGroup[]): void {
  const topChildren = scrollArea.children || [];

  for (let i = 0; i < topChildren.length; i++) {
    const child = topChildren[i];
    if (child.role === "AXScrollBar") continue;

    if (child.role === "AXHeading") {
      const heading = child.label || child.value || undefined;
      groups.push({ id: heading, heading, controls: [] });
      continue;
    }

    if (child.role === "AXStaticText") {
      const heading = child.value || child.label || undefined;
      if (heading) {
        if (i + 1 < topChildren.length) {
          const next = topChildren[i + 1];
          if (LABEL_CONSUMING_ROLES.has(next.role)) {
            // Fall through to mapNodeToControl below
          } else if (CONTAINER_ROLES.has(next.role) && findWrappedInteractiveControl(next)) {
            // Next sibling is a container wrapping a label-consuming control —
            // skip the text; the container handler below will pair it.
            continue;
          } else {
            groups.push({ id: heading, heading, controls: [] });
            continue;
          }
        } else {
          groups.push({ id: heading, heading, controls: [] });
          continue;
        }
      }
    }

    if (child.role === "AXOpaqueProviderGroup" || child.role === "AXGroup") {
      // When a container wraps a label-consuming control and the preceding
      // sibling is AXStaticText, extract the wrapped control with the label.
      const wrappedControl = findWrappedInteractiveControl(child);
      if (wrappedControl && i > 0 && topChildren[i - 1].role === "AXStaticText") {
        const prevText = topChildren[i - 1];
        const label = prevText.value || prevText.label || "";
        const mapped = mapNodeToControl(wrappedControl);
        if (mapped) {
          if (label) mapped.label = label;
          if (child.frame) mapped.frame = fmtFrame(child.frame);
          if (groups.length === 0) groups.push({ controls: [] });
          groups[groups.length - 1].controls.push(mapped);
          continue;
        }
      }

      if (child.role === "AXOpaqueProviderGroup") {
        extractOpaqueProviderGroup(child, groups);
      } else {
        const controls = extractControlsFromGroup(child);
        if (controls.length > 0) {
          groups.push({ controls, frame: fmtFrame(child.frame) });
        }
      }
      continue;
    }

    if (child.role === "AXTable" || child.role === "AXList" || child.role === "AXOutline") {
      const controls = extractListRows(child);
      if (controls.length > 0) {
        groups.push({ controls });
      }
      continue;
    }

    const control = mapNodeToControl(child, topChildren, i);
    if (control) {
      if (groups.length === 0) groups.push({ controls: [] });
      groups[groups.length - 1].controls.push(control);
    }
  }
}

/** Recursively extract an AXOpaqueProviderGroup — may contain buttons, headings, or nested scroll areas with more groups */
function extractOpaqueProviderGroup(node: AXNode, groups: ContentGroup[]): void {
  const heading = node.label || undefined;

  for (const inner of node.children || []) {
    if (inner.role === "AXScrollArea") {
      extractScrollAreaChildren(inner, groups);
      continue;
    }
    if (inner.role === "AXOpaqueProviderGroup") {
      extractOpaqueProviderGroup(inner, groups);
      continue;
    }
    if (inner.role === "AXStaticText") {
      const text = inner.value || inner.label || undefined;
      if (text) {
        groups.push({ id: text, heading: text, controls: [] });
      }
      continue;
    }
    // Buttons (e.g. "Show All") and other controls — append to the last group
    const control = mapNodeToControl(inner);
    if (control) {
      const lastGroup = groups[groups.length - 1];
      if (lastGroup) {
        lastGroup.controls.push(control);
      } else {
        groups.push({ id: heading, heading, controls: [control] });
      }
    }
  }
}

function extractContentGroups(contentPane: AXNode): { groups: ContentGroup[]; truncated: boolean } {
  // Collect all scroll areas in the content pane (there may be multiple, e.g. controls + wallpaper grid)
  const scrollAreas = findAllAXNodes(contentPane, (n) => n.role === "AXScrollArea");
  // Filter to only "top-level" scroll areas — exclude those nested inside other scroll areas
  const topScrollAreas = scrollAreas.filter((sa) => {
    return !scrollAreas.some((other) => other !== sa && isDescendant(sa, other));
  });

  if (topScrollAreas.length === 0) return { groups: [], truncated: false };

  const groups: ContentGroup[] = [];

  for (const scrollArea of topScrollAreas) {
    extractScrollAreaChildren(scrollArea, groups);
  }

  // Capture controls that are siblings of the scroll areas in the content pane
  const paneChildren = contentPane.children || [];
  const extraControls: ContentControl[] = [];
  for (const child of paneChildren) {
    if (child.role === "AXScrollArea") continue;
    const control = mapNodeToControl(child);
    if (control) extraControls.push(control);
  }
  if (extraControls.length > 0) {
    groups.push({ controls: extraControls });
  }

  const truncated = topScrollAreas.some((sa) => isScrollTruncated(sa));
  return { groups, truncated };
}

function extractControlsFromGroup(group: AXNode): ContentControl[] {
  const children = group.children || [];
  const controls: ContentControl[] = [];

  for (let i = 0; i < children.length; i++) {
    const child = children[i];

    if (child.role === "AXGroup" || child.role === "AXOpaqueProviderGroup") {
      // When a container wraps a label-consuming control and the preceding
      // sibling is AXStaticText, extract the wrapped control directly with
      // the label from the text (which mapNodeToControl already skipped).
      const wrappedControl = findWrappedInteractiveControl(child);
      if (wrappedControl && i > 0 && children[i - 1].role === "AXStaticText") {
        const prevText = children[i - 1];
        const label = prevText.value || prevText.label || "";
        const mapped = mapNodeToControl(wrappedControl);
        if (mapped) {
          if (label) mapped.label = label;
          if (child.frame) mapped.frame = fmtFrame(child.frame);
          controls.push(mapped);
          continue;
        }
      }

      const nested = extractNestedGroupRow(child);
      if (nested) {
        controls.push(nested);
        continue;
      }
      const subControls = extractControlsFromGroup(child);
      controls.push(...subControls);
      continue;
    }

    if (child.role === "AXScrollArea") {
      const listNode = findAXNode(child, (n) =>
        n.role === "AXOutline" || n.role === "AXTable" || n.role === "AXList",
      );
      if (listNode) {
        controls.push(...extractListRows(listNode));
      }
      continue;
    }

    if (child.role === "AXRadioGroup") {
      const radioControl = extractRadioGroup(child);
      if (radioControl) controls.push(radioControl);
      continue;
    }

    if (child.role === "AXSegmentedControl") {
      const segControl = extractSegmentedControl(child);
      if (segControl) controls.push(segControl);
      continue;
    }

    if (child.role === "AXTabGroup") {
      // Extract tab buttons as a segmented control, then recurse for the selected tab's content
      const tabControl = extractTabGroup(child);
      if (tabControl) controls.push(tabControl);
      // Also recurse into children for content within the selected tab
      const subControls = extractControlsFromGroup(child);
      controls.push(...subControls);
      continue;
    }

    const control = mapNodeToControl(child, children, i);
    if (control) {
      controls.push(control);
    }
  }

  return controls;
}

/** Roles that are interactive controls — when present as children of a group,
 *  the group should NOT be collapsed into a simple nav/detail row. Instead we
 *  fall through to extractControlsFromGroup so each child is individually mapped. */
const INTERACTIVE_CHILD_ROLES = new Set([
  "AXPopUpButton",
  "AXCheckBox",
  "AXSwitch",
  "AXSlider",
  "AXRadioGroup",
  "AXSegmentedControl",
  "AXComboBox",
  "AXTextField",
  "AXTextArea",
  "AXIncrementor",
]);

function extractNestedGroupRow(group: AXNode): ContentControl | null {
  const children = group.children || [];
  const texts = children.filter((c) => c.role === "AXStaticText");
  const buttons = children.filter((c) => c.role === "AXButton");

  if (texts.length === 0) return null;

  // If this group contains interactive controls (popups, checkboxes, sliders, etc.)
  // do NOT collapse it into a single row — return null so the caller recurses
  // into the group and maps each child individually.
  const hasInteractiveChild = children.some((c) => INTERACTIVE_CHILD_ROLES.has(c.role));
  if (hasInteractiveChild) return null;

  const label = texts[0].value || texts[0].label || "";
  if (!label) return null;

  const value = texts.length > 1 ? texts[1].value || texts[1].label || undefined : undefined;
  const hasChevron = buttons.some(
    (b) => b.label === "Show Detail" || b.subrole === "AXDisclosureButton",
  );

  return {
    type: buttons.length > 0 ? "navItem" : "detail",
    label,
    value,
    chevron: hasChevron || undefined,
    frame: fmtFrame(group.frame),
  };
}

function extractRadioGroup(radioGroup: AXNode): ContentControl | null {
  const children = radioGroup.children || [];
  const labelNode = children.find((c) => c.role === "AXStaticText");
  const radioButtons = children.filter((c) => c.role === "AXRadioButton");

  if (!labelNode) return null;

  const options = radioButtons.map((rb) => ({
    label: rb.title || rb.label || rb.value || "?",
    selected: rb.capabilities?.selected === true || rb.capabilities?.checked === true,
  }));

  return {
    type: "radio",
    label: labelNode.value || labelNode.label || "",
    options,
    frame: fmtFrame(radioGroup.frame),
  };
}

function extractSegmentedControl(node: AXNode): ContentControl | null {
  const children = node.children || [];
  // Look for a label from a preceding sibling or the node itself
  const label = node.label || node.title || "";

  const segments = children.filter(
    (c) => c.role === "AXRadioButton" || c.role === "AXButton",
  );
  if (segments.length === 0) return null;

  const options = segments.map((seg) => ({
    label: seg.title || seg.label || seg.value || "?",
    selected: seg.capabilities?.selected === true || seg.capabilities?.checked === true,
  }));

  return {
    type: "segmentedControl",
    label,
    options,
    frame: fmtFrame(node.frame),
  };
}

function extractTabGroup(tabGroup: AXNode): ContentControl | null {
  const children = tabGroup.children || [];
  // AXTabGroup children include AXRadioButton (tab buttons) and AXGroup (tab content)
  const tabs = children.filter(
    (c) => c.role === "AXRadioButton" || c.role === "AXButton",
  );
  if (tabs.length === 0) return null;

  const label = tabGroup.label || tabGroup.title || "";

  const options = tabs.map((tab) => ({
    label: tab.title || tab.label || tab.value || "?",
    selected: tab.capabilities?.selected === true || tab.value === "1",
  }));

  return {
    type: "segmentedControl",
    label,
    options,
    frame: fmtFrame(tabGroup.frame),
  };
}

function mapNodeToControl(
  node: AXNode,
  siblings?: AXNode[],
  index?: number,
): ContentControl | null {
  switch (node.role) {
    case "AXCheckBox": {
      let checkLabel = deriveLabel(node, siblings, index);
      return {
        type: "toggle",
        label: checkLabel,
        checked: node.value === "1" || node.capabilities?.checked === true,
        frame: fmtFrame(node.frame),
      };
    }

    case "AXPopUpButton": {
      let popupLabel = deriveLabel(node, siblings, index);
      return {
        type: "detail",
        label: popupLabel,
        value: node.value || undefined,
        axRole: "AXPopUpButton",
        frame: fmtFrame(node.frame),
      };
    }

    case "AXTextField":
      return {
        type: "textField",
        label: node.label || node.title || node.value || "",
        value: node.value || undefined,
        frame: fmtFrame(node.frame),
      };

    case "AXTextArea":
      return {
        type: "textField",
        label: node.label || node.title || node.value || "",
        value: node.value || undefined,
        frame: fmtFrame(node.frame),
      };

    case "AXButton":
      return {
        type: "button",
        label: node.title || node.label || node.value || "",
        frame: fmtFrame(node.frame),
      };

    case "AXSlider": {
      const label = deriveLabel(node, siblings, index);
      return {
        type: "slider",
        label,
        value: node.value || undefined,
        frame: fmtFrame(node.frame),
      };
    }

    case "AXSwitch": {
      const label = deriveLabel(node, siblings, index);
      return {
        type: "switch",
        label,
        checked: node.value === "1" || node.capabilities?.checked === true,
        frame: fmtFrame(node.frame),
      };
    }

    case "AXLink": {
      const label = node.title || node.label || node.value || "";
      if (!label) return null;
      return { type: "link", label, frame: fmtFrame(node.frame) };
    }

    case "AXDisclosureTriangle": {
      const label = deriveLabel(node, siblings, index);
      if (!label) return null;
      return {
        type: "disclosure",
        label,
        expanded: node.capabilities?.expanded ?? false,
        frame: fmtFrame(node.frame),
      };
    }

    case "AXSearchField":
      return {
        type: "searchField",
        label: node.label || node.title || "Search",
        value: node.value || undefined,
        frame: fmtFrame(node.frame),
      };

    case "AXImage": {
      const label = node.label || node.title || "";
      if (!label) return null;
      return { type: "image", label, frame: fmtFrame(node.frame) };
    }

    case "AXComboBox": {
      const label = deriveLabel(node, siblings, index);
      return {
        type: "textField",
        label,
        value: node.value || undefined,
        frame: fmtFrame(node.frame),
      };
    }

    case "AXIncrementor": {
      const label = deriveLabel(node, siblings, index);
      return {
        type: "detail",
        label,
        value: node.value || undefined,
        frame: fmtFrame(node.frame),
      };
    }

    case "AXDateField":
      return {
        type: "textField",
        label: node.label || node.title || "Date",
        value: node.value || undefined,
        frame: fmtFrame(node.frame),
      };

    case "AXColorWell":
      return {
        type: "button",
        label: node.label || node.title || "Color",
        frame: fmtFrame(node.frame),
      };

    case "AXStaticText": {
      // Skip labels consumed by a following control that uses preceding text as its label
      if (siblings && index != null && index + 1 < siblings.length) {
        const next = siblings[index + 1];
        if (LABEL_CONSUMING_ROLES.has(next.role)) {
          return null;
        }
        // Also skip when the next sibling is a container wrapping a label-consuming control
        if (CONTAINER_ROLES.has(next.role) && findWrappedInteractiveControl(next)) {
          return null;
        }
      }
      const val = node.value || node.label || "";
      if (!val) return null;
      return { type: "text", label: val, frame: fmtFrame(node.frame) };
    }

    default: {
      // Generic fallback — extract any labeled AX element rather than dropping it
      const label = deriveLabel(node, siblings, index);
      if (!label) return null;
      return {
        type: "generic",
        label,
        value: node.value || undefined,
        axRole: node.role,
        frame: fmtFrame(node.frame),
      };
    }
  }
}

// ── Sheet extraction ──

function extractSheet(axTree: AXNode): SheetState | null {
  const sheet = findAXNode(axTree, (n) => n.role === "AXSheet" || n.role === "AXDialog");
  if (!sheet) return null;

  const groups: ContentGroup[] = [];
  const buttons: string[] = [];

  // Extract content from scroll areas within the sheet
  const scrollAreas = findAllAXNodes(sheet, (n) => n.role === "AXScrollArea");
  for (const scrollArea of scrollAreas) {
    extractScrollAreaChildren(scrollArea, groups);
  }

  // If no scroll areas, try extracting from the hosting view group
  if (groups.length === 0) {
    const hostingView = findAXNode(sheet, (n) =>
      n.role === "AXGroup" && (n.subrole === "AXHostingView" || !n.subrole),
    );
    if (hostingView) {
      const controls = extractControlsFromGroup(hostingView);
      if (controls.length > 0) {
        groups.push({ controls });
      }
    }
  }

  // Collect action buttons (Done, Cancel, OK, etc.) — these are AXButton nodes
  // that are siblings of scroll areas inside the sheet's hosting view,
  // not nested inside the scroll area content itself.
  function collectSheetButtons(node: AXNode) {
    for (const child of node.children || []) {
      if (child.role === "AXButton") {
        const btnLabel = child.title || child.label || "";
        if (btnLabel) {
          // Only include buttons that are NOT inside a scroll area
          const inScroll = scrollAreas.some(sa => isDescendant(child, sa));
          if (!inScroll) {
            buttons.push(btnLabel);
          }
        }
      } else if (child.role !== "AXScrollArea" && child.role !== "AXScrollBar") {
        // Recurse into any container (AXGroup, AXOpaqueProviderGroup, etc.)
        // but skip scroll areas (already processed) and scroll bars
        collectSheetButtons(child);
      }
    }
  }
  collectSheetButtons(sheet);

  if (groups.length === 0 && buttons.length === 0) return null;

  return { groups, buttons };
}

// ── Main extraction ──

export function extractSystemSettingsState(axTree: AXNode): SystemSettingsState | null {
  const splitGroup = findAXNode(axTree, (n) => n.role === "AXSplitGroup");

  // When a modal sheet is covering the window (e.g. Advanced... dialog),
  // the AX tree root is AXSheet with no AXSplitGroup. Extract sheet content.
  if (!splitGroup) {
    const sheet = extractSheet(axTree);
    if (!sheet) return null;

    const windowTitle = axTree.title || "";
    return {
      sidebarItems: [],
      selectedSidebar: null,
      isSubPage: false,
      breadcrumb: [],
      contentTitle: windowTitle || null,
      contentGroups: [],
      sheet,
    };
  }

  const { items: sidebarItems, truncated: sidebarTruncated, searchValue: sidebarSearchValue } = extractSidebar(splitGroup);
  const selectedSidebar =
    sidebarItems.find((item) => item.selected)?.label ?? null;

  const windowTitle = axTree.title || "";
  const contentTitle = windowTitle || selectedSidebar || null;

  const { isSubPage, breadcrumb } = detectSubPage(axTree, selectedSidebar);

  const splitChildren = splitGroup.children || [];
  const splitterIndex = splitChildren.findIndex((c) => c.role === "AXSplitter");
  const contentPane =
    splitterIndex >= 0
      ? splitChildren.slice(splitterIndex + 1).find((c) => c.role === "AXGroup")
      : null;

  const { groups: contentGroups, truncated: contentTruncated } = contentPane
    ? extractContentGroups(contentPane)
    : { groups: [], truncated: false };

  // Also check if a sheet is overlaying the split group (embedded sheet)
  const sheet = extractSheet(axTree);

  return {
    sidebarItems,
    sidebarTruncated: sidebarTruncated || undefined,
    sidebarSearchValue,
    selectedSidebar,
    isSubPage,
    breadcrumb,
    contentTitle,
    contentGroups,
    contentTruncated: contentTruncated || undefined,
    sheet: sheet || undefined,
  };
}
