import { type CSSProperties, useEffect, useState } from "react";

import iconSimpleUrl from "../../../../src-tauri/icons/icon-simple.png";
import { FolderTree, Lightbulb, Settings, Wrench } from "../../../components/icons";
import { useLocale } from "../../../i18n";
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

const SUGGESTION_CARDS = [
  {
    key: "explore",
    icon: FolderTree,
    chipClassName: "text-sky-600 dark:text-sky-400",
    titleKey: "chat.suggestExploreTitle",
    promptKey: "chat.suggestExplorePrompt",
  },
  {
    key: "fix",
    icon: Wrench,
    chipClassName: "text-amber-600 dark:text-amber-400",
    titleKey: "chat.suggestFixTitle",
    promptKey: "chat.suggestFixPrompt",
  },
  {
    key: "ideate",
    icon: Lightbulb,
    chipClassName: "text-emerald-600 dark:text-emerald-400",
    titleKey: "chat.suggestIdeateTitle",
    promptKey: "chat.suggestIdeatePrompt",
  },
] as const;

export type ChatEmptyStateProps = {
  variant: "no-models" | "start-chat";
  onOpenSettings?: (section?: SectionId) => void;
  onSuggestionSelect?: (text: string) => void;
  /** Locks the suggestion cards while a picked prompt is still typing in. */
  suggestionsDisabled?: boolean;
};

export function ChatEmptyState({
  variant,
  onOpenSettings,
  onSuggestionSelect,
  suggestionsDisabled = false,
}: ChatEmptyStateProps) {
  const { t } = useLocale();
  const period = useGreetingPeriod();

  return (
    <div className="relative flex w-full flex-col items-center">
      <div className="chat-hero-logo-enter relative mb-5 flex h-14 w-14 items-center justify-center">
        {/* Idle float lives on an inner wrapper so its transform never fights
            the entrance animation on the outer node. */}
        <div className="chat-hero-logo-float relative flex h-full w-full items-center justify-center">
          <div
            aria-hidden="true"
            className="chat-hero-halo-breathe absolute inset-1 rounded-full bg-sky-500/10 blur-xl dark:bg-sky-400/10"
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
            {t(GREETING_KEYS[period])}，{t("chat.greetingSubtitle")}
          </div>
          {onSuggestionSelect ? (
            <div className="mt-7 grid w-full max-w-[520px] grid-cols-1 gap-2 px-6 sm:grid-cols-3 sm:px-4">
              {SUGGESTION_CARDS.map((card, index) => (
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
                    <card.icon className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 truncate text-[calc(14px*var(--zone-font-scale,1))] font-medium leading-5 text-foreground/90">
                    {t(card.titleKey)}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
