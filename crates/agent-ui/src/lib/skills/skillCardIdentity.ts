export const INSTALLED_SKILL_ICON_COLOR_COUNT = 9;

export type InstalledSkillCardIconName =
  | "bookOpen"
  | "bot"
  | "brain"
  | "cable"
  | "circleHelp"
  | "cloud"
  | "cpu"
  | "fileText"
  | "folder"
  | "gitBranch"
  | "globe"
  | "imageIcon"
  | "key"
  | "layoutGrid"
  | "lightbulb"
  | "link2"
  | "listChecks"
  | "lock"
  | "messageSquare"
  | "plug"
  | "radio"
  | "refreshCw"
  | "scanText"
  | "scrollText"
  | "search"
  | "send"
  | "server"
  | "settings"
  | "shield"
  | "sparkles"
  | "terminal"
  | "timer"
  | "waypoints"
  | "wifi"
  | "wrench"
  | "zap";

const FALLBACK_ICON_CANDIDATES: readonly InstalledSkillCardIconName[] = [
  "layoutGrid",
  "circleHelp",
  "folder",
  "fileText",
];

const CATEGORY_ICON_CANDIDATES: Record<string, readonly InstalledSkillCardIconName[]> = {
  integrations: ["plug", "cable", "link2", "wifi"],
  automation: ["zap", "refreshCw", "timer", "waypoints"],
  research: ["globe", "search", "scanText", "lightbulb"],
  development: ["wrench", "terminal", "gitBranch", "fileText"],
  productivity: ["listChecks", "layoutGrid", "folder", "timer"],
  communication: ["messageSquare", "send", "radio", "link2"],
  creative: ["sparkles", "imageIcon", "lightbulb", "fileText"],
  knowledge: ["bookOpen", "scrollText", "brain", "scanText"],
  agents: ["brain", "bot", "cpu", "waypoints"],
  operations: ["server", "settings", "cloud", "refreshCw"],
  security: ["shield", "key", "lock", "cpu"],
  finance: ["fileText", "timer", "key", "layoutGrid"],
  lifestyle: ["cloud", "imageIcon", "sparkles", "bookOpen"],
  other: FALLBACK_ICON_CANDIDATES,
};

function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function getInstalledSkillCardIdentity(skillName: string, primaryCategory: string) {
  const candidates = CATEGORY_ICON_CANDIDATES[primaryCategory] ?? FALLBACK_ICON_CANDIDATES;
  return {
    colorIndex: stableHash(`${skillName}:color`) % INSTALLED_SKILL_ICON_COLOR_COUNT,
    iconName: candidates[stableHash(`${skillName}:icon`) % candidates.length],
  };
}
