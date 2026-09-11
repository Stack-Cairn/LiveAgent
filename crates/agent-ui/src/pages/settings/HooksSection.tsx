import type { SettingsSectionProps } from "@liveagent/app/pages/settings/types";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronDown,
  Circle,
  Globe,
  MessageSquare,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Terminal,
  Trash2,
  Wrench,
  Zap,
} from "@liveagent/ui/components/IconSet";
import { SettingsNotice } from "@liveagent/ui/components/settings/SettingsNotice";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  applyHookOps,
  HOOK_EVENT_DESCRIPTION_TRANSLATION_KEYS,
  HOOK_EVENT_TRANSLATION_KEYS,
  type HookDef,
  type HookEvent,
  type HookType,
  useAutomation,
} from "@liveagent/ui/lib/automation/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { type ReactNode, useState } from "react";
import { Button } from "../../components/ui/button";
import { HookModal } from "./HookModal";
import { AgentActivationSwitch, ConfirmDeletePopover } from "./shared";

type LifecyclePhase = {
  key: string;
  label: string;
  description: string;
  color: string;
  bgColor: string;
  borderColor: string;
  dotColor: string;
  icon: ReactNode;
};

type PhaseGroup = {
  phase: LifecyclePhase;
  items: { event: HookEvent; index: number }[];
};

/** Conversation-order event flow; the single source for the lifecycle rail. */
const EVENT_FLOW: { event: HookEvent; phaseKey: string }[] = [
  { event: "agent_start", phaseKey: "agent" },
  { event: "turn_start", phaseKey: "turn" },
  { event: "message_start", phaseKey: "message" },
  { event: "message_end", phaseKey: "message" },
  { event: "tool_execution_start", phaseKey: "tool" },
  { event: "tool_execution_end", phaseKey: "tool" },
  { event: "turn_end", phaseKey: "turn" },
  { event: "agent_end", phaseKey: "agent" },
];

function getHookEventLabel(t: (key: string) => string, event: HookEvent) {
  return t(HOOK_EVENT_TRANSLATION_KEYS[event]);
}

function getHookTypeTone(type: HookType) {
  return type === "command"
    ? "bg-blue-500/10 text-blue-600 dark:text-blue-300"
    : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300";
}

export function HooksSection(_props: SettingsSectionProps) {
  const { t } = useLocale();
  const [activeEvent, setActiveEvent] = useState<HookEvent>(EVENT_FLOW[0].event);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingHook, setEditingHook] = useState<HookDef | null>(null);
  const [collapsedPhases, setCollapsedPhases] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);

  const { hooks: hooksSnapshot } = useAutomation();
  const hooks = hooksSnapshot.hooks;
  const activeHooks = hooks.filter((hook) => hook.event === activeEvent);
  const enabledCount = hooks.filter((hook) => hook.enabled).length;
  const disabledCount = hooks.length - enabledCount;

  const phasesByKey: Record<string, LifecyclePhase> = {
    agent: {
      key: "agent",
      label: t("settings.hooksPhaseAgent"),
      description: t("settings.hooksPhaseAgentDesc"),
      color: "text-violet-500",
      bgColor: "bg-violet-500/10",
      borderColor: "border-violet-500/20",
      dotColor: "bg-violet-500",
      icon: <Bot className="size-3.5" />,
    },
    turn: {
      key: "turn",
      label: t("settings.hooksPhaseTurn"),
      description: t("settings.hooksPhaseTurnDesc"),
      color: "text-blue-500",
      bgColor: "bg-blue-500/10",
      borderColor: "border-blue-500/20",
      dotColor: "bg-blue-500",
      icon: <RefreshCw className="size-3.5" />,
    },
    message: {
      key: "message",
      label: t("settings.hooksPhaseMessage"),
      description: t("settings.hooksPhaseMessageDesc"),
      color: "text-emerald-500",
      bgColor: "bg-emerald-500/10",
      borderColor: "border-emerald-500/20",
      dotColor: "bg-emerald-500",
      icon: <MessageSquare className="size-3.5" />,
    },
    tool: {
      key: "tool",
      label: t("settings.hooksPhaseTool"),
      description: t("settings.hooksPhaseToolDesc"),
      color: "text-amber-500",
      bgColor: "bg-amber-500/10",
      borderColor: "border-amber-500/20",
      dotColor: "bg-amber-500",
      icon: <Wrench className="size-3.5" />,
    },
  };

  const orderedEvents = EVENT_FLOW.map(({ event, phaseKey }) => ({
    event,
    phase: phasesByKey[phaseKey],
  }));

  function togglePhase(key: string) {
    setCollapsedPhases((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function closeModal() {
    setModalOpen(false);
    setEditingHook(null);
  }

  function openAdd() {
    setEditingHook(null);
    setModalOpen(true);
  }

  function openEdit(hook: HookDef) {
    setEditingHook(hook);
    setActiveEvent(hook.event);
    setModalOpen(true);
  }

  function runOps(run: () => Promise<unknown>) {
    setActionError(null);
    void run().catch((error) => {
      setActionError(error instanceof Error ? error.message : String(error));
    });
  }

  async function handleSave(data: Omit<HookDef, "id">) {
    setActionError(null);
    if (editingHook) {
      await applyHookOps([{ op: "update", id: editingHook.id, patch: { ...data } }]);
    } else {
      await applyHookOps([{ op: "create", item: { ...data } }]);
    }
  }

  function toggleHook(hook: HookDef) {
    runOps(() => applyHookOps([{ op: "update", id: hook.id, patch: { enabled: !hook.enabled } }]));
  }

  function deleteHook(hookId: string) {
    runOps(() => applyHookOps([{ op: "delete", id: hookId }]));
  }

  const phaseGroups: PhaseGroup[] = [];
  let currentGroup: PhaseGroup | null = null;

  for (let index = 0; index < orderedEvents.length; index += 1) {
    const { event, phase } = orderedEvents[index];
    if (!currentGroup || currentGroup.phase.key !== phase.key) {
      currentGroup = { phase, items: [] };
      phaseGroups.push(currentGroup);
    }
    currentGroup.items.push({ event, index });
  }

  return (
    <div
      className={cn(
        "flex h-full flex-col gap-5",
        "web:max-820:h-auto web:max-820:min-h-0 web:max-820:gap-12px web:max-820:overflow-visible web:max-820:pb-settings-hooks-section-pb",
      )}
    >
      <div
        className={cn(
          "shrink-0 flex flex-col gap-4",
          "rounded-2xl border border-border/60 bg-card p-5",
          "lg:flex-row lg:items-center lg:justify-between web:max-820:p-14px web:max-820:gap-12px",
        )}
      >
        <div className="settings-section-title-group flex items-start gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-amber-500/10 text-amber-500">
            <Zap className="size-5" />
          </div>
          <div>
            <h2 className="text-base font-semibold">{t("settings.hooksTitle")}</h2>
            <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">
              {t("settings.hooksDesc")}
            </p>
          </div>
        </div>
        <div className="settings-section-actions flex flex-wrap items-center gap-3 web:max-820:gap-8px web:max-520:w-full">
          <div
            className={cn(
              "settings-hooks-stat flex items-center gap-1.5",
              "rounded-lg border border-border/60 bg-background/80 px-3 py-1.5",
            )}
          >
            <Zap className="size-3.5 text-muted-foreground" />
            <span className="settings-hooks-stat-label text-xs font-medium text-muted-foreground">
              {t("settings.hooksTotalHooks")}
            </span>
            <span className="settings-hooks-stat-value ml-0.5 text-sm font-bold tabular-nums">
              {hooks.length}
            </span>
          </div>
          <div
            className={cn(
              "settings-hooks-stat flex items-center gap-1.5",
              "rounded-lg border border-success/20 bg-success/5 px-3 py-1.5",
            )}
          >
            <CheckCircle2 className="size-3.5 text-success" />
            <span className="settings-hooks-stat-label text-xs font-medium text-success">
              {t("settings.hooksActiveHooks")}
            </span>
            <span className="settings-hooks-stat-value ml-0.5 text-sm font-bold tabular-nums text-success">
              {enabledCount}
            </span>
          </div>
          {disabledCount > 0 ? (
            <div
              className={cn(
                "settings-hooks-stat flex items-center gap-1.5",
                "rounded-lg border border-border/60 bg-muted/30 px-3 py-1.5",
              )}
            >
              <Circle className="size-3.5 text-muted-foreground" />
              <span className="settings-hooks-stat-label text-xs font-medium text-muted-foreground">
                {t("settings.hooksInactiveHooks")}
              </span>
              <span className="settings-hooks-stat-value ml-0.5 text-sm font-bold tabular-nums text-muted-foreground">
                {disabledCount}
              </span>
            </div>
          ) : null}
        </div>
      </div>

      {actionError ? (
        <SettingsNotice variant="action-error" className="shrink-0">
          <AlertTriangle className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{actionError}</span>
        </SettingsNotice>
      ) : null}

      <div
        className={cn(
          "grid min-h-0 flex-1 gap-5",
          "xl:grid-cols-settings-navigation web:max-820:flex web:max-820:flex-none web:max-820:flex-col web:max-820:min-h-0 web:max-820:grid-cols-settings-cron-type-grid web:max-820:gap-12px web:max-820:overflow-visible",
        )}
      >
        <aside
          className={cn(
            "flex flex-col overflow-hidden",
            "rounded-2xl border border-border/60 bg-card",
            "web:max-820:flex-none web:max-820:max-h-none web:max-820:overflow-visible web:max-640:max-h-none",
          )}
        >
          <div className="shrink-0 border-b border-border/40 px-4 py-3 web:max-820:px-12px web:max-820:py-8px">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Play className="size-4 text-muted-foreground" />
              {t("settings.hooksLifecycle")}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2 web:max-820:flex-none web:max-820:overflow-visible web:max-820:p-6px">
            {phaseGroups.map((group, groupIndex) => {
              const phaseHookCount = group.items.reduce(
                (sum, { event }) => sum + hooks.filter((hook) => hook.event === event).length,
                0,
              );
              const groupKey = `${group.phase.key}-${groupIndex}`;
              const isCollapsed = collapsedPhases.has(groupKey);

              return (
                <div key={groupKey} className="settings-hooks-phase-group mb-1 last:mb-0">
                  <button
                    type="button"
                    onClick={() => togglePhase(groupKey)}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left",
                      "transition-colors hover:bg-muted/40 web:max-820:px-8px web:max-820:py-6px web:max-820:rounded-10px",
                      group.phase.color,
                    )}
                  >
                    <div
                      className={cn(
                        "flex size-7 items-center justify-center rounded-lg",
                        group.phase.bgColor,
                      )}
                    >
                      {group.phase.icon}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold uppercase tracking-wide">
                          {group.phase.label}
                        </span>
                        {phaseHookCount > 0 ? (
                          <span
                            className={cn(
                              "rounded-full px-1.5 py-0.5 text-tiny font-semibold leading-none",
                              group.phase.bgColor,
                            )}
                          >
                            {phaseHookCount}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <ChevronDown
                      className={cn(
                        "size-3.5 text-muted-foreground transition-transform",
                        isCollapsed ? "-rotate-90" : "",
                      )}
                    />
                  </button>

                  {!isCollapsed ? (
                    <div className="relative ml-3 mt-0.5 web:max-820:ml-16px web:max-820:pb-2px web:max-820:pt-2px">
                      <span
                        aria-hidden
                        className={cn(
                          "settings-hooks-event-rail pointer-events-none absolute left-3 inset-y-2 w-2px -translate-x-1/2",
                          "rounded-full bg-border/40",
                        )}
                      />
                      <ul className="space-y-0.5">
                        {group.items.map(({ event }) => {
                          const eventHooks = hooks.filter((hook) => hook.event === event);
                          const selected = activeEvent === event;
                          const hasHooks = eventHooks.length > 0;

                          return (
                            <li key={event}>
                              <button
                                type="button"
                                onClick={() => setActiveEvent(event)}
                                className={cn(
                                  "group relative flex w-full items-center gap-2.5 rounded-lg",
                                  "py-2 pl-7 pr-2.5 text-left transition-all",
                                  "web:max-820:min-h-32px web:max-820:pl-30px web:max-820:pr-10px web:max-820:py-7px",
                                  selected ? "bg-primary/10 shadow-sm" : "hover:bg-muted/30",
                                )}
                              >
                                <span
                                  aria-hidden
                                  className="settings-hooks-event-dot pointer-events-none absolute left-3 top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2"
                                >
                                  {selected ? (
                                    <span
                                      aria-hidden
                                      className={cn(
                                        "settings-hooks-event-dot-halo absolute left-1/2 top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full",
                                        group.phase.dotColor,
                                        "opacity-25",
                                      )}
                                    />
                                  ) : null}
                                  <span
                                    className={cn(
                                      "settings-hooks-event-dot-core relative block size-full",
                                      "rounded-full ring-2 ring-card transition-all duration-200",
                                      selected
                                        ? group.phase.dotColor
                                        : hasHooks
                                          ? `${group.phase.dotColor} opacity-80`
                                          : "border border-border/60 bg-card",
                                    )}
                                  />
                                </span>

                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-1.5">
                                    <span
                                      className={cn(
                                        "text-sm font-medium transition-colors web:max-820:min-w-0",
                                        selected
                                          ? "text-foreground"
                                          : "text-muted-foreground group-hover:text-foreground",
                                      )}
                                    >
                                      {getHookEventLabel(t, event)}
                                    </span>
                                    {hasHooks ? (
                                      <span
                                        className={cn(
                                          "rounded-full px-1.5 py-0.5 text-tiny font-semibold leading-none",
                                          selected
                                            ? "bg-primary/15 text-primary"
                                            : "bg-muted/60 text-muted-foreground",
                                        )}
                                      >
                                        {eventHooks.length}
                                      </span>
                                    ) : null}
                                  </div>
                                </div>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </aside>

        <section
          className={cn(
            "flex flex-col overflow-hidden",
            "rounded-2xl border border-border/60 bg-card",
            "web:max-820:flex-none web:max-820:min-h-0 web:max-820:overflow-visible",
          )}
        >
          <div
            className={cn(
              "shrink-0 border-b border-border/40 px-5 py-4",
              "web:max-820:px-14px web:max-820:py-12px web:max-640:px-12px web:max-640:py-11px",
            )}
          >
            <div
              className={cn(
                "settings-section-heading-row flex flex-col gap-3",
                "lg:flex-row lg:items-center lg:justify-between web:max-820:flex-row! web:max-820:items-start! web:max-820:gap-10px! web:max-820:[&_.settings-section-title-group]:min-w-0 web:max-380:flex-col!",
                "web:max-380:items-stretch!",
              )}
            >
              <div className="settings-section-title-group flex items-center gap-3">
                {(() => {
                  const phase = orderedEvents.find((item) => item.event === activeEvent)?.phase;
                  if (!phase) return null;
                  return (
                    <div
                      className={cn(
                        "flex size-9 items-center justify-center rounded-xl web:max-820:size-32px web:max-820:rounded-10px",
                        phase.bgColor,
                        phase.color,
                      )}
                    >
                      {phase.icon}
                    </div>
                  );
                })()}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-base font-semibold web:max-820:text-base">
                      {getHookEventLabel(t, activeEvent)}
                    </h3>
                  </div>
                  <p className="mt-0.5 text-sm text-muted-foreground web:max-820:text-xs web:max-820:leading-1p5">
                    {t(HOOK_EVENT_DESCRIPTION_TRANSLATION_KEYS[activeEvent])}
                  </p>
                </div>
              </div>
              {activeHooks.length > 0 ? (
                <Button
                  className="settings-section-action gap-1.5 self-start web:max-820:flex-none web:max-820:self-start web:max-380:self-start"
                  onClick={openAdd}
                >
                  <Plus className="size-3.5" />
                  {t("settings.hooksAdd")}
                </Button>
              ) : null}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-5 web:max-820:flex-none web:max-820:overflow-visible web:max-820:p-12px web:max-640:p-10px">
            {activeHooks.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border/60 bg-muted/5 px-6 py-12 text-center">
                <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-muted/30">
                  <Zap className="size-6 text-muted-foreground/40" />
                </div>
                <div className="mt-4 text-sm font-medium">{t("settings.hooksEmptyTitle")}</div>
                <p className="mx-auto mt-1.5 max-w-sm text-sm leading-relaxed text-muted-foreground">
                  {t("settings.hooksEmptyDesc")}
                </p>
                <Button className="mt-5 gap-1.5" size="sm" onClick={openAdd}>
                  <Plus className="size-3.5" />
                  {t("settings.hooksAdd")}
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                {activeHooks.map((hook) => {
                  const stepCount =
                    hook.type === "command"
                      ? (hook.script ?? "").split(/\r?\n/).filter((line) => line.trim()).length
                      : (hook.requests?.length ?? 0);
                  return (
                    <div
                      key={hook.id}
                      className={cn(
                        "group rounded-xl border bg-background/80 p-4 transition-all",
                        "hover:shadow-sm web:max-820:p-12px web:max-820:rounded-12px web:max-640:p-11px",
                        hook.enabled
                          ? "border-border/60 hover:border-border"
                          : "border-border/40 opacity-60",
                      )}
                    >
                      <div
                        className={cn(
                          "settings-card-row flex items-start gap-3",
                          "web:max-820:grid web:max-820:grid-cols-settings-hooks-card-row web:max-820:items-center web:max-820:gap-10px web:max-520:grid-cols-settings-hooks-card-row-2",
                        )}
                      >
                        <div
                          className={cn(
                            "flex size-10 shrink-0 items-center justify-center rounded-xl",
                            "web:max-820:size-36px web:max-820:rounded-10px web:max-640:size-32px web:max-640:rounded-9px web:max-640:[&_svg]:size-16px",
                            getHookTypeTone(hook.type),
                          )}
                        >
                          {hook.type === "command" ? (
                            <Terminal className="size-4.5" />
                          ) : (
                            <Globe className="size-4.5" />
                          )}
                        </div>

                        <div className="min-w-0 flex-1 web:max-520:min-w-0">
                          <div className="settings-hooks-card-meta flex flex-wrap items-center gap-2">
                            <span className="truncate text-sm font-semibold web:max-820:text-sm">
                              {hook.name}
                            </span>
                            <span
                              className={cn(
                                "settings-hooks-card-badge rounded-md bg-muted/50 px-1.5 py-0.5 text-tiny font-medium tabular-nums",
                                "text-muted-foreground",
                              )}
                            >
                              {stepCount}{" "}
                              {hook.type === "command"
                                ? t("settings.hooksScriptLinesCount")
                                : t("settings.hooksRequestsCount")}
                            </span>
                          </div>
                          <p className="mt-1 text-sm leading-relaxed text-muted-foreground web:max-820:text-xs web:max-820:leading-1p5">
                            {hook.description || t("settings.hooksNoDescription")}
                          </p>
                        </div>

                        <div className="settings-card-actions settings-hooks-card-actions flex shrink-0 items-center gap-1.5">
                          <AgentActivationSwitch
                            checked={hook.enabled}
                            title={hook.enabled ? t("settings.disable") : t("settings.enable")}
                            onToggle={() => toggleHook(hook)}
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            className="text-muted-foreground hover:text-foreground"
                            title={t("settings.edit")}
                            onClick={() => openEdit(hook)}
                          >
                            <Pencil className="size-3.5" />
                          </Button>
                          <ConfirmDeletePopover
                            name={hook.name}
                            onConfirm={() => deleteHook(hook.id)}
                          >
                            {(open) => (
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                className="text-muted-foreground hover:text-destructive"
                                title={t("settings.delete")}
                                onClick={open}
                              >
                                <Trash2 className="size-3.5" />
                              </Button>
                            )}
                          </ConfirmDeletePopover>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>
      </div>

      {modalOpen ? (
        <HookModal
          event={editingHook?.event ?? activeEvent}
          initialData={editingHook ?? undefined}
          onSave={handleSave}
          onClose={closeModal}
        />
      ) : null}
    </div>
  );
}
