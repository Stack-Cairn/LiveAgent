import { updateSkills } from "@liveagent/app/lib/settings/index";
import type { SettingsSectionProps } from "@liveagent/app/pages/settings/types";
import {
  AlertTriangle,
  BookOpen,
  Check,
  FileText,
  Lock,
  MessageSquare,
  RefreshCw,
  Search,
  Sparkles,
} from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { Skeleton } from "@liveagent/ui/components/ui/skeleton";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import {
  discoverSkills,
  isAlwaysEnabledSkillName,
  isUserSelectableSkill,
  mergeAlwaysEnabledSkillNames,
  notifySkillsDiscoveryUpdated,
  type SkillSummary,
} from "@liveagent/ui/lib/skills/index";
import { useEffect, useRef, useState } from "react";

export function SkillsSettingsForm(props: SettingsSectionProps) {
  const { settings, setSettings } = props;
  const { t } = useLocale();
  const skillsLockedByChatMode = settings.system.executionMode === "text";
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  /** Bumps on every successful scan to re-trigger entrance animations */
  const [scanGeneration, setScanGeneration] = useState(0);
  const hadSkillsBefore = useRef(false);

  async function refresh() {
    if (skillsLockedByChatMode) {
      setSkills([]);
      setLoadError(null);
      setLoading(false);
      return;
    }

    hadSkillsBefore.current = skills.length > 0;
    setLoading(true);
    setLoadError(null);
    try {
      const discovery = await discoverSkills({ force: true });
      setSkills(discovery.skills);
      setScanGeneration((g) => g + 1);
      notifySkillsDiscoveryUpdated();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSkills([]);
      setLoadError(msg || "Failed to load skills");
    } finally {
      setLoading(false);
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: chat-mode locking intentionally retriggers skill discovery
  useEffect(() => {
    void refresh();
  }, [skillsLockedByChatMode]);

  const selected = new Set(mergeAlwaysEnabledSkillNames(settings.skills.selected));
  const selectableSkills = skills.filter(isUserSelectableSkill);
  const selectedCount = selectableSkills.filter((skill) => selected.has(skill.name)).length;

  const filtered = filter.trim()
    ? skills.filter(
        (skill) =>
          skill.name.toLowerCase().includes(filter.toLowerCase()) ||
          skill.description.toLowerCase().includes(filter.toLowerCase()),
      )
    : skills;

  function toggleSkill(name: string, on: boolean) {
    if (isAlwaysEnabledSkillName(name)) return;
    const next = new Set(settings.skills.selected);
    if (on) next.add(name);
    else next.delete(name);
    setSettings((prev) => updateSkills(prev, { selected: Array.from(next) }));
  }

  return (
    <div className="settings-skills-section space-y-5">
      <div className="settings-section-heading-row flex items-start justify-between gap-4">
        <div className="settings-section-title-group flex items-center gap-2">
          <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10">
            <Sparkles className="size-4 text-primary" />
          </div>
          <div>
            <h3 className="text-sm font-semibold">Skills</h3>
            <p className="text-xs text-muted-foreground">{t("settings.skillsDesc")}</p>
          </div>
        </div>

        <div className="settings-section-actions flex items-center gap-2">
          {selectableSkills.length > 0 ? (
            <div className="flex items-center gap-1.5 rounded-full bg-muted/60 px-2.5 py-1">
              <div
                className={cn(
                  "size-1.5 rounded-full",
                  selectedCount > 0 ? "bg-emerald-500" : "bg-muted-foreground/40",
                )}
              />
              <span className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{selectedCount}</span>
                <span className="mx-0.5 text-muted-foreground/50">/</span>
                <span>{selectableSkills.length}</span>
                <span className="ml-1">{t("settings.skillsSelected")}</span>
              </span>
            </div>
          ) : null}

          <button
            type="button"
            role="switch"
            aria-checked={settings.skills.enabled ? "true" : "false"}
            aria-label={t("settings.skillsEnable")}
            disabled={skillsLockedByChatMode}
            onClick={() =>
              setSettings((prev) => updateSkills(prev, { enabled: !prev.skills.enabled }))
            }
            className={cn(
              "relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50",
              settings.skills.enabled ? "bg-primary" : "bg-muted-foreground/30",
            )}
          >
            <span
              className={cn(
                "pointer-events-none inline-block size-4 rounded-full bg-white shadow-xs transition-transform",
                settings.skills.enabled ? "translate-x-5" : "translate-x-1",
              )}
            />
          </button>

          <Button
            variant="outline"
            size="sm"
            className={cn(
              "gap-1.5 transition-all",
              loading ? "border-primary/40 bg-primary/5 text-primary" : "",
            )}
            onClick={() => void refresh()}
            disabled={loading || skillsLockedByChatMode}
          >
            <RefreshCw
              className={cn("size-3.5 transition-transform", loading ? "animate-spin" : "")}
            />
            {loading ? t("settings.skillsScanning") : t("settings.skillsScan")}
            {loading && (
              <span className="ml-0.5 inline-flex gap-2px">
                <span className="skills-scan-dot size-1 rounded-full bg-primary" />
                <span className="skills-scan-dot size-1 rounded-full bg-primary" />
                <span className="skills-scan-dot size-1 rounded-full bg-primary" />
              </span>
            )}
          </Button>
        </div>
      </div>

      {skillsLockedByChatMode ? (
        <div className="flex items-start gap-2 rounded-lg border border-border/60 bg-muted/40 px-3 py-2.5">
          <MessageSquare className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">
            {t("settings.skillsDisabledInChatMode")}
          </span>
        </div>
      ) : (
        <>
          {loadError ? (
            <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5">
              <AlertTriangle className="size-4 shrink-0 text-destructive" />
              <span className="text-xs text-destructive">{loadError}</span>
            </div>
          ) : null}

          {!settings.skills.enabled ? (
            <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/40 px-3 py-2.5">
              <BookOpen className="size-4 shrink-0 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">
                {t("settings.skillsDisabledHint")}
              </span>
            </div>
          ) : null}

          {!loading && skills.length === 0 && !loadError ? (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border/60 py-12 text-center">
              <div className="flex size-12 items-center justify-center rounded-full bg-muted">
                <BookOpen className="size-5 text-muted-foreground" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium text-muted-foreground">
                  {t("settings.skillsNotFound")}
                </p>
                <p className="text-xs text-muted-foreground/70">
                  {t("settings.skillsNotFoundHint")}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="mt-1 gap-1.5"
                onClick={() => void refresh()}
              >
                <RefreshCw className="size-3.5" />
                {t("settings.skillsRescan")}
              </Button>
            </div>
          ) : null}

          {loading && skills.length === 0 ? (
            <div className="space-y-3">
              {[1, 2, 3, 4].map((item) => (
                <div key={item} className="skill-card-enter rounded-xl border border-border/40 p-4">
                  <div className="flex items-center gap-3">
                    <Skeleton className="size-9 shrink-0 rounded-lg" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-3.5 w-28 rounded" />
                      <Skeleton className="h-3 w-48 rounded" />
                    </div>
                    <Skeleton className="size-5 shrink-0 rounded-md" />
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {skills.length > 4 ? (
            <div className="relative">
              <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                value={filter}
                onChange={(e) => setFilter(e.currentTarget.value)}
                placeholder={t("settings.skillsSearch")}
                className="h-9 w-full rounded-lg border bg-background pl-9 pr-3 text-sm outline-hidden transition-colors placeholder:text-muted-foreground/60 focus:border-primary/50 focus:ring-1 focus:ring-primary/20 web:text-0p75rem"
              />
            </div>
          ) : null}

          {filtered.length > 0 ? (
            <div className="space-y-2">
              {filtered.map((skill) => {
                const alwaysEnabled = isAlwaysEnabledSkillName(skill.name);
                const checked = alwaysEnabled || selected.has(skill.name);
                const content = (
                  <>
                    <div
                      className={cn(
                        "flex size-9 shrink-0 items-center justify-center rounded-lg transition-colors",
                        checked
                          ? "bg-primary/15 text-primary"
                          : "bg-muted text-muted-foreground group-hover:bg-accent",
                      )}
                    >
                      <Sparkles className="size-4" />
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium leading-none">{skill.name}</span>
                      </div>
                      {skill.description ? (
                        <p className="mt-1 truncate text-xs text-muted-foreground">
                          {skill.description}
                        </p>
                      ) : null}
                      <div className="mt-0.5 flex items-center gap-1 text-11px text-muted-foreground/60">
                        <FileText className="size-3" />
                        <span className="truncate">{skill.skillFile}</span>
                      </div>
                    </div>

                    {alwaysEnabled ? (
                      <div
                        className="flex shrink-0 items-center gap-1.5 rounded-full bg-primary/10 px-2 py-1 text-11px font-medium text-primary"
                        title={t("settings.skillsAlwaysOn")}
                      >
                        <Lock className="size-3" />
                        <span>{t("settings.skillsAlwaysOn")}</span>
                      </div>
                    ) : (
                      <div
                        className={cn(
                          "flex size-5 shrink-0 items-center justify-center rounded-md border transition-all",
                          checked
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border bg-background group-hover:border-muted-foreground/40",
                        )}
                      >
                        {checked ? (
                          <Check className="animate-skill-check-enter motion-reduce:animate-none! size-3" />
                        ) : null}
                      </div>
                    )}
                  </>
                );

                if (alwaysEnabled) {
                  return (
                    <div
                      key={`${skill.name}-${scanGeneration}`}
                      className="settings-card-row skill-card-enter flex w-full items-center gap-3 rounded-xl border border-primary/40 bg-primary/5 p-3 text-left shadow-xs"
                    >
                      {content}
                    </div>
                  );
                }

                return (
                  <button
                    key={`${skill.name}-${scanGeneration}`}
                    type="button"
                    onClick={() => toggleSkill(skill.name, !checked)}
                    className={cn(
                      "settings-card-row skill-card-enter group flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-all",
                      checked
                        ? "border-primary/40 bg-primary/5 shadow-xs"
                        : "border-border/60 bg-background hover:border-border hover:bg-accent/30",
                    )}
                  >
                    {content}
                  </button>
                );
              })}
            </div>
          ) : null}

          {filter.trim() && filtered.length === 0 && skills.length > 0 ? (
            <div className="py-8 text-center">
              <p className="text-sm text-muted-foreground">
                {t("settings.skillsNoMatch").replace("{filter}", filter)}
              </p>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
