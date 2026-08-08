export const MAX_SKILL_TRIGGER_HINT_LENGTH = 96;

const CHINESE_TRIGGER_PATTERN = /触发\s*[:：]\s*([^。；;.!！？!?\r\n]+)/u;
const ENGLISH_TRIGGER_PATTERNS = [
  /\buse\s+when\b\s*[:：-]?\s*([^。；;.!！？!?\r\n]+)/iu,
  /\btriggers?\s+on\b\s*[:：-]?\s*([^。；;.!！？!?\r\n]+)/iu,
  /\btrigger\s*[:：]\s*([^。；;.!！？!?\r\n]+)/iu,
];

function normalizeHint(value: string): string | null {
  const normalized = value
    .replace(/\s+/gu, " ")
    .replace(/^[\s,，、:：—–-]+/u, "")
    .replace(/[\s,，、。；;！？!?]+$/u, "")
    .trim();

  if (!normalized) return null;

  const characters = Array.from(normalized);
  if (characters.length <= MAX_SKILL_TRIGGER_HINT_LENGTH) return normalized;
  return `${characters.slice(0, MAX_SKILL_TRIGGER_HINT_LENGTH - 1).join("")}…`;
}

/**
 * Extracts the short "when to use it" clause embedded in a skill description.
 * This intentionally stays rule-based so descriptions never need an AI pass.
 */
export function getSkillTriggerHint(description: string | null | undefined): string | null {
  if (typeof description !== "string" || !description.trim()) return null;

  const normalizedDescription = description.replace(/\s+/gu, " ").trim();
  const chineseMatch = normalizedDescription.match(CHINESE_TRIGGER_PATTERN);
  if (chineseMatch?.[1]) return normalizeHint(chineseMatch[1]);

  for (const pattern of ENGLISH_TRIGGER_PATTERNS) {
    const match = normalizedDescription.match(pattern);
    if (match?.[1]) return normalizeHint(match[1]);
  }

  return null;
}
