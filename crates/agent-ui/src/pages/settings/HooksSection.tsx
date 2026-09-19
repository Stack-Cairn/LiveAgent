import type { SettingsSectionProps } from "@liveagent/app/pages/settings/types";
import { Plus, SquarePen, Trash2 } from "@liveagent/ui/components/IconSet";
import { SettingsNotice } from "@liveagent/ui/components/settings/SettingsNotice";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  applyHookOps,
  HOOK_EVENT_DESCRIPTION_TRANSLATION_KEYS,
  HOOK_EVENT_TRANSLATION_KEYS,
  type HookDef,
  type HookEvent,
  useAutomation,
} from "@liveagent/ui/lib/automation/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import { HookModal } from "./HookModal";
import { AgentActivationSwitch, ConfirmDeletePopover } from "./shared";

/** Events in conversation lifecycle order. */
const EVENT_FLOW: HookEvent[] = [
  "agent_start",
  "turn_start",
  "message_start",
  "message_end",
  "tool_execution_start",
  "tool_execution_end",
  "turn_end",
  "agent_end",
];

function getHookEventLabel(t: (key: string) => string, event: HookEvent) {
  return t(HOOK_EVENT_TRANSLATION_KEYS[event]);
}

export function HooksSection(_props: SettingsSectionProps) {
  const { t } = useLocale();
  const [activeEvent, setActiveEvent] = useState<HookEvent>(EVENT_FLOW[0]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingHook, setEditingHook] = useState<HookDef | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const { hooks: hooksSnapshot } = useAutomation();
  const hooks = hooksSnapshot.hooks;
  const activeHooks = hooks.filter((hook) => hook.event === activeEvent);
  const enabledCount = hooks.filter((hook) => hook.enabled).length;
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

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{t("settings.hooksDesc")}</p>
        <span className="text-xs text-muted-foreground">
          {t("settings.hooksActiveHooks")} {enabledCount} / {hooks.length}
        </span>
      </div>
      {actionError ? <SettingsNotice variant="action-error">{actionError}</SettingsNotice> : null}
      <div className="grid items-start gap-6 md:grid-cols-[13rem_minmax(0,1fr)]">
        <nav
          aria-label={t("settings.hooksLifecycle")}
          className="space-y-1 rounded-xl bg-settings-tile p-2"
        >
          <p className="px-3 py-2 text-xs font-medium text-muted-foreground">
            {t("settings.hooksLifecycle")}
          </p>
          {EVENT_FLOW.map((event) => {
            const count = hooks.filter((hook) => hook.event === event).length;
            return (
              <button
                key={event}
                type="button"
                aria-pressed={activeEvent === event}
                onClick={() => setActiveEvent(event)}
                className={cn(
                  "flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-3 py-2",
                  "text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  activeEvent === event
                    ? "bg-settings-active font-medium text-foreground"
                    : "text-muted-foreground hover:bg-settings-tile-hover hover:text-foreground",
                )}
              >
                {getHookEventLabel(t, event)}
                {count > 0 ? <span className="text-xs tabular-nums">{count}</span> : null}
              </button>
            );
          })}
        </nav>
        <section className="min-w-0 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">{getHookEventLabel(t, activeEvent)}</h3>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {t(HOOK_EVENT_DESCRIPTION_TRANSLATION_KEYS[activeEvent])}
              </p>
            </div>
            <Button size="sm" onClick={openAdd}>
              <Plus className="size-3.5" />
              {t("settings.hooksAdd")}
            </Button>
          </div>
          {activeHooks.length === 0 ? (
            <div className="rounded-xl bg-settings-tile px-4 py-6">
              <p className="text-sm font-medium">{t("settings.hooksEmptyTitle")}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t("settings.hooksEmptyDesc")}</p>
            </div>
          ) : (
            activeHooks.map((hook) => (
              <div
                key={hook.id}
                className="flex flex-wrap items-center gap-3 rounded-xl bg-settings-tile p-4"
              >
                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    onClick={() => openEdit(hook)}
                    className="max-w-full cursor-pointer truncate text-left text-sm font-medium hover:underline"
                  >
                    {hook.name}
                  </button>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {hook.type === "command"
                      ? t("settings.hooksTypeCommand")
                      : t("settings.hooksTypeHttp")}
                    {hook.description ? ` · ${hook.description}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <AgentActivationSwitch
                    checked={hook.enabled}
                    title={hook.enabled ? t("settings.disable") : t("settings.enable")}
                    onToggle={() => toggleHook(hook)}
                  />
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("settings.edit")}
                    onClick={() => openEdit(hook)}
                  >
                    <SquarePen className="size-3.5" />
                  </Button>
                  <ConfirmDeletePopover name={hook.name} onConfirm={() => deleteHook(hook.id)}>
                    {(open) => (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("settings.delete")}
                        onClick={open}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    )}
                  </ConfirmDeletePopover>
                </div>
              </div>
            ))
          )}
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
