import { inferRuntimePlatform } from "../../lib/runtimePlatform";

// 布局行是模块级常量，平台分叉须在模块加载时判定（同步推断即可，无需等后端）。
const IS_MAC = inferRuntimePlatform() === "macos";

export const KEY_UNIT = 40;
export const KEY_GAP = 6;
export const BOARD_PAD = 14;
export const BLOCK_GAP = 20;
export const ROW_GAP_LARGE = 14;

export function keyWidth(units: number): number {
  return units * KEY_UNIT + (units - 1) * KEY_GAP;
}

export interface KeyDef {
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

export const ROW_FN: KeyDef[] = [
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
export const ROW_NUM: KeyDef[] = [
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
export const ROW_Q: KeyDef[] = [
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
export const ROW_A: KeyDef[] = [
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
export const ROW_Z: KeyDef[] = [
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
export const ROW_CTL: KeyDef[] = IS_MAC
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

export const NAV_TOP: KeyDef[] = [
  k("PrtSc", "PrintScreen"),
  k("ScrLk", "ScrollLock"),
  k("Pause", "Pause"),
];
export const NAV_MID: KeyDef[][] = [
  [k("Ins", "Insert"), k("Home", "Home"), k("PgUp", "PageUp")],
  [k("Del", "Delete"), k("End", "End"), k("PgDn", "PageDown")],
];
export const NAV_ARROW_TOP: KeyDef[] = [gap(1), k("▲", "ArrowUp"), gap(1)];
export const NAV_ARROW_BOTTOM: KeyDef[] = [
  k("◀", "ArrowLeft"),
  k("▼", "ArrowDown"),
  k("▶", "ArrowRight"),
];

export const NUM_TOP: KeyDef[] = [
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
export const NUM_GRID: NumpadCell[] = [
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
export const LAYOUT_OPTIONS: KeyboardLayoutId[] = ["61", "87", "104"];

const MAIN_WIDTH = keyWidth(15);
const NAV_WIDTH = keyWidth(3);
const NUM_WIDTH = keyWidth(4);
export const NATURAL_WIDTH: Record<KeyboardLayoutId, number> = {
  "61": MAIN_WIDTH + BOARD_PAD * 2,
  "87": MAIN_WIDTH + BLOCK_GAP + NAV_WIDTH + BOARD_PAD * 2,
  "104": MAIN_WIDTH + BLOCK_GAP + NAV_WIDTH + BLOCK_GAP + NUM_WIDTH + BOARD_PAD * 2,
};
