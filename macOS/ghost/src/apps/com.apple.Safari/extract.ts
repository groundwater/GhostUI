import type { AXNode, WindowFrame } from "../types.js";
import { findAXNode, findAllAXNodes, fmtFrame } from "../ax-utils.js";
import type { SafariAppState, SafariTab, SafariToolbar } from "./types.js";

/** Extract Safari.app state from the raw AX tree */
export function extractSafariState(axRoot: AXNode, windowFrame: WindowFrame): SafariAppState | null {
  const title = axRoot.title ?? "";

  // Extract tabs: Safari exposes tab buttons as AXRadioButton (subrole AXTabButton)
  // inside an AXGroup titled "tab bar", NOT inside the AXTabGroup (which holds page content).
  const tabBar = findAXNode(axRoot, n => n.role === "AXGroup" && n.title === "tab bar");
  const tabs: SafariTab[] = [];
  if (tabBar) {
    const radioButtons = findAllAXNodes(tabBar, n => n.role === "AXRadioButton");
    for (const rb of radioButtons) {
      tabs.push({
        label: rb.title ?? "",
        active: rb.value === "1",
        frame: fmtFrame(rb.frame),
      });
    }
  }
  // Single tab: synthesize from window title
  if (tabs.length === 0) {
    tabs.push({ label: title, active: true });
  }

  // Extract toolbar: AXToolbar > AXTextField (URL bar) + nav AXButtons
  const toolbar = findAXNode(axRoot, n => n.role === "AXToolbar");
  let url = "";
  let canGoBack = false;
  let canGoForward = false;
  let toolbarFrame: string | undefined;

  if (toolbar) {
    toolbarFrame = fmtFrame(toolbar.frame);

    // URL bar is a text field inside the toolbar
    const urlField = findAXNode(toolbar, n => n.role === "AXTextField");
    if (urlField) {
      url = urlField.value ?? "";
    }

    // Navigation buttons
    const buttons = findAllAXNodes(toolbar, n => n.role === "AXButton");
    for (const btn of buttons) {
      const desc = (btn.label ?? btn.title ?? "").toLowerCase();
      if (desc.includes("back")) canGoBack = btn.capabilities?.enabled !== false;
      if (desc.includes("forward")) canGoForward = btn.capabilities?.enabled !== false;
    }
  }

  // Extract web content: find the AXWebArea subtree
  const webArea = findAXNode(axRoot, n => n.role === "AXWebArea");

  // Extract native overlays: non-web-content children of AXTabGroup
  // (e.g. permission dialogs, find bars) that appear as AXGroup siblings of AXWebArea
  const nativeOverlays: AXNode[] = [];
  const tabGroup = findAXNode(axRoot, n => n.role === "AXTabGroup");
  if (tabGroup) {
    for (const child of tabGroup.children || []) {
      if (child.role === "AXWebArea") continue;
      // AXGroup children with titles are native overlay dialogs/banners
      if (child.role === "AXGroup" && child.title) {
        nativeOverlays.push(child);
      }
    }
  }

  return {
    title,
    tabs,
    toolbar: { url, canGoBack, canGoForward, frame: toolbarFrame },
    webContent: webArea ?? undefined,
    nativeOverlays: nativeOverlays.length > 0 ? nativeOverlays : undefined,
  };
}
