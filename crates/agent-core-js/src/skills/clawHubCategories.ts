import type { ClawHubSkillCard } from "./clawHub";

// 与 ClawHub 官网侧边栏一致的分区（https://clawhub.ai/skills）。ClawHub 的公开
// API（/api/v1/skills、/api/v1/search）不返回分类信息，也不支持按分类过滤——分类
// 只存在于其内部后端。因此本地按关键词对技能做启发式分类：命中多个分类是正常
// 的（官网同样如此），全部未命中归入 other。
export type ClawHubCategorySlug =
  | "integrations"
  | "automation"
  | "research"
  | "development"
  | "productivity"
  | "communication"
  | "creative"
  | "knowledge"
  | "agents"
  | "operations"
  | "security"
  | "finance"
  | "lifestyle"
  | "other";

export const CLAWHUB_CATEGORY_SLUGS: readonly ClawHubCategorySlug[] = [
  "integrations",
  "automation",
  "research",
  "development",
  "productivity",
  "communication",
  "creative",
  "knowledge",
  "agents",
  "operations",
  "security",
  "finance",
  "lifestyle",
  "other",
];

/** 每张卡片最多标注的分类数，避免徽章行过长。 */
const MAX_CATEGORIES_PER_SKILL = 3;

// 关键词均为小写；含空格的短语按子串匹配，单词按词边界匹配。topics 命中权重
// 高于名称/摘要（topics 是发布者自己标的，信号最强）。
const CATEGORY_KEYWORDS: Record<Exclude<ClawHubCategorySlug, "other">, string[]> = {
  integrations: [
    "api",
    "integration",
    "mcp",
    "webhook",
    "oauth",
    "notion",
    "github",
    "gitlab",
    "jira",
    "linear",
    "airtable",
    "supabase",
    "google workspace",
    "google drive",
    "spotify",
    "sonos",
    "home assistant",
    "zapier",
    "sdk",
    "connector",
    "plugin",
  ],
  automation: [
    "cron",
    "schedule",
    "scheduled",
    "automation",
    "automate",
    "automatic",
    "automatically",
    "workflow",
    "trigger",
    "recurring",
    "daily",
    "batch",
  ],
  research: [
    "search",
    "research",
    "web search",
    "arxiv",
    "paper",
    "papers",
    "literature",
    "scholar",
    "pubmed",
    "wikipedia",
    "news",
    "crawl",
    "scrape",
    "browse",
    "fetch",
  ],
  development: [
    "code",
    "coding",
    "developer",
    "programming",
    "debug",
    "refactor",
    "lint",
    "test",
    "testing",
    "git",
    "pull request",
    "npm",
    "python",
    "typescript",
    "rust",
    "compiler",
    "ide",
    "skill creator",
    "skills",
  ],
  productivity: [
    "todo",
    "task",
    "tasks",
    "note",
    "notes",
    "calendar",
    "reminder",
    "obsidian",
    "markdown",
    "pdf",
    "document",
    "docs",
    "sheet",
    "sheets",
    "spreadsheet",
    "excel",
    "gtd",
    "productivity",
    "plan",
    "planner",
  ],
  communication: [
    "email",
    "gmail",
    "mail",
    "inbox",
    "slack",
    "discord",
    "telegram",
    "whatsapp",
    "wechat",
    "sms",
    "phone",
    "call",
    "calls",
    "voice",
    "message",
    "messaging",
    "chat",
    "twitter",
    "social",
  ],
  creative: [
    "image",
    "images",
    "photo",
    "draw",
    "drawing",
    "design",
    "art",
    "music",
    "audio",
    "video",
    "writing",
    "write",
    "story",
    "creative",
    "svg",
    "diagram",
    "speech",
    "tts",
    "whisper",
    "midjourney",
    "diffusion",
  ],
  knowledge: [
    "memory",
    "memories",
    "knowledge",
    "learn",
    "learning",
    "wiki",
    "ontology",
    "graph",
    "rag",
    "embedding",
    "recall",
    "second brain",
    "zettelkasten",
  ],
  agents: [
    "agent",
    "agents",
    "subagent",
    "multi-agent",
    "autonomous",
    "self-improving",
    "self-improvement",
    "proactive",
    "persona",
    "assistant",
  ],
  operations: [
    "monitor",
    "monitoring",
    "server",
    "servers",
    "devops",
    "deploy",
    "deployment",
    "docker",
    "kubernetes",
    "ssh",
    "logs",
    "metrics",
    "uptime",
    "infrastructure",
    "backup",
    "sysadmin",
    "ops",
  ],
  security: [
    "security",
    "secure",
    "vulnerability",
    "pentest",
    "audit",
    "privacy",
    "password",
    "passwords",
    "encrypt",
    "encryption",
    "vetting",
    "vet",
    "permission",
    "permissions",
    "secrets",
    "2fa",
    "credential",
  ],
  finance: [
    "finance",
    "financial",
    "stock",
    "stocks",
    "crypto",
    "bitcoin",
    "trading",
    "budget",
    "expense",
    "expenses",
    "invoice",
    "payment",
    "bank",
    "banking",
    "money",
    "portfolio",
    "accounting",
  ],
  lifestyle: [
    "health",
    "fitness",
    "recipe",
    "recipes",
    "cooking",
    "weather",
    "travel",
    "smart home",
    "smart-home",
    "speaker",
    "speakers",
    "hue",
    "sleep",
    "habit",
    "habits",
    "shopping",
    "sport",
    "workout",
    "meditation",
  ],
};

type CompiledKeyword = {
  phrase: string | null;
  word: RegExp | null;
};

function compileKeyword(keyword: string): CompiledKeyword {
  if (keyword.includes(" ") || keyword.includes("-")) {
    return { phrase: keyword, word: null };
  }
  return { phrase: null, word: new RegExp(`\\b${keyword}\\b`, "i") };
}

const COMPILED_KEYWORDS = Object.entries(CATEGORY_KEYWORDS).map(([slug, keywords]) => ({
  slug: slug as Exclude<ClawHubCategorySlug, "other">,
  keywords: keywords.map(compileKeyword),
}));

function matches(compiled: CompiledKeyword, haystack: string): boolean {
  if (compiled.phrase) return haystack.includes(compiled.phrase);
  return compiled.word ? compiled.word.test(haystack) : false;
}

const TOPIC_WEIGHT = 3;
const TEXT_WEIGHT = 1;

/**
 * 对单个技能做启发式分类：返回按匹配强度排序的 1~3 个分类，无命中时为
 * ["other"]。topics 命中的权重高于名称/摘要命中。
 */
export function classifyClawHubSkill(
  skill: Pick<ClawHubSkillCard, "slug" | "displayName" | "summary" | "topics">,
): ClawHubCategorySlug[] {
  const topicsText = skill.topics.join(" ").toLowerCase();
  const bodyText = `${skill.slug} ${skill.displayName} ${skill.summary}`.toLowerCase();

  const scored: Array<{ slug: ClawHubCategorySlug; score: number }> = [];
  for (const { slug, keywords } of COMPILED_KEYWORDS) {
    let score = 0;
    for (const keyword of keywords) {
      if (topicsText && matches(keyword, topicsText)) score += TOPIC_WEIGHT;
      if (matches(keyword, bodyText)) score += TEXT_WEIGHT;
    }
    if (score > 0) scored.push({ slug, score });
  }

  if (scored.length === 0) return ["other"];
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_CATEGORIES_PER_SKILL).map((item) => item.slug);
}
