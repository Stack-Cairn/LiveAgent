import { invoke } from "@liveagent/app/shims/tauriCore";
import {
  readShortcutOverrides,
  type ShortcutCommandId,
  writeShortcutOverrides,
} from "@liveagent/ui/lib/shortcuts/shortcutCommands";
import {
  isShortcutModifierToken,
  setInAppShortcutsSuspended,
} from "@liveagent/ui/lib/shortcuts/shortcutKeys";
import { wasBrowserKeyDefaultBlocked } from "../system/webviewNavigationGuard";

/**
 * 桌面快捷键：系统全局注册与仅软件内的键盘监听共用绑定。
 * 绑定只存本机 localStorage —— 快捷键是设备偏好，不进入设置同步/网关。
 * accelerator 采用 `Ctrl+Shift+KeyA` 形式：修饰键用 Ctrl/Shift/Alt/Super，
 * 主键用 W3C KeyboardEvent.code 名称，两端（前端录制 & Rust global_hotkey 解析）天然一致。
 */

export type GlobalShortcutAction = "summon" | "toggle" | "newChat" | "searchConversations" | "pin";

export const GLOBAL_SHORTCUT_ACTIONS: readonly GlobalShortcutAction[] = [
  "summon",
  "toggle",
  "newChat",
  "pin",
  "searchConversations",
];

export type ShortcutScope = "global" | "app";

export interface GlobalShortcutBinding {
  /** 缺省为 global，兼容已有本机配置。 */
  scope?: ShortcutScope;
  accelerator: string;
  enabled: boolean;
}

export type GlobalShortcutBindings = Partial<Record<GlobalShortcutAction, GlobalShortcutBinding>>;

export interface GlobalShortcutFailure {
  action: string;
  accelerator: string;
  error: string;
}

const GLOBAL_SHORTCUT_STORAGE_KEY = "liveagent.globalShortcuts.v1";

export {
  isShortcutModifierToken,
  modifierFromEventCode,
  SHORTCUT_MODIFIER_ORDER,
  type ShortcutModifier,
} from "@liveagent/ui/lib/shortcuts/shortcutKeys";

/**
 * 应用内（scope=app）的新建对话 / 搜索会话已并入 agent-ui 共享快捷键命令表，
 * 由侧栏直接处理；这里把旧绑定迁移为共享命令的用户覆盖，系统全局绑定保持不变。
 * 停用的旧绑定迁移为"未绑定"，保持升级前"应用内无快捷键"的行为。
 */
const APP_SCOPE_COMMAND_MIGRATIONS: ReadonlyArray<
  readonly [GlobalShortcutAction, ShortcutCommandId]
> = [
  ["newChat", "newConversation"],
  ["searchConversations", "searchConversations"],
];

/** 迁移已执行时从返回值里剔除被迁走的条目，并回写旧存储。 */
function migrateAppScopedBindings(
  parsed: Record<string, unknown>,
  bindings: GlobalShortcutBindings,
): GlobalShortcutBindings {
  const migrated = APP_SCOPE_COMMAND_MIGRATIONS.filter(
    ([action]) => bindings[action]?.scope === "app",
  );
  if (migrated.length === 0) return bindings;
  const overrides = { ...readShortcutOverrides() };
  const next = { ...bindings };
  const raw = { ...parsed };
  for (const [action, command] of migrated) {
    const binding = next[action];
    if (binding && overrides[command] === undefined) {
      overrides[command] = binding.enabled ? binding.accelerator : "";
    }
    delete next[action];
    delete raw[action];
  }
  writeShortcutOverrides(overrides);
  try {
    window.localStorage.setItem(GLOBAL_SHORTCUT_STORAGE_KEY, JSON.stringify(raw));
  } catch {
    // localStorage 不可用时静默忽略。
  }
  return next;
}

export function readGlobalShortcutBindings(): GlobalShortcutBindings {
  try {
    const raw = window.localStorage.getItem(GLOBAL_SHORTCUT_STORAGE_KEY);
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
          const scope = (value as Record<string, unknown>).scope;
          bindings[action] = {
            accelerator: accelerator.trim(),
            enabled: enabled !== false,
            ...(scope === "app" || scope === "global" ? { scope } : {}),
          };
        }
      }
    }
    return migrateAppScopedBindings(parsed as Record<string, unknown>, bindings);
  } catch {
    return {};
  }
}

export function writeGlobalShortcutBindings(bindings: GlobalShortcutBindings): void {
  try {
    window.localStorage.setItem(GLOBAL_SHORTCUT_STORAGE_KEY, JSON.stringify(bindings));
  } catch {
    // localStorage 不可用时静默忽略（例如隐私模式）。
  }
}

/**
 * 把绑定应用到 Tauri 端（全量替换式注册，仅注册已启用的绑定）。
 * 返回注册失败的条目；非 Tauri 环境（纯浏览器 dev）返回空数组。
 */
async function replaceGlobalShortcuts(
  bindings: GlobalShortcutBindings,
): Promise<GlobalShortcutFailure[]> {
  const payload = GLOBAL_SHORTCUT_ACTIONS.flatMap((action) => {
    const binding = bindings[action];
    const accelerator = binding?.accelerator.trim();
    return binding?.enabled && binding.scope !== "app" && accelerator
      ? [{ action, accelerator }]
      : [];
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

// 全量替换必须串行执行，避免快速切换范围后旧请求重新注册系统热键。
let registrationQueue: Promise<unknown> = Promise.resolve();
export function applyGlobalShortcuts(
  bindings: GlobalShortcutBindings,
): Promise<GlobalShortcutFailure[]> {
  const next = registrationQueue.then(() => replaceGlobalShortcuts(bindings));
  registrationQueue = next.catch(() => {});
  return next;
}

/** 应用启动时恢复本机保存的全局快捷键。 */
export async function applyStoredGlobalShortcuts(): Promise<void> {
  const bindings = readGlobalShortcutBindings();
  if (GLOBAL_SHORTCUT_ACTIONS.every((action) => !bindings[action])) return;
  await applyGlobalShortcuts(bindings);
}

let shortcutsSuspended = false;

/** 录制时同时挂起系统注册、软件内监听与共享的应用内快捷键命令。 */
export function setShortcutsSuspended(suspended: boolean): void {
  shortcutsSuspended = suspended;
  setInAppShortcutsSuspended(suspended);
}

export function matchesShortcutEvent(event: KeyboardEvent, accelerator: string): boolean {
  const tokens = accelerator.split("+").map((token) => token.trim());
  const main = tokens.filter((token) => !isShortcutModifierToken(token));
  return (
    main.length === 1 &&
    main[0] === event.code &&
    tokens.includes("Ctrl") === event.ctrlKey &&
    tokens.includes("Shift") === event.shiftKey &&
    tokens.includes("Alt") === event.altKey &&
    tokens.includes("Super") === event.metaKey
  );
}

/** 仅窗口有焦点时派发 app 绑定，不向操作系统占用组合键。 */
export function installAppShortcutListener(): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (
      shortcutsSuspended ||
      (event.defaultPrevented && !wasBrowserKeyDefaultBlocked(event)) ||
      event.isComposing ||
      event.keyCode === 229 ||
      !document.hasFocus()
    )
      return;
    const bindings = readGlobalShortcutBindings();
    const action = GLOBAL_SHORTCUT_ACTIONS.find((action) => {
      const binding = bindings[action];
      return (
        binding?.enabled &&
        binding.scope === "app" &&
        matchesShortcutEvent(event, binding.accelerator)
      );
    });
    if (!action) return;
    // 无修饰字符键不能抢走文本输入；带修饰组合与功能键仍可使用。
    const target = event.target instanceof Element ? event.target : null;
    if (
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      target?.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]') &&
      !/^F\d{1,2}$/.test(event.code)
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) {
      void invoke("app_run_shortcut", { action }).catch(() => {});
    }
  };
  window.addEventListener("keydown", onKeyDown, true);
  return () => window.removeEventListener("keydown", onKeyDown, true);
}
