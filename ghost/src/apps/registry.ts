import type { AppBundle } from "./types.js";
import { vscodeBundle } from "./com.microsoft.VSCode/index.js";
import { systemPreferencesBundle } from "./com.apple.systempreferences/index.js";
import { terminalBundle } from "./com.apple.Terminal/index.js";
import { safariBundle } from "./com.apple.Safari/index.js";
import { finderBundle } from "./com.apple.finder/index.js";

const bundles = new Map<string, AppBundle<unknown>>();

function register(bundle: AppBundle<unknown>) {
  bundles.set(bundle.bundleId, bundle);
}

register(vscodeBundle);
register(systemPreferencesBundle);
register(terminalBundle);
register(safariBundle);
register(finderBundle);

/** Get the app bundle for a given macOS bundle ID, or undefined if unsupported. */
export function getBundle(bundleId: string): AppBundle<unknown> | undefined {
  return bundles.get(bundleId);
}
