import type { AppBundle } from "../types.js";
import type { VSCodeState } from "./types.js";
import { vscodeTree } from "./tree.js";
import { extractExplorerState, extractVSCodeLayout, extractEditorState, extractPanelState } from "./extract.js";

export const vscodeBundle: AppBundle<VSCodeState> = {
  bundleId: "com.microsoft.VSCode",

  extract(axTree, windowFrame) {
    const explorer = extractExplorerState(axTree);
    const layout = extractVSCodeLayout(axTree, windowFrame);
    const editor = extractEditorState(axTree, windowFrame, layout);
    const panel = extractPanelState(axTree, windowFrame, layout);

    return { explorer, layout, editor, panel };
  },

  buildTree(geo, state) {
    return vscodeTree(geo, state ?? undefined);
  },
};
