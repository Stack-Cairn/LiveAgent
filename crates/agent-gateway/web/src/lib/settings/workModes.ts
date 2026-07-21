// ??????? / ?? / ???????????????????
// ??????? + ????GUI/WebUI ??????? scripts/mirror-manifest.json??
// ??? import???? settings/index.ts ???????????? i18n key?

export type WorkModeId = "coding" | "writing" | "design";

export const WORK_MODE_IDS: readonly WorkModeId[] = ["coding", "writing", "design"];

/** ???????? id???? ChatEmptyState ??????????? */
export type WorkModeSuggestionIconId =
  | "folderTree"
  | "wrench"
  | "lightbulb"
  | "listChecks"
  | "penLine"
  | "bookOpen"
  | "layoutGrid"
  | "gitBranch"
  | "palette";

export type WorkModeSuggestion = {
  key: string;
  icon: WorkModeSuggestionIconId;
  chipClassName: string;
  titleKey: string;
  promptKey: string;
};

export type WorkModeDefinition = {
  id: WorkModeId;
  labelKey: string;
  /** ??????????????????? */
  descriptionKey: string;
  /** ?????????????bg-*?? */
  accentClassName: string;
  /** ?? logo ???? */
  haloClassName: string;
  /**
   * ????????????????????????????????
   * ???????????????????????
   */
  prompt: string;
  /** ????????????????????????????? */
  excludedToolNames: readonly string[];
  /** ???????undefined ?????? inputHint ????????? */
  composerHintKey?: string;
  greetingSubtitleKey: string;
  suggestions: readonly WorkModeSuggestion[];
};

const CODING_MODE: WorkModeDefinition = {
  id: "coding",
  labelKey: "sidebar.workMode.coding",
  descriptionKey: "sidebar.workModeDesc.coding",
  accentClassName: "bg-sky-500",
  haloClassName: "bg-sky-500/10 dark:bg-sky-400/10",
  prompt: "",
  excludedToolNames: [],
  greetingSubtitleKey: "chat.greetingSubtitle",
  suggestions: [
    {
      key: "explore",
      icon: "folderTree",
      chipClassName: "text-sky-600 dark:text-sky-400",
      titleKey: "chat.suggestExploreTitle",
      promptKey: "chat.suggestExplorePrompt",
    },
    {
      key: "fix",
      icon: "wrench",
      chipClassName: "text-amber-600 dark:text-amber-400",
      titleKey: "chat.suggestFixTitle",
      promptKey: "chat.suggestFixPrompt",
    },
    {
      key: "ideate",
      icon: "lightbulb",
      chipClassName: "text-emerald-600 dark:text-emerald-400",
      titleKey: "chat.suggestIdeateTitle",
      promptKey: "chat.suggestIdeatePrompt",
    },
  ],
};

const WRITING_MODE: WorkModeDefinition = {
  id: "writing",
  labelKey: "sidebar.workMode.writing",
  descriptionKey: "sidebar.workModeDesc.writing",
  accentClassName: "bg-amber-500",
  haloClassName: "bg-amber-500/10 dark:bg-amber-400/10",
  prompt: [
    '<work-mode name="writing">',
    "You are in Writing mode: the user is working on prose (articles, docs, stories, posts), not code.",
    "- Match the language of the user's draft or request; default to the language the user writes in.",
    "- Workflow for longer pieces: clarify goal and audience, then outline, then draft, then revise. Skip steps the user has already provided.",
    "- When revising, preserve the author's voice; briefly note significant edits instead of silently rewriting.",
    "- Never fabricate quotes, statistics, or citations; clearly mark uncertain facts.",
    "- Work through file reads and edits; terminal tools are disabled in this mode.",
    "</work-mode>",
  ].join("\n"),
  // ??????????????????????????
  // ???????? system prompt ?????????
  excludedToolNames: ["Bash", "ManagedProcess", "ReadTerminal"],
  composerHintKey: "chat.workModeHint.writing",
  greetingSubtitleKey: "chat.workModeGreeting.writing",
  suggestions: [
    {
      key: "outline",
      icon: "listChecks",
      chipClassName: "text-sky-600 dark:text-sky-400",
      titleKey: "chat.suggestOutlineTitle",
      promptKey: "chat.suggestOutlinePrompt",
    },
    {
      key: "polish",
      icon: "penLine",
      chipClassName: "text-amber-600 dark:text-amber-400",
      titleKey: "chat.suggestPolishTitle",
      promptKey: "chat.suggestPolishPrompt",
    },
    {
      key: "continue",
      icon: "bookOpen",
      chipClassName: "text-emerald-600 dark:text-emerald-400",
      titleKey: "chat.suggestContinueTitle",
      promptKey: "chat.suggestContinuePrompt",
    },
  ],
};

const DESIGN_MODE: WorkModeDefinition = {
  id: "design",
  labelKey: "sidebar.workMode.design",
  descriptionKey: "sidebar.workModeDesc.design",
  accentClassName: "bg-fuchsia-500",
  haloClassName: "bg-fuchsia-500/10 dark:bg-fuchsia-400/10",
  prompt: [
    '<work-mode name="design">',
    "You are in Design mode: the user is exploring UI/UX, diagrams, or visual assets.",
    "- When the goal, target platform, style constraints, or brand tokens are missing, ask for them before producing final work.",
    "- Prefer concrete deliverables: Mermaid diagrams for flows, self-contained HTML/SVG prototypes for UI, palette tables with hex values for color work.",
    "- When producing UI code, favor a single self-contained file that is easy to preview.",
    "- Iterate in small visible steps and summarize the visual changes after each edit.",
    "</work-mode>",
  ].join("\n"),
  excludedToolNames: [],
  composerHintKey: "chat.workModeHint.design",
  greetingSubtitleKey: "chat.workModeGreeting.design",
  suggestions: [
    {
      key: "prototype",
      icon: "layoutGrid",
      chipClassName: "text-sky-600 dark:text-sky-400",
      titleKey: "chat.suggestPrototypeTitle",
      promptKey: "chat.suggestPrototypePrompt",
    },
    {
      key: "diagram",
      icon: "gitBranch",
      chipClassName: "text-violet-600 dark:text-violet-400",
      titleKey: "chat.suggestDiagramTitle",
      promptKey: "chat.suggestDiagramPrompt",
    },
    {
      key: "palette",
      icon: "palette",
      chipClassName: "text-rose-600 dark:text-rose-400",
      titleKey: "chat.suggestPaletteTitle",
      promptKey: "chat.suggestPalettePrompt",
    },
  ],
};

export const WORK_MODES: readonly WorkModeDefinition[] = [CODING_MODE, WRITING_MODE, DESIGN_MODE];

export const DEFAULT_WORK_MODE_ID: WorkModeId = "coding";

const WORK_MODES_BY_ID = new Map<WorkModeId, WorkModeDefinition>(
  WORK_MODES.map((mode) => [mode.id, mode]),
);

export function normalizeWorkModeId(input: unknown): WorkModeId {
  return typeof input === "string" && WORK_MODES_BY_ID.has(input as WorkModeId)
    ? (input as WorkModeId)
    : DEFAULT_WORK_MODE_ID;
}

export function getWorkModeDefinition(id: WorkModeId): WorkModeDefinition {
  return WORK_MODES_BY_ID.get(id) ?? CODING_MODE;
}
