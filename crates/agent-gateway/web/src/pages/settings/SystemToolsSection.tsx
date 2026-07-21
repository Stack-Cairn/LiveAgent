import {
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  Bot,
  Brain,
  CheckCircle2,
  CircleHelp,
  Clock3,
  Eye,
  FilePenLine,
  FileText,
  FolderTree,
  Globe2,
  type IconComponent,
  ImageIcon,
  List,
  ListChecks,
  McpLogo,
  MessageSquare,
  Pencil,
  Plug,
  Radio,
  ScrollText,
  Search,
  Server,
  SkillIcon,
  Terminal,
  Trash2,
  Wrench,
  X,
} from "../../components/icons";
import { Button } from "../../components/ui/button";
import { useLocale } from "../../i18n";
import { updateSystem } from "../../lib/settings";
import { useModalMotion } from "../../lib/shared/modalMotion";
import {
  BUILTIN_TOOL_CATALOG,
  BUILTIN_TOOL_CATEGORIES,
  type BuiltinToolCatalogEntry,
  type BuiltinToolCategoryId,
  CUSTOM_TOOL_PRESENTATION,
  type ToolCatalogIconId,
} from "../../lib/tools/builtinToolCatalog";
import { SYSTEM_TOOL_OPTIONS, type SystemToolOption } from "../../lib/tools/systemToolOptions";
import { AgentActivationSwitch } from "./shared";
import type { SettingsSectionProps } from "./types";

const TOOL_ICONS: Record<ToolCatalogIconId, IconComponent> = {
  fileText: FileText,
  image: ImageIcon,
  filePen: FilePenLine,
  pencil: Pencil,
  trash: Trash2,
  list: List,
  folderTree: FolderTree,
  search: Search,
  terminal: Terminal,
  radio: Radio,
  scrollText: ScrollText,
  skill: SkillIcon,
  brain: Brain,
  bot: Bot,
  messageSquare: MessageSquare,
  clock: Clock3,
  mcp: McpLogo,
  globe: Globe2,
  server: Server,
  plug: Plug,
  wrench: Wrench,
  checklist: ListChecks,
  circleHelp: CircleHelp,
};

type CategoryAccent = {
  chipBorder: string;
  chipBg: string;
  chipText: string;
  iconBg: string;
  icon: string;
  bar: string;
};

/* Per-category accent used to color chips, row icons/edge bars, and the
 * detail modal badge — purely presentational, no bearing on tool behavior. */
const CATEGORY_ACCENTS: Record<BuiltinToolCategoryId, CategoryAccent> = {
  fs: {
    chipBorder: "border-sky-500/40",
    chipBg: "bg-sky-500/10",
    chipText: "text-sky-500",
    iconBg: "bg-sky-500/10",
    icon: "text-sky-500",
    bar: "bg-sky-500",
  },
  process: {
    chipBorder: "border-orange-500/40",
    chipBg: "bg-orange-500/10",
    chipText: "text-orange-500",
    iconBg: "bg-orange-500/10",
    icon: "text-orange-500",
    bar: "bg-orange-500",
  },
  intelligence: {
    chipBorder: "border-fuchsia-500/40",
    chipBg: "bg-fuchsia-500/10",
    chipText: "text-fuchsia-500",
    iconBg: "bg-fuchsia-500/10",
    icon: "text-fuchsia-500",
    bar: "bg-fuchsia-500",
  },
  automation: {
    chipBorder: "border-amber-500/40",
    chipBg: "bg-amber-500/10",
    chipText: "text-amber-500",
    iconBg: "bg-amber-500/10",
    icon: "text-amber-500",
    bar: "bg-amber-500",
  },
  connectivity: {
    chipBorder: "border-emerald-500/40",
    chipBg: "bg-emerald-500/10",
    chipText: "text-emerald-500",
    iconBg: "bg-emerald-500/10",
    icon: "text-emerald-500",
    bar: "bg-emerald-500",
  },
};

const CUSTOM_TOOL_ACCENT: CategoryAccent = {
  chipBorder: "border-violet-500/40",
  chipBg: "bg-violet-500/10",
  chipText: "text-violet-500",
  iconBg: "bg-violet-500/10",
  icon: "text-violet-500",
  bar: "bg-violet-500",
};

type ToolsTab = "builtin" | "custom";

type ToolDetail =
  | { kind: "builtin"; entry: BuiltinToolCatalogEntry }
  | { kind: "custom"; option: SystemToolOption };

export function SystemToolsSection(props: SettingsSectionProps) {
  const { settings, setSettings } = props;
  const { t } = useLocale();

  const [activeTab, setActiveTab] = useState<ToolsTab>("builtin");
  const [activeCategory, setActiveCategory] = useState<BuiltinToolCategoryId>("fs");
  const [detail, setDetail] = useState<ToolDetail | null>(null);

  /* Animate the switchable area's height between tab/category changes so the
   * page below never jumps; the from-height is captured right before the
   * state update, then the wrapper transitions to the new content height. */
  const switchPanelRef = useRef<HTMLDivElement | null>(null);
  const panelFromHeightRef = useRef<number | null>(null);

  function capturePanelHeight() {
    panelFromHeightRef.current = switchPanelRef.current?.offsetHeight ?? null;
  }

  function selectTab(tab: ToolsTab) {
    if (tab === activeTab) return;
    capturePanelHeight();
    setActiveTab(tab);
  }

  function selectCategory(categoryId: BuiltinToolCategoryId) {
    if (categoryId === activeCategory) return;
    capturePanelHeight();
    setActiveCategory(categoryId);
  }

  useLayoutEffect(() => {
    const wrap = switchPanelRef.current;
    const from = panelFromHeightRef.current;
    panelFromHeightRef.current = null;
    if (!wrap || from === null) return;
    const inner = wrap.firstElementChild as HTMLElement | null;
    const to = inner ? inner.offsetHeight : wrap.scrollHeight;
    if (from === to) {
      wrap.style.height = "";
      return;
    }
    wrap.style.height = `${from}px`;
    void wrap.offsetHeight;
    wrap.style.height = `${to}px`;
    const timer = window.setTimeout(() => {
      wrap.style.height = "";
    }, 240);
    return () => window.clearTimeout(timer);
  }, [activeTab, activeCategory]);

  const selectedSystemTools = settings.system.selectedSystemTools;
  const customOptions = useMemo(
    () => SYSTEM_TOOL_OPTIONS.filter((option) => option.kind === "custom"),
    [],
  );
  const enabledCustomCount = useMemo(
    () => customOptions.filter((option) => selectedSystemTools.includes(option.id)).length,
    [customOptions, selectedSystemTools],
  );
  const builtinGroups = useMemo(
    () =>
      BUILTIN_TOOL_CATEGORIES.map((category) => ({
        category,
        entries: BUILTIN_TOOL_CATALOG.filter((entry) => entry.categoryId === category.id),
      })).filter((group) => group.entries.length > 0),
    [],
  );
  const activeCategoryEntries =
    builtinGroups.find((group) => group.category.id === activeCategory)?.entries ?? [];

  function isToolEnabled(option: SystemToolOption) {
    return selectedSystemTools.includes(option.id);
  }

  function toggleCustomTool(option: SystemToolOption) {
    const next = isToolEnabled(option)
      ? selectedSystemTools.filter((id) => id !== option.id)
      : [...selectedSystemTools, option.id];
    setSettings((prev) => updateSystem(prev, { selectedSystemTools: next }));
  }

  return (
    <div className="settings-tools-section space-y-4">
      <div className="settings-tools-header flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10">
            <Wrench className="h-[18px] w-[18px] text-primary" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold">{t("settings.systemTools")}</h3>
              {activeTab === "custom" && customOptions.length > 0 ? (
                <span
                  title={`${t("settings.systemToolsTabCustom")}: ${enabledCustomCount}/${customOptions.length}`}
                  className="inline-flex items-center gap-1 rounded-full bg-violet-500/10 px-2 py-0.5 text-[11px] font-medium leading-none text-violet-500"
                >
                  <CheckCircle2 className="h-3 w-3" />
                  {enabledCustomCount}/{customOptions.length}
                </span>
              ) : null}
            </div>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              {activeTab === "builtin"
                ? t("settings.systemToolsBuiltinDesc")
                : t("settings.systemToolsCustomDesc")}
            </p>
          </div>
        </div>
        <ToolsTabSwitch
          activeTab={activeTab}
          builtinCount={BUILTIN_TOOL_CATALOG.length}
          customCount={customOptions.length}
          onSelect={selectTab}
        />
      </div>

      <div
        ref={switchPanelRef}
        className="settings-tools-switch-panel overflow-hidden transition-[height] duration-200 ease-out motion-reduce:transition-none"
      >
        <div key={activeTab} className="settings-tools-view-enter space-y-3">
          {activeTab === "builtin" ? (
            <>
              <div className="settings-tools-category-bar flex flex-wrap items-center gap-1.5">
                {builtinGroups.map(({ category, entries }) => {
                  const active = category.id === activeCategory;
                  const CategoryIcon = TOOL_ICONS[category.icon];
                  const accent = CATEGORY_ACCENTS[category.id];
                  return (
                    <button
                      key={category.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => selectCategory(category.id)}
                      className={`settings-tools-category-chip flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 ${
                        active
                          ? `${accent.chipBorder} ${accent.chipBg} ${accent.chipText}`
                          : "border-border/60 bg-muted/30 text-muted-foreground hover:border-border hover:text-foreground"
                      }`}
                    >
                      <CategoryIcon className="h-3.5 w-3.5" />
                      {t(category.labelKey)}
                      <span
                        className={`rounded-full px-1.5 py-px text-[10px] leading-none ${
                          active
                            ? `${accent.chipBg} ${accent.chipText}`
                            : "bg-muted/70 text-muted-foreground"
                        }`}
                      >
                        {entries.length}
                      </span>
                    </button>
                  );
                })}
              </div>
              <div
                key={activeCategory}
                className="settings-tools-view-enter settings-tools-grid grid gap-2 xl:grid-cols-2"
              >
                {activeCategoryEntries.map((entry) => (
                  <ToolRow
                    key={entry.id}
                    icon={entry.icon}
                    name={t(`settings.builtinTool.${entry.id}.name`)}
                    identifier={entry.toolName}
                    description={t(`settings.builtinTool.${entry.id}.desc`)}
                    readOnly={entry.isReadOnly}
                    accent={CATEGORY_ACCENTS[entry.categoryId]}
                    actions={<EyeButton onClick={() => setDetail({ kind: "builtin", entry })} />}
                  />
                ))}
              </div>
            </>
          ) : customOptions.length > 0 ? (
            <div className="settings-tools-grid grid gap-2 xl:grid-cols-2">
              {customOptions.map((option) => {
                const presentation = CUSTOM_TOOL_PRESENTATION[option.id];
                const enabled = isToolEnabled(option);
                return (
                  <ToolRow
                    key={option.id}
                    icon={presentation?.icon ?? "wrench"}
                    name={presentation ? t(presentation.nameKey) : option.label}
                    identifier={option.id}
                    description={presentation ? t(presentation.descKey) : option.description}
                    readOnly={presentation?.isReadOnly ?? false}
                    accent={CUSTOM_TOOL_ACCENT}
                    highlighted={enabled}
                    actions={
                      <>
                        <AgentActivationSwitch
                          checked={enabled}
                          title={t("settings.toolDetailEnableInChat")}
                          onToggle={() => toggleCustomTool(option)}
                        />
                        <EyeButton onClick={() => setDetail({ kind: "custom", option })} />
                      </>
                    }
                  />
                );
              })}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed bg-muted/20 px-4 py-6 text-center">
              <Wrench className="mx-auto mb-2 h-6 w-6 text-muted-foreground/40" />
              <p className="text-xs text-muted-foreground">{t("settings.noCustomSystemTools")}</p>
            </div>
          )}
        </div>
      </div>

      {detail ? (
        <ToolDetailModal
          detail={detail}
          enabled={detail.kind === "custom" ? isToolEnabled(detail.option) : true}
          onToggleEnabled={() => {
            if (detail.kind === "custom") toggleCustomTool(detail.option);
          }}
          onClose={() => setDetail(null)}
        />
      ) : null}
    </div>
  );
}

function ToolsTabSwitch(props: {
  activeTab: ToolsTab;
  builtinCount: number;
  customCount: number;
  onSelect: (tab: ToolsTab) => void;
}) {
  const { t } = useLocale();
  const tabs: Array<{ id: ToolsTab; label: string; count: number }> = [
    { id: "builtin", label: t("settings.systemToolsTabBuiltin"), count: props.builtinCount },
    { id: "custom", label: t("settings.systemToolsTabCustom"), count: props.customCount },
  ];

  return (
    <div
      role="tablist"
      aria-label={t("settings.systemTools")}
      className="settings-tools-tabs inline-flex shrink-0 items-center rounded-full border border-border/60 bg-muted/40 p-0.5"
    >
      {tabs.map((tab) => {
        const active = props.activeTab === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => props.onSelect(tab.id)}
            className={`settings-tools-tab flex items-center justify-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 ${
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
            <span
              className={`rounded-full px-1.5 py-px text-[10px] leading-none ${
                active ? "bg-primary/10 text-primary" : "bg-muted/70 text-muted-foreground"
              }`}
            >
              {tab.count}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function ToolRow(props: {
  icon: ToolCatalogIconId;
  name: string;
  identifier: string;
  description: string;
  readOnly: boolean;
  accent: CategoryAccent;
  highlighted?: boolean;
  actions: ReactNode;
}) {
  const { t } = useLocale();
  const Icon = TOOL_ICONS[props.icon];
  const { accent } = props;

  return (
    <div
      className={`settings-tools-row group relative flex items-center gap-3 overflow-hidden rounded-xl border p-3 pl-4 transition-all ${
        props.highlighted
          ? `${accent.chipBorder} ${accent.chipBg}`
          : "border-border/60 bg-background/80 hover:border-border hover:bg-muted/35"
      }`}
    >
      <span
        aria-hidden="true"
        className={`absolute inset-y-0 left-0 w-[3px] opacity-70 ${accent.bar}`}
      />
      <div
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors ${accent.iconBg} ${accent.icon}`}
      >
        <Icon className="h-4.5 w-4.5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-sm font-medium">{props.name}</span>
          <code className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] leading-none text-muted-foreground">
            {props.identifier}
          </code>
          {props.readOnly ? (
            <span className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] leading-none text-emerald-500">
              {t("settings.toolDetailReadOnly")}
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 truncate text-xs leading-relaxed text-muted-foreground">
          {props.description}
        </div>
      </div>
      <div className="settings-tools-row-actions flex shrink-0 items-center gap-2">
        {props.actions}
      </div>
    </div>
  );
}

function EyeButton(props: { onClick: () => void }) {
  const { t } = useLocale();
  return (
    <button
      type="button"
      onClick={props.onClick}
      title={t("settings.systemToolsViewDetail")}
      aria-label={t("settings.systemToolsViewDetail")}
      className="settings-tools-row-action flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
    >
      <Eye className="h-4 w-4" />
    </button>
  );
}

function ToolDetailModal(props: {
  detail: ToolDetail;
  enabled: boolean;
  onToggleEnabled: () => void;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const titleId = useId();
  const { modalState, requestClose } = useModalMotion(props.onClose);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") requestClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [requestClose]);

  const { detail } = props;
  const isBuiltin = detail.kind === "builtin";
  const presentation =
    detail.kind === "custom" ? CUSTOM_TOOL_PRESENTATION[detail.option.id] : undefined;
  const iconId: ToolCatalogIconId = isBuiltin
    ? detail.entry.icon
    : (presentation?.icon ?? "wrench");
  const Icon = TOOL_ICONS[iconId];
  const name = isBuiltin
    ? t(`settings.builtinTool.${detail.entry.id}.name`)
    : presentation
      ? t(presentation.nameKey)
      : detail.option.label;
  const detailText = isBuiltin
    ? t(`settings.builtinTool.${detail.entry.id}.detail`)
    : presentation
      ? t(presentation.detailKey)
      : detail.option.description;
  const identifier = isBuiltin ? detail.entry.toolName : detail.option.id;
  const category = isBuiltin
    ? BUILTIN_TOOL_CATEGORIES.find((entry) => entry.id === detail.entry.categoryId)
    : undefined;
  const categoryLabel = category ? t(category.labelKey) : t("settings.toolBadgeCustom");
  const runtimeScopes = isBuiltin ? detail.entry.runtimeScopes : detail.option.runtimeScopes;
  const readOnly = isBuiltin ? detail.entry.isReadOnly : (presentation?.isReadOnly ?? false);
  const conditional = isBuiltin && detail.entry.conditional === true;
  const accent = category ? CATEGORY_ACCENTS[category.id] : CUSTOM_TOOL_ACCENT;

  return createPortal(
    <div
      className="settings-modal-overlay settings-tool-detail-overlay fixed inset-0 z-50 flex items-center justify-center p-4"
      data-state={modalState}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={requestClose} />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="settings-modal-panel settings-tool-detail-panel relative z-10 flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-border/60 bg-background shadow-2xl"
      >
        <div className="settings-tool-drawer-handle hidden justify-center pt-2.5">
          <div className="h-1 w-9 rounded-full bg-muted-foreground/25" />
        </div>

        <div className="settings-modal-header flex items-start gap-3 border-b border-border/40 px-6 py-4">
          <div
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${accent.iconBg} ${accent.icon}`}
          >
            <Icon className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-base font-semibold">
              {name}
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-medium leading-none ${accent.chipBg} ${accent.chipText}`}
              >
                {t(isBuiltin ? "settings.toolBadgeBuiltin" : "settings.toolBadgeCustom")}
              </span>
              {readOnly ? (
                <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium leading-none text-emerald-500">
                  {t("settings.toolDetailReadOnly")}
                </span>
              ) : null}
              {conditional ? (
                <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium leading-none text-amber-500">
                  {t("settings.toolConditionalNote")}
                </span>
              ) : null}
            </div>
          </div>
          <button
            type="button"
            onClick={requestClose}
            title={t("settings.toolDetailClose")}
            aria-label={t("settings.toolDetailClose")}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="settings-modal-body flex-1 space-y-5 overflow-y-auto px-6 py-5">
          <p className="text-sm leading-relaxed text-muted-foreground">{detailText}</p>

          <div className="divide-y divide-border/40 rounded-xl border border-border/50 bg-muted/20">
            <ToolMetaRow label={t("settings.toolDetailIdentifier")}>
              <code className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-foreground/80">
                {identifier}
              </code>
            </ToolMetaRow>
            <ToolMetaRow label={t("settings.toolDetailCategory")}>
              <span className="text-foreground/80">{categoryLabel}</span>
            </ToolMetaRow>
            <ToolMetaRow label={t("settings.toolDetailScopes")}>
              <span className="flex flex-wrap justify-end gap-1">
                {runtimeScopes.map((scope) => (
                  <span
                    key={scope}
                    className="rounded-full bg-muted/70 px-2 py-0.5 text-[10px] leading-none text-muted-foreground"
                  >
                    {t(scope === "chat" ? "settings.toolScopeChat" : "settings.toolScopeCron")}
                  </span>
                ))}
              </span>
            </ToolMetaRow>
            <ToolMetaRow label={t("settings.toolDetailAccess")}>
              <span className={readOnly ? "text-emerald-500" : "text-foreground/80"}>
                {t(readOnly ? "settings.toolDetailReadOnly" : "settings.toolDetailReadWrite")}
              </span>
            </ToolMetaRow>
          </div>

          {detail.kind === "custom" ? (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-border/50 bg-muted/20 px-4 py-3">
              <span className="text-xs font-medium text-foreground/80">
                {t("settings.toolDetailEnableInChat")}
              </span>
              <AgentActivationSwitch
                checked={props.enabled}
                title={t("settings.toolDetailEnableInChat")}
                onToggle={props.onToggleEnabled}
              />
            </div>
          ) : null}
        </div>

        <div className="settings-modal-footer flex justify-end border-t border-border/40 px-6 py-4">
          <Button variant="outline" size="sm" onClick={requestClose}>
            {t("settings.toolDetailClose")}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ToolMetaRow(props: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-2.5 text-xs">
      <span className="shrink-0 text-muted-foreground">{props.label}</span>
      {props.children}
    </div>
  );
}
