import { cn } from "@liveagent/ui/lib/shared/utils";

/** 已安装卡与商店卡共用的卡面：排布、圆角、表面、悬停。 */
export const SKILL_CARD_SHELL_CLASS = cn(
  "group relative flex min-w-0 w-full items-start gap-3 rounded-xl",
  "bg-settings-tile px-3.5 py-2.5 text-left transition-colors",
  "hover:bg-settings-tile-hover",
);

/** 已安装与商店两个列表共用的单列网格。 */
export const SKILL_LIST_GRID_CLASS = "grid gap-1.5";
