// 代码库语义/混合检索工具（docs/design/code-index.md）。
// 仅在 per-workspace 开关（workspaceResourceSettings[pathKey].codeIndexEnabled）
// 开启时注册——不注册即“工具表 + system prompt 双不注入”，天然满足验收项。
// 执行层直通 Rust `code_index_search`（检索在桌面端本地索引上进行）。

import type { Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { CodeSearchResultDetails } from "@liveagent/ui/contracts/builtinTools";
import { invoke } from "@tauri-apps/api/core";
import { Type } from "typebox";
import { type BuiltinToolBundle, createBuiltinMetadataMap } from "./builtinTypes";
import { waitForAbortablePromise } from "./invokeWithAbort";

export const CODE_SEARCH_TOOL_NAME = "CodeSearch";

const MAX_RESULTS_LIMIT = 20;
const DEFAULT_RESULTS = 8;

// 每 workdir 只自动补一次 enable，避免持久失败时每轮工具调用都重复触发。
const autoEnableAttempted = new Set<string>();

type CodeIndexSearchMatch = {
  path: string;
  startLine: number;
  endLine: number;
  kind: string;
  symbol: string;
  snippet: string;
  score: number;
  source: string;
};

type CodeIndexSearchResponse = {
  matches: CodeIndexSearchMatch[];
  mode: string;
  degraded?: string | null;
  indexing?: string | null;
};

function buildErrorResult(toolCall: ToolCall, text: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [{ type: "text", text }],
    details: {},
    isError: true,
    timestamp: Date.now(),
  };
}

export function createCodeSearchTools(params: { workdir: string }): BuiltinToolBundle {
  // 预热 embedding 模型（fire-and-forget）：工具注册发生在会话构建时，早于
  // 首次检索——不预热的话应用重启后第一波查询必然因模型未加载降级词法。
  // Rust 侧幂等且自带节流，重复调用是廉价 no-op。
  void invoke("code_index_warm", { args: { workdir: params.workdir } }).catch(() => {
    // 预热失败不影响功能（检索路有降级与自愈），静默即可。
  });
  const toolCodeSearch: Tool = {
    name: CODE_SEARCH_TOOL_NAME,
    description: [
      "Search this workspace's code index (hybrid lexical BM25 + semantic embeddings). The index is prebuilt and kept fresh by the workspace watcher.",
      'PREFER this over blind Grep when looking for functionality by intent or concept ("where is retry logic", "auth token refresh"), including natural-language and Chinese queries. Use Grep only for exact literal strings/regexes.',
      "Returns file:line ranges with symbol names and code snippets, ranked by fused relevance.",
    ].join("\n"),
    parameters: Type.Object({
      query: Type.String({
        description:
          "What to find, phrased by intent or concept (natural language works). Identifier fragments also fine.",
      }),
      mode: Type.Optional(
        Type.Union([Type.Literal("hybrid"), Type.Literal("semantic"), Type.Literal("lexical")], {
          description:
            "hybrid (default) fuses both routes; semantic = embeddings only; lexical = BM25 only.",
        }),
      ),
      path: Type.Optional(
        Type.String({
          description: 'Workspace-relative path prefix filter, e.g. "src/services".',
        }),
      ),
      max_results: Type.Optional(
        Type.Number({
          description: `How many matches to return (default ${DEFAULT_RESULTS}, max ${MAX_RESULTS_LIMIT}).`,
        }),
      ),
    }),
  };

  async function executeToolCall(
    toolCall: ToolCall,
    signal?: AbortSignal,
  ): Promise<ToolResultMessage> {
    if (toolCall.name !== CODE_SEARCH_TOOL_NAME) {
      return buildErrorResult(toolCall, `Unknown tool: ${toolCall.name}`);
    }
    const args = (toolCall.arguments || {}) as Record<string, unknown>;
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) {
      return buildErrorResult(toolCall, "query is required.");
    }
    const mode =
      args.mode === "semantic" || args.mode === "lexical" || args.mode === "hybrid"
        ? args.mode
        : undefined;
    const path = typeof args.path === "string" && args.path.trim() ? args.path.trim() : undefined;
    const maxResults =
      typeof args.max_results === "number" && Number.isFinite(args.max_results)
        ? Math.min(Math.max(Math.floor(args.max_results), 1), MAX_RESULTS_LIMIT)
        : undefined;

    let response: CodeIndexSearchResponse;
    try {
      response = await waitForAbortablePromise(
        invoke<CodeIndexSearchResponse>("code_index_search", {
          args: { workdir: params.workdir, query, mode, path, maxResults },
        }),
        signal,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 对账：CodeSearch 已注册说明设置开关是开的，但本地索引缺失（在 WebUI/
      // 异端开启后同步过来、或当时 enable side effect 失败）。触发一次后台
      // 建索引，把模型引导去 Grep 兜底，避免整轮对话陷在必败的工具错误里。
      // 错误文案与 Rust service.search 的“未启用代码索引”保持一致。
      if (message.includes("未启用代码索引") && !autoEnableAttempted.has(params.workdir)) {
        autoEnableAttempted.add(params.workdir);
        void invoke("code_index_enable", { args: { workdir: params.workdir } }).catch(
          (enableError) => {
            console.warn("code index auto-enable failed", enableError);
          },
        );
        return buildErrorResult(
          toolCall,
          "Code index is enabled in settings but missing locally; background indexing has just been started. Use Grep for this query and retry CodeSearch later in the conversation.",
        );
      }
      return buildErrorResult(toolCall, `CodeSearch failed: ${message}`);
    }

    const details: CodeSearchResultDetails = {
      kind: "code_search",
      query,
      mode: response.mode,
      matchCount: response.matches.length,
      ...(response.degraded ? { degraded: response.degraded } : {}),
      ...(response.indexing ? { indexing: response.indexing } : {}),
      matches: response.matches.map((match) => ({
        path: match.path,
        startLine: match.startLine,
        endLine: match.endLine,
        kind: match.kind,
        symbol: match.symbol,
        score: match.score,
        source: match.source,
      })),
    };

    // 索引构建期/降级态必须直达模型：构建期的"0 结果/少结果"不是终局事实。
    const notes = [response.indexing, response.degraded].filter(Boolean) as string[];
    if (response.matches.length === 0) {
      const noteSuffix = notes.length > 0 ? `\n${notes.join("\n")}` : "";
      return {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [
          {
            type: "text",
            text: `No matches for "${query}" (mode: ${response.mode}). Try broader phrasing, a different mode, or fall back to Grep for exact strings.${noteSuffix}`,
          },
        ],
        details,
        isError: false,
        timestamp: Date.now(),
      };
    }

    const lines = response.matches.map((match) => {
      const location = `${match.path}:${match.startLine}-${match.endLine}`;
      const heading = match.symbol
        ? `## ${location} · ${match.kind} \`${match.symbol}\` (${match.source})`
        : `## ${location} (${match.source})`;
      return match.snippet ? `${heading}\n\`\`\`\n${match.snippet}\n\`\`\`` : heading;
    });
    const header =
      notes.length > 0
        ? `${response.matches.length} match(es), mode: ${response.mode} — ${notes.join("；")}`
        : `${response.matches.length} match(es), mode: ${response.mode}`;

    return {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: [{ type: "text", text: [header, "", ...lines].join("\n") }],
      details,
      isError: false,
      timestamp: Date.now(),
    };
  }

  return {
    groupId: "code-index",
    tools: [toolCodeSearch],
    executeToolCall,
    metadataByName: createBuiltinMetadataMap([
      [
        CODE_SEARCH_TOOL_NAME,
        {
          groupId: "code-index",
          kind: "code_search",
          // 只读：只查本地索引与现读文件，plan mode / 子代理天然可用。
          isReadOnly: true,
          displayCategory: "search",
        },
      ],
    ]),
  };
}
