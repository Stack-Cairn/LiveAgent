import { invoke } from "../../lib/tauriBridge";

/**
 * 全局快捷键（桌面端专属能力）。
 * 绑定只存本机 localStorage —— 快捷键是设备偏好，不进入设置同步/网关。
 * accelerator 采用 `Ctrl+Shift+KeyA` 形式：修饰键用 Ctrl/Shift/Alt/Super，
 * 主键用 W3C KeyboardEvent.code 名称，两端（前端录制 & Rust global_hotkey 解析）天然一致。
 */

export type GlobalShortcutAction = "summon" | "toggle" | "newChat" | "pin";

export const GLOBAL_SHORTCUT_ACTIONS: readonly GlobalShortcutAction[] = [
  "summon",
  "toggle",
  "newChat",
  "pin",
];

export interface GlobalShortcutBinding {
  accelerator: string;
  enabled: boolean;
}

export type GlobalShortcutBindings = Partial<Record<GlobalShortcutAction, GlobalShortcutBinding>>;

export interface GlobalShortcutFailure {
  action: string;
  accelerator: string;
  error: string;
}

const STORAGE_KEY = "liveagent.globalShortcuts.v1";

export const SHORTCUT_MODIFIER_ORDER = ["Ctrl", "Shift", "Alt", "Super"] as const;
export type ShortcutModifier = (typeof SHORTCUT_MODIFIER_ORDER)[number];

const MODIFIER_SET = new Set<string>(SHORTCUT_MODIFIER_ORDER);

export function isShortcutModifierToken(token: string): token is ShortcutModifier {
  return MODIFIER_SET.has(token);
}

/** KeyboardEvent.code -> 修饰键 token；非修饰键返回 null。 */
export function modifierFromEventCode(code: string): ShortcutModifier | null {
  switch (code) {
    case "ControlLeft":
    case "ControlRight":
      return "Ctrl";
    case "ShiftLeft":
    case "ShiftRight":
      return "Shift";
    case "AltLeft":
    case "AltRight":
      return "Alt";
    case "MetaLeft":
    case "MetaRight":
      return "Super";
    default:
      return null;
  }
}

export function readGlobalShortcutBindings(): GlobalShortcutBindings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const bindings: GlobalShortcutBindings = {};
    for (const action of GLOBAL_SHORTCUT_ACTIONS) {
      const value = (parsed as Record<string, unknown>)[action];
      // 早期版本直接存 accelerator 字符串，读取时迁移为 {accelerator, enabled}。
      if (typeof value === "string" && value.trim()) {
        bindings[action] = { accelerator: value.trim(), enabled: true };
        continue;
      }
      if (value && typeof value === "object") {
        const accelerator = (value as Record<string, unknown>).accelerator;
        const enabled = (value as Record<string, unknown>).enabled;
        if (typeof accelerator === "string" && accelerator.trim()) {
          bindings[action] = { accelerator: accelerator.trim(), enabled: enabled !== false };
        }
      }
    }
    return bindings;
  } catch {
    return {};
  }
}

export function writeGlobalShortcutBindings(bindings: GlobalShortcutBindings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(bindings));
  } catch {
    // localStorage 不可用时静默忽略（例如隐私模式）。
  }
}

/**
 * 把绑定应用到 Tauri 端（全量替换式注册，仅注册已启用的绑定）。
 * 返回注册失败的条目；非 Tauri 环境（纯浏览器 dev）返回空数组。
 */
export async function applyGlobalShortcuts(
  bindings: GlobalShortcutBindings,
): Promise<GlobalShortcutFailure[]> {
  const payload = GLOBAL_SHORTCUT_ACTIONS.flatMap((action) => {
    const binding = bindings[action];
    const accelerator = binding?.accelerator.trim();
    return binding?.enabled && accelerator ? [{ action, accelerator }] : [];
  });
  try {
    const failures = await invoke<GlobalShortcutFailure[]>("app_set_global_shortcuts", {
      bindings: payload,
    });
    return Array.isArray(failures) ? failures : [];
  } catch {
    // 非 Tauri 环境或旧版桌面壳：忽略。
    return [];
  }
}

/** 应用启动时恢复本机保存的全局快捷键。 */
export async function applyStoredGlobalShortcuts(): Promise<void> {
  const bindings = readGlobalShortcutBindings();
  if (GLOBAL_SHORTCUT_ACTIONS.every((action) => !bindings[action])) return;
  await applyGlobalShortcuts(bindings);
}
