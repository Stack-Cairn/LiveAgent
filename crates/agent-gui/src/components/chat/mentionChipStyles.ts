export type MentionChipVariant =
  | "file"
  | "dir"
  | "skill"
  | "commit"
  | "gitFile"
  | "codeRef"
  | "pastedText";

type MentionChipClassOptions = {
  interactive?: boolean;
  selectable?: boolean;
};

const BASE_CHIP_CLASS =
  "mention-chip mx-0.5 inline-flex items-baseline gap-1 rounded px-1.5 align-baseline whitespace-nowrap";

const VARIANT_CLASS: Record<MentionChipVariant, string> = {
  file: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  dir: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  skill: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  commit: "bg-cyan-500/15 text-cyan-800 dark:text-cyan-200",
  gitFile: "bg-sky-500/15 text-sky-800 dark:text-sky-200",
  codeRef: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300",
  pastedText: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
};

const INTERACTIVE_HOVER_CLASS: Partial<Record<MentionChipVariant, string>> = {
  commit: "hover:bg-cyan-500/20",
  gitFile: "hover:bg-sky-500/20",
  codeRef: "hover:bg-indigo-500/20",
};

export function mentionChipClassName(
  variant: MentionChipVariant,
  options: MentionChipClassOptions = {},
) {
  return [
    BASE_CHIP_CLASS,
    VARIANT_CLASS[variant],
    options.interactive ? "cursor-pointer" : "cursor-default",
    options.interactive ? INTERACTIVE_HOVER_CLASS[variant] : "",
    options.selectable === false ? "select-none" : "",
  ]
    .filter(Boolean)
    .join(" ");
}
