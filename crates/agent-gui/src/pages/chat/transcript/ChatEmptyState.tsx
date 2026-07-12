import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useState,
} from "react";

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
    accent: "199 89% 48%",
    chipClassName:
      "bg-sky-500/10 text-sky-600 group-hover:bg-sky-500/20 dark:bg-sky-400/10 dark:text-sky-400 dark:group-hover:bg-sky-400/20",
    titleKey: "chat.suggestExploreTitle",
    hintKey: "chat.suggestExploreHint",
    promptKey: "chat.suggestExplorePrompt",
  },
  {
    key: "fix",
    icon: Wrench,
    accent: "38 92% 50%",
    chipClassName:
      "bg-amber-500/10 text-amber-600 group-hover:bg-amber-500/20 dark:bg-amber-400/10 dark:text-amber-400 dark:group-hover:bg-amber-400/20",
    titleKey: "chat.suggestFixTitle",
    hintKey: "chat.suggestFixHint",
    promptKey: "chat.suggestFixPrompt",
  },
  {
    key: "ideate",
    icon: Lightbulb,
    accent: "160 84% 39%",
    chipClassName:
      "bg-emerald-500/10 text-emerald-600 group-hover:bg-emerald-500/20 dark:bg-emerald-400/10 dark:text-emerald-400 dark:group-hover:bg-emerald-400/20",
    titleKey: "chat.suggestIdeateTitle",
    hintKey: "chat.suggestIdeateHint",
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

  // Drives the accent spotlight that follows the cursor inside each card.
  const handleCardPointerMove = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const card = event.currentTarget;
    const rect = card.getBoundingClientRect();
    card.style.setProperty("--spot-x", `${event.clientX - rect.left}px`);
    card.style.setProperty("--spot-y", `${event.clientY - rect.top}px`);
  }, []);

  return (
    <div className="relative flex w-full flex-col items-center">
      <div className="hero-entrance relative mb-6 flex h-[88px] w-[88px] items-center justify-center">
        <div className="hero-aura" aria-hidden="true" />
        <div className="hero-icon-float relative z-[1] flex items-center justify-center">
          <img
            src={iconSimpleUrl}
            alt=""
            aria-hidden="true"
            draggable={false}
            className="h-16 w-16 select-none object-contain"
          />
        </div>
      </div>

      {variant === "no-models" ? (
        <>
          <div className="hero-entrance-delay-1 mb-2 bg-gradient-to-b from-foreground to-foreground/65 bg-clip-text text-center text-[calc(26px*var(--zone-font-scale,1))] font-semibold leading-tight tracking-tight text-transparent">
            {t("chat.welcome")}
          </div>
          <div className="hero-entrance-delay-2 mb-1 text-center text-sm leading-relaxed text-muted-foreground">
            {t("chat.noModelSelected")}
          </div>
          <div className="hero-entrance-delay-2 mb-7 text-center text-sm leading-relaxed text-muted-foreground">
            {t("chat.configureModel")}
          </div>
          {onOpenSettings ? (
            <button
              type="button"
              onClick={() => onOpenSettings("providers")}
              className="hero-entrance-delay-3 group inline-flex items-center gap-2 rounded-full border border-white/70 bg-white/65 px-5 py-2 text-sm font-medium text-foreground/85 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_rgba(0,0,0,0.06),inset_0_1px_0_rgba(255,255,255,0.85)] backdrop-blur-xl transition-all duration-200 hover:-translate-y-[1px] hover:bg-white/80 hover:text-foreground hover:shadow-[0_2px_4px_rgba(0,0,0,0.05),0_12px_32px_rgba(0,0,0,0.08),inset_0_1px_0_rgba(255,255,255,0.9)] active:translate-y-0 active:shadow-[0_1px_2px_rgba(0,0,0,0.04)] dark:border-white/[0.1] dark:bg-white/[0.06] dark:text-foreground/90 dark:shadow-[0_1px_2px_rgba(0,0,0,0.2),0_8px_24px_rgba(0,0,0,0.25),inset_0_1px_0_rgba(255,255,255,0.06)] dark:hover:bg-white/[0.1]"
            >
              <Settings className="h-3.5 w-3.5 text-foreground/55 transition-colors group-hover:text-foreground/80" />
              {t("chat.goToSettings")}
            </button>
          ) : null}
        </>
      ) : (
        <>
          <div className="hero-entrance-delay-1 mb-2.5 bg-gradient-to-b from-foreground to-foreground/65 bg-clip-text text-center text-[calc(26px*var(--zone-font-scale,1))] font-semibold leading-tight tracking-tight text-transparent">
            {t(GREETING_KEYS[period])}
          </div>
          <div className="hero-entrance-delay-2 flex items-center justify-center gap-1.5 text-center text-sm leading-relaxed text-muted-foreground">
            <Lightbulb
              aria-hidden="true"
              className="h-3.5 w-3.5 shrink-0 text-amber-500 dark:text-amber-400"
            />
            {t("chat.greetingSubtitle")}
          </div>
          {onSuggestionSelect ? (
            <div className="mt-9 grid w-full max-w-[640px] grid-cols-1 gap-2.5 px-6 sm:grid-cols-3 sm:px-4">
              {SUGGESTION_CARDS.map((card, index) => (
                <button
                  key={card.key}
                  type="button"
                  disabled={suggestionsDisabled}
                  onClick={() => onSuggestionSelect(t(card.promptKey))}
                  onPointerMove={handleCardPointerMove}
                  style={
                    {
                      "--hero-delay": `${0.26 + index * 0.06}s`,
                      "--card-accent": card.accent,
                    } as CSSProperties
                  }
                  className="hero-card-entrance hero-suggest-card group flex items-center gap-3 rounded-xl px-3.5 py-3 text-left backdrop-blur-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-55"
                >
                  <span
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-all duration-200 group-hover:-rotate-3 group-hover:scale-110 ${card.chipClassName}`}
                  >
                    <card.icon className="h-4 w-4" />
                  </span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-[calc(13px*var(--zone-font-scale,1))] font-medium leading-tight text-foreground/90">
                      {t(card.titleKey)}
                    </span>
                    <span className="truncate text-xs leading-tight text-muted-foreground">
                      {t(card.hintKey)}
                    </span>
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
