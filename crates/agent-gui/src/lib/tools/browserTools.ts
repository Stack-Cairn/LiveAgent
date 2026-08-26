import type { Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { invoke } from "@tauri-apps/api/core";
import { Type } from "typebox";
import {
  type BrowserResultDetails,
  type BuiltinToolBundle,
  createBuiltinMetadataMap,
} from "./builtinTypes";
import type { ShellSandboxSettings } from "./shellTools";

type BrowserAction =
  | "navigate"
  | "snapshot"
  | "click"
  | "type"
  | "screenshot"
  | "eval"
  | "wait"
  | "back";

type BrowserActionResponse = {
  action: string;
  url?: string | null;
  title?: string | null;
  snapshot?: string | null;
  result?: string | null;
  screenshotBase64?: string | null;
  screenshotMime?: string | null;
};

const BROWSER_PARAMETERS = Type.Object({
  action: Type.Union([
    Type.Literal("navigate"),
    Type.Literal("snapshot"),
    Type.Literal("click"),
    Type.Literal("type"),
    Type.Literal("screenshot"),
    Type.Literal("eval"),
    Type.Literal("wait"),
    Type.Literal("back"),
  ]),
  url: Type.Optional(
    Type.String({ description: "navigate: target URL. https:// is assumed when no scheme." }),
  ),
  ref: Type.Optional(
    Type.String({
      description:
        'click/type: element ref id from the latest snapshot output, e.g. "e12". Take a fresh snapshot after any page change before reusing refs.',
    }),
  ),
  text: Type.Optional(Type.String({ description: "type: text to enter into the element." })),
  submit: Type.Optional(
    Type.Boolean({ description: "type: press Enter after typing (submit forms/searches)." }),
  ),
  expression: Type.Optional(
    Type.String({ description: "eval: JavaScript expression evaluated in the page." }),
  ),
  selector: Type.Optional(
    Type.String({ description: "wait: CSS selector to wait for (alternative to timeMs)." }),
  ),
  timeMs: Type.Optional(
    Type.Number({ minimum: 1, description: "wait: plain delay in milliseconds (max 60000)." }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({ minimum: 1000, description: "Per-action timeout, default 30000, max 120000." }),
  ),
  includeSnapshot: Type.Optional(
    Type.Boolean({
      description:
        "Whether to append a fresh a11y snapshot to the result. Defaults to true for page-changing actions.",
    }),
  ),
});

function asErrorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

function formatResult(response: BrowserActionResponse): string {
  const lines: string[] = [];
  const location = [response.url, response.title && `"${response.title}"`]
    .filter(Boolean)
    .join(" — ");
  if (location) lines.push(`Page: ${location}`);
  if (response.result) lines.push(response.result);
  if (response.screenshotBase64) lines.push("Screenshot captured (see image below).");
  if (response.snapshot) lines.push("", "Page snapshot (a11y tree):", response.snapshot);
  return lines.join("\n") || "OK";
}

export function createBrowserTools(params: { sandbox?: ShellSandboxSettings }): BuiltinToolBundle {
  // sandboxOffline(enabled 且 !allowNetwork)语义必须覆盖浏览器出网。注册层
  // 已在 builtinRegistry 里整体跳过本 bundle;这里是 executor 级的 fail-closed 兜底。
  const offlineSandboxed = params.sandbox?.enabled === true && !params.sandbox.allowNetwork;

  const toolBrowser: Tool = {
    name: "Browser",
    description:
      "Automate a dedicated Chromium browser (isolated profile, separate from the user's daily browser). Actions: navigate (open URL), snapshot (a11y tree with element refs), click/type (interact via refs from the latest snapshot), screenshot (returns an image), eval (run JavaScript in the page), wait (selector or delay), back (history). Page-changing actions return a fresh snapshot automatically. The browser launches on first use and persists across calls in this session.",
    parameters: BROWSER_PARAMETERS,
  };

  async function executeToolCall(
    toolCall: ToolCall,
    signal?: AbortSignal,
  ): Promise<ToolResultMessage> {
    const now = Date.now();
    const args = (toolCall.arguments ?? {}) as Record<string, unknown>;
    const action = String(args.action ?? "") as BrowserAction;

    const fail = (text: string): ToolResultMessage => ({
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: [{ type: "text", text }],
      details: { kind: "browser", action } satisfies BrowserResultDetails,
      isError: true,
      timestamp: now,
    });

    if (toolCall.name !== "Browser") {
      return fail(`Unknown tool: ${toolCall.name}`);
    }
    if (offlineSandboxed) {
      return fail(
        "Browser is unavailable: the session runs in offline sandbox mode (sandboxOffline), which must also cover browser network access.",
      );
    }
    if (signal?.aborted) {
      return fail("Cancelled");
    }

    try {
      const response = await invoke<BrowserActionResponse>("browser_action", {
        args: {
          action,
          url: args.url,
          ref: args.ref,
          text: args.text,
          submit: args.submit,
          expression: args.expression,
          selector: args.selector,
          timeMs: args.timeMs,
          timeoutMs: args.timeoutMs,
          includeSnapshot: args.includeSnapshot,
        },
      });
      const content: ToolResultMessage["content"] = [
        { type: "text", text: formatResult(response) },
      ];
      if (response.screenshotBase64) {
        content.push({
          type: "image",
          data: response.screenshotBase64,
          mimeType: response.screenshotMime ?? "image/jpeg",
        });
      }
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content,
        details: {
          kind: "browser",
          action,
          url: response.url ?? undefined,
          title: response.title ?? undefined,
          hasSnapshot: Boolean(response.snapshot),
          hasScreenshot: Boolean(response.screenshotBase64),
        } satisfies BrowserResultDetails,
        isError: false,
        timestamp: now,
      };
    } catch (err) {
      return fail(`Browser ${action || "action"} failed: ${asErrorMessage(err)}`);
    }
  }

  return {
    groupId: "browser",
    tools: [toolBrowser],
    executeToolCall,
    metadataByName: createBuiltinMetadataMap([
      [
        "Browser",
        {
          groupId: "browser",
          kind: "browser",
          isReadOnly: false,
          displayCategory: "other",
        },
      ],
    ]),
  };
}
