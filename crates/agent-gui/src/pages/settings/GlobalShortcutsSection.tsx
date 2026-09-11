import { type KeyDecor, SHORTCUT_KEYBOARD_TONES, ShortcutKeyboard } from "./ShortcutKeyboard";
import { type KeyboardLayoutId, LAYOUT_OPTIONS } from "./ShortcutKeyboardLayout";

export type { KeyboardLayoutId } from "./ShortcutKeyboardLayout";

import {
  Keyboard,
  MonitorSmartphone,
  Pin,
  Search,
  Send,
  SquarePen,
  X,
  Zap,
} from "@liveagent/ui/components/IconSet";
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
  isShortcutModifierToken,
  modifierFromEventCode,
  readGlobalShortcutBindings,
  SHORTCUT_MODIFIER_ORDER,
  type ShortcutModifier,
  type ShortcutScope,
  setShortcutsSuspended,
  writeGlobalShortcutBindings,
} from "../../lib/shortcuts/globalShortcuts";

const IS_MAC = inferRuntimePlatform() === "macos";

function displayToken(token: string): string {
  return globalShortcutDisplayToken(token, IS_MAC);
}

const MODIFIER_KEY_CODES: Record<ShortcutModifier, string[]> = {
  Ctrl: ["ControlLeft", "ControlRight"],
  Shift: ["ShiftLeft", "ShiftRight"],
  Alt: ["AltLeft", "AltRight"],
  Super: ["MetaLeft", "MetaRight"],
};

interface ShortcutDraft {
  mods: ShortcutModifier[];
  main: string | null;
}

interface BoundShortcutEntry {
  action: GlobalShortcutAction;
  label: string;
  mods: ShortcutModifier[];
  main: string;
  colorIndex: number;
  combo: string;
}

/* ============================== 组件 ============================== */

const SHORTCUT_KEY_BUTTON_CLASS =
  "flex shrink-0 items-center gap-1.5 rounded-md px-2 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** 发送键和应用快捷键共用行结构，保持图标、文字、键帽与编辑状态一致。 */
function ShortcutRow({
  id,
  icon,
  label,
  description,
  editing = false,
  onEdit,
  children,
}: {
  id: string;
  icon: ReactNode;
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
        "flex w-full items-center gap-1.5 rounded-xl border pr-2.5 transition-all",
        editing
          ? "border-primary/40 bg-muted/35"
          : "border-border/60 bg-background/80 hover:border-border hover:bg-muted/35",
      )}
    >
      <Label
        type={onEdit ? "button" : undefined}
        onClick={onEdit}
        className={cn(
          "group flex min-w-0 flex-1 items-center justify-between gap-3 px-3.5",
          "py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring rounded-xl",
        )}
      >
        <div className="flex min-w-0 items-center gap-3">
          <div
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-lg transition-colors",
              editing
                ? "bg-primary/10 text-primary"
                : "bg-muted text-muted-foreground group-hover:bg-accent/80",
            )}
          >
            {icon}
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-foreground">{label}</div>
            <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              {description}
            </div>
          </div>
        </div>
      </Label>
      {children}
    </div>
  );
}

function ShortcutKeys({ tokens }: { tokens: string[] }) {
  return tokens.map((token, index) => (
    <span key={token} className="flex items-center gap-1.5">
      {index > 0 ? <span className="text-xs text-muted-foreground">+</span> : null}
      <span className="ghk-kbd">{token}</span>
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
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title}
      onClick={() => onChange(!checked)}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        event.stopPropagation();
        onChange(event.key === "ArrowRight");
      }}
      className={cn(
        "flex h-8 shrink-0 items-center gap-2 rounded-full px-1 text-xs",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "min-w-2em whitespace-nowrap text-center transition-colors",
          !checked ? "font-semibold text-foreground" : "text-muted-foreground",
        )}
      >
        {leftLabel}
      </span>
      <span
        aria-hidden="true"
        className="relative h-6 w-10 rounded-full border border-border/60 bg-muted/60"
      >
        <span
          className={cn(
            "absolute left-3px top-3px size-4",
            "rounded-full bg-primary shadow-sm",
            "transition-transform duration-200 ease-out motion-reduce:transition-none",
            checked ? "translate-x-4" : "translate-x-0",
          )}
        />
      </span>
      <span
        aria-hidden="true"
        className={cn(
          "min-w-2em whitespace-nowrap text-center transition-colors",
          checked ? "font-semibold text-foreground" : "text-muted-foreground",
        )}
      >
        {rightLabel}
      </span>
    </button>
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
  const [pressedCodes, setPressedCodes] = useState<ReadonlySet<string>>(() => new Set());
  const [layout, setLayout] = useState<KeyboardLayoutId>("87");
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const recordingRef = useRef(recording);
  recordingRef.current = recording;

  const actionMeta: Array<{
    id: GlobalShortcutAction;
    icon: ReactNode;
    label: string;
    desc: string;
  }> = [
    {
      id: "summon",
      icon: <Zap className="size-4.5" />,
      label: t("settings.shortcutSummon"),
      desc: t("settings.shortcutSummonDesc"),
    },
    {
      id: "toggle",
      icon: <MonitorSmartphone className="size-4.5" />,
      label: t("settings.shortcutToggle"),
      desc: t("settings.shortcutToggleDesc"),
    },
    {
      id: "newChat",
      icon: <SquarePen className="size-4.5" />,
      label: t("settings.shortcutNewChat"),
      desc: t("settings.shortcutNewChatDesc"),
    },
    {
      id: "pin",
      icon: <Pin className="size-4.5" />,
      label: t("settings.shortcutPin"),
      desc: t("settings.shortcutPinDesc"),
    },
    {
      id: "searchConversations",
      icon: <Search className="size-4.5" />,
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

  // 始终监听物理按键，驱动键帽按下动画（不拦截默认行为）。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      setPressedCodes((prev) => {
        if (prev.has(event.code)) return prev;
        const next = new Set(prev);
        next.add(event.code);
        return next;
      });
    };
    const onKeyUp = (event: KeyboardEvent) => {
      setPressedCodes((prev) => {
        if (!prev.has(event.code)) return prev;
        const next = new Set(prev);
        next.delete(event.code);
        return next;
      });
    };
    const onBlur = () => setPressedCodes(new Set());
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

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

  // 录制中要在键盘上驻留高亮的键：draft 修饰键(左右两侧) + 主键。
  const heldCodes = useMemo(() => {
    const set = new Set<string>();
    if (!recording) return set;
    for (const mod of draft.mods) {
      for (const code of MODIFIER_KEY_CODES[mod]) set.add(code);
    }
    if (draft.main) set.add(draft.main);
    return set;
  }, [recording, draft]);

  const draftTokens = useMemo(() => {
    const tokens = draft.mods.map((mod) => displayToken(mod));
    if (draft.main) tokens.push(globalShortcutKeyDisplayLabel(draft.main));
    return tokens;
  }, [draft]);

  // ===== 快捷键占用地图（非录制状态下渲染在键盘上）=====
  // 无修饰键按住时显示"裸键"快捷键（如 F10）；按住修饰键（如 Alt）则切到该层，
  // 显示修饰键完全匹配的组合；其余组合在缺失的修饰键键帽上以彩点提示。
  const actionLabelById: Record<GlobalShortcutAction, string> = {
    summon: t("settings.shortcutSummon"),
    toggle: t("settings.shortcutToggle"),
    newChat: t("settings.shortcutNewChat"),
    searchConversations: t("settings.shortcutSearchConversations"),
    pin: t("settings.shortcutPin"),
  };
  const boundEntries: BoundShortcutEntry[] = [];
  GLOBAL_SHORTCUT_ACTIONS.forEach((action, index) => {
    const binding = bindings[action];
    if (!binding?.enabled) return;
    const tokens = binding.accelerator.split("+");
    const main = tokens.find((token) => !isShortcutModifierToken(token));
    if (!main) return;
    boundEntries.push({
      action,
      label: actionLabelById[action],
      mods: SHORTCUT_MODIFIER_ORDER.filter((mod) => tokens.includes(mod)),
      main,
      colorIndex: index % SHORTCUT_KEYBOARD_TONES.length,
      combo: tokens.map((token) => displayToken(token)).join(" + "),
    });
  });

  const heldMods = SHORTCUT_MODIFIER_ORDER.filter((mod) =>
    MODIFIER_KEY_CODES[mod].some((code) => pressedCodes.has(code)),
  );
  const boundByMain = new Map<string, BoundShortcutEntry>();
  const modHintDots = new Map<string, string[]>();
  const modHintTitles = new Map<string, string[]>();
  if (!recording) {
    const heldKey = heldMods.join("+");
    for (const entry of boundEntries) {
      if (entry.mods.join("+") === heldKey) {
        boundByMain.set(entry.main, entry);
      } else if (heldMods.every((mod) => entry.mods.includes(mod))) {
        for (const mod of entry.mods) {
          if (heldMods.includes(mod)) continue;
          const color = SHORTCUT_KEYBOARD_TONES[entry.colorIndex];
          for (const code of MODIFIER_KEY_CODES[mod]) {
            const dots = modHintDots.get(code) ?? [];
            if (!dots.includes(color)) dots.push(color);
            modHintDots.set(code, dots);
            const titles = modHintTitles.get(code) ?? [];
            titles.push(`${entry.combo} · ${entry.label}`);
            modHintTitles.set(code, titles);
          }
        }
      }
    }
  }

  function decorForCode(code: string | null): KeyDecor | undefined {
    if (!code || recording) return undefined;
    const bound = boundByMain.get(code);
    if (bound) {
      return {
        bound: {
          colorClass: SHORTCUT_KEYBOARD_TONES[bound.colorIndex],
          tag: bound.label,
          title: `${bound.combo} · ${bound.label} (${t("settings.shortcutOccupied")})`,
        },
      };
    }
    const dots = modHintDots.get(code);
    if (dots && dots.length > 0) {
      return { hintDots: dots.slice(0, 3), hintTitle: modHintTitles.get(code)?.join("\n") };
    }
    return undefined;
  }

  return (
    <div className="ghk-root space-y-6">
      <section className="space-y-3 rounded-2xl border border-border/60 bg-card p-4">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Keyboard className="size-4 text-muted-foreground" />
          {t("settings.globalShortcuts")}
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("settings.globalShortcutsDesc")}
        </p>

        <div className="space-y-2">
          <ShortcutRow
            id="sendMessage"
            icon={<Send className="size-4.5" />}
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
            <span aria-hidden="true" className="w-66px shrink-0" />
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
                icon={action.icon}
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
                  <>
                    <AgentActivationSwitch
                      checked={binding.enabled}
                      title={t("settings.shortcutToggleOnOff")}
                      onToggle={() => toggleBinding(action.id)}
                    />
                    <button
                      type="button"
                      onClick={() => clearBinding(action.id)}
                      title={t("settings.shortcutClear")}
                      className={cn(
                        "flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors",
                        "hover:bg-muted hover:text-foreground",
                      )}
                    >
                      <X className="size-3.5" />
                    </button>
                  </>
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

      <section className="space-y-3 rounded-2xl border border-border/60 bg-card p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Keyboard className="size-4 text-muted-foreground" />
            {t("settings.shortcutKeyboardTitle")}
          </div>
          <div className="flex items-center gap-0.5 rounded-lg bg-muted/50 p-0.5">
            {LAYOUT_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setLayout(option)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs transition-all",
                  layout === option
                    ? "bg-background font-semibold text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t(`settings.shortcutLayout${option}`)}
              </button>
            ))}
          </div>
        </div>

        {!recording && boundEntries.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            {boundEntries.map((entry) => (
              <span
                key={entry.action}
                className={cn(
                  "flex items-center gap-1.5",
                  "rounded-lg border border-border/60 bg-background/80 px-2 py-1 text-xs",
                )}
              >
                <span
                  className={cn(
                    "size-2 rounded-full bg-(--ghk-hl)",
                    SHORTCUT_KEYBOARD_TONES[entry.colorIndex],
                  )}
                />
                <span className="font-medium text-foreground">{entry.label}</span>
                <span className="text-muted-foreground">{entry.combo}</span>
              </span>
            ))}
          </div>
        ) : null}

        <ShortcutKeyboard
          layout={layout}
          recording={Boolean(recording)}
          pressedCodes={pressedCodes}
          heldCodes={heldCodes}
          decorForCode={decorForCode}
        />
      </section>
    </div>
  );
}
