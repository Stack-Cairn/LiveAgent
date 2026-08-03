import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocale } from "../../i18n";
import { DEFAULT_SKILL_PRESET_ID, type SkillPreset } from "../../lib/settings";
import { cn } from "../../lib/shared/utils";
import { isUserSelectableSkill, type SkillSummary } from "../../lib/skills";
import {
  CLAWHUB_CATEGORY_SLUGS,
  type ClawHubCategorySlug,
  classifyClawHubSkill,
} from "../../lib/skills/clawHubCategories";
import {
  BookOpen,
  Brain,
  Copy,
  Folder,
  Globe,
  Key,
  Layers,
  ListChecks,
  Lock,
  MessageSquare,
  Plug,
  Plus,
  Search,
  Server,
  Shield,
  SkillIcon,
  Sparkles,
  Trash2,
  Wrench,
  X,
  Zap,
} from "../icons";
import { ConfirmActionPopover } from "../ui/confirm-action-popover";

type CategoryFilter = "all" | ClawHubCategorySlug;

const CATEGORY_ICONS: Record<CategoryFilter, typeof Layers> = {
  all: Layers,
  integrations: Plug,
  automation: Zap,
  research: Globe,
  development: Wrench,
  productivity: ListChecks,
  communication: MessageSquare,
  creative: Sparkles,
  knowledge: BookOpen,
  agents: Brain,
  operations: Server,
  security: Shield,
  finance: Key,
  lifestyle: Globe,
  other: Folder,
};

type PresetDraft = {
  name: string;
  description: string;
  skillNames: Set<string>;
};

export type SkillPresetManagerProps = {
  presets: SkillPreset[];
  skills: SkillSummary[];
  onCreate: (draft: { name: string; description: string; skillNames: string[] }) => void;
  onUpdate: (
    id: string,
    patch: { name: string; description: string; skillNames: string[] },
  ) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onGoInstalled: () => void;
};

function classifySkill(skill: SkillSummary): ClawHubCategorySlug[] {
  return classifyClawHubSkill({
    slug: skill.name,
    displayName: skill.name,
    summary: skill.description,
    topics: [],
  });
}

function categoryLabelKey(category: CategoryFilter) {
  return `settings.skillsStoreCategory${category.charAt(0).toUpperCase()}${category.slice(1)}`;
}

function presetDescription(preset: SkillPreset, defaultDescription: string, fallback: string) {
  if (preset.id === DEFAULT_SKILL_PRESET_ID) return defaultDescription;
  return preset.description.trim() || fallback;
}

function makeDraft(preset?: SkillPreset): PresetDraft {
  return {
    name: preset?.name ?? "",
    description: preset?.description ?? "",
    skillNames: new Set(preset?.skillNames ?? []),
  };
}

export function SkillPresetManager(props: SkillPresetManagerProps) {
  const { presets, skills, onCreate, onUpdate, onDuplicate, onDelete, onGoInstalled } = props;
  const { t } = useLocale();
  const [openPresetId, setOpenPresetId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const selectableSkills = useMemo(() => skills.filter(isUserSelectableSkill), [skills]);
  const defaultDescription = t("settings.skillsPresetDefaultDescription");
  const fallbackDescription = t("settings.skillsPresetDescriptionFallback");
  const defaultPreset = presets.find((preset) => preset.id === DEFAULT_SKILL_PRESET_ID);
  const orderedPresets = useMemo(
    () => [
      ...(defaultPreset ? [defaultPreset] : []),
      ...presets.filter((preset) => preset.id !== DEFAULT_SKILL_PRESET_ID),
    ],
    [defaultPreset, presets],
  );
  const openPreset = openPresetId
    ? (presets.find((preset) => preset.id === openPresetId) ?? null)
    : null;

  return (
    <div className="flex flex-col gap-4 py-1">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold tracking-tight text-foreground">
            {t("settings.skillsPresetSectionTitle")}
          </h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {t("settings.skillsPresetSectionDescription")}
          </p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {orderedPresets.map((preset) => {
          const isDefault = preset.id === DEFAULT_SKILL_PRESET_ID;
          const installedCount = preset.skillNames.filter((name) =>
            selectableSkills.some((skill) => skill.name === name),
          ).length;
          return (
            <button
              key={preset.id}
              type="button"
              onClick={() => {
                setCreating(false);
                setOpenPresetId(preset.id);
              }}
              className="group flex min-h-40 flex-col rounded-xl border border-border/45 bg-background/75 p-4 text-left shadow-[0_1px_0_rgba(255,255,255,0.55)_inset] transition-all hover:-translate-y-0.5 hover:border-border/70 hover:bg-background hover:shadow-[0_12px_28px_-20px_rgba(15,23,42,0.35)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 dark:border-white/[0.08] dark:bg-white/[0.045] dark:hover:bg-white/[0.07]"
            >
              <div className="flex items-start justify-between gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-border/50 bg-background/80 text-foreground/80">
                  {isDefault ? <Lock className="h-4.5 w-4.5" /> : <Layers className="h-5 w-5" />}
                </span>
                {isDefault ? (
                  <span className="rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[10px] font-medium text-foreground/70 ring-1 ring-border/40">
                    {t("settings.skillsPresetDefaultBadge")}
                  </span>
                ) : null}
              </div>
              <div className="mt-3 line-clamp-1 text-[13.5px] font-semibold text-foreground">
                {preset.name}
              </div>
              <p className="mt-1.5 line-clamp-2 min-h-10 text-[11.5px] leading-5 text-muted-foreground">
                {presetDescription(preset, defaultDescription, fallbackDescription)}
              </p>
              <div className="mt-auto pt-3 text-[10.5px] font-medium text-muted-foreground/80">
                {t("settings.skillsPresetSkillCount").replace("{count}", String(installedCount))}
              </div>
            </button>
          );
        })}

        <button
          type="button"
          onClick={() => {
            setOpenPresetId(null);
            setCreating(true);
          }}
          className="group flex min-h-40 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border/60 bg-background/40 p-4 text-center text-muted-foreground transition-all hover:border-primary/45 hover:bg-background/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 dark:border-white/[0.12] dark:bg-white/[0.025]"
        >
          <span className="flex h-10 w-10 items-center justify-center rounded-full border border-border/50 bg-background/80 transition-colors group-hover:border-primary/35 group-hover:text-primary">
            <Plus className="h-4.5 w-4.5" />
          </span>
          <span className="text-[12.5px] font-medium">{t("settings.skillsPresetCreate")}</span>
        </button>
      </div>

      {openPreset || creating ? (
        <SkillPresetDrawer
          key={creating ? "create" : openPreset?.id}
          preset={openPreset}
          creating={creating}
          presets={presets}
          skills={selectableSkills}
          onClose={() => {
            setCreating(false);
            setOpenPresetId(null);
          }}
          onCreate={onCreate}
          onUpdate={onUpdate}
          onDuplicate={onDuplicate}
          onDelete={onDelete}
          onGoInstalled={onGoInstalled}
        />
      ) : null}
    </div>
  );
}

function SkillPresetDrawer(props: {
  preset: SkillPreset | null;
  creating: boolean;
  presets: SkillPreset[];
  skills: SkillSummary[];
  onClose: () => void;
  onCreate: SkillPresetManagerProps["onCreate"];
  onUpdate: SkillPresetManagerProps["onUpdate"];
  onDuplicate: SkillPresetManagerProps["onDuplicate"];
  onDelete: SkillPresetManagerProps["onDelete"];
  onGoInstalled: () => void;
}) {
  const {
    preset,
    creating,
    presets,
    skills,
    onClose,
    onCreate,
    onUpdate,
    onDuplicate,
    onDelete,
    onGoInstalled,
  } = props;
  const { t } = useLocale();
  const isDefault = preset?.id === DEFAULT_SKILL_PRESET_ID;
  const readOnly = isDefault;
  const [draft, setDraft] = useState<PresetDraft>(() => makeDraft(preset ?? undefined));
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [error, setError] = useState("");
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const closeTimerRef = useRef<number | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const handleClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    closeTimerRef.current = window.setTimeout(() => onCloseRef.current(), 200);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") handleClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    };
  }, [handleClose]);

  const categorizedSkills = useMemo(
    () => skills.map((skill) => ({ skill, categories: classifySkill(skill) })),
    [skills],
  );
  const categoryCounts = useMemo(() => {
    const counts = new Map<CategoryFilter, number>([["all", categorizedSkills.length]]);
    for (const item of categorizedSkills) {
      for (const value of item.categories) counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return counts;
  }, [categorizedSkills]);
  const visibleSkills = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return categorizedSkills.filter(({ skill, categories }) => {
      if (normalizedQuery && !skill.name.toLowerCase().includes(normalizedQuery)) return false;
      if (category !== "all" && !categories.includes(category)) return false;
      return !selectedOnly || draft.skillNames.has(skill.name);
    });
  }, [categorizedSkills, category, draft.skillNames, query, selectedOnly]);

  function toggleSkill(name: string) {
    if (readOnly) return;
    setDraft((current) => {
      const skillNames = new Set(current.skillNames);
      if (skillNames.has(name)) skillNames.delete(name);
      else skillNames.add(name);
      return { ...current, skillNames };
    });
  }

  function save() {
    const name = draft.name.trim();
    if (!name) {
      setError(t("settings.skillsPresetNameRequired"));
      return;
    }
    const duplicate = presets.some(
      (item) => item.id !== preset?.id && item.name.trim().toLowerCase() === name.toLowerCase(),
    );
    if (duplicate) {
      setError(t("settings.skillsPresetNameExists"));
      return;
    }
    const value = {
      name,
      description: draft.description.trim(),
      skillNames: [...draft.skillNames],
    };
    if (creating) onCreate(value);
    else if (preset && !readOnly) onUpdate(preset.id, value);
    handleClose();
  }

  const title = creating
    ? t("settings.skillsPresetCreate")
    : isDefault
      ? "Default"
      : (preset?.name ?? "");

  return createPortal(
    <div
      className={cn(
        "fixed inset-0 z-50 flex justify-end bg-background/55",
        closing ? "skills-drawer-backdrop-closing" : "skills-drawer-backdrop",
      )}
      role="dialog"
      aria-modal="true"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) handleClose();
      }}
    >
      <aside
        className={cn(
          "flex h-full w-full flex-col border-l border-border/45 bg-background shadow-[-18px_0_45px_-28px_rgba(15,23,42,0.45)] dark:border-white/[0.08] dark:bg-popover md:w-[46%] md:max-w-[42rem]",
          closing ? "skills-drawer-panel-closing" : "skills-drawer-panel",
        )}
      >
        <div className="flex items-start gap-3 border-b border-border/40 px-5 py-4">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border/50 bg-background/80 text-foreground/80">
            {isDefault ? <Lock className="h-4.5 w-4.5" /> : <Layers className="h-5 w-5" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[10.5px] font-medium uppercase text-muted-foreground/75">
              {readOnly
                ? t("settings.skillsPresetReadOnlyTitle")
                : t("settings.skillsPresetEditorTitle")}
            </div>
            <h2 className="mt-1 truncate text-base font-semibold text-foreground">{title}</h2>
          </div>
          {!creating && preset && !readOnly ? (
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => {
                  onDuplicate(preset.id);
                  handleClose();
                }}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted/70 hover:text-foreground"
                title={t("settings.skillsPresetDuplicate")}
              >
                <Copy className="h-4 w-4" />
              </button>
              <ConfirmActionPopover
                title={t("settings.skillsPresetDelete")}
                description={t("settings.skillsPresetDeleteConfirm")}
                confirmLabel={t("settings.delete")}
                onConfirm={() => {
                  onDelete(preset.id);
                  handleClose();
                }}
              >
                {(open) => (
                  <button
                    type="button"
                    onClick={open}
                    className="flex h-8 w-8 items-center justify-center rounded-lg text-destructive hover:bg-destructive/10"
                    title={t("settings.skillsPresetDelete")}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </ConfirmActionPopover>
            </div>
          ) : null}
          <button
            type="button"
            onClick={handleClose}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted/70 hover:text-foreground"
            title={t("settings.cronViewClose")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="flex flex-col gap-4">
            {readOnly ? (
              <div className="rounded-xl border border-border/45 bg-muted/25 p-3.5">
                <p className="text-[12.5px] leading-5 text-muted-foreground">
                  {t("settings.skillsPresetDefaultDescription")}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    onGoInstalled();
                    handleClose();
                  }}
                  className="mt-3 inline-flex h-8 items-center rounded-lg bg-foreground px-3 text-xs font-medium text-background"
                >
                  {t("settings.skillsPresetGoInstalled")}
                </button>
              </div>
            ) : (
              <div className="grid gap-3">
                <label className="grid gap-1.5 text-xs font-medium text-foreground">
                  {t("settings.skillsPresetNameLabel")}
                  <input
                    value={draft.name}
                    maxLength={80}
                    onChange={(event) => {
                      const name = event.currentTarget.value;
                      setError("");
                      setDraft((current) => ({ ...current, name }));
                    }}
                    className="h-9 rounded-lg border border-border/50 bg-background px-3 text-[13px] outline-none focus:border-primary/55 focus:ring-2 focus:ring-primary/15"
                    placeholder={t("settings.skillsPresetNamePlaceholder")}
                  />
                </label>
                <label className="grid gap-1.5 text-xs font-medium text-foreground">
                  {t("settings.skillsPresetDescriptionLabel")}
                  <textarea
                    value={draft.description}
                    maxLength={240}
                    rows={3}
                    onChange={(event) => {
                      const description = event.currentTarget.value;
                      setDraft((current) => ({
                        ...current,
                        description,
                      }));
                    }}
                    className="resize-none rounded-lg border border-border/50 bg-background px-3 py-2 text-[13px] leading-5 outline-none focus:border-primary/55 focus:ring-2 focus:ring-primary/15"
                    placeholder={t("settings.skillsPresetDescriptionPlaceholder")}
                  />
                </label>
                {error ? <p className="text-xs text-destructive">{error}</p> : null}
              </div>
            )}

            <div className="border-t border-border/35 pt-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-xs font-semibold text-foreground">
                    {t("settings.skillsPresetMembersTitle")}
                  </h3>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {t("settings.skillsPresetSelectedCount").replace(
                      "{count}",
                      String(draft.skillNames.size),
                    )}
                  </p>
                </div>
                <label className="inline-flex items-center gap-2 text-[11px] text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={selectedOnly}
                    onChange={(event) => setSelectedOnly(event.currentTarget.checked)}
                    className="h-3.5 w-3.5 accent-primary"
                  />
                  {t("settings.skillsPresetSelectedOnly")}
                </label>
              </div>

              <div className="relative mt-3">
                <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                  className="h-9 w-full rounded-lg border border-border/50 bg-background pl-9 pr-3 text-xs outline-none focus:border-primary/55 focus:ring-2 focus:ring-primary/15"
                  placeholder={t("settings.skillsPresetSearchPlaceholder")}
                />
              </div>

              <fieldset
                className="mt-2 flex max-w-full flex-wrap items-center gap-1 rounded-xl border border-border/40 bg-background/60 p-1"
                aria-label={t("settings.skillsPresetCategoryLabel")}
              >
                {(["all", ...CLAWHUB_CATEGORY_SLUGS] as CategoryFilter[]).map((value) => {
                  const CategoryIcon = CATEGORY_ICONS[value];
                  const active = category === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setCategory(value)}
                      className={cn(
                        "inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-[11.5px] font-medium transition-all",
                        active
                          ? "bg-background/90 text-foreground shadow-sm ring-1 ring-border/45 dark:bg-white/[0.08] dark:ring-white/[0.09]"
                          : "text-muted-foreground hover:bg-background/80 hover:text-foreground",
                      )}
                    >
                      <CategoryIcon className="h-3.5 w-3.5" />
                      <span>{t(categoryLabelKey(value))}</span>
                      <span
                        className={cn(
                          "inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums",
                          active
                            ? "bg-foreground/[0.08] text-foreground/85"
                            : "bg-muted/70 text-muted-foreground",
                        )}
                      >
                        {categoryCounts.get(value) ?? 0}
                      </span>
                    </button>
                  );
                })}
              </fieldset>

              <div className="mt-3 grid gap-2">
                {visibleSkills.map(({ skill, categories }) => {
                  const checked = draft.skillNames.has(skill.name);
                  const primaryCategory = categories[0] ?? "other";
                  const CategoryIcon = CATEGORY_ICONS[primaryCategory];
                  return (
                    <button
                      key={skill.name}
                      type="button"
                      role="switch"
                      aria-checked={checked}
                      disabled={readOnly}
                      onClick={() => toggleSkill(skill.name)}
                      className={cn(
                        "group flex min-h-[5.75rem] items-start gap-3 rounded-xl border px-3 py-3 text-left transition-all",
                        checked
                          ? "border-emerald-500/30 bg-emerald-500/[0.045]"
                          : "border-border/40 bg-background/55 hover:border-border/60 hover:bg-background/80",
                        readOnly && "cursor-default",
                      )}
                    >
                      <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border/45 bg-background/80 text-muted-foreground">
                        <SkillIcon className="h-5 w-5" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-semibold text-foreground">
                          {skill.name}
                        </span>
                        <span className="mt-1 line-clamp-2 min-h-8 text-[11px] leading-4 text-muted-foreground">
                          {skill.description || t("settings.skillsPresetDescriptionFallback")}
                        </span>
                        <span className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-foreground/[0.055] px-2 py-0.5 text-[10px] font-medium text-foreground/70 ring-1 ring-border/40">
                          <CategoryIcon className="h-2.5 w-2.5" />
                          {t(categoryLabelKey(primaryCategory))}
                        </span>
                      </span>
                      <span
                        aria-hidden="true"
                        className={cn(
                          "relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full ring-1 transition-all",
                          checked
                            ? "bg-emerald-500 ring-emerald-400/45"
                            : "bg-muted-foreground/25 ring-border/40",
                        )}
                      >
                        <span
                          className={cn(
                            "pointer-events-none inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform",
                            checked ? "translate-x-[1.05rem]" : "translate-x-[0.15rem]",
                          )}
                        />
                      </span>
                    </button>
                  );
                })}
                {visibleSkills.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border/50 py-8 text-center text-xs text-muted-foreground">
                    {t("settings.skillsPresetNoSkillsMatch")}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>

        {!readOnly ? (
          <div className="flex items-center justify-end gap-2 border-t border-border/40 px-5 py-3.5">
            <button
              type="button"
              onClick={handleClose}
              className="h-9 rounded-lg px-3 text-xs font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            >
              {t("settings.cancel")}
            </button>
            <button
              type="button"
              onClick={save}
              className="h-9 rounded-lg bg-foreground px-4 text-xs font-medium text-background hover:opacity-90"
            >
              {t("settings.save")}
            </button>
          </div>
        ) : null}
      </aside>
    </div>,
    document.body,
  );
}
