import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Keyboard, MonitorSmartphone, Pin, SquarePen, X, Zap } from "../../components/icons";
import { useLocale } from "../../i18n";
import { inferRuntimePlatform } from "../../lib/runtimePlatform";
import {
  applyGlobalShortcuts,
  GLOBAL_SHORTCUT_ACTIONS,
  type GlobalShortcutAction,
  type GlobalShortcutBindings,
  type GlobalShortcutFailure,
  isShortcutModifierToken,
  modifierFromEventCode,
  readGlobalShortcutBindings,
  SHORTCUT_MODIFIER_ORDER,
  type ShortcutModifier,
  writeGlobalShortcutBindings,
} from "../../lib/shortcuts/globalShortcuts";
import { AgentActivationSwitch } from "./shared";

/* ============================== 键盘布局数据 ============================== */

// 布局行是模块级常量，平台分叉须在模块加载时判定（同步推断即可，无需等后端）。
const IS_MAC = inferRuntimePlatform() === "macos";

const KEY_UNIT = 40;
const KEY_GAP = 6;
const BOARD_PAD = 14;
const BLOCK_GAP = 20;
const ROW_GAP_LARGE = 14;

function keyWidth(units: number): number {
  return units * KEY_UNIT + (units - 1) * KEY_GAP;
}

interface KeyDef {
  /** 渲染 key（布局静态，模块加载时生成稳定 id） */
  id: string;
  /** KeyboardEvent.code；null 表示占位或不可录制键（Fn） */
  code: string | null;
  units: number;
  label: string;
}

let keyDefSeq = 0;
function k(label: string, code: string | null, units = 1): KeyDef {
  keyDefSeq += 1;
  return { id: `k${keyDefSeq}`, code, units, label };
}
function gap(units: number): KeyDef {
  keyDefSeq += 1;
  return { id: `k${keyDefSeq}`, code: null, units, label: "" };
}

const ROW_FN: KeyDef[] = [
  k("Esc", "Escape"),
  gap(1),
  k("F1", "F1"),
  k("F2", "F2"),
  k("F3", "F3"),
  k("F4", "F4"),
  gap(0.5),
  k("F5", "F5"),
  k("F6", "F6"),
  k("F7", "F7"),
  k("F8", "F8"),
  gap(0.5),
  k("F9", "F9"),
  k("F10", "F10"),
  k("F11", "F11"),
  k("F12", "F12"),
];
const ROW_NUM: KeyDef[] = [
  k("`", "Backquote"),
  k("1", "Digit1"),
  k("2", "Digit2"),
  k("3", "Digit3"),
  k("4", "Digit4"),
  k("5", "Digit5"),
  k("6", "Digit6"),
  k("7", "Digit7"),
  k("8", "Digit8"),
  k("9", "Digit9"),
  k("0", "Digit0"),
  k("-", "Minus"),
  k("=", "Equal"),
  k("⌫", "Backspace", 2),
];
const ROW_Q: KeyDef[] = [
  k("Tab", "Tab", 1.5),
  k("Q", "KeyQ"),
  k("W", "KeyW"),
  k("E", "KeyE"),
  k("R", "KeyR"),
  k("T", "KeyT"),
  k("Y", "KeyY"),
  k("U", "KeyU"),
  k("I", "KeyI"),
  k("O", "KeyO"),
  k("P", "KeyP"),
  k("[", "BracketLeft"),
  k("]", "BracketRight"),
  k("\\", "Backslash", 1.5),
];
const ROW_A: KeyDef[] = [
  k("Caps", "CapsLock", 1.75),
  k("A", "KeyA"),
  k("S", "KeyS"),
  k("D", "KeyD"),
  k("F", "KeyF"),
  k("G", "KeyG"),
  k("H", "KeyH"),
  k("J", "KeyJ"),
  k("K", "KeyK"),
  k("L", "KeyL"),
  k(";", "Semicolon"),
  k("'", "Quote"),
  k("Enter ⏎", "Enter", 2.25),
];
const ROW_Z: KeyDef[] = [
  k("Shift", "ShiftLeft", 2.25),
  k("Z", "KeyZ"),
  k("X", "KeyX"),
  k("C", "KeyC"),
  k("V", "KeyV"),
  k("B", "KeyB"),
  k("N", "KeyN"),
  k("M", "KeyM"),
  k(",", "Comma"),
  k(".", "Period"),
  k("/", "Slash"),
  k("Shift", "ShiftRight", 2.75),
];
// 底排按平台分叉：macOS 用 fn ⌃ ⌥ ⌘ 排布与符号，其余平台用 Ctrl Win Alt。
const ROW_CTL: KeyDef[] = IS_MAC
  ? [
      k("Fn", null, 1.25),
      k("⌃", "ControlLeft", 1.25),
      k("⌥", "AltLeft", 1.25),
      k("⌘", "MetaLeft", 1.25),
      k("", "Space", 6.25),
      k("⌘", "MetaRight", 1.25),
      k("⌥", "AltRight", 1.25),
      k("⌃", "ControlRight", 1.25),
    ]
  : [
      k("Ctrl", "ControlLeft", 1.25),
      k("Win", "MetaLeft", 1.25),
      k("Alt", "AltLeft", 1.25),
      k("", "Space", 6.25),
      k("Alt", "AltRight", 1.25),
      k("Fn", null, 1.25),
      k("☰", "ContextMenu", 1.25),
      k("Ctrl", "ControlRight", 1.25),
    ];

const NAV_TOP: KeyDef[] = [
  k("PrtSc", "PrintScreen"),
  k("ScrLk", "ScrollLock"),
  k("Pause", "Pause"),
];
const NAV_MID: KeyDef[][] = [
  [k("Ins", "Insert"), k("Home", "Home"), k("PgUp", "PageUp")],
  [k("Del", "Delete"), k("End", "End"), k("PgDn", "PageDown")],
];
const NAV_ARROW_TOP: KeyDef[] = [gap(1), k("▲", "ArrowUp"), gap(1)];
const NAV_ARROW_BOTTOM: KeyDef[] = [k("◀", "ArrowLeft"), k("▼", "ArrowDown"), k("▶", "ArrowRight")];

const NUM_TOP: KeyDef[] = [
  k("Num", "NumLock"),
  k("/", "NumpadDivide"),
  k("*", "NumpadMultiply"),
  k("-", "NumpadSubtract"),
];
interface NumpadCell {
  def: KeyDef;
  tall?: boolean;
  wide?: boolean;
}
const NUM_GRID: NumpadCell[] = [
  { def: k("7", "Numpad7") },
  { def: k("8", "Numpad8") },
  { def: k("9", "Numpad9") },
  { def: k("+", "NumpadAdd"), tall: true },
  { def: k("4", "Numpad4") },
  { def: k("5", "Numpad5") },
  { def: k("6", "Numpad6") },
  { def: k("1", "Numpad1") },
  { def: k("2", "Numpad2") },
  { def: k("3", "Numpad3") },
  { def: k("⏎", "NumpadEnter"), tall: true },
  { def: k("0", "Numpad0"), wide: true },
  { def: k(".", "NumpadDecimal") },
];

export type KeyboardLayoutId = "61" | "87" | "104";
const LAYOUT_OPTIONS: KeyboardLayoutId[] = ["61", "87", "104"];

const MAIN_WIDTH = keyWidth(15);
const NAV_WIDTH = keyWidth(3);
const NUM_WIDTH = keyWidth(4);
const NATURAL_WIDTH: Record<KeyboardLayoutId, number> = {
  "61": MAIN_WIDTH + BOARD_PAD * 2,
  "87": MAIN_WIDTH + BLOCK_GAP + NAV_WIDTH + BOARD_PAD * 2,
  "104": MAIN_WIDTH + BLOCK_GAP + NAV_WIDTH + BLOCK_GAP + NUM_WIDTH + BOARD_PAD * 2,
};

/* ============================== 展示辅助 ============================== */

const CODE_DISPLAY: Record<string, string> = {
  Space: "Space",
  Tab: "Tab",
  CapsLock: "Caps",
  Backspace: "⌫",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Insert: "Ins",
  Delete: "Del",
  Home: "Home",
  End: "End",
  PageUp: "PgUp",
  PageDown: "PgDn",
  PrintScreen: "PrtSc",
  ScrollLock: "ScrLk",
  Pause: "Pause",
  ContextMenu: "Menu",
  NumLock: "NumLock",
  NumpadDivide: "Num /",
  NumpadMultiply: "Num *",
  NumpadSubtract: "Num -",
  NumpadAdd: "Num +",
  NumpadDecimal: "Num .",
  Numpad0: "Num 0",
  Numpad1: "Num 1",
  Numpad2: "Num 2",
  Numpad3: "Num 3",
  Numpad4: "Num 4",
  Numpad5: "Num 5",
  Numpad6: "Num 6",
  Numpad7: "Num 7",
  Numpad8: "Num 8",
  Numpad9: "Num 9",
};

function keyDisplayLabel(code: string): string {
  if (code.startsWith("Key") && code.length === 4) return code.slice(3);
  if (code.startsWith("Digit") && code.length === 6) return code.slice(5);
  return CODE_DISPLAY[code] ?? code;
}

/** macOS 上修饰键按系统惯例显示为符号（⌃⇧⌥⌘），其余平台沿用文本。 */
const MAC_MODIFIER_DISPLAY: Record<ShortcutModifier, string> = {
  Ctrl: "⌃",
  Shift: "⇧",
  Alt: "⌥",
  Super: "⌘",
};

function displayToken(token: string): string {
  if (isShortcutModifierToken(token)) {
    if (IS_MAC) return MAC_MODIFIER_DISPLAY[token];
    return token === "Super" ? "Win" : token;
  }
  return keyDisplayLabel(token);
}

const MODIFIER_KEY_CODES: Record<ShortcutModifier, string[]> = {
  Ctrl: ["ControlLeft", "ControlRight"],
  Shift: ["ShiftLeft", "ShiftRight"],
  Alt: ["AltLeft", "AltRight"],
  Super: ["MetaLeft", "MetaRight"],
};

/** 每个动作的高亮色（与 .ghk-cN 类一一对应，索引按 GLOBAL_SHORTCUT_ACTIONS 顺序取模） */
const ACTION_COLOR_HEX = ["#3b82f6", "#8b5cf6", "#10b981", "#f59e0b"];

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

const GHK_STYLE = `
.ghk-root{--ghk-cap-top:#fdfdfe;--ghk-cap-side:#c9d3e0;--ghk-cap-text:#475569;
--ghk-cap-active:#bfdbfe;--ghk-cap-active-text:#1d4ed8;--ghk-cap-held:#dbeafe;--ghk-cap-held-side:#93b8f0;
--ghk-cap-enter:#bbf7d0;--ghk-cap-enter-text:#15803d;
--ghk-board1:#e9edf4;--ghk-board2:#d6dde8;--ghk-board-edge:#b7c2d1;--ghk-shadow:rgb(15 23 42/.26);}
.dark .ghk-root{--ghk-cap-top:#313d4f;--ghk-cap-side:#10161f;--ghk-cap-text:#b6c2d4;
--ghk-cap-active:#1e40af;--ghk-cap-active-text:#bfdbfe;--ghk-cap-held:#1e3a8a;--ghk-cap-held-side:#172554;
--ghk-cap-enter:#14532d;--ghk-cap-enter-text:#86efac;
--ghk-board1:#222b38;--ghk-board2:#161d28;--ghk-board-edge:#0b1017;--ghk-shadow:rgb(0 0 0/.5);}
.ghk-stage{perspective:1400px;}
.ghk-board{display:inline-flex;gap:${BLOCK_GAP}px;padding:${BOARD_PAD}px;border-radius:16px;
background:linear-gradient(180deg,var(--ghk-board1),var(--ghk-board2));
box-shadow:0 16px 0 -6px var(--ghk-board-edge),0 28px 32px var(--ghk-shadow);
transform:rotateX(22deg);transform-style:preserve-3d;transition:transform .35s,box-shadow .35s;}
.ghk-board.ghk-rec{
box-shadow:0 16px 0 -6px var(--ghk-board-edge),0 28px 34px var(--ghk-shadow),0 0 0 2px rgb(59 130 246/.45),0 0 26px rgb(59 130 246/.28);}
.ghk-key{position:relative;height:${KEY_UNIT}px;border-radius:7px;background:var(--ghk-cap-top);
box-shadow:0 4px 0 var(--ghk-cap-side),0 6px 5px rgb(15 23 42/.16);color:var(--ghk-cap-text);
display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;line-height:1.1;
text-align:center;padding:0 2px;transition:transform .05s,box-shadow .05s,background .12s,color .12s;}
.ghk-c0{--ghk-hl:#3b82f6;--ghk-hl-bg:#dbeafe;--ghk-hl-side:#94b6ee;--ghk-hl-text:#1d4ed8;}
.ghk-c1{--ghk-hl:#8b5cf6;--ghk-hl-bg:#ede9fe;--ghk-hl-side:#b7a6ee;--ghk-hl-text:#6d28d9;}
.ghk-c2{--ghk-hl:#10b981;--ghk-hl-bg:#d1fae5;--ghk-hl-side:#86d5b8;--ghk-hl-text:#047857;}
.ghk-c3{--ghk-hl:#f59e0b;--ghk-hl-bg:#fef3c7;--ghk-hl-side:#e2c078;--ghk-hl-text:#b45309;}
.dark .ghk-c0{--ghk-hl-bg:#1e3a8a;--ghk-hl-side:#152a63;--ghk-hl-text:#bfdbfe;}
.dark .ghk-c1{--ghk-hl-bg:#4c1d95;--ghk-hl-side:#37156b;--ghk-hl-text:#ddd6fe;}
.dark .ghk-c2{--ghk-hl-bg:#065f46;--ghk-hl-side:#04422f;--ghk-hl-text:#a7f3d0;}
.dark .ghk-c3{--ghk-hl-bg:#78350f;--ghk-hl-side:#571f05;--ghk-hl-text:#fde68a;}
.ghk-key.ghk-bound{background:var(--ghk-hl-bg);color:var(--ghk-hl-text);
box-shadow:0 4px 0 var(--ghk-hl-side),0 6px 5px rgb(15 23 42/.16);}
.ghk-key.ghk-bound .ghk-klegend{transform:translateY(-5px);}
.ghk-tag{position:absolute;left:2px;right:2px;bottom:2px;font-size:8px;font-weight:600;line-height:1.2;
color:var(--ghk-hl-text);text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;}
.ghk-dots{position:absolute;top:3px;right:4px;display:flex;gap:2px;pointer-events:none;}
.ghk-dot{width:5px;height:5px;border-radius:9999px;box-shadow:0 0 0 1px rgb(255 255 255/.55);}
.dark .ghk-dot{box-shadow:0 0 0 1px rgb(0 0 0/.4);}
.ghk-key.ghk-held{background:var(--ghk-cap-held);color:var(--ghk-cap-active-text);
box-shadow:0 4px 0 var(--ghk-cap-held-side),0 6px 5px rgb(37 99 235/.22);}
.ghk-key.ghk-down{transform:translateY(4px);background:var(--ghk-cap-active);color:var(--ghk-cap-active-text);
box-shadow:0 0 0 var(--ghk-cap-side),0 1px 2px rgb(15 23 42/.2);}
.ghk-key.ghk-enter.ghk-down{background:var(--ghk-cap-enter);color:var(--ghk-cap-enter-text);}
.ghk-kbd{display:inline-block;padding:3px 9px;font-size:12px;font-weight:600;border-radius:6px;
border:1px solid var(--ghk-cap-side);border-bottom-width:2.5px;background:var(--ghk-cap-top);color:var(--ghk-cap-text);}
`;

/** 键帽上的占用标注：bound=该键是某快捷键主键；hintDots=按下更多修饰键后此修饰键下有组合 */
interface KeyDecor {
  bound?: { colorClass: string; tag: string; title: string };
  hintDots?: string[];
  hintTitle?: string;
}

function KeyCap(props: {
  def: KeyDef;
  pressed: boolean;
  held: boolean;
  decor?: KeyDecor;
  fill?: boolean;
}) {
  const { def, pressed, held, decor, fill } = props;
  if (!def.code && !def.label) {
    return <div style={{ width: keyWidth(def.units), height: KEY_UNIT }} />;
  }
  const bound = decor?.bound;
  const hintDots = decor?.hintDots ?? [];
  const isEnter = def.code === "Enter" || def.code === "NumpadEnter";
  const className = `ghk-key${isEnter ? " ghk-enter" : ""}${
    bound ? ` ghk-bound ${bound.colorClass}` : ""
  }${pressed ? " ghk-down" : ""}${held && !pressed ? " ghk-held" : ""}`;
  return (
    <div
      className={className}
      style={fill ? { width: "100%", height: "100%" } : { width: keyWidth(def.units) }}
      title={bound?.title ?? decor?.hintTitle}
    >
      <span className="ghk-klegend" style={def.label.length > 3 ? { fontSize: 9 } : undefined}>
        {def.label}
      </span>
      {bound ? <span className="ghk-tag">{bound.tag}</span> : null}
      {!bound && hintDots.length > 0 ? (
        <span className="ghk-dots">
          {hintDots.map((hex) => (
            <span key={hex} className="ghk-dot" style={{ background: hex }} />
          ))}
        </span>
      ) : null}
    </div>
  );
}

export function GlobalShortcutsSection() {
  const { t } = useLocale();
  const [bindings, setBindings] = useState<GlobalShortcutBindings>(() =>
    readGlobalShortcutBindings(),
  );
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
      icon: <Zap className="h-4.5 w-4.5" />,
      label: t("settings.shortcutSummon"),
      desc: t("settings.shortcutSummonDesc"),
    },
    {
      id: "toggle",
      icon: <MonitorSmartphone className="h-4.5 w-4.5" />,
      label: t("settings.shortcutToggle"),
      desc: t("settings.shortcutToggleDesc"),
    },
    {
      id: "newChat",
      icon: <SquarePen className="h-4.5 w-4.5" />,
      label: t("settings.shortcutNewChat"),
      desc: t("settings.shortcutNewChatDesc"),
    },
    {
      id: "pin",
      icon: <Pin className="h-4.5 w-4.5" />,
      label: t("settings.shortcutPin"),
      desc: t("settings.shortcutPinDesc"),
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
      setRecording(null);
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
      commit({ ...bindingsRef.current, [action]: { accelerator, enabled: true } });
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

  // 录制期间接管键盘输入：Enter 确认（不计入组合），Esc 取消；
  // 点击录制行以外的任意位置或窗口失焦 → 有主键则视为确认绑定。
  useEffect(() => {
    if (!recording) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      const code = event.code;
      if (code === "Enter" || code === "NumpadEnter") {
        stopRecording("confirm");
        return;
      }
      if (code === "Escape") {
        stopRecording("cancel");
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
    if (draft.main) tokens.push(keyDisplayLabel(draft.main));
    return tokens;
  }, [draft]);

  // ===== 快捷键占用地图（非录制状态下渲染在键盘上）=====
  // 无修饰键按住时显示"裸键"快捷键（如 F10）；按住修饰键（如 Alt）则切到该层，
  // 显示修饰键完全匹配的组合；其余组合在缺失的修饰键键帽上以彩点提示。
  const actionLabelById: Record<GlobalShortcutAction, string> = {
    summon: t("settings.shortcutSummon"),
    toggle: t("settings.shortcutToggle"),
    newChat: t("settings.shortcutNewChat"),
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
      colorIndex: index % ACTION_COLOR_HEX.length,
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
          const hex = ACTION_COLOR_HEX[entry.colorIndex];
          for (const code of MODIFIER_KEY_CODES[mod]) {
            const dots = modHintDots.get(code) ?? [];
            if (!dots.includes(hex)) dots.push(hex);
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
          colorClass: `ghk-c${bound.colorIndex}`,
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

  // 键盘随容器宽度等比缩放；缩放与容器高度直接写 DOM，
  // 以便在同一次布局中量取变换后的实际视高（transform 不影响布局盒）。
  const outerRef = useRef<HTMLDivElement | null>(null);
  const scalerRef = useRef<HTMLDivElement | null>(null);
  const naturalWidth = NATURAL_WIDTH[layout];

  useLayoutEffect(() => {
    const outer = outerRef.current;
    const scaler = scalerRef.current;
    if (!outer || !scaler) return;
    const update = () => {
      const width = outer.clientWidth;
      if (width <= 0) return;
      const nextScale = Math.min(1, width / naturalWidth);
      scaler.style.width = `${naturalWidth}px`;
      scaler.style.transform = `scale(${nextScale})`;
      scaler.style.transformOrigin = "top center";
      scaler.style.marginLeft = `calc(50% - ${naturalWidth / 2}px)`;
      // 底部预留投影空间，避免 overflow-hidden 裁掉键盘厚度阴影。
      outer.style.height = `${scaler.getBoundingClientRect().height + 44}px`;
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(outer);
    return () => observer.disconnect();
  }, [naturalWidth]);

  function renderRow(defs: KeyDef[], key: string) {
    return (
      <div key={key} className="flex" style={{ gap: KEY_GAP }}>
        {defs.map((def) => (
          <KeyCap
            key={def.id}
            def={def}
            pressed={def.code !== null && pressedCodes.has(def.code)}
            held={def.code !== null && heldCodes.has(def.code)}
            decor={decorForCode(def.code)}
          />
        ))}
      </div>
    );
  }

  function renderMainBlock(withFnRow: boolean) {
    return (
      <div className="flex flex-col" style={{ gap: KEY_GAP }}>
        {withFnRow ? (
          <>
            {renderRow(ROW_FN, "fn")}
            <div style={{ height: ROW_GAP_LARGE - KEY_GAP }} />
          </>
        ) : null}
        {renderRow(ROW_NUM, "num")}
        {renderRow(ROW_Q, "q")}
        {renderRow(ROW_A, "a")}
        {renderRow(ROW_Z, "z")}
        {renderRow(ROW_CTL, "ctl")}
      </div>
    );
  }

  function renderNavBlock() {
    return (
      <div className="flex flex-col" style={{ gap: KEY_GAP }}>
        {renderRow(NAV_TOP, "navtop")}
        <div style={{ height: ROW_GAP_LARGE - KEY_GAP }} />
        {renderRow(NAV_MID[0], "navmid0")}
        {renderRow(NAV_MID[1], "navmid1")}
        <div style={{ height: KEY_UNIT }} />
        {renderRow(NAV_ARROW_TOP, "arrowtop")}
        {renderRow(NAV_ARROW_BOTTOM, "arrowbottom")}
      </div>
    );
  }

  function renderNumBlock() {
    return (
      <div className="flex flex-col" style={{ gap: KEY_GAP }}>
        {renderRow(NUM_TOP, "numtop")}
        <div style={{ height: ROW_GAP_LARGE - KEY_GAP }} />
        <div
          className="grid"
          style={{
            gridTemplateColumns: `repeat(4, ${KEY_UNIT}px)`,
            gridAutoRows: KEY_UNIT,
            gap: KEY_GAP,
          }}
        >
          {NUM_GRID.map((cell) => (
            <div
              key={cell.def.id}
              style={{
                gridRow: cell.tall ? "span 2" : undefined,
                gridColumn: cell.wide ? "span 2" : undefined,
              }}
            >
              <KeyCap
                def={cell.def}
                pressed={cell.def.code !== null && pressedCodes.has(cell.def.code)}
                held={cell.def.code !== null && heldCodes.has(cell.def.code)}
                decor={decorForCode(cell.def.code)}
                fill
              />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="ghk-root space-y-6">
      <style>{GHK_STYLE}</style>
      <section className="space-y-3 rounded-2xl border border-border/60 bg-card p-4">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Keyboard className="h-4 w-4 text-muted-foreground" />
          {t("settings.globalShortcuts")}
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("settings.globalShortcutsDesc")}
        </p>

        <div className="space-y-2">
          {actionMeta.map((action) => {
            const isRecording = recording === action.id;
            const binding = bindings[action.id];
            const bindingDisabled = Boolean(binding) && !binding?.enabled;
            const tokens = isRecording
              ? draftTokens
              : binding
                ? binding.accelerator.split("+").map((token) => displayToken(token))
                : [];
            return (
              <div
                key={action.id}
                data-ghk-row={action.id}
                className={`flex w-full items-center gap-1.5 rounded-xl border pr-2.5 transition-all ${
                  isRecording
                    ? "border-primary bg-primary/5 shadow-sm shadow-primary/20"
                    : "border-border/60 bg-background/80 hover:border-border hover:bg-muted/35"
                }`}
              >
                <button
                  type="button"
                  onClick={() => {
                    if (isRecording) {
                      // 点击录制中的行 = 隐式确认（有主键保存，否则取消）。
                      stopRecording("implicit");
                    } else {
                      startRecording(action.id);
                    }
                  }}
                  className="group flex min-w-0 flex-1 items-center justify-between gap-3 px-3.5 py-3 text-left"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <div
                      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors ${
                        isRecording
                          ? "bg-primary/10 text-primary"
                          : "bg-muted text-muted-foreground group-hover:bg-accent/80"
                      }`}
                    >
                      {action.icon}
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-foreground">{action.label}</div>
                      <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                        {action.desc}
                      </div>
                    </div>
                  </div>
                  <div
                    className={`flex shrink-0 items-center gap-1.5 ${bindingDisabled ? "opacity-40" : ""}`}
                  >
                    {tokens.length > 0 ? (
                      tokens.map((token, index) => (
                        <span key={token} className="flex items-center gap-1.5">
                          {index > 0 ? (
                            <span className="text-xs text-muted-foreground">+</span>
                          ) : null}
                          <span className="ghk-kbd">{token}</span>
                        </span>
                      ))
                    ) : (
                      <span
                        className={`text-xs ${isRecording ? "text-primary" : "text-muted-foreground"}`}
                      >
                        {isRecording
                          ? t("settings.shortcutRecordingHint")
                          : t("settings.shortcutNotSet")}
                      </span>
                    )}
                    {isRecording && tokens.length > 0 ? (
                      <span className="ml-1 text-xs font-medium text-primary">
                        {t("settings.shortcutPressEnter")}
                      </span>
                    ) : null}
                  </div>
                </button>
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
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </>
                ) : null}
              </div>
            );
          })}
        </div>

        {status ? (
          <div
            className={`text-xs font-medium ${status.kind === "ok" ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}`}
          >
            {status.text}
          </div>
        ) : null}
      </section>

      <section className="space-y-3 rounded-2xl border border-border/60 bg-card p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Keyboard className="h-4 w-4 text-muted-foreground" />
            {t("settings.shortcutKeyboardTitle")}
          </div>
          <div className="flex items-center gap-0.5 rounded-lg bg-muted/50 p-0.5">
            {LAYOUT_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setLayout(option)}
                className={`rounded-md px-2.5 py-1 text-xs transition-all ${
                  layout === option
                    ? "bg-background font-semibold text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
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
                className="flex items-center gap-1.5 rounded-lg border border-border/60 bg-background/80 px-2 py-1 text-xs"
              >
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ background: ACTION_COLOR_HEX[entry.colorIndex] }}
                />
                <span className="font-medium text-foreground">{entry.label}</span>
                <span className="text-muted-foreground">{entry.combo}</span>
              </span>
            ))}
          </div>
        ) : null}

        <div ref={outerRef} className="overflow-hidden pt-2">
          <div ref={scalerRef}>
            <div className="ghk-stage">
              <div className={`ghk-board${recording ? " ghk-rec" : ""}`}>
                {renderMainBlock(layout !== "61")}
                {layout !== "61" ? renderNavBlock() : null}
                {layout === "104" ? renderNumBlock() : null}
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
