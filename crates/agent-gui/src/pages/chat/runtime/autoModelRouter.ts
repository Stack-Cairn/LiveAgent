import type { AppSettings, AutoRoutingTier, SelectedModel } from "../../../lib/settings";

export type AutoRoutingInput = {
  text: string;
  hasAttachments?: boolean;
};

export type AutoRoutingReason =
  | "attachment"
  | "long-prompt"
  | "medium-prompt"
  | "complex-task"
  | "simple-task";

export type AutoRoutingDecision = {
  requestedTier: AutoRoutingTier;
  selectedTier: AutoRoutingTier;
  reasons: AutoRoutingReason[];
  selectedModel: SelectedModel;
  provider: AppSettings["customProviders"][number];
  model: string;
};

const COMPLEX_TASK_PATTERNS = [
  /\b(?:analy[sz]e|architecture|compare|debug|design|implement|investigate|plan|refactor|review|test)\b/gi,
  /\b(?:bug|error|failure|multi[- ]?step|performance|security|trade-?off)\b/gi,
  /(?:分析|架构|比较|调试|规划|设计|实现|排查|评审|重构|测试|修复|性能|安全|多步骤)/g,
];

const FALLBACK_TIERS: Record<AutoRoutingTier, AutoRoutingTier[]> = {
  fast: ["fast", "balanced", "reasoning"],
  balanced: ["balanced", "reasoning", "fast"],
  reasoning: ["reasoning", "balanced", "fast"],
};

export function classifyAutoRoutingInput(input: AutoRoutingInput): {
  tier: AutoRoutingTier;
  reasons: AutoRoutingReason[];
} {
  const text = input.text.trim();
  const reasons: AutoRoutingReason[] = [];

  if (input.hasAttachments) reasons.push("attachment");
  if (text.length >= 1200) reasons.push("long-prompt");
  else if (text.length >= 400) reasons.push("medium-prompt");

  let complexitySignals = 0;
  for (const pattern of COMPLEX_TASK_PATTERNS) {
    pattern.lastIndex = 0;
    complexitySignals += text.match(pattern)?.length ?? 0;
  }
  if (complexitySignals > 0) reasons.push("complex-task");

  if (input.hasAttachments || text.length >= 1200 || complexitySignals >= 2) {
    return { tier: "reasoning", reasons };
  }
  if (text.length >= 400 || complexitySignals === 1) {
    return { tier: "balanced", reasons };
  }
  return { tier: "fast", reasons: ["simple-task"] };
}

export function routeAutoModel(
  settings: AppSettings,
  input: AutoRoutingInput,
): AutoRoutingDecision {
  const classification = classifyAutoRoutingInput(input);
  const candidates: Array<{
    tier: AutoRoutingTier;
    selectedModel: SelectedModel;
    provider: AppSettings["customProviders"][number];
    model: string;
  }> = [];

  for (const provider of settings.customProviders) {
    for (const model of provider.activeModels) {
      const tier = provider.models.find((item) => item.id === model)?.autoRoutingTier;
      if (!tier) continue;
      candidates.push({
        tier,
        selectedModel: { customProviderId: provider.id, model },
        provider,
        model,
      });
    }
  }

  for (const tier of FALLBACK_TIERS[classification.tier]) {
    const candidate = candidates.find((item) => item.tier === tier);
    if (!candidate) continue;
    return {
      requestedTier: classification.tier,
      selectedTier: tier,
      reasons: classification.reasons,
      selectedModel: candidate.selectedModel,
      provider: candidate.provider,
      model: candidate.model,
    };
  }

  throw new Error(
    "Auto 模式没有可用模型。请在供应商设置中为至少一个已启用模型配置 Auto 路由档位。",
  );
}
