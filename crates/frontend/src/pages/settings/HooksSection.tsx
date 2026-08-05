import { type ReactNode, useState } from "react";
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
} from "../../components/icons";

import { Button } from "../../components/ui/button";
import { useLocale } from "../../i18n";
import {
  applyHookOps,
  HOOK_EVENT_DESCRIPTION_TRANSLATION_KEYS,
  HOOK_EVENT_TRANSLATION_KEYS,
  type HookDef,
  type HookEvent,
  type HookType,
  useAutomation,
} from "../../lib/automation";
import { HookModal } from "./HookModal";
import { AgentActivationSwitch, ConfirmDeletePopover } from "./shared";
import type { SettingsSectionProps } from "./types";

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
      icon: <Bot className="h-3.5 w-3.5" />,
    },
    turn: {
      key: "turn",
      label: t("settings.hooksPhaseTurn"),
      description: t("settings.hooksPhaseTurnDesc"),
      color: "text-blue-500",
      bgColor: "bg-blue-500/10",
      borderColor: "border-blue-500/20",
      dotColor: "bg-blue-500",
      icon: <RefreshCw className="h-3.5 w-3.5" />,
    },
    message: {
      key: "message",
      label: t("settings.hooksPhaseMessage"),
      description: t("settings.hooksPhaseMessageDesc"),
      color: "text-emerald-500",
      bgColor: "bg-emerald-500/10",
      borderColor: "border-emerald-500/20",
      dotColor: "bg-emerald-500",
      icon: <MessageSquare className="h-3.5 w-3.5" />,
    },
    tool: {
      key: "tool",
      label: t("settings.hooksPhaseTool"),
      description: t("settings.hooksPhaseToolDesc"),
      color: "text-amber-500",
      bgColor: "bg-amber-500/10",
      borderColor: "border-amber-500/20",
      dotColor: "bg-amber-500",
      icon: <Wrench className="h-3.5 w-3.5" />,
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
    <div className="settings-hooks-section flex h-full flex-col gap-5">
      <div className="settings-section-hero shrink-0 flex flex-col gap-4 rounded-2xl border border-border/60 bg-card p-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="settings-section-title-group flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500/10 text-amber-500">
            <Zap className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-base font-semibold">{t("settings.hooksTitle")}</h2>
            <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">
              {t("settings.hooksDesc")}
            </p>
          </div>
        </div>
        <div className="settings-section-actions settings-hooks-stats flex flex-wrap items-center gap-3">
          <div className="settings-hooks-stat flex items-center gap-1.5 rounded-lg border border-border/60 bg-background/80 px-3 py-1.5">
            <Zap className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="settings-hooks-stat-label text-xs font-medium text-muted-foreground">
              {t("settings.hooksTotalHooks")}
            </span>
            <span className="settings-hooks-stat-value ml-0.5 text-sm font-bold tabular-nums">
              {hooks.length}
            </span>
          </div>
          <div className="settings-hooks-stat flex items-center gap-1.5 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-1.5">
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
            <span className="settings-hooks-stat-label text-xs font-medium text-emerald-600 dark:text-emerald-400">
              {t("settings.hooksActiveHooks")}
            </span>
            <span className="settings-hooks-stat-value ml-0.5 text-sm font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
              {enabledCount}
            </span>
          </div>
          {disabledCount > 0 ? (
            <div className="settings-hooks-stat flex items-center gap-1.5 rounded-lg border border-border/60 bg-muted/30 px-3 py-1.5">
              <Circle className="h-3.5 w-3.5 text-muted-foreground" />
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
        <div className="flex shrink-0 items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-xs text-destructive">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{actionError}</span>
        </div>
      ) : null}

      <div className="settings-hooks-grid grid min-h-0 flex-1 gap-5 xl:grid-cols-[300px_minmax(0,1fr)]">
        <aside className="settings-hooks-lifecycle flex flex-col overflow-hidden rounded-2xl border border-border/60 bg-card">
          <div className="settings-hooks-lifecycle-header shrink-0 border-b border-border/40 px-4 py-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Play className="h-4 w-4 text-muted-foreground" />
              {t("settings.hooksLifecycle")}
            </div>
          </div>
          <div className="settings-hooks-lifecycle-body min-h-0 flex-1 overflow-y-auto p-2">
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
                    className={`settings-hooks-phase-button flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left transition-colors hover:bg-muted/40 ${group.phase.color}`}
                  >
                    <div
                      className={`flex h-7 w-7 items-center justify-center rounded-lg ${group.phase.bgColor}`}
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
                            className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none ${group.phase.bgColor}`}
                          >
                            {phaseHookCount}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <ChevronDown
                      className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${
                        isCollapsed ? "-rotate-90" : ""
                      }`}
                    />
                  </button>

                  {!isCollapsed ? (
                    <div className="settings-hooks-event-tree relative ml-3 mt-0.5">
                      <span
                        aria-hidden
                        className="settings-hooks-event-rail pointer-events-none absolute left-3 top-2 bottom-2 w-[2px] -translate-x-1/2 rounded-full bg-border/40"
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
                                className={`settings-hooks-event-button group relative flex w-full items-center gap-2.5 rounded-lg py-2 pl-7 pr-2.5 text-left transition-all ${
                                  selected ? "bg-primary/10 shadow-sm" : "hover:bg-muted/30"
                                }`}
                              >
                                <span
                                  aria-hidden
                                  className="settings-hooks-event-dot pointer-events-none absolute left-3 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2"
                                >
                                  {selected ? (
                                    <span
                                      aria-hidden
                                      className={`settings-hooks-event-dot-halo absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full ${group.phase.dotColor} opacity-25`}
                                    />
                                  ) : null}
                                  <span
                                    className={`settings-hooks-event-dot-core relative block h-full w-full rounded-full ring-2 ring-card transition-all duration-200 ${
                                      selected
                                        ? group.phase.dotColor
                                        : hasHooks
                                          ? `${group.phase.dotColor} opacity-80`
                                          : "border border-border/60 bg-card"
                                    }`}
                                  />
                                </span>

                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-1.5">
                                    <span
                                      className={`settings-hooks-event-label text-[13px] font-medium transition-colors ${
                                        selected
                                          ? "text-foreground"
                                          : "text-muted-foreground group-hover:text-foreground"
                                      }`}
                                    >
                                      {getHookEventLabel(t, event)}
                                    </span>
                                    {hasHooks ? (
                                      <span
                                        className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none ${
                                          selected
                                            ? "bg-primary/15 text-primary"
                                            : "bg-muted/60 text-muted-foreground"
                                        }`}
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

        <section className="settings-hooks-detail flex flex-col overflow-hidden rounded-2xl border border-border/60 bg-card">
          <div className="settings-hooks-detail-header shrink-0 border-b border-border/40 px-5 py-4">
            <div className="settings-section-heading-row flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="settings-section-title-group flex items-center gap-3">
                {(() => {
                  const phase = orderedEvents.find((item) => item.event === activeEvent)?.phase;
                  if (!phase) return null;
                  return (
                    <div
                      className={`settings-hooks-detail-icon flex h-9 w-9 items-center justify-center rounded-xl ${phase.bgColor} ${phase.color}`}
                    >
                      {phase.icon}
                    </div>
                  );
                })()}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="settings-hooks-detail-title text-base font-semibold">
                      {getHookEventLabel(t, activeEvent)}
                    </h3>
                  </div>
                  <p className="settings-hooks-detail-desc mt-0.5 text-sm text-muted-foreground">
                    {t(HOOK_EVENT_DESCRIPTION_TRANSLATION_KEYS[activeEvent])}
                  </p>
                </div>
              </div>
              <Button className="settings-section-action gap-1.5 self-start" onClick={openAdd}>
                <Plus className="h-3.5 w-3.5" />
                {t("settings.hooksAdd")}
              </Button>
            </div>
          </div>

          <div className="settings-hooks-detail-body min-h-0 flex-1 overflow-y-auto p-5">
            {activeHooks.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border/60 bg-muted/5 px-6 py-12 text-center">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-muted/30">
                  <Zap className="h-6 w-6 text-muted-foreground/40" />
                </div>
                <div className="mt-4 text-sm font-medium">{t("settings.hooksEmptyTitle")}</div>
                <p className="mx-auto mt-1.5 max-w-sm text-sm leading-relaxed text-muted-foreground">
                  {t("settings.hooksEmptyDesc")}
                </p>
                <Button className="mt-5 gap-1.5" size="sm" onClick={openAdd}>
                  <Plus className="h-3.5 w-3.5" />
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
                      className={`settings-hooks-card group rounded-xl border bg-background/80 p-4 transition-all hover:shadow-sm ${
                        hook.enabled
                          ? "border-border/60 hover:border-border"
                          : "border-border/40 opacity-60"
                      }`}
                    >
                      <div className="settings-card-row settings-hooks-card-row flex items-start gap-3">
                        <div
                          className={`settings-hooks-card-icon flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${getHookTypeTone(hook.type)}`}
                        >
                          {hook.type === "command" ? (
                            <Terminal className="h-4.5 w-4.5" />
                          ) : (
                            <Globe className="h-4.5 w-4.5" />
                          )}
                        </div>

                        <div className="settings-hooks-card-main min-w-0 flex-1">
                          <div className="settings-hooks-card-meta flex flex-wrap items-center gap-2">
                            <span className="settings-hooks-card-name truncate text-sm font-semibold">
                              {hook.name}
                            </span>
                            <span className="settings-hooks-card-badge rounded-md bg-muted/50 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
                              {stepCount}{" "}
                              {hook.type === "command"
                                ? t("settings.hooksScriptLinesCount")
                                : t("settings.hooksRequestsCount")}
                            </span>
                          </div>
                          <p className="settings-hooks-card-desc mt-1 text-sm leading-relaxed text-muted-foreground">
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
                            size="icon"
                            className="h-8 w-8 text-muted-foreground hover:text-foreground"
                            title={t("settings.edit")}
                            onClick={() => openEdit(hook)}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <ConfirmDeletePopover
                            name={hook.name}
                            onConfirm={() => deleteHook(hook.id)}
                          >
                            {(open) => (
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                                title={t("settings.delete")}
                                onClick={open}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
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
