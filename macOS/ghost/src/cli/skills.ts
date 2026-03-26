import { findHelpTopic } from "./help.js";

export type SkillTarget = "claude" | "codex";

const SKILL_TARGETS: SkillTarget[] = ["claude", "codex"];

function usageLine(topicName: string, index = 0): string {
  return findHelpTopic(topicName)?.usage[index] ?? topicName;
}

function exampleLine(topicName: string, index = 0): string {
  return findHelpTopic(topicName)?.examples[index] ?? topicName;
}

export function listSkillTargets(): SkillTarget[] {
  return [...SKILL_TARGETS];
}

export function findSkillTarget(target: string): SkillTarget | undefined {
  const normalized = target.trim().toLowerCase();
  if (normalized === "claude" || normalized === "codex") {
    return normalized;
  }
  return undefined;
}

export function renderSkillList(): string {
  return [
    "gui skill list",
    "",
    "Targets:",
    "  claude   Print the GhostUI operating skill for Claude",
    "  codex    Print the GhostUI operating skill for Codex",
    "",
    "Use `gui help skills` for the human docs.",
  ].join("\n");
}

function renderSkillBody(target: SkillTarget): string {
  const label = target === "claude" ? "Claude" : "Codex";

  return [
    `# GhostUI skill: ${label}`,
    "",
    "## Mission",
    `Operate GhostUI through the \`gui\` CLI. This version is framed for ${label}, but the operational rules are the same: inspect live state first, act with the narrowest command that works, and verify with another targeted command instead of guessing.`,
    "",
    "## Fast path",
    `- Start with \`${exampleLine("crdt query")}\` when you need the daemon-owned document.`,
    `- Use \`${usageLine("query")}\` for a quick live tree query.`,
    `- Use \`${usageLine("ax tree")}\` or \`${usageLine("ax query")}\` when raw frontmost AX is the real source of truth.`,
    `- Use \`${usageLine("cg key")}\` or \`${usageLine("cg type")}\` when you need synthetic keyboard input.`,
    "",
    "## Command map",
    `- Live GUI state: \`${usageLine("query")}\`, \`${usageLine("crdt query")}\``,
    `- Raw AX inspection and action: \`${usageLine("ax tree")}\`, \`${usageLine("ax query")}\`, \`${usageLine("ax click")}\`, \`${usageLine("ax set")}\`, \`${usageLine("ax hover")}\``,
    `- Input and raw windowing: \`${usageLine("cg key")}\`, \`${usageLine("cg type")}\`, \`${usageLine("window focus")}\`, \`${usageLine("window drag")}\`, \`${usageLine("cg windows")}\``,
    `- System state: \`${usageLine("pb read")}\`, \`${usageLine("display list")}\`, \`${usageLine("defaults read")}\`, \`${usageLine("log")}\``,
    "",
    "## Operating rules",
    "- Prefer `gui query` or `gui crdt query` over raw AX unless you specifically need raw AX roles, values, or actions.",
    "- Prefer the smallest query that proves the state you need. Do not dump the entire tree unless the narrow query failed.",
    "- Keep stdout for machine-readable payloads and treat stderr as status or path guidance.",
    "- If the target app is not frontmost, use `--app <name|bundleId>` or confirm with `gui ws frontmost` before acting.",
    "",
    "## Verification",
    `- After an action, re-run a narrow query like \`${exampleLine("query")}\` or \`${exampleLine("ax query")}\` to confirm the new state.`,
    `- For system changes, confirm with the matching read command, for example \`${usageLine("pb read")}\` or \`${usageLine("defaults read")}\`.`,
    `- If behavior is still weird, inspect \`${usageLine("log", 1)}\` and the relevant tree command before trying another blind action.`,
    "",
    "## Failure modes",
    "- Missing Accessibility permission breaks AX and input commands.",
    "- Missing Screen Recording permission breaks screenshot flows and some display-dependent inspection.",
    "- Frontmost-app confusion is common; AX commands only search the frontmost app.",
    "- Context menus are not part of the normal AX window tree. If you are chasing one, raw AX alone may lie to you.",
    "",
    "## See also",
    "- `gui help query-language`",
    "- `gui help output`",
    "- `gui help skills`",
  ].join("\n");
}

export function renderSkill(target: string): string {
  const resolved = findSkillTarget(target);
  if (!resolved) {
    return [
      `Unknown skill target: ${target}`,
      "",
      renderSkillList(),
    ].join("\n");
  }
  return renderSkillBody(resolved);
}
