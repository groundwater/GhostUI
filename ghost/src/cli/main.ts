#!/usr/bin/env bun
import { fetchTree, fetchCRDTTree, fetchLiveQuery, fetchElementScreenshot, fetchFrameScreenshot, postScanOverlay, postDrawOverlay, postKeyboardInput, switchApp, focusWindow, dragWindow, fetchFilteredCGWindows, findCGWindowAt, fetchRawWorkspaceApps, fetchRawWorkspaceFrontmost, fetchLogs, openLogStream, fetchScreen, fetchLeases, openEventStream, fetchPbRead, postPbWrite, fetchPbTypes, postPbClear, fetchDisplayList, fetchDisplayMain, fetchDisplayById, fetchDefaultsRead, postDefaultsWrite, fetchDefaultsDomains, killActor, listActors, postRecFilmstrip, postRecImage, runActor, spawnActor, postCgMove, postCgClick, postCgDoubleClick, postCgDrag, postCgScroll, postCgKeyDown, postCgKeyUp, postCgModDown, postCgModUp, fetchCgMousePos, fetchCgMouseState, fetchVatMounts, fetchVatQuery, fetchVatTree, openVatWatchStream, postVatMount, deleteVatMount, postVatPolicy, VatMountRequestError } from "./client.js";
import { parseQuery } from "./query.js";
import { filterTree, bfsFirst, collectObscuredApps, findMatchedNode, OBSCURED_THRESHOLD, matchTree } from "./filter.js";
import { parseSelector, matchChain } from "./print.js";
import { toGUIML } from "./guiml.js";
import { collectRects } from "./frames.js";
import { renderQueryResult } from "./introspection.js";
import {
  renderAXQueryGuiml as renderCanonicalAXQueryGuiml,
  serializeAXQueryMatches as serializeCanonicalAXQueryMatches,
} from "../a11y/ax-query.js";
import { fetchRawAXTree, fetchAXCursor, fetchAXQueryMatches, axClickTarget, axPressTarget, axSetTarget, axHoverTarget, axType, axTypeCursor, axTypeTarget, axFocusTarget, axFocusWindowTarget, axPerformTarget, fetchAXAt, fetchAXActionsTarget, fetchAXMenuAt, formatAXNode, extractAXQueryScope, resolveAXQueryScope, renderAXQueryGuimlForScope, parseAXScopePayload, parseAXTargetPayload, parseAXTargetStream, describeAXTarget, axEventMatchesFilter, axSelectCursor, resolveAXQueryApp } from "./ax.js";
import type { AXNode, AXCursor, AXEventFilter, AXTarget, AXQueryMatch, AXQueryScopeInput, AXScopePayload } from "./ax.js";
import { axNodeAccessor } from "./accessor.js";
import type { PlainNode } from "./types.js";
import { tailLogStream } from "./log-stream.js";
import { findHelpTopic, findNearestHelpTopic, renderHelpIndex, renderHelpTopic, renderRootHelp, renderUnknownHelpTopic, renderUsage } from "./help.js";
import { findSkillTarget, renderSkill, renderSkillList } from "./skills.js";
import {
  buildCLICompositionPayloadFromAXQueryMatch,
  buildCLICompositionPayloadFromVatQueryResult,
  normalizeCLICompositionPayload,
  parseCLICompositionPayloadStream,
  type CLICompositionRect,
  requireCLICompositionBounds,
  serializeCLICompositionPayload,
} from "./payload.js";
import type { CLICompositionPayload } from "./payload.js";
import { normalizeDrawScriptText } from "../overlay/draw.js";
import type { DrawScript } from "../overlay/draw.js";
import { waitForDrawOverlayAttachment } from "./draw-stream.js";
import { axTargetFromPoint, isAXTarget } from "../a11y/ax-target.js";
import {
  ACTOR_CLICK_PASSTHROUGH_DELAY_MS,
  ActorApiError,
  parseActorRunCLIArgs,
  parseActorSpawnCLIArgs,
  type PointerButton,
} from "../actors/protocol.js";
import { parseRecCLIArgs, RecProtocolError } from "../rec/protocol.js";
import type { AXObserverBenchmarkMode, AXObserverBenchmarkResult } from "../a11y/native-ax.js";
import {
  VAT_A11Y_STDIN_AX_QUERY_ARG,
  VAT_A11Y_STDIN_AX_QUERY_PLAN_ARG,
  type VatA11YQueryPlan,
  type VatA11YQueryScope,
  type VatMountPolicy,
  type VatMountSummary,
  type VatMountResponse,
  type VatPolicyResponse,
  type VatUnmountResponse,
} from "../vat/types.js";

interface VatQueryResult {
  tree: PlainNode;
  nodes: PlainNode[];
  matchCount: number;
}

function normalizeAppIdentity(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

type WorkspaceAppCandidate = {
  pid: number;
  bundleId?: string;
  name?: string;
  regular?: boolean;
};

function findGUIApplicationNodes(
  tree: PlainNode,
  target: { bundleId?: string; name?: string },
): PlainNode[] {
  const bundleId = normalizeAppIdentity(target.bundleId);
  const name = normalizeAppIdentity(target.name);
  const apps: PlainNode[] = [];
  (function walk(node: PlainNode) {
    if (node._tag === "Application") {
      const title = normalizeAppIdentity(typeof node.title === "string" ? node.title : undefined);
      const nodeBundleId = normalizeAppIdentity(typeof node.bundleId === "string" ? node.bundleId : undefined);
      const matchesBundle = Boolean(bundleId && (nodeBundleId === bundleId || title === bundleId));
      const matchesName = Boolean(name && (title === name || nodeBundleId === name));
      if (matchesBundle || matchesName) {
        apps.push(node);
      }
    }
    if (node._children) node._children.forEach(walk);
  })(tree);
  return apps;
}

/** Check if a target app has at least one visible window in the CRDT tree. */
function appWindowVisible(tree: PlainNode, target: { bundleId?: string; name?: string }): boolean {
  const apps = findGUIApplicationNodes(tree, target);
  if (apps.length === 0) return false;
  for (const app of apps) {
    for (const child of app._children || []) {
      if (child._tag === "Window") {
        const obscured = Number(child.obscured || 0);
        if (obscured < OBSCURED_THRESHOLD) {
          return true;
        }
      }
    }
  }
  return false;
}

export function collectVisibleWorkspaceAppPids(
  tree: PlainNode,
  apps: WorkspaceAppCandidate[],
): number[] {
  const seen = new Set<number>();
  const pids: number[] = [];
  for (const app of apps) {
    if (!Number.isInteger(app.pid) || app.pid <= 0 || seen.has(app.pid)) {
      continue;
    }
    if (app.regular === false) {
      continue;
    }
    if (!app.bundleId && !app.name) {
      continue;
    }
    if (!appWindowVisible(tree, { bundleId: app.bundleId, name: app.name })) {
      continue;
    }
    seen.add(app.pid);
    pids.push(app.pid);
  }
  return pids;
}

export function collectRegularWorkspaceAppPids(apps: WorkspaceAppCandidate[]): number[] {
  const seen = new Set<number>();
  const pids: number[] = [];
  for (const app of apps) {
    if (!Number.isInteger(app.pid) || app.pid <= 0 || seen.has(app.pid)) {
      continue;
    }
    if (app.regular === false) {
      continue;
    }
    seen.add(app.pid);
    pids.push(app.pid);
  }
  return pids;
}

type AXQueryRoot = { pid: number; tree: AXNode };

type AXQueryAppFilter = "none" | "regular" | "visible";

async function fetchFilteredAXQueryRoots(filter: Exclude<AXQueryAppFilter, "none">): Promise<AXQueryRoot[]> {
  const apps = await fetchRawWorkspaceApps() as WorkspaceAppCandidate[];
  const pids = filter === "visible"
    ? collectVisibleWorkspaceAppPids(await fetchTree(), apps)
    : collectRegularWorkspaceAppPids(apps);
  const roots = await Promise.all(pids.map(async (pid) => {
    try {
      return { pid, tree: (await fetchRawAXTree(pid)).tree };
    } catch {
      return null;
    }
  }));
  return roots.filter((root): root is AXQueryRoot => root !== null);
}

async function renderFilteredAXQueryGuiml(
  query: string,
  cardinality: AXQueryCardinality,
  filter: Exclude<AXQueryAppFilter, "none">,
): Promise<string> {
  return renderCanonicalAXQueryGuiml(await fetchFilteredAXQueryRoots(filter), query, cardinality);
}

async function fetchFilteredAXQueryMatches(
  query: string,
  cardinality: AXQueryCardinality,
  filter: Exclude<AXQueryAppFilter, "none">,
): Promise<AXQueryMatch[]> {
  return serializeCanonicalAXQueryMatches(await fetchFilteredAXQueryRoots(filter), query, cardinality);
}

const args = process.argv.slice(2);
const HELP_FLAGS = new Set(["--help", "-h"]);

export function resolveCommandAlias(command: string | undefined): string | undefined {
  return command === "q" ? "query" : command;
}

export function resolveCRDTSubcommandAlias(subcommand: string | undefined): string | undefined {
  return subcommand === "q" ? "query" : subcommand;
}

const command = resolveCommandAlias(args[0]);
const preservesLocalAppFlag = command === "ax" && (args[1] === "query" || args[1] === "bench-observers");

// Extract --app flag before determining command
let appTarget: string | undefined;
const appIdx = preservesLocalAppFlag ? -1 : args.indexOf("--app");
if (appIdx >= 0) {
  appTarget = args[appIdx + 1];
  if (!appTarget) { console.error("--app requires an app name or bundleId"); process.exit(1); }
  args.splice(appIdx, 2);
}

function resolveHelpRequest(tokens: string[]): { topic: string; explicit: boolean } | null {
  if (tokens.length === 0) {
    return { topic: "", explicit: false };
  }

  if (tokens[0] === "help") {
    const helpTokens = tokens.slice(1);
    return {
      topic: findNearestHelpTopic(helpTokens)?.id ?? helpTokens.join(" ").trim(),
      explicit: true,
    };
  }

  const helpIndex = tokens.findIndex((token) => HELP_FLAGS.has(token));
  if (helpIndex >= 0) {
    const topicTokens = tokens.filter((_, index) => index !== helpIndex);
    return {
      topic: findNearestHelpTopic(topicTokens)?.id ?? topicTokens.join(" ").trim(),
      explicit: true,
    };
  }

  return null;
}

function failUsage(topic: string, detail?: string): never {
  if (detail) {
    console.error(detail);
  }
  console.error(renderUsage(topic));
  process.exit(1);
}

export function renderActorRunUsage(nameHint?: string): string {
  const usage = renderUsage("actor run");
  if (!nameHint) return usage;
  return usage.replaceAll("<name>.", `${nameHint}.`);
}

function failActorRunUsage(nameHint?: string, detail?: string): never {
  if (detail) {
    console.error(detail);
  }
  console.error(renderActorRunUsage(nameHint));
  process.exit(1);
}

function formatAXObserverBenchmark(result: AXObserverBenchmarkResult): string {
  const lines = [
    `pid: ${result.pid}`,
    `mode: ${result.mode}`,
    `iterations: ${result.iterations}`,
    `targets: ${result.targetCount}`,
    `registrations: ${result.totalRegistrations}`,
    `create observer: ${result.createObserverMs.toFixed(2)}ms total`,
    `add notifications: ${result.addNotificationsMs.toFixed(2)}ms total`,
    `remove notifications: ${result.removeNotificationsMs.toFixed(2)}ms total`,
    `successes: ${result.successCount}`,
    `failures: ${result.failureCount}`,
  ];
  const failures = Object.entries(result.failuresByCode);
  if (failures.length > 0) {
    lines.push("failure codes:");
    for (const [code, count] of failures) {
      lines.push(`  ${code}: ${count}`);
    }
  }
  return lines.join("\n");
}

function extractStringFlag(arr: string[], flag: string): string | undefined {
  const i = arr.indexOf(flag);
  if (i < 0) return undefined;
  const value = arr[i + 1];
  if (!value) {
    console.error(`${flag} requires a value`);
    process.exit(1);
  }
  arr.splice(i, 2);
  return value;
}

function extractBooleanFlag(arr: string[], flag: string): boolean {
  const i = arr.indexOf(flag);
  if (i < 0) return false;
  arr.splice(i, 1);
  return true;
}

export type VatOutputMode = "json" | "text";

export function extractVatOutputMode(arr: string[]): VatOutputMode | undefined {
  let outputMode: VatOutputMode | undefined;
  let index = 0;
  while (index < arr.length) {
    const token = arr[index];
    if (token !== "--json" && token !== "--text") {
      break;
    }
    const nextMode: VatOutputMode = token === "--json" ? "json" : "text";
    if (outputMode && outputMode !== nextMode) {
      throw new Error("Choose at most one of --json or --text.");
    }
    outputMode = nextMode;
    index++;
  }
  if (index > 0) {
    arr.splice(0, index);
  }
  return outputMode;
}

export function resolveVatOutputTTY(outputMode: VatOutputMode | undefined, stdoutIsTTY: boolean): boolean {
  if (outputMode === "text") {
    return true;
  }
  if (outputMode === "json") {
    return false;
  }
  return stdoutIsTTY;
}

export interface VatMountCLIArgs {
  path: string;
  driver: string;
  args: string[];
}

export interface VatPolicyCLIArgs {
  path: string;
  mountPolicy: VatMountPolicy;
}

export type VatWatchChangeKind = "added" | "removed" | "updated";

export interface VatWatchCLIArgs {
  query: string;
  once: boolean;
  filter?: VatWatchChangeKind[];
}

export interface VatWatchChange {
  kind: VatWatchChangeKind;
  index: number;
  previous: PlainNode | null;
  current: PlainNode | null;
}

export interface VatWatchChangeSummary {
  added: number;
  removed: number;
  updated: number;
  total: number;
}

export interface VatWatchEvent {
  payload: CLICompositionPayload;
  changes: VatWatchChange[];
  summary: VatWatchChangeSummary;
}

export function parseVatMountArgs(argv: string[], usageLabel = "vat mount"): VatMountCLIArgs {
  if (argv.length < 2) {
    throw new Error(`gui ${usageLabel} requires a path and a driver`);
  }

  const [path, driver, ...args] = argv;
  if (!path.startsWith("/")) {
    throw new Error(`gui ${usageLabel} path must start with /`);
  }
  if (!driver) {
    throw new Error(`gui ${usageLabel} requires a driver`);
  }

  return { path, driver, args };
}

export function parseVatQueryArgs(argv: string[]): string {
  const query = argv.join(" ").trim();
  if (!query) {
    throw new Error("gui vat query requires a query");
  }
  return query;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPlainNodeLike(value: unknown): value is PlainNode {
  return isRecord(value) && typeof value._tag === "string";
}

function parseVatWatchFilterKinds(value: string): VatWatchChangeKind[] {
  const kinds = value
    .split(",")
    .map((kind) => kind.trim())
    .filter(Boolean);
  if (kinds.length === 0) {
    throw new Error("gui vat watch --filter requires one or more comma-separated kinds");
  }
  const normalized: VatWatchChangeKind[] = [];
  for (const kind of kinds) {
    if (kind !== "added" && kind !== "removed" && kind !== "updated") {
      throw new Error("gui vat watch --filter kinds must be added, removed, or updated");
    }
    if (!normalized.includes(kind)) {
      normalized.push(kind);
    }
  }
  return normalized;
}

export function parseVatWatchArgs(argv: string[]): VatWatchCLIArgs {
  const args = [...argv];
  let once = false;
  let filter: VatWatchChangeKind[] | undefined;

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--once") {
      once = true;
      args.splice(index, 1);
      index -= 1;
      continue;
    }
    if (args[index] === "--filter") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("gui vat watch --filter requires one or more comma-separated kinds");
      }
      filter = parseVatWatchFilterKinds(value);
      args.splice(index, 2);
      index -= 1;
    }
  }

  return {
    query: parseVatQueryArgs(args),
    once,
    ...(filter ? { filter } : {}),
  };
}

export function queryVatTree(tree: PlainNode, queryStr: string): VatQueryResult {
  const queries = parseQuery(queryStr);
  const { nodes: filtered } = filterTree(tree, queries);
  return {
    tree,
    nodes: filtered,
    matchCount: filtered.length,
  };
}

export function renderVatQueryResult(tree: PlainNode, queryStr: string): string {
  const queries = parseQuery(queryStr);
  const { nodes: filtered } = filterTree(tree, queries);
  return renderQueryResult(filtered, queries);
}

export function formatVatQueryOutput(tree: PlainNode, queryStr: string, tty = process.stdout.isTTY): string {
  const result = queryVatTree(tree, queryStr);
  if (tty) {
    return renderVatQueryResult(tree, queryStr);
  }
  return serializeCLICompositionPayload(
    buildCLICompositionPayloadFromVatQueryResult(queryStr, result.tree, result.nodes, result.matchCount),
    false,
  );
}

export function summarizeVatWatchChanges(changes: VatWatchChange[]): VatWatchChangeSummary {
  const summary: VatWatchChangeSummary = {
    added: 0,
    removed: 0,
    updated: 0,
    total: changes.length,
  };
  for (const change of changes) {
    summary[change.kind] += 1;
  }
  return summary;
}

export function parseVatWatchEventLine(line: string): VatWatchEvent {
  let raw: unknown;
  try {
    raw = JSON.parse(line) as unknown;
  } catch {
    throw new Error("gui vat watch expected NDJSON payloads");
  }
  if (!isRecord(raw)) {
    throw new Error("gui vat watch expected object payloads");
  }
  const payload = normalizeCLICompositionPayload(raw, "vat watch payload");
  if (payload.source !== "vat.watch") {
    throw new Error(`gui vat watch expected source vat.watch, received ${payload.source}`);
  }
  const changesRaw = raw.changes;
  if (!Array.isArray(changesRaw)) {
    throw new Error("gui vat watch payload is missing changes");
  }
  const changes: VatWatchChange[] = changesRaw.map((change, index) => {
    if (!isRecord(change)) {
      throw new Error(`gui vat watch payload changes[${index}] is invalid`);
    }
    const kind = change.kind;
    if (kind !== "added" && kind !== "removed" && kind !== "updated") {
      throw new Error(`gui vat watch payload changes[${index}].kind is invalid`);
    }
    if (!Number.isInteger(change.index) || Number(change.index) < 0) {
      throw new Error(`gui vat watch payload changes[${index}].index is invalid`);
    }
    const previous = change.previous == null
      ? null
      : isPlainNodeLike(change.previous)
        ? change.previous
        : (() => { throw new Error(`gui vat watch payload changes[${index}].previous is invalid`); })();
    const current = change.current == null
      ? null
      : isPlainNodeLike(change.current)
        ? change.current
        : (() => { throw new Error(`gui vat watch payload changes[${index}].current is invalid`); })();
    return {
      kind,
      index: Number(change.index),
      previous,
      current,
    };
  });

  const summaryRaw = raw.changeSummary;
  const summary = isRecord(summaryRaw)
    && Number.isFinite(summaryRaw.added)
    && Number.isFinite(summaryRaw.removed)
    && Number.isFinite(summaryRaw.updated)
    && Number.isFinite(summaryRaw.total)
    ? {
        added: Number(summaryRaw.added),
        removed: Number(summaryRaw.removed),
        updated: Number(summaryRaw.updated),
        total: Number(summaryRaw.total),
      }
    : summarizeVatWatchChanges(changes);

  return { payload, changes, summary };
}

export function formatVatWatchSummary(summary: VatWatchChangeSummary): string {
  if (summary.total === 0) {
    return "changes: none";
  }
  const parts: string[] = [];
  if (summary.added > 0) {
    parts.push(`${summary.added} added`);
  }
  if (summary.removed > 0) {
    parts.push(`${summary.removed} removed`);
  }
  if (summary.updated > 0) {
    parts.push(`${summary.updated} updated`);
  }
  return `changes: ${parts.join(", ")}`;
}

export function formatVatWatchEventText(event: VatWatchEvent): string {
  const query = event.payload.query;
  const tree = event.payload.tree;
  if (!query || !tree) {
    throw new Error("gui vat watch payload is missing query/tree");
  }
  return `${formatVatWatchSummary(event.summary)}\n${renderVatQueryResult(tree, query)}`;
}

export function formatVatMountOutput(result: VatMountResponse, tty = process.stdout.isTTY): string {
  if (!tty) {
    return JSON.stringify(result, null, 0);
  }
  if (result.tree) {
    return `Mounted ${result.mount.path} [${result.mount.driver}] policy=${formatVatPolicyLabel(result.mount.mountPolicy)} active=yes\n${toGUIML([result.tree])}`;
  }
  return `Mounted ${result.mount.path} [${result.mount.driver}] policy=${formatVatPolicyLabel(result.mount.mountPolicy)} active=no`;
}

export function formatVatMountsOutput(mounts: VatMountSummary[], tty = process.stdout.isTTY): string {
  if (!tty) {
    return JSON.stringify(mounts, null, 0);
  }
  if (mounts.length === 0) {
    return "No VAT mounts.";
  }
  const pathWidth = Math.max("PATH".length, ...mounts.map(mount => mount.path.length));
  const driverWidth = Math.max("DRIVER".length, ...mounts.map(mount => mount.driver.length));
  const policyWidth = Math.max("POLICY".length, ...mounts.map(mount => formatVatPolicyLabel(mount.mountPolicy).length));
  const activeWidth = "ACTIVE".length;
  const header = [
    padVatColumn("PATH", pathWidth),
    padVatColumn("DRIVER", driverWidth),
    padVatColumn("POLICY", policyWidth),
    padVatColumn("ACTIVE", activeWidth),
    "ARGS",
  ].join("  ");

  return [
    header,
    ...mounts.map((mount) => [
      padVatColumn(mount.path, pathWidth),
      padVatColumn(mount.driver, driverWidth),
      padVatColumn(formatVatPolicyLabel(mount.mountPolicy), policyWidth),
      padVatColumn(mount.active ? "yes" : "no", activeWidth),
      formatVatArgsLabel(mount),
    ].join("  ")),
  ].join("\n");
}

export function formatVatUnmountOutput(result: VatUnmountResponse, tty = process.stdout.isTTY): string {
  if (!tty) {
    return JSON.stringify(result, null, 0);
  }
  return `Unmounted ${result.unmounted.path} [${result.unmounted.driver}]`;
}

export function formatVatPolicyOutput(result: VatPolicyResponse, tty = process.stdout.isTTY): string {
  if (!tty) {
    return JSON.stringify(result, null, 0);
  }
  return `Updated ${result.mount.path} policy=${formatVatPolicyLabel(result.mount.mountPolicy)} active=${result.mount.active ? "yes" : "no"}`;
}

export function parseVatUnmountArgs(argv: string[], usageLabel = "vat unmount"): string {
  if (argv.length < 1) {
    throw new Error(`gui ${usageLabel} requires a path`);
  }

  const [path] = argv;
  if (!path.startsWith("/")) {
    throw new Error(`gui ${usageLabel} path must start with /`);
  }

  return path;
}

export function formatVatMountError(error: unknown): { kind: "usage" | "runtime"; message: string } {
  if (error instanceof VatMountRequestError) {
    return { kind: "runtime", message: error.message };
  }
  return { kind: "usage", message: error instanceof Error ? error.message : String(error) };
}

function formatVatPolicyLabel(policy: VatMountPolicy): string {
  switch (policy.kind) {
    case "always":
      return "always";
    case "disabled":
      return "disabled";
    case "auto":
      return policy.unmountTimeout.kind === "never"
        ? "auto never"
        : `auto ${policy.unmountTimeout.seconds}`;
  }
}

function padVatColumn(value: string, width: number): string {
  return value.padEnd(width, " ");
}

function formatVatArgsLabel(mount: VatMountSummary): string {
  const { args } = mount;
  if (args.length === 0) {
    return "-";
  }
  const a11yTransportLabel = mount.driver === "a11y"
    ? formatVatA11YTransportArgsLabel(args)
    : null;
  if (a11yTransportLabel) {
    return a11yTransportLabel;
  }
  return args.map(formatVatArg).join(" ");
}

function formatVatArg(value: string): string {
  return /[\s"'\\]/.test(value)
    ? JSON.stringify(value)
    : value;
}

function formatVatA11YTransportArgsLabel(args: string[]): string | null {
  if (args.length !== 2) {
    return null;
  }
  if (args[0] === VAT_A11Y_STDIN_AX_QUERY_ARG) {
    return "a11y stdin";
  }
  if (args[0] !== VAT_A11Y_STDIN_AX_QUERY_PLAN_ARG) {
    return null;
  }
  const plan = parseVatA11YQueryPlanLabel(args[1]);
  if (!plan) {
    return "a11y query";
  }
  const scope = formatVatA11YQueryScopeLabel(plan.scope);
  return scope === "" ? `a11y query ${JSON.stringify(plan.query)}` : `a11y query ${JSON.stringify(plan.query)} ${scope}`;
}

function parseVatA11YQueryPlanLabel(payload: string): VatA11YQueryPlan | null {
  try {
    const plan: unknown = JSON.parse(payload);
    return isVatA11YQueryPlan(plan) ? plan : null;
  } catch {
    return null;
  }
}

function formatVatA11YQueryScopeLabel(scope: VatA11YQueryScope): string {
  switch (scope.kind) {
    case "all":
      return "";
    case "focused":
      return "focused";
    case "pid":
      return `pid=${scope.pid}`;
    case "app":
      return `app=${scope.app}`;
  }
}

export function parseVatPolicyArgs(argv: string[], usageLabel = "vat policy"): VatPolicyCLIArgs {
  if (argv.length < 2) {
    throw new Error(`gui ${usageLabel} requires a path and policy`);
  }
  const [path, kind, value] = argv;
  if (!path.startsWith("/")) {
    throw new Error(`gui ${usageLabel} path must start with /`);
  }
  if (kind === "always") {
    if (argv.length !== 2) {
      throw new Error(`gui ${usageLabel} always takes no extra values`);
    }
    return { path, mountPolicy: { kind: "always" } };
  }
  if (kind === "disabled") {
    if (argv.length !== 2) {
      throw new Error(`gui ${usageLabel} disabled takes no extra values`);
    }
    return { path, mountPolicy: { kind: "disabled" } };
  }
  if (kind === "auto") {
    if (!value || argv.length !== 3) {
      throw new Error(`gui ${usageLabel} auto requires 'never' or a positive integer timeout`);
    }
    if (value === "never") {
      return {
        path,
        mountPolicy: { kind: "auto", unmountTimeout: { kind: "never" } },
      };
    }
    const seconds = Number(value);
    if (!Number.isInteger(seconds) || seconds <= 0) {
      throw new Error(`gui ${usageLabel} auto timeout must be a positive integer or 'never'`);
    }
    return {
      path,
      mountPolicy: { kind: "auto", unmountTimeout: { kind: "seconds", seconds } },
    };
  }
  throw new Error(`gui ${usageLabel} policy must be one of: always, disabled, auto`);
}

function extractVatA11YQueryPlanFromPayloads(
  payloads: ReturnType<typeof parseCLICompositionPayloadStream>,
): VatA11YQueryPlan | null {
  const plans = payloads
    .map(payload => payload.vatQueryPlan)
    .filter((plan): plan is VatA11YQueryPlan => plan !== null);
  if (plans.length === 0) {
    return null;
  }
  const first = JSON.stringify(plans[0]);
  const mismatch = plans.find((plan) => JSON.stringify(plan) !== first);
  if (mismatch) {
    throw new Error("gui vat mount received conflicting vatQueryPlan metadata on stdin");
  }
  return plans[0];
}

function serializeVatA11YTransportMatches(
  payloads: ReturnType<typeof parseCLICompositionPayloadStream>,
): string {
  if (payloads.length === 0) {
    throw new Error("gui vat mount expected AX query JSON CLI payload on stdin");
  }
  const matches = payloads.map((payload, index) => {
    if (!payload.axQueryMatch) {
      throw new Error(`gui vat mount stdin payload[${index}] is missing an AX query match`);
    }
    return payload.vatQueryPlan
      ? { ...payload.axQueryMatch, vatQueryPlan: payload.vatQueryPlan }
      : payload.axQueryMatch;
  });
  return JSON.stringify(matches.length === 1 ? matches[0] : matches);
}

export function resolveVatMountRequest(mountArgs: VatMountCLIArgs, stdinText?: string): VatMountCLIArgs {
  if (mountArgs.driver !== "a11y" || mountArgs.args.length !== 1 || mountArgs.args[0] !== "-") {
    return mountArgs;
  }
  const payload = stdinText?.trim();
  if (!payload) {
    throw new Error("gui vat mount expected AX query JSON CLI payload on stdin");
  }
  const payloads = parseCLICompositionPayloadStream(payload, "stdin");
  if (payloads.length === 0) {
    throw new Error("gui vat mount expected AX query JSON CLI payload on stdin");
  }
  const queryPlan = extractVatA11YQueryPlanFromPayloads(payloads);
  if (queryPlan) {
    return {
      ...mountArgs,
      args: [VAT_A11Y_STDIN_AX_QUERY_PLAN_ARG, JSON.stringify(queryPlan)],
    };
  }
  return {
    ...mountArgs,
    args: [VAT_A11Y_STDIN_AX_QUERY_ARG, serializeVatA11YTransportMatches(payloads)],
  };
}

function extractPositiveIntFlag(arr: string[], flag: string): number | undefined {
  const i = arr.indexOf(flag);
  if (i < 0) return undefined;
  const value = Number(arr[i + 1]);
  if (!Number.isInteger(value) || value <= 0) {
    console.error(`${flag} requires a positive integer`);
    process.exit(1);
  }
  arr.splice(i, 2);
  return value;
}

function extractAXObserverBenchmarkMode(arr: string[]): AXObserverBenchmarkMode | undefined {
  const i = arr.indexOf("--mode");
  if (i < 0) return undefined;
  const value = arr[i + 1];
  if (value !== "app" && value !== "windows" && value !== "focused") {
    console.error("--mode must be one of: app, windows, focused");
    process.exit(1);
  }
  arr.splice(i, 2);
  return value;
}

async function readStdinText(usageLabel: string): Promise<string> {
  if (process.stdin.isTTY) {
    throw new Error(`gui ${usageLabel} expects JSON on stdin`);
  }
  return Bun.stdin.text();
}

async function writeStdoutText(text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const stdout = process.stdout;

    const cleanup = () => {
      stdout.off("error", onError);
      stdout.off("drain", onDrain);
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onDrain = () => {
      cleanup();
      resolve();
    };

    stdout.on("error", onError);
    const flushed = stdout.write(text);
    if (flushed) {
      cleanup();
      resolve();
      return;
    }
    stdout.once("drain", onDrain);
  });
}

async function tailVatWatchStream(
  watchArgs: VatWatchCLIArgs,
  tty: boolean,
  writer: (chunk: string) => Promise<void> = writeStdoutText,
): Promise<void> {
  const res = await openVatWatchStream(watchArgs.query, {
    once: watchArgs.once,
    filter: watchArgs.filter,
  });

  if (!res.body) {
    throw new Error("vat watch stream missing response body");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let receivedPayload = false;

  const emitLine = async (line: string): Promise<void> => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    receivedPayload = true;
    if (!tty) {
      await writer(trimmed + "\n");
      return;
    }
    await writer(`${formatVatWatchEventText(parseVatWatchEventLine(trimmed))}\n`);
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      if (buffer.trim().length > 0) {
        await emitLine(buffer);
        buffer = "";
      }
      if (watchArgs.once && receivedPayload) {
        return;
      }
      throw new Error("vat watch stream ended unexpectedly");
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      await emitLine(line);
      if (watchArgs.once && receivedPayload) {
        return;
      }
    }
  }
}

type AXQueryCardinality = "first" | "only" | "all" | "each";
type AXQueryOutputMode = "json" | "ndjson" | "guiml";

function extractAXQueryCardinality(arr: string[]): AXQueryCardinality {
  const flags = [
    { flag: "--first", mode: "first" as const },
    { flag: "--only", mode: "only" as const },
    { flag: "--each", mode: "each" as const },
  ].filter(({ flag }) => arr.includes(flag));
  if (flags.length > 1) {
    failUsage("ax query", "Choose at most one of --first, --only, or --each.");
  }
  if (flags.length === 0) return "all";
  arr.splice(arr.indexOf(flags[0].flag), 1);
  return flags[0].mode;
}

function extractAXOutputMode(arr: string[]): AXQueryOutputMode | undefined {
  const flags = [
    { flag: "--json", mode: "json" as const },
    { flag: "--ndjson", mode: "ndjson" as const },
    { flag: "--guiml", mode: "guiml" as const },
  ].filter(({ flag }) => arr.includes(flag));
  if (flags.length > 1) {
    failUsage("ax query", "Choose at most one of --json, --ndjson, or --guiml.");
  }
  if (flags.length === 0) return undefined;
  arr.splice(arr.indexOf(flags[0].flag), 1);
  return flags[0].mode;
}

function resolveAXQueryOutputMode(mode: AXQueryCardinality, explicit?: AXQueryOutputMode): AXQueryOutputMode {
  if (explicit) return explicit;
  if (process.stdout.isTTY) return "guiml";
  return mode === "each" ? "ndjson" : "json";
}

export async function renderAXQueryMatches(
  matches: AXQueryMatch[],
  cardinality: AXQueryCardinality,
  outputMode: AXQueryOutputMode,
  vatQueryPlan?: VatA11YQueryPlan,
  writer: (chunk: string) => Promise<void> = writeStdoutText,
): Promise<void> {
  if (matches.length === 0) return;
  const payloadMatches = matches.map((match) =>
    buildCLICompositionPayloadFromAXQueryMatch(match, "ax.query", vatQueryPlan ?? null)
  );
  switch (outputMode) {
    case "json": {
      const payload = cardinality === "first" || cardinality === "only" ? payloadMatches[0] : payloadMatches;
      await writer(JSON.stringify(payload, null, process.stdout.isTTY ? 2 : 0) + "\n");
      return;
    }
    case "ndjson":
      await writer(payloadMatches.map(match => JSON.stringify(match)).join("\n") + "\n");
      return;
    case "guiml":
      throw new Error("Internal error: guiml AX query output should use raw AX matches");
  }
}

function isVatA11YQueryScope(value: unknown): value is VatA11YQueryScope {
  if (!value || typeof value !== "object") return false;
  const scope = value as Record<string, unknown>;
  switch (scope.kind) {
    case "all":
    case "focused":
      return true;
    case "pid":
      return Number.isInteger(scope.pid) && Number(scope.pid) > 0;
    case "app":
      return typeof scope.app === "string" && scope.app.trim().length > 0;
    default:
      return false;
  }
}

function isVatA11YQueryPlan(value: unknown): value is VatA11YQueryPlan {
  if (!value || typeof value !== "object") return false;
  const plan = value as Record<string, unknown>;
  if (plan.type !== "vat.a11y-query-plan") return false;
  if (typeof plan.query !== "string" || plan.query.trim().length === 0) return false;
  if (plan.cardinality !== "first" && plan.cardinality !== "only" && plan.cardinality !== "all" && plan.cardinality !== "each") {
    return false;
  }
  if (!isVatA11YQueryScope(plan.scope)) return false;
  if (plan.target !== undefined && !isAXTarget(plan.target)) return false;
  return true;
}

function buildVatA11YQueryPlan(
  query: string,
  cardinality: AXQueryCardinality,
  scope: AXQueryScopeInput,
  inputTarget?: AXTarget,
): VatA11YQueryPlan {
  return {
    type: "vat.a11y-query-plan",
    query,
    cardinality,
    scope: scope.kind === "focused" ? { kind: "focused" } : scope,
    ...(inputTarget ? { target: inputTarget } : {}),
  };
}

async function readSingleAXTarget(usageLabel: string): Promise<AXTarget> {
  const targets = parseAXTargetStream(await readStdinText(usageLabel));
  if (targets.length === 0) {
    throw new Error(`gui ${usageLabel} received no AX target-bearing payload on stdin`);
  }
  if (targets.length > 1) {
    throw new Error(`gui ${usageLabel} expected exactly one AX target-bearing payload on stdin, received ${targets.length}`);
  }
  return targets[0];
}

export interface AXTargetPassthroughInput {
  raw: string;
  target: AXTarget;
}

export interface AXCursorPassthroughInput {
  raw: string;
  cursor: AXCursor;
}

export function parseSingleAXTargetPassthroughInput(input: string, usageLabel: string): AXTargetPassthroughInput {
  const targets = parseAXTargetStream(input);
  if (targets.length === 0) {
    throw new Error(`gui ${usageLabel} received no AX target-bearing payload on stdin`);
  }
  if (targets.length > 1) {
    throw new Error(`gui ${usageLabel} expected exactly one AX target-bearing payload on stdin, received ${targets.length}`);
  }
  return {
    raw: input,
    target: targets[0],
  };
}

async function readAXScopePassthroughInput(value: string | undefined, usageLabel: string): Promise<{ raw: string; scope: AXScopePayload }> {
  if (value === undefined || value === "-") {
    const raw = await readStdinText(usageLabel);
    return { raw, scope: parseAXScopePayload(raw, `gui ${usageLabel}`) };
  }
  return { raw: value, scope: parseAXScopePayload(value, `gui ${usageLabel}`) };
}

async function readAXCursorPassthroughInput(value: string | undefined, usageLabel: string): Promise<AXCursorPassthroughInput> {
  const { raw, scope } = await readAXScopePassthroughInput(value, usageLabel);
  if (scope.kind !== "cursor") {
    throw new Error(`gui ${usageLabel} expects an ax.cursor payload`);
  }
  return { raw, cursor: scope.cursor };
}

async function readAXTargetArgOrStdin(action: string, value: string, usageLabel: string): Promise<AXTarget> {
  if (value === "-") {
    return readSingleAXTarget(usageLabel);
  }
  try {
    return parseAXTargetPayload(value, `gui ${usageLabel}`);
  } catch {
    throw new Error(stdinOnlyAXActionMessage(action));
  }
}

function parsePointerButtonFlag(args: string[], usageTopic: string): PointerButton | undefined {
  const buttonIndex = args.indexOf("--button");
  if (buttonIndex < 0) {
    return undefined;
  }
  const button = args[buttonIndex + 1];
  if (!button || !["left", "right", "middle"].includes(button)) {
    failUsage(usageTopic, "--button requires left, right, or middle");
  }
  return button as PointerButton;
}

function stripOptionValueFlags(args: string[], flags: string[]): string[] {
  const skip = new Set<number>();
  for (const flag of flags) {
    const index = args.indexOf(flag);
    if (index >= 0) {
      skip.add(index);
      skip.add(index + 1);
    }
  }
  return args.filter((_, index) => !skip.has(index));
}

export function buildActorClickPassthroughRequest(args: string[], target: AXTarget) {
  const stdinMarkers = args.filter(arg => arg === "-");
  if (stdinMarkers.length !== 1) {
    throw new Error("actor run click stdin mode requires exactly one `-` argument");
  }
  if (args.includes("--at")) {
    throw new Error("actor run click stdin mode cannot be combined with --at");
  }
  const normalizedArgs = args.filter(arg => arg !== "-");
  return parseActorRunCLIArgs("click", [
    ...normalizedArgs,
    "--at",
    String(target.point.x),
    String(target.point.y),
  ]);
}

export function buildActorMovePassthroughRequest(args: string[], target: AXTarget) {
  const stdinMarkers = args.filter(arg => arg === "-");
  if (stdinMarkers.length !== 1) {
    throw new Error("actor run move stdin mode requires exactly one `-` argument");
  }
  if (args.includes("--to")) {
    throw new Error("actor run move stdin mode cannot be combined with --to");
  }
  const normalizedArgs = args.filter(arg => arg !== "-");
  return parseActorRunCLIArgs("move", [
    ...normalizedArgs,
    "--to",
    String(target.point.x),
    String(target.point.y),
  ]);
}

export function shouldEmitPassthroughStdout(stdoutIsTTY: boolean | undefined): boolean {
  return !stdoutIsTTY;
}

export function emitPassthroughStdout(
  raw: string,
  stdoutIsTTY: boolean | undefined,
  writer: (chunk: string) => void = chunk => process.stdout.write(chunk),
): void {
  if (shouldEmitPassthroughStdout(stdoutIsTTY)) {
    writer(raw);
  }
}

async function runActorClickPassthrough(name: string, args: string[]): Promise<void> {
  const input = parseSingleAXTargetPassthroughInput(await readStdinText("actor run click"), "actor run click");
  const request = buildActorClickPassthroughRequest(args, input.target);
  const emitPassthroughStdout = shouldEmitPassthroughStdout(process.stdout.isTTY);
  const runPromise = runActor(name, request.action, request.timeoutMs);
  const gate = await Promise.race([
    runPromise.then(() => "completed" as const),
    Bun.sleep(ACTOR_CLICK_PASSTHROUGH_DELAY_MS).then(() => "delay" as const),
  ]);
  if (gate === "delay" && emitPassthroughStdout) {
    process.stdout.write(input.raw);
  }
  await runPromise;
  if (gate === "completed" && emitPassthroughStdout) {
    process.stdout.write(input.raw);
  }
}

async function runActorMovePassthrough(name: string, args: string[]): Promise<void> {
  const input = parseSingleAXTargetPassthroughInput(await readStdinText("actor run move"), "actor run move");
  const request = buildActorMovePassthroughRequest(args, input.target);
  await runActor(name, request.action, request.timeoutMs);
  emitPassthroughStdout(input.raw, process.stdout.isTTY);
}

export function parseCGPointPassthroughInput(input: string, usageLabel: string): { x: number; y: number } {
  const { target } = parseSingleAXTargetPassthroughInput(input, usageLabel);
  return { x: target.point.x, y: target.point.y };
}

export function parseRecRectArgFromPayloadText(input: string, usageLabel: string): string {
  const target = parseAXTargetPayload(input, `gui ${usageLabel}`);
  if (!target.bounds || target.bounds.width <= 0 || target.bounds.height <= 0) {
    throw new Error(`gui ${usageLabel} ${describeAXTarget(target)} has no usable bounds`);
  }
  return `${target.bounds.x},${target.bounds.y},${target.bounds.width},${target.bounds.height}`;
}

interface CGWindowPayloadLike {
  cgWindowId?: number;
  windowNumber?: number;
}

function extractCGWindowIdFromPayloadRecord(record: CGWindowPayloadLike, usageLabel: string): number {
  const cgWindowId = Number(record.cgWindowId ?? record.windowNumber);
  if (!Number.isFinite(cgWindowId) || cgWindowId <= 0) {
    throw new Error(`gui ${usageLabel} payload has no usable cgWindowId`);
  }
  return cgWindowId;
}

export function parseSingleCGWindowPayloadText(input: string, usageLabel: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error(`gui ${usageLabel} expected a JSON CG window payload`);
  }

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      throw new Error(`gui ${usageLabel} received no CG window payload on stdin`);
    }
    if (parsed.length > 1) {
      throw new Error(`gui ${usageLabel} expected exactly one JSON CG window payload on stdin, received ${parsed.length}`);
    }
    parsed = parsed[0];
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`gui ${usageLabel} expected a JSON CG window payload`);
  }

  return extractCGWindowIdFromPayloadRecord(parsed as CGWindowPayloadLike, usageLabel);
}

async function readCGWindowIdArgOrStdin(value: string, usageLabel: string): Promise<number> {
  if (value === "-") {
    return parseSingleCGWindowPayloadText(await readStdinText(usageLabel), usageLabel);
  }
  if (/^\d+$/.test(value)) {
    return Number(value);
  }
  return parseSingleCGWindowPayloadText(value, usageLabel);
}

async function normalizeRecPayloadCLIArgs(mode: "image" | "filmstrip", targetArg: string, rest: string[]): Promise<string[]> {
  const payloadText = targetArg === "-" ? await readStdinText(`rec ${mode}`) : targetArg;
  return ["--rect", parseRecRectArgFromPayloadText(payloadText, `rec ${mode}`), ...rest];
}

export function parseCGDragPoints(
  args: string[],
  usageLabel: string,
  stdinText = "",
): { from: { x: number; y: number }; to: { x: number; y: number } } {
  const positional = stripOptionValueFlags(args, ["--button"]);
  const placeholderCount = positional.filter(arg => arg === "-").length;
  const stdinTargets = placeholderCount > 0 ? parseAXTargetStream(stdinText) : [];
  if (stdinTargets.length !== placeholderCount) {
    throw new Error(
      `gui ${usageLabel} expected ${placeholderCount} AX target-bearing payload${placeholderCount === 1 ? "" : "s"} on stdin for ${placeholderCount} \`-\` placeholder${placeholderCount === 1 ? "" : "s"}, received ${stdinTargets.length}`,
    );
  }

  let argIndex = 0;
  let stdinIndex = 0;

  const parseEndpoint = (label: "from" | "to"): { x: number; y: number } => {
    const token = positional[argIndex];
    if (token === undefined) {
      throw new Error(
        `gui ${usageLabel} ${label} endpoint must be <x> <y>, \`-\`, or a literal JSON AX target / AX query match payload`,
      );
    }
    if (token === "-") {
      argIndex += 1;
      const target = stdinTargets[stdinIndex++];
      return { x: target.point.x, y: target.point.y };
    }
    try {
      const target = parseAXTargetPayload(token, `gui ${usageLabel} ${label} endpoint`);
      argIndex += 1;
      return { x: target.point.x, y: target.point.y };
    } catch {
      const x = Number(token);
      const yToken = positional[argIndex + 1];
      const y = Number(yToken);
      if (!Number.isFinite(x) || !yToken || !Number.isFinite(y)) {
        throw new Error(
          `gui ${usageLabel} ${label} endpoint must be <x> <y>, \`-\`, or a literal JSON AX target / AX query match payload`,
        );
      }
      argIndex += 2;
      return { x, y };
    }
  };

  const from = parseEndpoint("from");
  const to = parseEndpoint("to");
  if (argIndex !== positional.length) {
    throw new Error(`gui ${usageLabel} received extra positional arguments after the to endpoint`);
  }
  return { from, to };
}

async function parseCGPointArgs(args: string[], usageLabel: string, flagsToStrip: string[] = []): Promise<{ x: number; y: number }> {
  const positional = stripOptionValueFlags(args, flagsToStrip);
  const xArg = positional[0];
  const yArg = positional[1];
  if (xArg === "-") {
    if (positional.length !== 1) {
      failUsage(usageLabel, `gui ${usageLabel} stdin mode does not accept explicit coordinates`);
    }
    return parseCGPointPassthroughInput(await readStdinText(usageLabel), usageLabel);
  }
  const x = Number(xArg);
  const y = Number(yArg);
  if (!xArg || !yArg || !Number.isFinite(x) || !Number.isFinite(y)) {
    failUsage(usageLabel);
  }
  return { x, y };
}

function stdinOnlyAXActionMessage(action: string): string {
  const suffix =
    action === "type" ? " - '<value>'" :
    action === "set" ? " '<value>' -" :
    action === "perform" ? " <AXAction> -" :
    " -";
  return `gui ax ${action} expects \`-\` or a literal JSON AX cursor / AX target / AX query match payload. Use \`gui ax query ... | gui ax ${action}${suffix}\` if you want stdin.`;
}

function hasExplicitAXQueryScope(args: string[]): boolean {
  return args.includes("--focused") || args.includes("--all") || args.includes("--pid") || args.includes("--app");
}

export function extractAXQueryAppFilter(args: string[]): AXQueryAppFilter {
  const gui = extractBooleanFlag(args, "--gui");
  const visible = extractBooleanFlag(args, "--visible");
  if (gui && visible) {
    throw new Error("Choose at most one of --gui or --visible.");
  }
  if (visible) return "visible";
  if (gui) return "regular";
  return "none";
}

function axQueryAppFilterFlag(filter: Exclude<AXQueryAppFilter, "none">): "--gui" | "--visible" {
  return filter === "visible" ? "--visible" : "--gui";
}

export function resolveAXQueryAppFilterScope(
  scopeInput: AXQueryScopeInput | undefined,
  filter: AXQueryAppFilter,
  stdinRefined: boolean,
): AXQueryScopeInput | undefined {
  if (filter === "none") {
    return scopeInput;
  }
  const filterFlag = axQueryAppFilterFlag(filter);
  if (stdinRefined) {
    throw new Error(`${filterFlag} cannot be combined with stdin-refined AX queries.`);
  }
  if (scopeInput && scopeInput.kind !== "all") {
    throw new Error(`${filterFlag} cannot be combined with --focused, --pid, or --app.`);
  }
  return scopeInput ?? { kind: "all" };
}

function sameAXTarget(left: AXTarget, right: AXTarget): boolean {
  return left.pid === right.pid
    && left.role === right.role
    && left.point.x === right.point.x
    && left.point.y === right.point.y
    && (left.identifier ?? null) === (right.identifier ?? null)
    && (left.title ?? null) === (right.title ?? null)
    && (left.label ?? null) === (right.label ?? null);
}

export const DEFAULT_CA_HIGHLIGHT_TIMEOUT_MS = 1200;
export const DEFAULT_GFX_SCAN_DURATION_MS = 500;
export const DEFAULT_GFX_XRAY_DURATION_MS = 650;

function normalizeHighlightRect(value: unknown): CLICompositionRect | null {
  if (typeof value === "string") {
    const match = value.trim().match(/^\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)$/);
    if (!match) return null;
    return {
      x: Number(match[1]),
      y: Number(match[2]),
      width: Number(match[3]),
      height: Number(match[4]),
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const x = typeof record.x === "number" ? record.x : typeof record.x === "string" ? Number(record.x) : null;
  const y = typeof record.y === "number" ? record.y : typeof record.y === "string" ? Number(record.y) : null;
  const width = typeof record.width === "number" ? record.width : typeof record.width === "string" ? Number(record.width) : null;
  const height = typeof record.height === "number" ? record.height : typeof record.height === "string" ? Number(record.height) : null;
  if (
    x === null || y === null || width === null || height === null
    || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)
  ) {
    return null;
  }
  return { x, y, width, height };
}

function boundsFromHighlightNode(node: PlainNode): CLICompositionRect | null {
  const record = node as PlainNode & Record<string, unknown>;
  const frame = normalizeHighlightRect(record.frame) ?? normalizeHighlightRect(record._frame);
  if (frame) return frame;
  const x = typeof record.x === "number" ? record.x : typeof record.x === "string" ? Number(record.x) : null;
  const y = typeof record.y === "number" ? record.y : typeof record.y === "string" ? Number(record.y) : null;
  const width = typeof record.width === "number" ? record.width : typeof record.width === "string" ? Number(record.width) : null;
  const height = typeof record.height === "number" ? record.height : typeof record.height === "string" ? Number(record.height) : null;
  if (
    x === null || y === null || width === null || height === null
    || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)
  ) {
    return null;
  }
  return { x, y, width, height };
}

function describeHighlightNode(node: PlainNode): string {
  const record = node as PlainNode & Record<string, unknown>;
  const label = typeof record.title === "string"
    ? record.title
    : typeof record.label === "string"
      ? record.label
      : typeof record._displayName === "string"
        ? record._displayName
        : typeof record._label === "string"
          ? record._label
          : typeof record._id === "string"
            ? record._id
            : typeof record._text === "string"
              ? record._text
              : undefined;
  return `${node._tag}${label ? ` "${label}"` : ""}`;
}

function collectVatHighlightRects(
  nodes: PlainNode[] | null,
): { rects: CLICompositionRect[]; firstNodeWithoutBounds: PlainNode | null } {
  const rects: CLICompositionRect[] = [];
  const seen = new Set<string>();
  let firstNodeWithoutBounds: PlainNode | null = null;
  const walk = (node: PlainNode) => {
    if (node._tag !== "VATRoot") {
      const rect = boundsFromHighlightNode(node);
      if (rect && rect.width > 0 && rect.height > 0) {
        const key = `${rect.x}:${rect.y}:${rect.width}:${rect.height}`;
        if (!seen.has(key)) {
          seen.add(key);
          rects.push(rect);
        }
      } else {
        firstNodeWithoutBounds ??= node;
      }
    }
    for (const child of node._children ?? []) {
      walk(child);
    }
  };
  for (const node of nodes ?? []) {
    walk(node);
  }
  return { rects, firstNodeWithoutBounds };
}

function parseSingleGfxPayload(
  input: string,
  usageLabel: string,
): CLICompositionPayload {
  const payloads = parseCLICompositionPayloadStream(input);
  if (payloads.length === 0) {
    throw new Error(`${usageLabel} received no JSON CLI payload on stdin`);
  }
  if (payloads.length > 1) {
    throw new Error(`${usageLabel} expected exactly one JSON CLI payload on stdin, received ${payloads.length}`);
  }
  return payloads[0]!;
}

function resolveGfxRectsFromPayload(
  payload: CLICompositionPayload,
  usageLabel: string,
): CLICompositionRect[] {
  if (payload.source === "vat.query") {
    const { rects, firstNodeWithoutBounds } = collectVatHighlightRects(payload.nodes);
    if (rects.length > 0) {
      return rects;
    }
    if (firstNodeWithoutBounds) {
      throw new Error(`${usageLabel} ${describeHighlightNode(firstNodeWithoutBounds)} is missing bounds/frame coordinates`);
    }
  }
  return [requireCLICompositionBounds(payload, usageLabel)];
}

function resolveGfxRectsFromText(
  input: string,
  usageLabel: string,
): CLICompositionRect[] {
  return resolveGfxRectsFromPayload(parseSingleGfxPayload(input, usageLabel), usageLabel);
}

function buildOutlineItems(rects: CLICompositionRect[]): DrawScript["items"] {
  return rects.map((rect) => ({
    kind: "rect" as const,
    rect,
  }));
}

function buildXrayItems(rects: CLICompositionRect[]): DrawScript["items"] {
  return rects.map((rect) => ({
    kind: "xray" as const,
    rect,
    direction: "leftToRight" as const,
    animation: { durMs: DEFAULT_GFX_XRAY_DURATION_MS, ease: "easeInOut" as const },
  }));
}

function buildSpotlightItems(rects: CLICompositionRect[]): DrawScript["items"] {
  return rects.map((rect) => ({
    kind: "rect" as const,
    rect,
    style: {
      stroke: "#FFD54F",
      fill: "#FFD54F33",
      lineWidth: 3,
      cornerRadius: 14,
      opacity: 1,
    },
  }));
}

function buildArrowItems(rects: CLICompositionRect[]): DrawScript["items"] {
  const items: DrawScript["items"] = [];
  for (const rect of rects) {
    const center = {
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
    };
    const start = {
      x: rect.x - Math.min(Math.max(rect.width * 0.22, 18), 52),
      y: rect.y - Math.min(Math.max(rect.height * 0.22, 18), 52),
    };
    const angle = Math.atan2(center.y - start.y, center.x - start.x);
    const headLength = Math.min(Math.max(Math.min(rect.width, rect.height) * 0.18, 10), 18);
    const headSpread = Math.PI / 7;
    const left = {
      x: center.x - headLength * Math.cos(angle - headSpread),
      y: center.y - headLength * Math.sin(angle - headSpread),
    };
    const right = {
      x: center.x - headLength * Math.cos(angle + headSpread),
      y: center.y - headLength * Math.sin(angle + headSpread),
    };
    const style = {
      stroke: "#FFB300",
      lineWidth: 3,
      opacity: 1,
    };
    items.push(
      { kind: "line" as const, line: { from: start, to: center }, style },
      { kind: "line" as const, line: { from: center, to: left }, style },
      { kind: "line" as const, line: { from: center, to: right }, style },
    );
  }
  return items;
}

function buildGfxDrawScript(
  rects: CLICompositionRect[],
  items: DrawScript["items"],
  timeoutMs: number,
): DrawScript {
  if (rects.length === 0) {
    throw new Error("gfx draw script requires at least one resolved rect");
  }
  return {
    coordinateSpace: "screen",
    timeout: timeoutMs,
    items,
  };
}

export function buildGfxOutlineDrawScriptFromText(
  input: string,
  timeoutMs = DEFAULT_CA_HIGHLIGHT_TIMEOUT_MS,
): DrawScript {
  const rects = resolveGfxRectsFromText(input, "gui gfx outline -");
  return buildGfxDrawScript(rects, buildOutlineItems(rects), timeoutMs);
}

export function buildGfxXrayDrawScriptFromText(
  input: string,
  timeoutMs = DEFAULT_CA_HIGHLIGHT_TIMEOUT_MS,
): DrawScript {
  const rects = resolveGfxRectsFromText(input, "gui gfx xray -");
  return buildGfxDrawScript(rects, buildXrayItems(rects), timeoutMs);
}

export function buildGfxSpotlightDrawScriptFromText(
  input: string,
  timeoutMs = DEFAULT_CA_HIGHLIGHT_TIMEOUT_MS,
): DrawScript {
  const rects = resolveGfxRectsFromText(input, "gui gfx spotlight -");
  return buildGfxDrawScript(rects, buildSpotlightItems(rects), timeoutMs);
}

export function buildGfxArrowDrawScriptFromText(
  input: string,
  timeoutMs = DEFAULT_CA_HIGHLIGHT_TIMEOUT_MS,
): DrawScript {
  const rects = resolveGfxRectsFromText(input, "gui gfx arrow -");
  return buildGfxDrawScript(rects, buildArrowItems(rects), timeoutMs);
}

export function buildAXHighlightDrawScriptFromText(
  input: string,
  timeoutMs = DEFAULT_CA_HIGHLIGHT_TIMEOUT_MS,
): DrawScript {
  const rects = resolveGfxRectsFromText(input, "gui ca highlight -");
  return buildGfxDrawScript(rects, buildOutlineItems(rects), timeoutMs);
}

export function buildGfxTextPlacementsFromText(
  input: string,
  text: string,
): Array<{ point: { x: number; y: number }; text: string }> {
  if (text.trim().length === 0) {
    throw new Error("gui gfx text - text must be non-empty");
  }
  return resolveGfxRectsFromText(input, "gui gfx text -").map((rect) => ({
    point: {
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
    },
    text,
  }));
}

export function buildGfxScanOverlayRequestFromText(
  input: string,
  durationMs = DEFAULT_GFX_SCAN_DURATION_MS,
): {
  rects: CLICompositionRect[];
  durationMs: number;
} {
  return {
    rects: resolveGfxRectsFromText(input, "gui gfx scan -"),
    durationMs,
  };
}

async function runGfxTextFromText(
  input: string,
  text: string,
  timeoutMs = DEFAULT_CA_HIGHLIGHT_TIMEOUT_MS,
): Promise<void> {
  const placements = buildGfxTextPlacementsFromText(input, text);
  const actorNames = placements.map((_, index) => `gfx.text.${process.pid}.${Date.now()}.${index}`);
  try {
    await Promise.all(actorNames.map((name) => spawnActor("pointer", name)));
    await Promise.all(placements.map((placement, index) => runActor(actorNames[index]!, {
      kind: "move",
      to: placement.point,
      style: "fast",
    })));
    await Promise.all(placements.map((placement, index) => runActor(
      actorNames[index]!,
      { kind: "narrate", text: placement.text },
      timeoutMs,
    )));
  } finally {
    await Promise.allSettled(actorNames.map((name) => killActor(name)));
  }
}

async function runGfxScanFromText(
  input: string,
  durationMs = DEFAULT_GFX_SCAN_DURATION_MS,
): Promise<void> {
  const request = buildGfxScanOverlayRequestFromText(input, durationMs);
  await postScanOverlay(request.rects, request.durationMs);
}

function parseGfxTimeout(
  argv: string[],
  usageTopic: string,
  defaultTimeoutMs: number,
): number {
  let timeoutMs = defaultTimeoutMs;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] !== "--timeout") {
      continue;
    }
    const raw = argv[index + 1];
    const parsed = Number(raw);
    if (!raw || !Number.isFinite(parsed) || parsed <= 0) {
      failUsage(usageTopic, "--timeout requires a positive number of milliseconds.");
    }
    timeoutMs = parsed;
    argv.splice(index, 2);
    index--;
  }
  return timeoutMs;
}

async function attachDrawOverlay(payload: DrawScript): Promise<void> {
  const drawAbort = new AbortController();
  const onAbort = () => {
    if (!drawAbort.signal.aborted) {
      drawAbort.abort();
    }
    process.exitCode = 130;
  };
  process.once("SIGINT", onAbort);
  process.once("SIGTERM", onAbort);
  try {
    const res = await postDrawOverlay(payload, drawAbort.signal);
    await waitForDrawOverlayAttachment(res, drawAbort.signal);
  } catch (error: unknown) {
    if (!drawAbort.signal.aborted) {
      throw error;
    }
  } finally {
    process.removeListener("SIGINT", onAbort);
    process.removeListener("SIGTERM", onAbort);
  }
}

async function writeArtifactOutput(bytes: Buffer, outPath?: string): Promise<void> {
  if (outPath) {
    await Bun.write(outPath, bytes);
    console.error(`Saved: ${outPath} (${bytes.length} bytes)`);
    return;
  }
  process.stdout.write(bytes);
}

async function main() {
  try {
    const helpRequest = resolveHelpRequest(args);
    if (helpRequest) {
      if (!helpRequest.topic) {
        console.log(helpRequest.explicit ? renderHelpIndex() : renderRootHelp());
        return;
      }

      if (!findHelpTopic(helpRequest.topic)) {
        console.error(renderUnknownHelpTopic(helpRequest.topic));
        process.exit(1);
      }

      console.log(renderHelpTopic(helpRequest.topic));
      return;
    }

    // If --app specified, bring that app to foreground first
    if (appTarget && command !== "skill" && command !== "vat") {
      const result = await switchApp(appTarget);
      if (!result.ok) {
        console.error(`Failed to switch to app: ${result.error || appTarget}`);
        process.exit(1);
      }
      const activated = result.activated || appTarget;
      console.error(`Switched to ${activated}`);
      // Wait for the event-driven CRDT update to reflect the newly activated app.
      for (let i = 0; i < 25; i++) {
        await new Promise(r => setTimeout(r, 200));
        const tree = await fetchTree();
        if (appWindowVisible(tree, { name: activated })) break;
      }
    }

    switch (command) {
      case "skill": {
        const skillTarget = args[1];
        if (!skillTarget || skillTarget === "list") {
          console.log(renderSkillList());
          break;
        }

        if (!findSkillTarget(skillTarget)) {
          console.error(renderSkill(skillTarget));
          process.exit(1);
        }

        console.log(renderSkill(skillTarget));
        break;
      }

      case "query": {
        // Extract --first N from args before joining into query string
        const qArgs = args.slice(1);
        let first = 100; // default
        let scanDuration: number | undefined;
        for (let i = 0; i < qArgs.length; i++) {
          if (qArgs[i] === "--first") {
            const n = Number(qArgs[i + 1]);
            if (isNaN(n) || n < 0) { console.error("--first requires a non-negative number (0 = unlimited)"); process.exit(1); }
            first = n;
            qArgs.splice(i, 2);
            i--;
          } else if (qArgs[i] === "--scan") {
            // --scan [durationMs] — optional numeric arg
            const next = qArgs[i + 1];
            if (next && /^\d+$/.test(next)) {
              scanDuration = Number(next);
              qArgs.splice(i, 2);
            } else {
              scanDuration = 500;
              qArgs.splice(i, 1);
            }
            i--;
          }
        }

        const queryStr = qArgs.join(" ");
        if (!queryStr) {
          failUsage("query");
        }
        const { tree, nodes: filtered, matchCount } = await fetchLiveQuery(queryStr, first);

        const queries = parseQuery(queryStr);
        console.log(renderQueryResult(filtered, queries));

        // Scan overlay if requested
        if (scanDuration !== undefined && filtered.length > 0) {
          const { rects, outlineRects } = collectRects(filtered);
          if (rects.length > 0 || outlineRects.length > 0) {
            await postScanOverlay(rects, scanDuration, outlineRects);
          }
        }

        // Warn if query returned no actual matches
        if (matchCount === 0) {
          const obscuredApps = collectObscuredApps(tree);
          for (const app of obscuredApps) {
            const name = app.appName || app.bundleId;
            const windowWord = app.obscuredCount === 1 ? "window" : "windows";
            console.error(`Note: ${name} has ${app.obscuredCount} obscured ${windowWord}. Use --app to bring it forward.`);
          }
        }
        break;
      }

      case "vat": {
        const vatArgs = args.slice(1);
        let outputMode: VatOutputMode | undefined;
        try {
          outputMode = extractVatOutputMode(vatArgs);
        } catch (error: unknown) {
          failUsage("vat", error instanceof Error ? error.message : String(error));
        }
        const vatCmd = vatArgs[0];
        const tty = resolveVatOutputTTY(outputMode, process.stdout.isTTY);

        switch (vatCmd) {
          case "mount": {
            try {
              const parsedMountArgs = parseVatMountArgs(vatArgs.slice(1));
              const mountArgs = parsedMountArgs.driver === "a11y" && parsedMountArgs.args.length === 1 && parsedMountArgs.args[0] === "-"
                ? resolveVatMountRequest(parsedMountArgs, await readStdinText("vat mount"))
                : parsedMountArgs;
              const result = await postVatMount(mountArgs);
              await writeStdoutText(`${formatVatMountOutput(result, tty)}\n`);
            } catch (error: unknown) {
              const mountError = formatVatMountError(error);
              if (mountError.kind === "runtime") {
                console.error(mountError.message);
                process.exit(1);
              }
              failUsage("vat mount", mountError.message);
            }
            break;
          }

          case "mounts": {
            if (vatArgs.length !== 1) {
              failUsage("vat mounts");
            }
            await writeStdoutText(`${formatVatMountsOutput(await fetchVatMounts(), tty)}\n`);
            break;
          }

          case "unmount": {
            let path: string;
            try {
              path = parseVatUnmountArgs(vatArgs.slice(1));
            } catch (error: unknown) {
              failUsage("vat unmount", error instanceof Error ? error.message : String(error));
            }
            try {
              await writeStdoutText(`${formatVatUnmountOutput(await deleteVatMount(path), tty)}\n`);
            } catch (error: unknown) {
              console.error(error instanceof Error ? error.message : String(error));
              process.exit(1);
            }
            break;
          }

          case "policy": {
            let policyArgs: VatPolicyCLIArgs;
            try {
              policyArgs = parseVatPolicyArgs(vatArgs.slice(1));
            } catch (error: unknown) {
              failUsage("vat policy", error instanceof Error ? error.message : String(error));
            }
            try {
              await writeStdoutText(`${formatVatPolicyOutput(await postVatPolicy(policyArgs.path, policyArgs.mountPolicy), tty)}\n`);
            } catch (error: unknown) {
              console.error(error instanceof Error ? error.message : String(error));
              process.exit(1);
            }
            break;
          }

          case "query": {
            let queryStr: string;
            try {
              queryStr = parseVatQueryArgs(vatArgs.slice(1));
            } catch (error: unknown) {
              failUsage("vat query", error instanceof Error ? error.message : String(error));
            }
            const { tree } = await fetchVatQuery(queryStr);
            const rendered = formatVatQueryOutput(tree as PlainNode, queryStr, tty);
            if (rendered.length > 0) {
              await writeStdoutText(`${rendered}\n`);
            }
            break;
          }

          case "watch": {
            let watchArgs: VatWatchCLIArgs;
            try {
              watchArgs = parseVatWatchArgs(vatArgs.slice(1));
            } catch (error: unknown) {
              failUsage("vat watch", error instanceof Error ? error.message : String(error));
            }
            try {
              await tailVatWatchStream(watchArgs, tty);
            } catch (error: unknown) {
              console.error(error instanceof Error ? error.message : String(error));
              process.exit(1);
            }
            break;
          }

          case undefined:
            failUsage("vat");

          default:
            console.error(`Unknown vat command: ${vatCmd}`);
            failUsage("vat");
        }
        break;
      }

      case "ca": {
        const drawCmd = args[1];
        switch (drawCmd) {
          case "script": {
            if (args[2] !== "-" || args.length !== 3) {
              failUsage(command);
            }
            const payload = normalizeDrawScriptText(await readStdinText(`${command} script -`));
            await attachDrawOverlay(payload);
            break;
          }
          case "highlight": {
            const highlightArgs = args.slice(2);
            const timeoutMs = parseGfxTimeout(highlightArgs, "ca highlight", DEFAULT_CA_HIGHLIGHT_TIMEOUT_MS);
            if (highlightArgs.length !== 1 || highlightArgs[0] !== "-") {
              failUsage("ca highlight");
            }
            const input = await readStdinText(`${command} highlight -`);
            const payload = buildAXHighlightDrawScriptFromText(
              input,
              timeoutMs,
            );
            await attachDrawOverlay(payload);
            emitPassthroughStdout(input, process.stdout.isTTY);
            break;
          }
          default:
            failUsage("ca");
        }
        break;
      }

      case "gfx": {
        const gfxCmd = args[1];
        const gfxArgs = args.slice(2);
        switch (gfxCmd) {
          case "outline": {
            const timeoutMs = parseGfxTimeout(gfxArgs, "gfx outline", DEFAULT_CA_HIGHLIGHT_TIMEOUT_MS);
            if (gfxArgs.length !== 1 || gfxArgs[0] !== "-") {
              failUsage("gfx outline");
            }
            const input = await readStdinText("gfx outline");
            await attachDrawOverlay(buildGfxOutlineDrawScriptFromText(input, timeoutMs));
            emitPassthroughStdout(input, process.stdout.isTTY);
            break;
          }
          case "xray": {
            const timeoutMs = parseGfxTimeout(gfxArgs, "gfx xray", DEFAULT_CA_HIGHLIGHT_TIMEOUT_MS);
            if (gfxArgs.length !== 1 || gfxArgs[0] !== "-") {
              failUsage("gfx xray");
            }
            const input = await readStdinText("gfx xray");
            await attachDrawOverlay(buildGfxXrayDrawScriptFromText(input, timeoutMs));
            emitPassthroughStdout(input, process.stdout.isTTY);
            break;
          }
          case "spotlight": {
            const timeoutMs = parseGfxTimeout(gfxArgs, "gfx spotlight", DEFAULT_CA_HIGHLIGHT_TIMEOUT_MS);
            if (gfxArgs.length !== 1 || gfxArgs[0] !== "-") {
              failUsage("gfx spotlight");
            }
            const input = await readStdinText("gfx spotlight");
            await attachDrawOverlay(buildGfxSpotlightDrawScriptFromText(input, timeoutMs));
            emitPassthroughStdout(input, process.stdout.isTTY);
            break;
          }
          case "arrow": {
            const timeoutMs = parseGfxTimeout(gfxArgs, "gfx arrow", DEFAULT_CA_HIGHLIGHT_TIMEOUT_MS);
            if (gfxArgs.length !== 1 || gfxArgs[0] !== "-") {
              failUsage("gfx arrow");
            }
            const input = await readStdinText("gfx arrow");
            await attachDrawOverlay(buildGfxArrowDrawScriptFromText(input, timeoutMs));
            emitPassthroughStdout(input, process.stdout.isTTY);
            break;
          }
          case "scan": {
            const timeoutMs = parseGfxTimeout(gfxArgs, "gfx scan", DEFAULT_GFX_SCAN_DURATION_MS);
            if (gfxArgs.length !== 1 || gfxArgs[0] !== "-") {
              failUsage("gfx scan");
            }
            const input = await readStdinText("gfx scan");
            await runGfxScanFromText(input, timeoutMs);
            emitPassthroughStdout(input, process.stdout.isTTY);
            break;
          }
          case "text": {
            const timeoutMs = parseGfxTimeout(gfxArgs, "gfx text", DEFAULT_CA_HIGHLIGHT_TIMEOUT_MS);
            const stdinIndex = gfxArgs.indexOf("-");
            if (stdinIndex < 0 || gfxArgs.length !== 2 || stdinIndex !== 1 || !gfxArgs[0]) {
              failUsage("gfx text");
            }
            const input = await readStdinText("gfx text");
            await runGfxTextFromText(input, gfxArgs[0]!, timeoutMs);
            emitPassthroughStdout(input, process.stdout.isTTY);
            break;
          }
          default:
            failUsage("gfx");
        }
        break;
      }

      case "print":
      case "p": {
        const pArgs = args.slice(1);
        if (pArgs.length < 2) {
          failUsage("print");
        }
        // Last arg starting with "." is the property
        const lastArg = pArgs[pArgs.length - 1];
        if (!lastArg.startsWith(".")) {
          failUsage("print", "Last argument must be a .property (e.g. .value)");
        }
        const property = lastArg.slice(1);
        const selectorTokens = pArgs.slice(0, -1);
        const selectors = selectorTokens.map(parseSelector);

        const tree = await fetchTree();
        const matches = matchChain(tree, selectors, property);

        if (matches.length === 0) {
          process.exit(1);
        }
        for (const m of matches) {
          console.error(m.path);
          console.log(m.value);
        }
        break;
      }

      case "window": {
        const windowArgs = args.slice(1);
        const subcommand = windowArgs[0];
        if (!subcommand) {
          failUsage("window");
        }

        if (subcommand === "focus") {
          const idArg = windowArgs[1];
          if (!idArg) {
            failUsage("window focus");
          }

          const cgWindowId = await readCGWindowIdArgOrStdin(idArg, "window focus");
          const result = await focusWindow(cgWindowId);
          if (!result.ok) {
            throw new Error(`Window focus failed: ${result.error || "unknown error"}`);
          }
          console.error(result.queued ? "queued" : "ok");
          break;
        }

        if (subcommand === "drag") {
          const idArg = windowArgs[1];
          const xArg = windowArgs[2];
          const yArg = windowArgs[3];
          if (!idArg || xArg === undefined || yArg === undefined) {
            failUsage("window drag");
          }

          const cgWindowId = await readCGWindowIdArgOrStdin(idArg, "window drag");
          const toX = Number(xArg);
          const toY = Number(yArg);
          if (!Number.isFinite(toX) || !Number.isFinite(toY)) {
            failUsage("window drag");
          }

          const result = await dragWindow(cgWindowId, toX, toY);
          if (!result.ok) {
            throw new Error(`Window drag failed: ${result.error || "unknown error"}`);
          }
          console.error(result.queued ? "queued" : "ok");
          break;
        }

        failUsage("window");
      }

      case "actor": {
        const actorArgs = args.slice(1);
        if (actorArgs.length === 0) {
          failUsage("actor");
        }

        if (actorArgs[0] === "spawn") {
          try {
            const request = parseActorSpawnCLIArgs(actorArgs.slice(1));
            console.log(JSON.stringify(await spawnActor(request.type, request.name, request.durationScale), null, 2));
          } catch (error) {
            if (error instanceof ActorApiError) {
              failUsage("actor spawn");
            }
            throw error;
          }
          break;
        }

        if (actorArgs[0] === "list") {
          if (actorArgs.length !== 1) {
            failUsage("actor list");
          }
          console.log(JSON.stringify(await listActors(), null, 2));
          break;
        }

        let name: string | undefined;
        let subcommand: string | undefined;
        let actionName: string | undefined;
        let actionArgs: string[] = [];

        if (actorArgs[0] === "kill") {
          subcommand = "kill";
          name = actorArgs[1];
          if (!name || actorArgs.length !== 2) {
            failUsage("actor kill");
          }
        } else if (actorArgs[0] === "run") {
          subcommand = "run";
          const target = actorArgs[1];
          if (!target) {
            failUsage("actor run");
          }
          const splitAt = target.lastIndexOf(".");
          if (splitAt <= 0 || splitAt === target.length - 1) {
            failActorRunUsage(target, "Expected <name>.<action>.");
          }
          name = target.slice(0, splitAt);
          actionName = target.slice(splitAt + 1);
          actionArgs = actorArgs.slice(2);
        } else {
          // Hidden compatibility shim: gui actor <name> run <action> ...
          // and gui actor <name> kill
          name = actorArgs[0];
          subcommand = actorArgs[1];
          if (!subcommand) {
            failUsage("actor");
          }
          if (subcommand === "kill") {
            if (actorArgs.length !== 2) {
              failUsage("actor kill");
            }
          } else if (subcommand === "run") {
            actionName = actorArgs[2];
            if (!actionName) {
              failUsage("actor run");
            }
            actionArgs = actorArgs.slice(3);
          }
        }

        if (subcommand === "kill") {
          console.log(JSON.stringify(await killActor(name), null, 2));
          break;
        }

        if (subcommand === "run") {
          if (!actionName) {
            failActorRunUsage(name);
          }
          try {
            if (actionName === "click" && actionArgs.includes("-")) {
              await runActorClickPassthrough(name, actionArgs);
              break;
            }
            if (actionName === "move" && actionArgs.includes("-")) {
              await runActorMovePassthrough(name, actionArgs);
              break;
            }
            const request = parseActorRunCLIArgs(actionName!, actionArgs);
            console.log(JSON.stringify(await runActor(name, request.action, request.timeoutMs), null, 2));
          } catch (error) {
            if (error instanceof ActorApiError) {
              const actionTopic = findHelpTopic(`actor run ${actionName}`) ? `actor run ${actionName}` : "actor run";
              failUsage(actionTopic);
            }
            throw error;
          }
          break;
        }

        failUsage("actor");
      }

      case "rec": {
        const recArgs = args.slice(1);
        const mode = recArgs[0];
        let parsed: ReturnType<typeof parseRecCLIArgs>;
        try {
          if ((mode === "image" || mode === "filmstrip") && recArgs[1] && !recArgs[1].startsWith("--")) {
            parsed = parseRecCLIArgs([
              mode,
              ...await normalizeRecPayloadCLIArgs(mode, recArgs[1], recArgs.slice(2)),
            ]);
          } else {
            parsed = parseRecCLIArgs(recArgs);
          }
        } catch (error) {
          if (error instanceof RecProtocolError) {
            failUsage(error.usageTopic || "rec", error.message);
          }
          if (error instanceof Error && (mode === "image" || mode === "filmstrip")) {
            failUsage(`rec ${mode}`, error.message);
          }
          throw error;
        }

        switch (parsed.mode) {
          case "image":
            await writeArtifactOutput(await postRecImage(parsed.request), parsed.outPath);
            break;
          case "filmstrip":
            await writeArtifactOutput(await postRecFilmstrip(parsed.request), parsed.outPath);
            break;
          default: {
            const _exhaustive: never = parsed;
            throw new Error(`Unsupported rec mode: ${String(_exhaustive)}`);
          }
        }
        break;
      }

      case "img": {
        const imgArgs = args.slice(1);
        // Parse --out flag
        let outPath: string | undefined;
        const outIdx = imgArgs.indexOf("--out");
        if (outIdx >= 0) {
          outPath = imgArgs[outIdx + 1];
          if (!outPath) { failUsage("img", "--out requires a file path"); }
          imgArgs.splice(outIdx, 2);
        }
        const imgQueryStr = imgArgs.join(" ");
        if (!imgQueryStr) { failUsage("img"); }

        // Use findMatchedNode to get the deepest matched node with all original
        // attributes preserved (filterTree strips frame coords for display output)
        const tree = await fetchTree();
        const queries = parseQuery(imgQueryStr);
        const target = findMatchedNode(tree, queries);
        if (!target) throw new Error(`Node not found: ${imgQueryStr}`);

        // If the node has frame coordinates (x, y, w, h), use direct frame-based cropping.
        // This works for Window nodes and any other node with geometry in the CRDT tree.
        const hasFrame = target.x != null && target.y != null && target.w != null && target.h != null;
        let png: Buffer;

        if (hasFrame) {
          png = await fetchFrameScreenshot(
            target.x as number, target.y as number,
            target.w as number, target.h as number,
          );
        } else {
          // Fall back to label-based AX lookup
          const rawId = (target._id || target.id) as string;
          if (!rawId) throw new Error(`Cannot screenshot '${imgQueryStr}': matched node has no frame coordinates (x,y,w,h) and no id`);

          // Extract label from ID (Tag:Label:Index → Label)
          const parts = rawId.split(":");
          let label = parts.length < 3 ? parts[1] || "" : parts.slice(1, -1).join(":");
          if (!label) {
            label = (target.label || target.title || target._displayName || target.value || "") as string;
          }
          if (!label) throw new Error(`Cannot screenshot '${imgQueryStr}': matched node has no frame coordinates and no label`);

          // Map CRDT type → AX role for more precise matching
          const typeToRole: Record<string, string> = {
            Button: "AXButton", TextField: "AXTextField", SearchField: "AXSearchField", Toggle: "AXCheckBox",
            ListItem: "AXRow", Tab: "AXTab", TreeItem: "AXRow",
            Row: "AXRow", Cell: "AXCell",
            MenuItem: "AXMenuItem", MenuBarItem: "AXMenuBarItem",
            Window: "AXWindow",
          };
          const role = typeToRole[target._tag] || undefined;

          png = await fetchElementScreenshot(label, role);
        }

        await writeArtifactOutput(png, outPath);
        break;
      }

      case "ax": {
        const axCmd = args[1];
        const axArgs = args.slice(2);

        /** Extract and remove --pid <n> from a mutable args array. */
        function extractPid(arr: string[]): number | undefined {
          const i = arr.indexOf("--pid");
          if (i < 0) return undefined;
          const val = Number(arr[i + 1]);
          if (!Number.isFinite(val) || val <= 0) { console.error("--pid requires a positive integer"); process.exit(1); }
          arr.splice(i, 2);
          return val;
        }

        /** Extract and remove --depth <n> from a mutable args array. */
        function extractDepth(arr: string[]): number | undefined {
          const i = arr.indexOf("--depth");
          if (i < 0) return undefined;
          const val = Number(arr[i + 1]);
          if (!Number.isFinite(val) || val < 0) { console.error("--depth requires a non-negative integer"); process.exit(1); }
          arr.splice(i, 2);
          return val;
        }

        switch (axCmd) {
          case "snapshot": {
            const pid = extractPid(axArgs);
            const depth = extractDepth(axArgs);
            const { tree } = await fetchRawAXTree(pid, depth);
            console.log(JSON.stringify(tree, null, 2));
            break;
          }

          case "tree": {
            const pid = extractPid(axArgs);
            const depth = extractDepth(axArgs);
            const { tree } = await fetchRawAXTree(pid, depth);
            console.log(formatAXNode(tree));
            break;
          }

          case "query": {
            const cardinality = extractAXQueryCardinality(axArgs);
            const explicitOutputMode = extractAXOutputMode(axArgs);
            const appFilter = extractAXQueryAppFilter(axArgs);
            const queryStr = axArgs.join(" ");
            if (!queryStr) {
              failUsage("ax query");
            }
            const outputMode = resolveAXQueryOutputMode(cardinality, explicitOutputMode);
            const explicitScope = hasExplicitAXQueryScope(axArgs);
            const stdinRefined = !process.stdin.isTTY && !explicitScope;
            let inputCursor: AXCursor | undefined;
            let inputTarget: AXTarget | undefined;
            let scope;
            let scopeInput: AXQueryScopeInput;
            try {
              if (stdinRefined) {
                resolveAXQueryAppFilterScope(undefined, appFilter, true);
                const scopePayload = parseAXScopePayload(await readStdinText("ax query"), "gui ax query");
                inputTarget = scopePayload.target;
                if (scopePayload.kind === "cursor") {
                  inputCursor = scopePayload.cursor;
                }
                scopeInput = { kind: "pid", pid: scopePayload.pid };
                scope = scopeInput;
              } else {
                const explicitScopeInput = explicitScope ? extractAXQueryScope(axArgs) : undefined;
                scopeInput = resolveAXQueryAppFilterScope(explicitScopeInput, appFilter, false)
                  ?? extractAXQueryScope(axArgs);
                scope = await resolveAXQueryScope(scopeInput);
              }
            } catch (error: unknown) {
              failUsage("ax query", error instanceof Error ? error.message : String(error));
            }
            const filteredScope = scopeInput.kind === "all" ? appFilter : "none";
            if (outputMode === "guiml") {
              if (inputTarget) {
                failUsage("ax query", "stdin-refined ax query currently supports JSON/NDJSON output only");
              }
              if (filteredScope !== "none") {
                console.log(await renderFilteredAXQueryGuiml(queryStr, cardinality, filteredScope));
              } else {
                console.log(await renderAXQueryGuimlForScope(scope, queryStr, cardinality));
              }
              break;
            }
            const matches = filteredScope !== "none"
              ? await fetchFilteredAXQueryMatches(queryStr, cardinality, filteredScope)
              : await fetchAXQueryMatches(queryStr, scope, cardinality, inputTarget);
            if (
              inputCursor &&
              matches.length === 1 &&
              matches[0].target &&
              sameAXTarget(matches[0].target, inputCursor.target)
            ) {
              console.log(JSON.stringify(inputCursor, null, process.stdout.isTTY ? 2 : 0));
              break;
            }
            await renderAXQueryMatches(
              matches,
              cardinality,
              outputMode,
              buildVatA11YQueryPlan(queryStr, cardinality, scopeInput, inputTarget),
            );
            break;
          }

          case "click": {
            if (axArgs.length !== 1) {
              failUsage("ax click", stdinOnlyAXActionMessage("click"));
            }
            try {
              const target = await readAXTargetArgOrStdin("click", axArgs[0], "ax click");
              await axClickTarget(target);
              console.error(`ok — clicked ${describeAXTarget(target)}`);
              break;
            } catch (error) {
              failUsage("ax click", error instanceof Error ? error.message : String(error));
            }
          }

          case "press": {
            if (axArgs.length !== 1) {
              failUsage("ax press", stdinOnlyAXActionMessage("press"));
            }
            try {
              const target = await readAXTargetArgOrStdin("press", axArgs[0], "ax press");
              await axPressTarget(target);
              console.error(`ok — pressed ${describeAXTarget(target)}`);
              break;
            } catch (error) {
              failUsage("ax press", error instanceof Error ? error.message : String(error));
            }
          }

          case "set": {
            if (axArgs.length !== 2) {
              failUsage("ax set", stdinOnlyAXActionMessage("set"));
            }
            const setValue = axArgs[0];
            if (setValue === undefined) {
              failUsage("ax set");
            }
            try {
              const target = await readAXTargetArgOrStdin("set", axArgs[1], "ax set");
              await axSetTarget(setValue, target);
              console.error(`ok — set ${describeAXTarget(target)} = "${setValue}"`);
              break;
            } catch (error) {
              failUsage("ax set", error instanceof Error ? error.message : String(error));
            }
          }

          case "hover": {
            if (axArgs.length !== 1) {
              failUsage("ax hover", stdinOnlyAXActionMessage("hover"));
            }
            try {
              const target = await readAXTargetArgOrStdin("hover", axArgs[0], "ax hover");
              await axHoverTarget(target);
              console.error(`ok — hovered ${describeAXTarget(target)}`);
              break;
            } catch (error) {
              failUsage("ax hover", error instanceof Error ? error.message : String(error));
            }
          }

          case "events": {
            // Parse --pid and --bundle filter flags
            const filter: AXEventFilter = {};
            for (let i = 0; i < axArgs.length; i++) {
              if (axArgs[i] === "--pid") {
                const n = Number(axArgs[i + 1]);
                if (!Number.isFinite(n) || n <= 0) { console.error("--pid requires a positive integer"); process.exit(1); }
                filter.pid = n;
                axArgs.splice(i, 2);
                i--;
              } else if (axArgs[i] === "--bundle") {
                const b = axArgs[i + 1];
                if (!b) { console.error("--bundle requires a bundleId string"); process.exit(1); }
                filter.bundle = b;
                axArgs.splice(i, 2);
                i--;
              }
            }

            const filtering = filter.pid !== undefined || filter.bundle !== undefined;
            const res = await openEventStream();
            if (!res.body) throw new Error("event stream missing response body");
            const reader = res.body.getReader();
            const decoder = new TextDecoder();

            if (!filtering) {
              while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                process.stdout.write(decoder.decode(value, { stream: true }));
              }
            } else {
              let buf = "";
              const flushLine = (line: string) => {
                if (!line.trim()) return;
                try {
                  const event = JSON.parse(line) as { pid?: number; bundleId?: string };
                  if (!axEventMatchesFilter(event, filter)) return;
                } catch {
                  // Non-JSON line — pass through
                }
                process.stdout.write(line + "\n");
              };
              while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                const lines = buf.split("\n");
                buf = lines.pop() ?? "";
                for (const line of lines) flushLine(line);
              }
              if (buf) flushLine(buf);
            }
            break;
          }

          case "bench-observers": {
            const jsonOutput = extractBooleanFlag(axArgs, "--json");
            const pid = extractPid(axArgs);
            const app = extractStringFlag(axArgs, "--app");
            const iterations = extractPositiveIntFlag(axArgs, "--iterations");
            const mode = extractAXObserverBenchmarkMode(axArgs);
            if (pid !== undefined && app !== undefined) {
              failUsage("ax bench-observers", "Choose at most one target selector: --pid or --app.");
            }
            if (axArgs.length !== 0) {
              failUsage("ax bench-observers");
            }
            try {
              const { benchmarkAXObserverNotifications, getNativeAX } = await import("../a11y/native-ax.js");
              let targetPid = pid;
              if (targetPid === undefined && app !== undefined) {
                const apps = getNativeAX().wsGetRunningApps().map((candidate) => ({
                  pid: candidate.pid,
                  bundleId: candidate.bundleId ?? "",
                  name: candidate.name ?? "",
                  regular: candidate.regular !== false,
                }));
                targetPid = resolveAXQueryApp(apps, app).pid;
              }
              if (targetPid === undefined) {
                targetPid = getNativeAX().axGetFrontmostPid();
              }
              if (!targetPid || targetPid <= 0) {
                throw new Error("No target PID available. Use --pid, --app, or ensure an app is frontmost.");
              }
              const result = benchmarkAXObserverNotifications({ pid: targetPid, iterations, mode });
              if (jsonOutput || !process.stdout.isTTY) {
                console.log(JSON.stringify(result, null, process.stdout.isTTY ? 2 : 0));
              } else {
                console.log(formatAXObserverBenchmark(result));
              }
              break;
            } catch (error) {
              failUsage("ax bench-observers", error instanceof Error ? error.message : String(error));
            }
          }

          case "at": {
            const atPid = extractPid(axArgs);
            const { x, y } = await parseCGPointArgs(axArgs, "ax at", ["--pid"]);
            const atResult = await fetchAXAt(x, y, atPid);
            console.log(JSON.stringify(atResult, null, 2));
            break;
          }

          case "actions": {
            if (axArgs.length !== 1) {
              failUsage("ax actions", stdinOnlyAXActionMessage("actions"));
            }
            try {
              const target = await readAXTargetArgOrStdin("actions", axArgs[0], "ax actions");
              const actionsList = await fetchAXActionsTarget(target);
              console.log(JSON.stringify(actionsList, null, 2));
              break;
            } catch (error) {
              failUsage("ax actions", error instanceof Error ? error.message : String(error));
            }
          }

          case "perform": {
            if (axArgs.length !== 2) {
              failUsage("ax perform", stdinOnlyAXActionMessage("perform"));
            }
            const performAction = axArgs[0];
            if (!performAction) { failUsage("ax perform"); }
            try {
              const target = await readAXTargetArgOrStdin("perform", axArgs[1], "ax perform");
              await axPerformTarget(performAction, target);
              console.error(`ok — performed ${performAction} on ${describeAXTarget(target)}`);
              break;
            } catch (error) {
              failUsage("ax perform", error instanceof Error ? error.message : String(error));
            }
          }

          case "type": {
            if (axArgs.length !== 2) {
              failUsage("ax type", stdinOnlyAXActionMessage("type"));
            }
            const [targetArg, typeValue] = axArgs;
            if (typeValue === undefined) { failUsage("ax type"); }
            try {
              if (targetArg === "-" && !process.stdin.isTTY) {
                const input = parseAXScopePayload(await readStdinText("ax type"), "gui ax type");
                if (input.kind === "cursor") {
                  await axTypeCursor(typeValue, input.cursor);
                } else {
                  await axTypeTarget(typeValue, input.target);
                }
                console.error(`ok — typed into ${describeAXTarget(input.target)}`);
                break;
              }
              const target = await readAXTargetArgOrStdin("type", targetArg, "ax type");
              await axTypeTarget(typeValue, target);
              console.error(`ok — typed into ${describeAXTarget(target)}`);
              break;
            } catch (error) {
              failUsage("ax type", error instanceof Error ? error.message : String(error));
            }
          }

          case "focus-window": {
            if (axArgs.length > 1) {
              failUsage("ax focus-window");
            }
            try {
              const input = await readAXScopePassthroughInput(axArgs[0], "ax focus-window");
              await axFocusWindowTarget(input.scope.target);
              console.error(`ok — focused containing window for ${describeAXTarget(input.scope.target)}`);
              emitPassthroughStdout(input.raw, process.stdout.isTTY);
              break;
            } catch (error) {
              failUsage("ax focus-window", error instanceof Error ? error.message : String(error));
            }
          }

          case "select": {
            if (axArgs.length > 1) {
              failUsage("ax select");
            }
            try {
              const input = await readAXCursorPassthroughInput(axArgs[0], "ax select");
              await axSelectCursor(input.cursor);
              console.error("ok — restored AX selection");
              emitPassthroughStdout(input.raw, process.stdout.isTTY);
              break;
            } catch (error) {
              failUsage("ax select", error instanceof Error ? error.message : String(error));
            }
          }

          case "cursor": {
            if (axArgs.length !== 0) {
              failUsage("ax cursor");
            }
            const cursor = await fetchAXCursor();
            console.log(JSON.stringify(cursor, null, process.stdout.isTTY ? 2 : 0));
            break;
          }

          case "focus": {
            if (axArgs.length !== 1) {
              failUsage("ax focus", stdinOnlyAXActionMessage("focus"));
            }
            try {
              const target = await readAXTargetArgOrStdin("focus", axArgs[0], "ax focus");
              await axFocusTarget(target);
              console.error(`ok — focused ${describeAXTarget(target)}`);
              break;
            } catch (error) {
              failUsage("ax focus", error instanceof Error ? error.message : String(error));
            }
          }

          case "menu-at": {
            const menuPid = extractPid(axArgs);
            const mxStr = axArgs[0];
            const myStr = axArgs[1];
            const mx = Number(mxStr);
            const my = Number(myStr);
            if (!mxStr || !myStr || !Number.isFinite(mx) || !Number.isFinite(my)) {
              failUsage("ax menu-at");
            }
            const menuResult = await fetchAXMenuAt(mx, my, menuPid);
            console.log(JSON.stringify(menuResult, null, 2));
            break;
          }

        default:
            console.error(`Unknown ax command: ${axCmd}`);
            failUsage("ax");
        }
        break;
      }

      case "cg": {
        const cgCmd = args[1];
        const cgArgs = args.slice(2);
        function extractLayer(arr: string[]): number | undefined {
          const i = arr.indexOf("--layer");
          if (i < 0) return undefined;
          const val = Number(arr[i + 1]);
          if (!Number.isFinite(val) || val < 0) { console.error("--layer requires a non-negative integer"); process.exit(1); }
          arr.splice(i, 2);
          return val;
        }
        switch (cgCmd) {
          case "windows": {
            const layer = extractLayer(cgArgs);
            const windows = await fetchFilteredCGWindows(layer);
            console.log(JSON.stringify(windows, null, 2));
            break;
          }

          case "window-at": {
            const layer = extractLayer(cgArgs);
            const { x, y } = await parseCGPointArgs(cgArgs, "cg window-at", ["--layer"]);
            const windows = await fetchFilteredCGWindows(layer);
            console.log(JSON.stringify(findCGWindowAt(windows, x, y), null, 2));
            break;
          }

          case "key": {
            if (cgArgs.length === 0) {
              failUsage("cg key");
            }
            const keyInput = cgArgs.join(" ");
            const MODIFIER_NAMES = new Set(["cmd", "command", "shift", "option", "alt", "control", "ctrl"]);

            if (keyInput.includes("+")) {
              const parts = keyInput.split("+").map(p => p.trim().toLowerCase());
              const modifiers: string[] = [];
              const keys: string[] = [];
              for (const part of parts) {
                if (MODIFIER_NAMES.has(part)) {
                  modifiers.push(part);
                } else {
                  keys.push(part);
                }
              }
              if (keys.length === 0) {
                console.error("No key specified in combo (only modifiers found)");
                process.exit(1);
              }
              await postKeyboardInput(keys, modifiers);
            } else {
              const KNOWN_KEYS = new Set([
                "return", "enter", "tab", "space", "delete", "backspace", "escape", "esc",
                "left", "right", "down", "up", "home", "end", "pageup", "pagedown", "forwarddelete",
                "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
              ]);
              const lower = keyInput.toLowerCase();
              if (KNOWN_KEYS.has(lower)) {
                await postKeyboardInput([lower]);
              } else if (keyInput.length === 1) {
                await postKeyboardInput([lower]);
              } else {
                await postKeyboardInput([], undefined, keyInput);
              }
            }
            console.error("ok");
            break;
          }

          case "type": {
            const typeQueryStr = cgArgs[0];
            const typeValue = cgArgs[1];
            if (!typeQueryStr || typeValue === undefined) {
              failUsage("cg type");
            }
            const { tree } = await fetchRawAXTree();
            const queries = parseQuery(typeQueryStr);
            const matches = matchTree(tree, queries, axNodeAccessor);
            if (matches.length === 0) {
              throw new Error(`No AX match for: ${typeQueryStr}`);
            }
            const target = matches[0].node;
            const label = target.title || target.label || target.description || "";
            await axType(typeValue, label || undefined, target.role || undefined);
            console.error(`ok — typed into ${target.role}${label ? ` "${label}"` : ""}`);
            break;
          }

          case "move": {
            const { x, y } = await parseCGPointArgs(cgArgs, "cg move");
            await postCgMove(x, y);
            console.error("ok");
            break;
          }

          case "click": {
            const { x, y } = await parseCGPointArgs(cgArgs, "cg click", ["--button"]);
            const button = parsePointerButtonFlag(cgArgs, "cg click");
            await postCgClick(x, y, button);
            console.error("ok");
            break;
          }

          case "doubleclick": {
            const { x, y } = await parseCGPointArgs(cgArgs, "cg doubleclick", ["--button"]);
            const button = parsePointerButtonFlag(cgArgs, "cg doubleclick");
            await postCgDoubleClick(x, y, button);
            console.error("ok");
            break;
          }

          case "drag": {
            const stdinText = cgArgs.includes("-") ? await readStdinText("cg drag") : "";
            const { from, to } = parseCGDragPoints(cgArgs, "cg drag", stdinText);
            const button = parsePointerButtonFlag(cgArgs, "cg drag");
            await postCgDrag(from.x, from.y, to.x, to.y, button);
            console.error("ok");
            break;
          }

          case "scroll": {
            const { x, y } = await parseCGPointArgs(cgArgs, "cg scroll", ["--dx", "--dy"]);
            const dxIdx = cgArgs.indexOf("--dx");
            const dyIdx = cgArgs.indexOf("--dy");
            if (dxIdx < 0 || dyIdx < 0) { failUsage("cg scroll", "--dx and --dy are required"); }
            const dx = Number(cgArgs[dxIdx + 1]);
            const dy = Number(cgArgs[dyIdx + 1]);
            if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
              failUsage("cg scroll", "--dx and --dy must be finite numbers");
            }
            await postCgScroll(x, y, dx, dy);
            console.error("ok");
            break;
          }

          case "keydown":
          case "keyup": {
            const keyStr = cgArgs[0];
            if (!keyStr) { failUsage(`cg ${cgCmd}`); }
            const modsIdx = cgArgs.indexOf("--mods");
            let mods: string[] | undefined;
            if (modsIdx >= 0) {
              const modsVal = cgArgs[modsIdx + 1];
              if (!modsVal) { console.error("--mods requires a comma-separated list, e.g. cmd,shift"); process.exit(1); }
              mods = modsVal.split(",").map(m => m.trim().toLowerCase()).filter(Boolean);
            }
            if (cgCmd === "keydown") {
              await postCgKeyDown(keyStr.toLowerCase(), mods);
            } else {
              await postCgKeyUp(keyStr.toLowerCase(), mods);
            }
            console.error("ok");
            break;
          }

          case "moddown":
          case "modup": {
            const modArgs = cgArgs.filter(a => !a.startsWith("-"));
            if (modArgs.length === 0) { failUsage(`cg ${cgCmd}`); }
            const normalizedMods = modArgs.map(m => m.toLowerCase());
            if (cgCmd === "moddown") {
              await postCgModDown(normalizedMods);
            } else {
              await postCgModUp(normalizedMods);
            }
            console.error("ok");
            break;
          }

          case "mousepos": {
            const pos = await fetchCgMousePos();
            const frontmost = await fetchRawWorkspaceFrontmost();
            if (!Number.isFinite(frontmost.pid) || frontmost.pid <= 0) {
              throw new Error("gui cg mousepos could not resolve a frontmost pid for the shared target payload");
            }
            console.log(JSON.stringify(axTargetFromPoint(frontmost.pid, pos)));
            break;
          }

          case "mousestate": {
            const state = await fetchCgMouseState();
            console.log(JSON.stringify(state));
            break;
          }

          default:
            console.error(`Unknown cg command: ${cgCmd}`);
            failUsage("cg");
        }
        break;
      }

      case "ws": {
        const wsCmd = args[1];
        switch (wsCmd) {
          case "apps": {
            const apps = await fetchRawWorkspaceApps();
            console.log(JSON.stringify(apps, null, 2));
            break;
          }

          case "frontmost": {
            const frontmost = await fetchRawWorkspaceFrontmost();
            console.log(JSON.stringify(frontmost, null, 2));
            break;
          }

          case "screen": {
            const screen = await fetchScreen();
            console.log(JSON.stringify(screen, null, 2));
            break;
          }

          default:
            console.error(`Unknown ws command: ${wsCmd}`);
            failUsage("ws");
        }
        break;
      }

      case "crdt": {
        const crdtSub = resolveCRDTSubcommandAlias(args[1]);
        switch (crdtSub) {
          case "query": {
            const tree = await fetchCRDTTree();
            const crdtArgs = args.slice(2);
            let crdtFirst = 100;
            for (let i = 0; i < crdtArgs.length; i++) {
              if (crdtArgs[i] === "--first") {
                const n = Number(crdtArgs[i + 1]);
                if (isNaN(n) || n < 0) { console.error("--first requires a non-negative number (0 = unlimited)"); process.exit(1); }
                crdtFirst = n;
                crdtArgs.splice(i, 2);
                i--;
              }
            }
            const queryStr = crdtArgs.join(" ");
            if (!queryStr) { failUsage("crdt query"); }
            const queries = parseQuery(queryStr);
            const { nodes: filteredAll } = filterTree(tree, queries);
            const filtered = bfsFirst(filteredAll, crdtFirst);
            const rendered = renderQueryResult(filtered, queries);
            if (rendered.length > 0) {
              console.log(rendered);
            }
            break;
          }
          case "leases": {
            const leases = await fetchLeases();
            console.log(JSON.stringify(leases, null, 2));
            break;
          }

          case undefined: {
            // No subcommand — dump full raw CRDT tree
            const tree = await fetchCRDTTree();
            console.log(toGUIML([tree]));
            break;
          }

          default:
            console.error(`Unknown crdt command: ${crdtSub}`);
            failUsage("crdt");
        }
        break;
      }

      case "pb": {
        const pbCmd = args[1];
        switch (pbCmd) {
          case "read": {
            const pbArgs = args.slice(2);
            let pbType: string | undefined;
            const typeIdx = pbArgs.indexOf("--type");
            if (typeIdx >= 0) {
              pbType = pbArgs[typeIdx + 1];
              if (!pbType) { failUsage("pb read", "--type requires a UTI type"); }
            }
            const result = await fetchPbRead(pbType);
            if (result.value === null) {
              console.error("(empty clipboard)");
              process.exit(1);
            }
            console.log(result.value);
            break;
          }
          case "write": {
            const text = args[2];
            if (text === undefined) { failUsage("pb write"); }
            await postPbWrite(text);
            console.error("ok");
            break;
          }
          case "types": {
            const types = await fetchPbTypes();
            console.log(JSON.stringify(types, null, 2));
            break;
          }
          case "clear": {
            await postPbClear();
            console.error("ok");
            break;
          }
          default:
            console.error(`Unknown pb command: ${pbCmd}`);
            failUsage("pb");
        }
        break;
      }

      case "display": {
        const displayCmd = args[1];
        switch (displayCmd) {
          case "list": {
            const displays = await fetchDisplayList();
            console.log(JSON.stringify(displays, null, 2));
            break;
          }
          case "main": {
            const main = await fetchDisplayMain();
            console.log(JSON.stringify(main, null, 2));
            break;
          }
          case undefined:
            failUsage("display");
          default: {
            // Treat as display ID
            const id = Number(displayCmd);
            if (isNaN(id)) {
              console.error(`Unknown display command: ${displayCmd}`);
              failUsage("display");
            }
            const display = await fetchDisplayById(id);
            console.log(JSON.stringify(display, null, 2));
            break;
          }
        }
        break;
      }

      case "defaults": {
        const defCmd = args[1];
        switch (defCmd) {
          case "read": {
            const domain = args[2];
            if (!domain) { failUsage("defaults read"); }
            const key = args[3];
            const value = await fetchDefaultsRead(domain, key);
            if (typeof value === "string") {
              console.log(value);
            } else {
              console.log(JSON.stringify(value, null, 2));
            }
            break;
          }
          case "write": {
            const domain = args[2];
            const key = args[3];
            const value = args[4];
            if (!domain || !key || value === undefined) {
              failUsage("defaults write");
            }
            // Check for type flag like -bool, -int, -float, -string
            let defType: string | undefined;
            const typeArg = args[5];
            if (typeArg && typeArg.startsWith("-")) {
              defType = typeArg.slice(1);
            }
            await postDefaultsWrite(domain, key, value, defType);
            console.error("ok");
            break;
          }
          case "domains": {
            const domains = await fetchDefaultsDomains();
            console.log(JSON.stringify(domains, null, 2));
            break;
          }
          default:
            console.error(`Unknown defaults command: ${defCmd}`);
            failUsage("defaults");
        }
        break;
      }

      case "log": {
        const logArgs = args.slice(1);
        let last = 20;
        let follow = true;

        for (let i = 0; i < logArgs.length; i++) {
          if (logArgs[i] === "--last") {
            const n = Number(logArgs[i + 1]);
            if (isNaN(n) || n < 0) {
              console.error("--last requires a non-negative number");
              process.exit(1);
            }
            last = n;
            follow = false;
            logArgs.splice(i, 2);
            i--;
            continue;
          }
        }

        if (logArgs.length > 0) {
          failUsage("log");
        }

        if (!follow) {
          const text = await fetchLogs(last);
          console.log(text);
          break;
        }

        await tailLogStream(openLogStream, process.stdout, process.stderr, last);
        break;
      }

      case undefined:
        console.log(renderRootHelp());
        break;
      default:
        console.error(`Unknown command: ${command}`);
        console.error(renderRootHelp());
        process.exit(1);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(msg);
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
