import { type CSSProperties, useEffect, useState } from "react";

import iconSimpleUrl from "../../../../src-tauri/icons/icon-simple.png";
import {
  BookOpen,
  Edit3,
  FolderTree,
  GitBranch,
  LayoutGrid,
  Lightbulb,
  ListChecks,
  Palette,
  Settings,
  Wrench,
} from "../../../components/icons";
import { useLocale } from "../../../i18n";
import {
  getWorkModeDefinition,
  type WorkModeDefinition,
  type WorkModeSuggestionIconId,
} from "../../../lib/settings";
import { cn } from "../../../lib/shared/utils";
import type { SectionId } from "../../settings/types";

type GreetingPeriod = "morning" | "noon" | "afternoon" | "evening" | "night";

const GREETING_KEYS: Record<GreetingPeriod, string> = {
  morning: "chat.greetingMorning",
  noon: "chat.greetingNoon",
  afternoon: "chat.greetingAfternoon",
  evening: "chat.greetingEvening",
  night: "chat.greetingNight",
};

function resolveGreetingPeriod(hour: number): GreetingPeriod {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 14) return "noon";
  if (hour >= 14 && hour < 18) return "afternoon";
  if (hour >= 18 && hour < 23) return "evening";
  return "night";
}

function useGreetingPeriod() {
  const [period, setPeriod] = useState<GreetingPeriod>(() =>
    resolveGreetingPeriod(new Date().getHours()),
  );

  useEffect(() => {
    const timer = window.setInterval(() => {
      setPeriod(resolveGreetingPeriod(new Date().getHours()));
    }, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  return period;
}

// 工作模式建议卡片图标 id → 图标组件（模式定义位于镜像的 workModes.ts，
// 不能直接携带各端的组件引用）。
const SUGGESTION_ICONS: Record<WorkModeSuggestionIconId, typeof FolderTree> = {
  folderTree: FolderTree,
  wrench: Wrench,
  lightbulb: Lightbulb,
  listChecks: ListChecks,
  penLine: Edit3,
  bookOpen: BookOpen,
  layoutGrid: LayoutGrid,
  gitBranch: GitBranch,
  palette: Palette,
};

export type ChatEmptyStateProps = {
  variant: "no-models" | "start-chat";
  onOpenSettings?: (section?: SectionId) => void;
  onSuggestionSelect?: (text: string) => void;
  /** Locks the suggestion cards while a picked prompt is still typing in. */
  suggestionsDisabled?: boolean;
  /** 当前工作模式：驱动问候语、建议卡片与光晕色；缺省为编程模式。 */
  workMode?: WorkModeDefinition;
};

export function ChatEmptyState({
  variant,
  onOpenSettings,
  onSuggestionSelect,
  suggestionsDisabled = false,
  workMode,
}: ChatEmptyStateProps) {
  const { t } = useLocale();
  const period = useGreetingPeriod();
  const mode = workMode ?? getWorkModeDefinition("coding");

  return (
    <div className="relative flex w-full flex-col items-center">
      <div className="chat-hero-logo-enter relative mb-5 flex h-14 w-14 items-center justify-center">
        {/* Idle float lives on an inner wrapper so its transform never fights
            the entrance animation on the outer node. */}
        <div className="chat-hero-logo-float relative flex h-full w-full items-center justify-center">
          <div
            aria-hidden="true"
            className={cn(
              "chat-hero-halo-breathe absolute inset-1 rounded-full blur-xl",
              mode.haloClassName,
            )}
          />
          <img
            src={iconSimpleUrl}
            alt=""
            aria-hidden="true"
            draggable={false}
            className="relative h-12 w-12 select-none object-contain"
          />
        </div>
      </div>

      {variant === "no-models" ? (
        <>
          <div className="chat-hero-title-enter mb-1.5 text-center text-[calc(22px*var(--zone-font-scale,1))] font-semibold leading-7 tracking-tight text-foreground">
            {t("chat.welcome")}
          </div>
          <div className="chat-hero-line-enter mb-0.5 text-center text-sm leading-5 text-muted-foreground">
            {t("chat.noModelSelected")}
          </div>
          <div className="chat-hero-line-enter text-center text-sm leading-5 text-muted-foreground">
            {t("chat.configureModel")}
          </div>
          {onOpenSettings ? (
            <button
              type="button"
              onClick={() => onOpenSettings("providers")}
              className="chat-hero-cta-enter mt-5 inline-flex h-8 items-center gap-2 rounded-lg bg-foreground/[0.05] px-3 text-sm font-normal text-foreground/85 transition-colors hover:bg-foreground/[0.08] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <Settings className="h-4 w-4 text-foreground/65" />
              {t("chat.goToSettings")}
            </button>
          ) : null}
        </>
      ) : (
        <>
          <div className="chat-hero-title-enter whitespace-nowrap text-center text-[calc(20px*var(--zone-font-scale,1))] font-semibold leading-7 tracking-tight text-foreground">
            {t(GREETING_KEYS[period])}，{t(mode.greetingSubtitleKey)}
          </div>
          {onSuggestionSelect ? (
            // Keyed per mode so the card entrance replays on mode switches.
            <div
              key={mode.id}
              className="mt-7 grid w-full max-w-[520px] grid-cols-1 gap-2 px-6 sm:grid-cols-3 sm:px-4"
            >
              {mode.suggestions.map((card, index) => {
                const Icon = SUGGESTION_ICONS[card.icon];
                return (
                  <button
                    key={card.key}
                    type="button"
                    disabled={suggestionsDisabled}
                    onClick={() => onSuggestionSelect(t(card.promptKey))}
                    style={{ "--chat-hero-delay": `${0.26 + index * 0.08}s` } as CSSProperties}
                    className="chat-hero-card-enter flex h-11 items-center gap-2 rounded-lg bg-foreground/[0.025] px-2.5 text-left text-foreground/85 transition-colors hover:bg-foreground/[0.055] hover:text-foreground focus-visible:bg-foreground/[0.055] focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
                  >
                    <span
                      className={`flex h-7 w-7 shrink-0 items-center justify-center ${card.chipClassName}`}
                    >
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 truncate text-[calc(14px*var(--zone-font-scale,1))] font-medium leading-5 text-foreground/90">
                      {t(card.titleKey)}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
