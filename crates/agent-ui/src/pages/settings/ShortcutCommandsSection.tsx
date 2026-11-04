import { AlertTriangle, RotateCcw, X } from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { useLocale } from "@liveagent/ui/i18n/index";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isMacLikePlatform } from "../../lib/shared/platform";
import { cn } from "../../lib/shared/utils";
import {
  findShortcutConflicts,
  getShortcutBinding,
  SHORTCUT_COMMAND_GROUP_ORDER,
  SHORTCUT_COMMANDS,
  type ShortcutCommand,
  type ShortcutCommandId,
  useShortcutOverrides,
  writeShortcutOverrides,
} from "../../lib/shortcuts/shortcutCommands";
import {
  acceleratorFromEvent,
  formatShortcutLabel,
  globalShortcutDisplayToken,
  modifierFromEventCode,
  resolveAccelerator,
  type ShortcutModifier,
  setInAppShortcutsSuspended,
  shortcutDisplayTokens,
} from "../../lib/shortcuts/shortcutKeys";

/** A binding owned elsewhere (desktop system-wide hotkeys) that app commands must not reuse. */
export type ExternalShortcutBinding = { id: string; label: string; accelerator: string };

export type ShortcutCommandsSectionProps = {
  /** Commands the host does not implement (e.g. find in conversation on the WebUI). */
  excludeCommandIds?: readonly ShortcutCommandId[];
  externalBindings?: readonly ExternalShortcutBinding[];
  /** Hosts with their own key listeners suspend them while a binding is recorded. */
  onRecordingChange?: (recording: boolean) => void;
  isMac?: boolean;
};

type Status = { kind: "ok" | "error"; text: string } | null;

function format(template: string, values: Record<string, string>) {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, value),
    template,
  );
}

function ShortcutKeyTokens({ tokens }: { tokens: readonly string[] }) {
  return tokens.map((token, index) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: a chord can repeat a glyph only by position
    <span key={`${token}-${index}`} className="flex items-center gap-1">
      {index > 0 ? <span className="text-xs text-muted-foreground">+</span> : null}
      <kbd className="rounded-md bg-settings-tile px-1.5 py-0.5 font-sans text-xs text-foreground">
        {token}
      </kbd>
    </span>
  ));
}

/**
 * Lists every in-app shortcut command with its binding: click a binding to
 * record a new chord, clear it, or reset it to the default. Conflicting
 * bindings are flagged, and recording a chord already in use is refused.
 */
export function ShortcutCommandsSection({
  excludeCommandIds = [],
  externalBindings = [],
  onRecordingChange,
  isMac: isMacProp,
}: ShortcutCommandsSectionProps) {
  const { t } = useLocale();
  const isMac = useMemo(() => isMacProp ?? isMacLikePlatform(), [isMacProp]);
  const overrides = useShortcutOverrides();
  const [recording, setRecording] = useState<ShortcutCommandId | null>(null);
  const [draftModifiers, setDraftModifiers] = useState<ShortcutModifier[]>([]);
  const [status, setStatus] = useState<Status>(null);

  const commands = useMemo(
    () => SHORTCUT_COMMANDS.filter((command) => !excludeCommandIds.includes(command.id)),
    [excludeCommandIds],
  );
  const labelFor = useCallback(
    (id: string) => {
      const command = commands.find((entry) => entry.id === id);
      if (command) return t(command.labelKey);
      return externalBindings.find((entry) => entry.id === id)?.label ?? id;
    },
    [commands, externalBindings, t],
  );
  const allBindings = useMemo(
    () => [
      ...commands.map((command) => ({
        id: command.id as string,
        accelerator: getShortcutBinding(command.id, overrides),
      })),
      ...externalBindings.map(({ id, accelerator }) => ({ id, accelerator })),
    ],
    [commands, externalBindings, overrides],
  );
  const conflicts = useMemo(() => findShortcutConflicts(allBindings, isMac), [allBindings, isMac]);

  const recordingRef = useRef(recording);
  recordingRef.current = recording;
  const onRecordingChangeRef = useRef(onRecordingChange);
  onRecordingChangeRef.current = onRecordingChange;

  const setRecordingState = useCallback((next: ShortcutCommandId | null) => {
    recordingRef.current = next;
    setRecording(next);
    setDraftModifiers([]);
    setInAppShortcutsSuspended(next !== null);
    onRecordingChangeRef.current?.(next !== null);
  }, []);

  const saveBinding = useCallback(
    (command: ShortcutCommand, accelerator: string) => {
      const next = { ...overrides };
      const defaultBinding = command.defaultBinding
        ? resolveAccelerator(command.defaultBinding, isMac)
        : "";
      if (resolveAccelerator(accelerator, isMac) === defaultBinding) delete next[command.id];
      else next[command.id] = accelerator;
      writeShortcutOverrides(next);
    },
    [isMac, overrides],
  );

  const commitRecording = useCallback(
    (accelerator: string) => {
      const id = recordingRef.current;
      const command = commands.find((entry) => entry.id === id);
      setRecordingState(null);
      if (!command) return;
      const chord = resolveAccelerator(accelerator, isMac);
      const taken = allBindings.find(
        (entry) =>
          entry.id !== command.id && resolveAccelerator(entry.accelerator, isMac) === chord,
      );
      if (taken) {
        setStatus({
          kind: "error",
          text: format(t("shortcuts.rejectedConflict"), {
            keys: formatShortcutLabel(accelerator, isMac),
            name: labelFor(taken.id),
          }),
        });
        return;
      }
      saveBinding(command, accelerator);
      setStatus({ kind: "ok", text: t("shortcuts.saved") });
    },
    [allBindings, commands, isMac, labelFor, saveBinding, setRecordingState, t],
  );

  useEffect(() => {
    if (!recording) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      if (
        event.code === "Escape" &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey
      ) {
        setRecordingState(null);
        return;
      }
      if (modifierFromEventCode(event.code)) {
        const modifiers: ShortcutModifier[] = [];
        if (event.ctrlKey) modifiers.push("Ctrl");
        if (event.shiftKey) modifiers.push("Shift");
        if (event.altKey) modifiers.push("Alt");
        if (event.metaKey) modifiers.push("Super");
        setDraftModifiers(modifiers);
        return;
      }
      const accelerator = acceleratorFromEvent(event);
      if (accelerator) commitRecording(accelerator);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!modifierFromEventCode(event.code)) return;
      const modifiers: ShortcutModifier[] = [];
      if (event.ctrlKey) modifiers.push("Ctrl");
      if (event.shiftKey) modifiers.push("Shift");
      if (event.altKey) modifiers.push("Alt");
      if (event.metaKey) modifiers.push("Super");
      setDraftModifiers(modifiers);
    };
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(`[data-shortcut-record="${recordingRef.current}"]`)) return;
      setRecordingState(null);
    };
    const onBlur = () => setRecordingState(null);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [commitRecording, recording, setRecordingState]);

  // Never leave shortcuts suspended when the section unmounts mid-recording.
  useEffect(
    () => () => {
      if (recordingRef.current) {
        setInAppShortcutsSuspended(false);
        onRecordingChangeRef.current?.(false);
      }
    },
    [],
  );

  const hasOverrides = commands.some((command) => overrides[command.id] !== undefined);
  const resetAll = () => {
    const next = { ...overrides };
    for (const command of commands) delete next[command.id];
    writeShortcutOverrides(next);
    setStatus({ kind: "ok", text: t("shortcuts.saved") });
  };

  return (
    <section className="space-y-3" data-shortcut-commands="">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <h3 className="text-sm font-medium">{t("shortcuts.inAppTitle")}</h3>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t("shortcuts.inAppDesc")}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!hasOverrides}
          onClick={resetAll}
          data-shortcut-reset-all=""
        >
          <RotateCcw className="size-3.5" />
          {t("shortcuts.resetAll")}
        </Button>
      </div>
      {SHORTCUT_COMMAND_GROUP_ORDER.map((group) => {
        const groupCommands = commands.filter((command) => command.group === group);
        if (groupCommands.length === 0) return null;
        return (
          <div key={group} className="space-y-2">
            <div className="px-1 text-xs font-medium text-muted-foreground">
              {t(`shortcuts.group.${group}`)}
            </div>
            {groupCommands.map((command) => {
              const label = t(command.labelKey);
              const binding = getShortcutBinding(command.id, overrides);
              const isRecording = recording === command.id;
              const overridden = overrides[command.id] !== undefined;
              const conflictNames = (conflicts.get(command.id) ?? []).map(labelFor);
              const tokens = isRecording
                ? draftModifiers.map((modifier) => globalShortcutDisplayToken(modifier, isMac))
                : shortcutDisplayTokens(binding, isMac);
              const defaultLabel = command.defaultBinding
                ? formatShortcutLabel(command.defaultBinding, isMac)
                : t("shortcuts.notAssigned");
              return (
                <div
                  key={command.id}
                  data-shortcut-command={command.id}
                  className={cn(
                    "flex min-h-12 w-full flex-wrap items-center gap-3 rounded-xl px-4 py-2.5",
                    isRecording ? "bg-settings-active" : "bg-settings-tile",
                  )}
                >
                  <div className="min-w-32 flex-1">
                    <div className="text-sm font-medium">{label}</div>
                    {conflictNames.length > 0 ? (
                      <div
                        className="mt-0.5 flex items-center gap-1 text-xs text-destructive"
                        data-shortcut-conflict=""
                      >
                        <AlertTriangle className="size-3 shrink-0" />
                        {format(t("shortcuts.conflictWith"), { names: conflictNames.join(", ") })}
                      </div>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    data-shortcut-record={command.id}
                    aria-pressed={isRecording}
                    aria-label={`${label} · ${t("shortcuts.record")}`}
                    title={t("shortcuts.record")}
                    onClick={() => {
                      setStatus(null);
                      setRecordingState(isRecording ? null : command.id);
                    }}
                    className={cn(
                      "flex min-h-8 w-48 shrink-0 flex-wrap items-center justify-end gap-1 rounded-lg bg-background px-2.5 py-1.5",
                      "cursor-pointer shadow-sm hover:bg-background/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25",
                    )}
                  >
                    {tokens.length > 0 ? <ShortcutKeyTokens tokens={tokens} /> : null}
                    {isRecording ? (
                      <span className="text-xs text-primary">{t("shortcuts.recording")}</span>
                    ) : tokens.length === 0 ? (
                      <span className="text-xs text-muted-foreground">
                        {t("shortcuts.notAssigned")}
                      </span>
                    ) : null}
                  </button>
                  <div className="flex w-16 shrink-0 items-center justify-end gap-1">
                    {binding && !isRecording ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        data-shortcut-clear={command.id}
                        title={t("shortcuts.clear")}
                        aria-label={`${label} · ${t("shortcuts.clear")}`}
                        onClick={() => {
                          setStatus(null);
                          saveBinding(command, "");
                        }}
                      >
                        <X className="size-3.5" />
                      </Button>
                    ) : null}
                    {overridden && !isRecording ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        data-shortcut-reset={command.id}
                        title={format(t("shortcuts.resetTo"), { keys: defaultLabel })}
                        aria-label={`${label} · ${format(t("shortcuts.resetTo"), { keys: defaultLabel })}`}
                        onClick={() => {
                          const next = { ...overrides };
                          delete next[command.id];
                          writeShortcutOverrides(next);
                          setStatus(null);
                        }}
                      >
                        <RotateCcw className="size-3.5" />
                      </Button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
      {status ? (
        <div
          role="status"
          className={cn(
            "text-xs font-medium",
            status.kind === "ok" ? "text-emerald-600 dark:text-emerald-400" : "text-destructive",
          )}
        >
          {status.text}
        </div>
      ) : null}
    </section>
  );
}
