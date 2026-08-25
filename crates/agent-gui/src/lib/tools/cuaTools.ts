import type {
  ImageContent,
  TextContent,
  Tool,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { invoke } from "@tauri-apps/api/core";
import { DEFAULT_LOCALE, type Locale, t } from "@liveagent/app/i18n/config";
import {
  formatUnknownCuaError,
  type CuaErrorPayload,
} from "@liveagent/ui/lib/cua/formatCuaError";

import type { BuiltinToolBundle, BuiltinToolMetadata } from "./builtinTypes";
import { createBuiltinMetadataMap } from "./builtinTypes";
import { normalizeToolParametersSchema } from "./toolSchema";

type CuaWindow = {
  windowId: number;
  owner: string;
  title: string;
  bounds?: { x: number; y: number; width: number; height: number };
  focused: boolean;
};

type CuaConfig = {
  enabled: boolean;
  allowedOwners: string[];
  auditLogLimit: number;
};

type CuaStatus = {
  config: CuaConfig;
  platform: string;
  available: boolean;
  recent: Array<{
    timestamp: string;
    operation: string;
    ok: boolean;
    error?: string;
    detail?: unknown;
  }>;
};

type CuaOpResponse = { ok: boolean; error?: CuaErrorPayload };
type CuaScreenshotResponse = {
  width: number;
  height: number;
  base64Png: string;
};

const SCREENSHOT_MIME = "image/png";
const MAX_TEXT_LEN = 64 * 1024;

function trimText(text: string): string {
  if (text.length <= MAX_TEXT_LEN) return text;
  return `${text.slice(0, MAX_TEXT_LEN)}\n…(剩余 ${text.length - MAX_TEXT_LEN} 字符已截断)`;
}

function errorResult(toolCall: ToolCall, message: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [{ type: "text", text: trimText(message) }],
    details: {},
    isError: true,
    timestamp: Date.now(),
  };
}

function textResult(toolCall: ToolCall, text: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [{ type: "text", text: trimText(text) }],
    details: {},
    isError: false,
    timestamp: Date.now(),
  };
}

function imageResult(
  toolCall: ToolCall,
  data: { base64Png: string; width: number; height: number },
  textSummary: string,
): ToolResultMessage {
  const content: Array<TextContent | ImageContent> = [
    { type: "text", text: trimText(textSummary) },
    { type: "image", data: data.base64Png, mimeType: SCREENSHOT_MIME },
  ];
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content,
    details: { width: data.width, height: data.height },
    isError: false,
    timestamp: Date.now(),
  };
}

function jsonResult<T>(toolCall: ToolCall, payload: T, summary: string): ToolResultMessage {
  return textResult(toolCall, `${summary}\n${JSON.stringify(payload, null, 2)}`);
}

/**
 * 创建一组把 CUA 操作暴露给 Agent 的 builtin tool。CUA 总开关与名单
 * 由后端 CuaStore 强制执行；前端 bundle 仅在用户启用时挂载。
 *
 * `getLocale` 用来把后端结构化错误（kind + params）按用户当前 UI locale
 * 翻译成可读消息；缺省时回落到系统/默认 locale（CUA-006）。
 */
export function createCuaTools(params?: { getLocale?: () => Locale }): BuiltinToolBundle {
  const resolveLocale = (): Locale =>
    params?.getLocale ? safeReadLocale(params.getLocale) : DEFAULT_LOCALE;
  const formatError = (input: unknown): string =>
    formatUnknownCuaError(input, t, resolveLocale());
  const formatOpError = (payload: CuaErrorPayload | undefined): string => {
    if (payload) {
      return formatUnknownCuaError(payload, t, resolveLocale());
    }
    return t("cua.errors.unknown", resolveLocale());
  };
  const metadataEntries: Array<[string, BuiltinToolMetadata]> = [
    ["cua_list_windows", { groupId: "cua", kind: "cua", isReadOnly: true, displayCategory: "cua" }],
    ["cua_focus_window", { groupId: "cua", kind: "cua", isReadOnly: false, displayCategory: "cua" }],
    ["cua_screenshot", { groupId: "cua", kind: "cua", isReadOnly: true, displayCategory: "cua" }],
    ["cua_click", { groupId: "cua", kind: "cua", isReadOnly: false, displayCategory: "cua" }],
    ["cua_double_click", { groupId: "cua", kind: "cua", isReadOnly: false, displayCategory: "cua" }],
    ["cua_type", { groupId: "cua", kind: "cua", isReadOnly: false, displayCategory: "cua" }],
    ["cua_key", { groupId: "cua", kind: "cua", isReadOnly: false, displayCategory: "cua" }],
    ["cua_scroll", { groupId: "cua", kind: "cua", isReadOnly: false, displayCategory: "cua" }],
    ["cua_drag", { groupId: "cua", kind: "cua", isReadOnly: false, displayCategory: "cua" }],
  ];

  const tools: Tool[] = [
    {
      name: "cua_list_windows",
      description:
        "[CUA] 列出当前系统中所有可见窗口（owner 应用名、title、bounds）。需要先在设置中启用 CUA。",
      parameters: normalizeToolParametersSchema(
        { type: "object", properties: {}, additionalProperties: false },
        "CUA cua_list_windows",
      ),
    },
    {
      name: "cua_focus_window",
      description: "[CUA] 将指定 owner（应用名，例如 Finder、Safari）聚焦到前台。",
      parameters: normalizeToolParametersSchema(
        {
          type: "object",
          properties: { owner: { type: "string", description: "应用名" } },
          required: ["owner"],
          additionalProperties: false,
        },
        "CUA cua_focus_window",
      ),
    },
    {
      name: "cua_screenshot",
      description:
        "[CUA] 截取整个主屏幕的当前画面，返回 PNG 图片（image content）。需要屏幕录制权限。",
      parameters: normalizeToolParametersSchema(
        {
          type: "object",
          properties: {
            windowOwner: {
              type: "string",
              description: "可选：目标应用名（当前 MVP 仍截全屏）",
            },
          },
          additionalProperties: false,
        },
        "CUA cua_screenshot",
      ),
    },
    {
      name: "cua_click",
      description: "[CUA] 在屏幕坐标 (x, y) 处模拟鼠标点击。",
      parameters: normalizeToolParametersSchema(
        {
          type: "object",
          properties: {
            x: { type: "integer", description: "屏幕 x 坐标" },
            y: { type: "integer", description: "屏幕 y 坐标" },
            button: { type: "string", enum: ["left", "middle", "right"], default: "left" },
          },
          required: ["x", "y"],
          additionalProperties: false,
        },
        "CUA cua_click",
      ),
    },
    {
      name: "cua_double_click",
      description: "[CUA] 在屏幕坐标 (x, y) 处双击。",
      parameters: normalizeToolParametersSchema(
        {
          type: "object",
          properties: {
            x: { type: "integer" },
            y: { type: "integer" },
          },
          required: ["x", "y"],
          additionalProperties: false,
        },
        "CUA cua_double_click",
      ),
    },
    {
      name: "cua_type",
      description:
        "[CUA] 模拟键盘输入字符串。targetOwner 可选：指定后操作会经后端白名单校验。",
      parameters: normalizeToolParametersSchema(
        {
          type: "object",
          properties: {
            text: { type: "string", description: "要输入的文本" },
            targetOwner: {
              type: "string",
              description: "可选：当前焦点应用名（用于白名单校验）",
            },
          },
          required: ["text"],
          additionalProperties: false,
        },
        "CUA cua_type",
      ),
    },
    {
      name: "cua_key",
      description:
        "[CUA] 按下指定按键；key 可填入 key code（数字，如 49 = Return）或键名（return / tab / escape 等）。modifiers 数组可传 command / shift / control / option。",
      parameters: normalizeToolParametersSchema(
        {
          type: "object",
          properties: {
            key: { type: "string", description: "按键 key code 或名称" },
            modifiers: {
              type: "array",
              items: { type: "string" },
              description: "修饰键：command | shift | control | option",
            },
            targetOwner: { type: "string" },
          },
          required: ["key"],
          additionalProperties: false,
        },
        "CUA cua_key",
      ),
    },
    {
      name: "cua_scroll",
      description: "[CUA] 在屏幕坐标 (x, y) 处滚动：dy > 0 向上、< 0 向下。",
      parameters: normalizeToolParametersSchema(
        {
          type: "object",
          properties: {
            x: { type: "integer" },
            y: { type: "integer" },
            dy: { type: "integer" },
          },
          required: ["x", "y", "dy"],
          additionalProperties: false,
        },
        "CUA cua_scroll",
      ),
    },
    {
      name: "cua_drag",
      description:
        "[CUA] 拖拽（macOS 上需要 `brew install cliclick`）。从 (x1, y1) 到 (x2, y2)。",
      parameters: normalizeToolParametersSchema(
        {
          type: "object",
          properties: {
            x1: { type: "integer" },
            y1: { type: "integer" },
            x2: { type: "integer" },
            y2: { type: "integer" },
          },
          required: ["x1", "y1", "x2", "y2"],
          additionalProperties: false,
        },
        "CUA cua_drag",
      ),
    },
  ];

  async function invokeCua<T>(name: string, args: Record<string, unknown>): Promise<T> {
    return invoke<T>(name, args as never);
  }

  async function executeToolCall(toolCall: ToolCall): Promise<ToolResultMessage> {
    const args = (toolCall.arguments ?? {}) as Record<string, unknown>;
    try {
      switch (toolCall.name) {
        case "cua_list_windows": {
          const wins = await invokeCua<CuaWindow[]>("cua_list_windows", {});
          if (wins.length === 0) {
            return textResult(toolCall, "未发现可见窗口（可能前台应用没有窗口，或缺少屏幕录制权限）。");
          }
          return jsonResult(toolCall, wins, `共 ${wins.length} 个可见窗口：`);
        }
        case "cua_focus_window": {
          const owner = String(args.owner ?? "").trim();
          if (!owner) return errorResult(toolCall, "缺少必填参数 owner");
          const resp = await invokeCua<CuaOpResponse>("cua_focus_window", { owner });
          if (!resp.ok) {
            return errorResult(toolCall, formatOpError(resp.error));
          }
          return textResult(toolCall, `已尝试聚焦「${owner}」`);
        }
        case "cua_screenshot": {
          const windowOwner =
            typeof args.windowOwner === "string" && args.windowOwner.trim()
              ? args.windowOwner.trim()
              : undefined;
          const resp = await invokeCua<CuaScreenshotResponse>("cua_screenshot", {
            windowOwner,
          });
          return imageResult(
            toolCall,
            resp,
            `截图成功：${resp.width}×${resp.height}`,
          );
        }
        case "cua_click": {
          const x = Number(args.x);
          const y = Number(args.y);
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            return errorResult(toolCall, "x / y 必须是数字");
          }
          const button = typeof args.button === "string" ? args.button : "left";
          const resp = await invokeCua<CuaOpResponse>("cua_click", { x, y, button });
          if (!resp.ok) return errorResult(toolCall, formatOpError(resp.error));
          return textResult(toolCall, `已在 (${x}, ${y}) 点击 (${button})`);
        }
        case "cua_double_click": {
          const x = Number(args.x);
          const y = Number(args.y);
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            return errorResult(toolCall, "x / y 必须是数字");
          }
          const resp = await invokeCua<CuaOpResponse>("cua_double_click", { x, y });
          if (!resp.ok) return errorResult(toolCall, formatOpError(resp.error));
          return textResult(toolCall, `已在 (${x}, ${y}) 双击`);
        }
        case "cua_type": {
          const text = typeof args.text === "string" ? args.text : "";
          if (!text) return errorResult(toolCall, "缺少必填参数 text");
          const targetOwner =
            typeof args.targetOwner === "string" && args.targetOwner.trim()
              ? args.targetOwner.trim()
              : undefined;
          const resp = await invokeCua<CuaOpResponse>("cua_type", { text, targetOwner });
          if (!resp.ok) return errorResult(toolCall, formatOpError(resp.error));
          return textResult(toolCall, `已输入 ${text.length} 字符`);
        }
        case "cua_key": {
          const key = String(args.key ?? "").trim();
          if (!key) return errorResult(toolCall, "缺少必填参数 key");
          const modifiers = Array.isArray(args.modifiers)
            ? (args.modifiers as unknown[]).filter((s): s is string => typeof s === "string")
            : undefined;
          const targetOwner =
            typeof args.targetOwner === "string" && args.targetOwner.trim()
              ? args.targetOwner.trim()
              : undefined;
          const resp = await invokeCua<CuaOpResponse>("cua_key", {
            key,
            modifiers,
            targetOwner,
          });
          if (!resp.ok) return errorResult(toolCall, formatOpError(resp.error));
          return textResult(
            toolCall,
            `已按键「${key}」${modifiers?.length ? `（+${modifiers.join("+")}）` : ""}`,
          );
        }
        case "cua_scroll": {
          const x = Number(args.x);
          const y = Number(args.y);
          const dy = Number(args.dy);
          if (![x, y, dy].every(Number.isFinite)) {
            return errorResult(toolCall, "x / y / dy 必须是数字");
          }
          const resp = await invokeCua<CuaOpResponse>("cua_scroll", { x, y, dy });
          if (!resp.ok) return errorResult(toolCall, formatOpError(resp.error));
          return textResult(toolCall, `已在 (${x}, ${y}) 滚动 dy=${dy}`);
        }
        case "cua_drag": {
          const [x1, y1, x2, y2] = [args.x1, args.y1, args.x2, args.y2].map((v) => Number(v));
          if (![x1, y1, x2, y2].every(Number.isFinite)) {
            return errorResult(toolCall, "x1 / y1 / x2 / y2 必须是数字");
          }
          const resp = await invokeCua<CuaOpResponse>("cua_drag", { x1, y1, x2, y2 });
          if (!resp.ok) return errorResult(toolCall, formatOpError(resp.error));
          return textResult(toolCall, `已拖拽 (${x1}, ${y1}) → (${x2}, ${y2})`);
        }
        default:
          return errorResult(toolCall, `未知 CUA 工具：${toolCall.name}`);
      }
    } catch (err) {
      return errorResult(toolCall, `CUA 调用失败：${formatError(err)}`);
    }
  }

  return {
    groupId: "cua",
    tools,
    executeToolCall,
    metadataByName: createBuiltinMetadataMap(metadataEntries),
  };
}

/**
 * 拉取后端 CUA 状态（供前端 UI 与按需工具挂载判定）。
 */
export async function fetchCuaStatus(): Promise<CuaStatus | null> {
  try {
    return await invoke<CuaStatus>("cua_status");
  } catch {
    return null;
  }
}

/**
 * 工具执行器和设置面板可能在 React 渲染周期之外被调用，`getLocale` 抛错或
 * 返回非法值时回退到默认 locale，不让 CUA 工具整条降级。
 */
function safeReadLocale(getLocale: () => Locale): Locale {
  try {
    const value = getLocale();
    return value === "en-US" || value === "zh-CN" ? value : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}
