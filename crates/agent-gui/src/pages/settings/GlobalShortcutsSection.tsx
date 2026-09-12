import { X } from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { Switch } from "@liveagent/ui/components/ui/switch";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  readSendShortcut,
  type SendShortcut,
  writeSendShortcut,
} from "@liveagent/ui/lib/chat/sendShortcut";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { AgentActivationSwitch } from "@liveagent/ui/pages/settings/shared";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { inferRuntimePlatform } from "../../lib/runtimePlatform";
import {
  applyGlobalShortcuts,
  GLOBAL_SHORTCUT_ACTIONS,
  type GlobalShortcutAction,
  type GlobalShortcutBindings,
  type GlobalShortcutFailure,
  globalShortcutDisplayToken,
  globalShortcutKeyDisplayLabel,
  modifierFromEventCode,
  readGlobalShortcutBindings,
  type ShortcutModifier,
  type ShortcutScope,
  setShortcutsSuspended,
  writeGlobalShortcutBindings,
} from "../../lib/shortcuts/globalShortcuts";

const IS_MAC = inferRuntimePlatform() === "macos";

function displayToken(token: string): string {
  return globalShortcutDisplayToken(token, IS_MAC);
}

interface ShortcutDraft {
  mods: ShortcutModifier[];
  main: string | null;
}

const SHORTCUT_KEY_BUTTON_CLASS = cn(
  "flex min-h-8 w-48 shrink-0 flex-wrap items-center justify-end gap-1.5 rounded-lg bg-background px-2.5 py-1.5",
  "cursor-pointer shadow-sm hover:bg-background/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25",
);

function ShortcutRow({
  id,
  label,
  description,
  editing = false,
  onEdit,
  children,
}: {
  id: string;
  label: string;
  description: string;
  editing?: boolean;
  onEdit?: () => void;
  children: ReactNode;
}) {
  const Label = onEdit ? "button" : "div";
  return (
    <div
      data-ghk-row={id}
      className={cn(
        "flex min-h-14 w-full flex-wrap items-center gap-3 rounded-xl px-4 py-3",
        editing ? "bg-settings-active" : "bg-settings-tile",
      )}
    >
      <Label
        type={onEdit ? "button" : undefined}
        onClick={onEdit}
        title={description}
        className={cn(
          "min-w-32 flex-1 rounded-lg text-left text-sm font-medium",
          onEdit &&
            "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25",
        )}
      >
        {label}
      </Label>
      {children}
    </div>
  );
}

function ShortcutKeys({ tokens }: { tokens: string[] }) {
  return tokens.map((token, index) => (
    <span key={token} className="flex items-center gap-1.5">
      {index > 0 ? <span className="text-xs text-muted-foreground">+</span> : null}
      <kbd className="ghk-kbd rounded-md bg-settings-tile px-1.5 py-0.5 font-sans text-xs text-foreground">
        {token}
      </kbd>
    </span>
  ));
}

function ShortcutRecordButton({
  id,
  label,
  tokens,
  recording,
  dimmed = false,
  confirmationHint,
  onClick,
}: {
  id?: string;
  label: string;
  tokens: string[];
  recording: boolean;
  dimmed?: boolean;
  confirmationHint: string;
  onClick: () => void;
}) {
  const { t } = useLocale();
  return (
    <button
      type="button"
      id={id}
      onClick={onClick}
      aria-label={`${label} · ${t("settings.shortcutClickToRecord")}`}
      aria-pressed={recording}
      title={t("settings.shortcutClickToRecord")}
      className={cn(SHORTCUT_KEY_BUTTON_CLASS, dimmed && "opacity-40")}
    >
      {tokens.length > 0 ? (
        <ShortcutKeys tokens={tokens} />
      ) : (
        <span className={cn("text-xs", recording ? "text-primary" : "text-muted-foreground")}>
          {recording ? t("settings.shortcutRecordingHint") : t("settings.shortcutNotSet")}
        </span>
      )}
      {recording && tokens.length > 0 ? (
        <span className="ml-1 text-xs font-medium text-primary">{confirmationHint}</span>
      ) : null}
    </button>
  );
}

function ShortcutChoiceSwitch({
  checked,
  leftLabel,
  rightLabel,
  label,
  title,
  onChange,
}: {
  checked: boolean;
  leftLabel: string;
  rightLabel: string;
  label: string;
  title: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 text-xs" title={title}>
      <span className={checked ? "text-muted-foreground" : "font-medium text-foreground"}>
        {leftLabel}
      </span>
      <Switch
        checked={checked}
        aria-label={label}
        onCheckedChange={onChange}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          event.stopPropagation();
          onChange(event.key === "ArrowRight");
        }}
      />
      <span className={checked ? "font-medium text-foreground" : "text-muted-foreground"}>
        {rightLabel}
      </span>
    </div>
  );
}

export function GlobalShortcutsSection() {
  const { t } = useLocale();
  const [bindings, setBindings] = useState<GlobalShortcutBindings>(() =>
    readGlobalShortcutBindings(),
  );
  const [sendShortcut, setSendShortcut] = useState(readSendShortcut);
  const [recording, setRecording] = useState<GlobalShortcutAction | null>(null);
  const [draft, setDraft] = useState<ShortcutDraft>({ mods: [], main: null });
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const recordingRef = useRef(recording);
  recordingRef.current = recording;

  const actionMeta: Array<{
    id: GlobalShortcutAction;
    label: string;
    desc: string;
  }> = [
    {
      id: "summon",
      label: t("settings.shortcutSummon"),
      desc: t("settings.shortcutSummonDesc"),
    },
    {
      id: "toggle",
      label: t("settings.shortcutToggle"),
      desc: t("settings.shortcutToggleDesc"),
    },
    {
      id: "newChat",
      label: t("settings.shortcutNewChat"),
      desc: t("settings.shortcutNewChatDesc"),
    },
    {
      id: "pin",
      label: t("settings.shortcutPin"),
      desc: t("settings.shortcutPinDesc"),
    },
    {
      id: "searchConversations",
      label: t("settings.shortcutSearchConversations"),
      desc: t("settings.shortcutSearchConversationsDesc"),
    },
  ];

  const formatRegisterFailures = useCallback(
    (failures: GlobalShortcutFailure[]) =>
      `${t("settings.shortcutRegisterFailed")}: ${failures
        .map((failure) => failure.error)
        .join("; ")}`,
    [t],
  );

  const commit = useCallback(
    (next: GlobalShortcutBindings) => {
      // 同步镜像到 ref：同一事件序列里（如 mousedown 隐式保存 + click 其他操作）
      // 后续回调要能立刻读到最新值，不等 React 重渲染。
      bindingsRef.current = next;
      setBindings(next);
      writeGlobalShortcutBindings(next);
      void applyGlobalShortcuts(next).then((failures) => {
        if (failures.length > 0) {
          setStatus({ kind: "error", text: formatRegisterFailures(failures) });
        }
      });
    },
    [formatRegisterFailures],
  );

  // 启动时 applyStoredGlobalShortcuts 的注册失败是静默的；进入本页时按当前
  // 绑定重新注册一次（幂等的全量替换），把"被其他程序占用"等失败回显出来。
  useEffect(() => {
    // 录制期间注册处于挂起态（locale 变更会重跑本效果），此时绝不能重新注册。
    if (recordingRef.current) return;
    let disposed = false;
    void applyGlobalShortcuts(bindingsRef.current).then((failures) => {
      if (disposed || recordingRef.current || failures.length === 0) return;
      setStatus({ kind: "error", text: formatRegisterFailures(failures) });
    });
    return () => {
      disposed = true;
    };
  }, [formatRegisterFailures]);

  const startRecording = useCallback((action: GlobalShortcutAction) => {
    recordingRef.current = action;
    draftRef.current = { mods: [], main: null };
    setShortcutsSuspended(true);
    setRecording(action);
    setDraft({ mods: [], main: null });
    setStatus(null);
    // 录制期间挂起全局快捷键，避免录制现有组合时窗口被隐藏/呼出。
    void applyGlobalShortcuts({});
  }, []);

  /**
   * 结束录制。confirm=按 Enter 显式确认（草稿无主键时报错）；
   * implicit=点击别处/窗口失焦（有主键就保存，否则静默取消）；cancel=Esc/放弃。
   */
  const stopRecording = useCallback(
    (mode: "confirm" | "implicit" | "cancel") => {
      const action = recordingRef.current;
      if (!action) return;
      setShortcutsSuspended(false);
      setRecording(null);
      recordingRef.current = null;
      const current = draftRef.current;
      if (mode === "cancel" || (mode === "implicit" && !current.main)) {
        void applyGlobalShortcuts(bindingsRef.current);
        return;
      }
      if (!current.main) {
        setStatus({ kind: "error", text: t("settings.shortcutNeedMainKey") });
        void applyGlobalShortcuts(bindingsRef.current);
        return;
      }
      const accelerator = [...current.mods, current.main].join("+");
      const conflict = GLOBAL_SHORTCUT_ACTIONS.some(
        (other) => other !== action && bindingsRef.current[other]?.accelerator === accelerator,
      );
      if (conflict) {
        setStatus({ kind: "error", text: t("settings.shortcutConflict") });
        void applyGlobalShortcuts(bindingsRef.current);
        return;
      }
      setStatus({ kind: "ok", text: t("settings.shortcutSaved") });
      commit({
        ...bindingsRef.current,
        [action]: { ...bindingsRef.current[action], accelerator, enabled: true },
      });
    },
    [commit, t],
  );

  const clearBinding = useCallback(
    (action: GlobalShortcutAction) => {
      const next = { ...bindingsRef.current };
      delete next[action];
      setStatus(null);
      commit(next);
    },
    [commit],
  );

  const toggleBinding = useCallback(
    (action: GlobalShortcutAction) => {
      const current = bindingsRef.current[action];
      if (!current) return;
      setStatus(null);
      commit({
        ...bindingsRef.current,
        [action]: { ...current, enabled: !current.enabled },
      });
    },
    [commit],
  );

  // 应用快捷键在行内录制：Enter 确认，Esc 取消。
  useEffect(() => {
    if (!recording) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      const code = event.code;
      if (code === "Escape") {
        stopRecording("cancel");
        return;
      }
      if (code === "Enter" || code === "NumpadEnter") {
        stopRecording("confirm");
        return;
      }
      const mods: ShortcutModifier[] = [];
      if (event.ctrlKey) mods.push("Ctrl");
      if (event.shiftKey) mods.push("Shift");
      if (event.altKey) mods.push("Alt");
      if (event.metaKey) mods.push("Super");
      const isModifier = modifierFromEventCode(code) !== null;
      setDraft((prev) => ({ mods, main: isModifier ? prev.main : code }));
    };
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const row = target?.closest("[data-ghk-row]");
      // 点击的是正在录制的行本身：交给该行自己的 onClick 处理（同样是隐式确认）。
      if (row && row.getAttribute("data-ghk-row") === recordingRef.current) return;
      stopRecording("implicit");
    };
    const onBlur = () => stopRecording("implicit");
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [recording, stopRecording]);

  // 卸载时若仍在录制，恢复既有注册。
  useEffect(
    () => () => {
      setShortcutsSuspended(false);
      if (recordingRef.current) {
        void applyGlobalShortcuts(bindingsRef.current);
      }
    },
    [],
  );

  const draftTokens = useMemo(() => {
    const tokens = draft.mods.map((mod) => displayToken(mod));
    if (draft.main) tokens.push(globalShortcutKeyDisplayLabel(draft.main));
    return tokens;
  }, [draft]);

  return (
    <div className="ghk-root space-y-6">
      <section className="space-y-3">
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("settings.globalShortcutsDesc")}
        </p>

        <div className="space-y-2">
          <ShortcutRow
            id="sendMessage"
            label={t("settings.shortcutSend")}
            description={t(
              sendShortcut === "enter"
                ? "settings.shortcutSendEnterDesc"
                : "settings.shortcutSendModifiedDesc",
            )}
          >
            <span
              className="shrink-0 px-1 text-xs text-muted-foreground"
              title={t("settings.shortcutSendScopeDesc")}
            >
              {t("settings.shortcutScopeComposer")}
            </span>
            <ShortcutChoiceSwitch
              checked={sendShortcut === "ctrlEnter"}
              leftLabel="Enter"
              rightLabel={`${IS_MAC ? "⌘" : "Ctrl"} + Enter`}
              label={`${t("settings.shortcutSend")} · ${IS_MAC ? "⌘" : "Ctrl"} + Enter`}
              title={t("settings.shortcutSendSwitchHint")}
              onChange={(checked) => {
                const next: SendShortcut = checked ? "ctrlEnter" : "enter";
                if (next === sendShortcut) return;
                try {
                  writeSendShortcut(next);
                  setSendShortcut(next);
                  setStatus({ kind: "ok", text: t("settings.shortcutSaved") });
                } catch {
                  setStatus({ kind: "error", text: t("settings.shortcutSaveFailed") });
                }
              }}
            />
          </ShortcutRow>
          {actionMeta.map((action) => {
            const isRecording = recording === action.id;
            const binding = bindings[action.id];
            const bindingDisabled = Boolean(binding) && !binding?.enabled;
            const tokens = isRecording
              ? draftTokens
              : binding
                ? binding.accelerator.split("+").map((token) => displayToken(token))
                : [];
            const scope = binding?.scope ?? "global";
            const changeScope = (nextScope: ShortcutScope) => {
              if (!binding || nextScope === scope) return;
              setStatus(null);
              commit({
                ...bindingsRef.current,
                [action.id]: { ...binding, scope: nextScope },
              });
            };
            const toggleRecording = () => {
              if (isRecording) {
                stopRecording("implicit");
              } else {
                startRecording(action.id);
              }
            };
            return (
              <ShortcutRow
                key={action.id}
                id={action.id}
                label={action.label}
                description={action.desc}
                editing={isRecording}
                onEdit={toggleRecording}
              >
                {!isRecording && binding ? (
                  <ShortcutChoiceSwitch
                    checked={scope === "app"}
                    leftLabel={t("settings.shortcutScopeGlobal")}
                    rightLabel={t("settings.shortcutScopeApp")}
                    label={`${action.label} · ${t("settings.shortcutScopeApp")}`}
                    title={`${t("settings.shortcutScope")}: ${t(scope === "app" ? "settings.shortcutScopeApp" : "settings.shortcutScopeGlobal")} · ${t("settings.shortcutScopeSwitch")}`}
                    onChange={(checked) => changeScope(checked ? "app" : "global")}
                  />
                ) : null}
                <ShortcutRecordButton
                  label={action.label}
                  tokens={tokens}
                  recording={isRecording}
                  dimmed={bindingDisabled}
                  confirmationHint={t("settings.shortcutPressEnter")}
                  onClick={toggleRecording}
                />
                {!isRecording && binding ? (
                  <div className="flex shrink-0 items-center gap-2">
                    <AgentActivationSwitch
                      checked={binding.enabled}
                      title={t("settings.shortcutToggleOnOff")}
                      onToggle={() => toggleBinding(action.id)}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => clearBinding(action.id)}
                      title={t("settings.shortcutClear")}
                      aria-label={`${action.label} · ${t("settings.shortcutClear")}`}
                    >
                      <X className="size-3.5" />
                    </Button>
                  </div>
                ) : null}
              </ShortcutRow>
            );
          })}
        </div>

        {status ? (
          <div
            className={cn(
              "text-xs font-medium",
              status.kind === "ok" ? "text-emerald-600 dark:text-emerald-400" : "text-destructive",
            )}
          >
            {status.text}
          </div>
        ) : null}
      </section>
    </div>
  );
}
