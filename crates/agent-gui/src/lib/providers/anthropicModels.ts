import type { Model } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import {
  hasAnthropicLongContextSuffix,
  shouldSendAnthropicLongContextHeader,
} from "@liveagent/ui/lib/models/anthropicContext";
import { normalizeModelIdCandidates } from "@liveagent/ui/lib/models/modelCatalog";
import { anthropicModelSupportsXHigh } from "@liveagent/ui/lib/models/modelThinking";

export {
  ANTHROPIC_LONG_CONTEXT_WINDOW,
  ANTHROPIC_STANDARD_CONTEXT_WINDOW,
  hasAnthropicLongContextSuffix,
  resolveAnthropicContextWindow,
  resolveAnthropicKnownModelLimits,
  shouldSendAnthropicLongContextHeader,
} from "@liveagent/ui/lib/models/anthropicContext";
// ---------------------------------------------------------------------------
// Anthropic 1M 长上下文窗口策略（请求行为，单一真源）
// ---------------------------------------------------------------------------
// 官方 2026-03-13 起 1M 上下文在 adaptive 世代（Opus/Sonnet 4.6+、Claude 5）GA，
// 无需 beta 头；2026-04-30 起旧世代（Sonnet 4/4.5）的 `context-1m-2025-08-07`
// beta 退役——头仍被接受但无效，超过 200K 的请求必 400。目录（models.dev 快照）
// 仍给 claude-sonnet-4-5 标 1M，这里以"是否 adaptive 世代"（id 启发式，与目录
// 世代集合等价）钳出线上真实的有效窗口，供 settings 默认值与请求侧 beta 头
// 判定共用，预算与信号永不漂移。限额/单价数据本身来自 lib/models/modelCatalog；
// 本文件对 pi-ai 目录的回查（findBuiltinAnthropicModel）只服务 compat 等请求
// 路径元数据。
export { normalizeModelIdCandidates as normalizeAnthropicModelIdCandidates } from "@liveagent/ui/lib/models/modelCatalog";
export { isAnthropicAdaptiveModelId } from "@liveagent/ui/lib/models/modelThinking";

// 中转/网关常给官方 Anthropic 模型 id 加装饰，逐字匹配会漏检 pi-ai 目录；
// 漏检后模型丢失 compat.forceAdaptiveThinking 等请求路径元数据，思考档位失效。
// 候选链与 lib/models/modelCatalog 的目录回查共用同一实现。
export function findBuiltinAnthropicModel(
  modelId: string,
): Model<"anthropic-messages"> | undefined {
  const models = getBuiltinModels("anthropic");
  for (const candidate of normalizeModelIdCandidates(modelId)) {
    const known = models.find((model) => model.id === candidate);
    if (known?.api) return known as Model<"anthropic-messages">;
  }
  return undefined;
}

export function getAnthropicCompat(
  model: Model<"anthropic-messages">,
): Model<"anthropic-messages">["compat"] | undefined {
  return model.compat;
}

// 世代启发式的唯一实现在镜像模块 lib/models/modelThinking（web 端同源）；
// 此处 re-export 供限额/1M 路径的既有消费者使用。
export { anthropicModelSupportsXHigh };

export function resolveAnthropicWireModelId(modelId: string, baseUrl: string | undefined): string {
  if (hasAnthropicLongContextSuffix(modelId) && !shouldSendAnthropicLongContextHeader(baseUrl)) {
    return modelId.replace(/\[1m\]$/i, "");
  }
  return modelId;
}

// adaptive 世代即 1M GA 世代；旧世代目录里的 1M 是退役前的历史数值，按 200K
// 报有效窗口。
