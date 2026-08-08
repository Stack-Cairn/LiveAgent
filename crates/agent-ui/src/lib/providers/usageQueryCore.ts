// 用量查询共享核心（状态归约、协调器与 hook、展示派生纯函数）。平台传输差异
// 只进各端的 usageQuery.ts 适配层。展示派生函数返回 token/结构，不接触 i18n。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// 富结果模型:与桌面端 Rust UsageData(serde camelCase)同构。字段全可选,
// total === -1 表示无限额度(展示为 ∞)。
export type UsageData = {
  planName?: string | null;
  extra?: string | null;
  isValid?: boolean | null;
  invalidMessage?: string | null;
  total?: number | null;
  used?: number | null;
  remaining?: number | null;
  unit?: string | null;
};

export type ProviderUsageResult = {
  data: UsageData[];
  queriedAt?: number | null;
  error?: string | null;
  isStale: boolean;
};

export type ProviderUsageState = Record<string, ProviderUsageResult>;

export type UsageQueryProvider = {
  id: string;
  usageQuery?: {
    enabled?: boolean;
  };
};

type UsageStateAction = {
  providerId: string;
  result?: ProviderUsageResult | null;
  error?: string;
};

type UsageSnapshot = {
  usageByProvider: ProviderUsageState;
  refreshingProviderIds: ReadonlySet<string>;
};

export type UsageQuery = (
  providerId: string,
  refresh: boolean,
) => Promise<ProviderUsageResult | null>;

export function reduceUsageState(
  state: ProviderUsageState,
  action: UsageStateAction,
): ProviderUsageState {
  if (action.result) {
    // 混版桌面端可能仍回旧形状(无 data 字段)——容错为空数组。
    return {
      ...state,
      [action.providerId]: { ...action.result, data: action.result.data ?? [] },
    };
  }
  if (!action.error) return state;

  const previous = state[action.providerId];
  const hasLastGoodValue = Boolean(previous?.data.length || previous?.queriedAt);
  return {
    ...state,
    [action.providerId]: {
      data: previous?.data ?? [],
      queriedAt: previous?.queriedAt ?? null,
      error: action.error,
      isStale: hasLastGoodValue,
    },
  };
}

/** 打开供应商设置页时批量强制刷新的对象:所有启用了用量查询的供应商。 */
export function getEnabledUsageProviderIds(providers: readonly UsageQueryProvider[]): string[] {
  return providers
    .filter((provider) => provider.usageQuery?.enabled)
    .map((provider) => provider.id);
}

// ---------------------------------------------------------------------------
// 展示派生(纯函数,组件层负责把 token 翻译成 i18n 文案)
// ---------------------------------------------------------------------------

export type UsageRelativeTime =
  | { kind: "justNow" }
  | { kind: "minutesAgo"; value: number }
  | { kind: "hoursAgo"; value: number }
  | { kind: "daysAgo"; value: number };

export function getUsageRelativeTime(queriedAt: number, nowMs: number): UsageRelativeTime {
  const minutes = Math.floor(Math.max(0, nowMs - queriedAt) / 60_000);
  if (minutes < 1) return { kind: "justNow" };
  if (minutes < 60) return { kind: "minutesAgo", value: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { kind: "hoursAgo", value: hours };
  return { kind: "daysAgo", value: Math.floor(hours / 24) };
}

export function formatUsageAmount(value: number): string {
  if (!Number.isFinite(value)) return "";
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

// 配额窗口稳定 token(Rust 侧 coding-plan 输出),未识别的 planName 原样展示。
export type UsagePlanTitle =
  | { kind: "window"; token: "5h" | "weekly" | "monthly" | "quota" }
  | { kind: "text"; text: string }
  | { kind: "none" };

export function resolveUsagePlanTitle(planName: string | null | undefined): UsagePlanTitle {
  switch (planName) {
    case "window:5h":
      return { kind: "window", token: "5h" };
    case "window:weekly":
      return { kind: "window", token: "weekly" };
    case "window:monthly":
      return { kind: "window", token: "monthly" };
    case "window:quota":
      return { kind: "window", token: "quota" };
    default:
      return planName ? { kind: "text", text: planName } : { kind: "none" };
  }
}

export type UsagePlanSeverity = "invalid" | "low" | "normal";

export function getUsagePlanSeverity(plan: UsageData): UsagePlanSeverity {
  if (plan.isValid === false) return "invalid";
  const remaining = usageNumber(plan.remaining);
  const total = usageNumber(plan.total);
  if (remaining !== null && total !== null && total > 0 && remaining < total * 0.1) {
    return "low";
  }
  return "normal";
}

export type UsagePlanDisplay = {
  title: UsagePlanTitle;
  severity: UsagePlanSeverity;
  /** 主数值(优先 remaining;退化到 total-used / used)。 */
  amount: string | null;
  /** 配额总量;total === -1 显示 ∞。 */
  total: string | null;
  /** remaining/total 百分比(0-100 取整),total>0 时才有。 */
  percent: number | null;
  unit: string | null;
  extra: string | null;
  invalid: boolean;
  invalidMessage: string | null;
};

function usageNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function getUsagePlanDisplay(plan: UsageData): UsagePlanDisplay {
  const remaining = usageNumber(plan.remaining);
  const used = usageNumber(plan.used);
  const total = usageNumber(plan.total);
  const amountValue =
    remaining ?? (total !== null && total >= 0 && used !== null ? total - used : used);
  const invalid = plan.isValid === false;
  return {
    title: resolveUsagePlanTitle(plan.planName),
    severity: getUsagePlanSeverity(plan),
    amount: amountValue !== null ? formatUsageAmount(amountValue) : null,
    total: total !== null ? (total === -1 ? "∞" : formatUsageAmount(total)) : null,
    percent:
      total !== null && total > 0 && remaining !== null
        ? Math.round(Math.min(100, Math.max(0, (remaining / total) * 100)))
        : null,
    unit: typeof plan.unit === "string" && plan.unit ? plan.unit : null,
    extra: typeof plan.extra === "string" && plan.extra ? plan.extra : null,
    invalid,
    invalidMessage:
      invalid && typeof plan.invalidMessage === "string" && plan.invalidMessage
        ? plan.invalidMessage
        : null,
  };
}

export function getProviderUsageCardDisplay(
  provider: UsageQueryProvider,
  usage: ProviderUsageResult | undefined,
  refreshing: boolean,
  nowMs: number,
) {
  const queriedAt = usage?.queriedAt ?? null;
  return {
    show: Boolean(provider.usageQuery?.enabled || usage),
    plans: (usage?.data ?? []).map(getUsagePlanDisplay),
    isStale: usage?.isStale === true,
    error: usage?.error ?? null,
    updatedAt:
      typeof queriedAt === "number" && Number.isFinite(queriedAt)
        ? getUsageRelativeTime(queriedAt, nowMs)
        : null,
    refreshDisabled: refreshing,
  };
}

// 相对时间的 30s ticker:卡片列表挂一个实例,驱动"N 分钟前"随时间推进。
export const USAGE_NOW_TICK_MS = 30_000;

export function useUsageNowTicker(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), USAGE_NOW_TICK_MS);
    return () => window.clearInterval(interval);
  }, [enabled]);
  return now;
}

export function createProviderUsageCoordinator(query: UsageQuery) {
  let providers = new Map<string, UsageQueryProvider>();
  const generations = new Map<string, number>();
  let usageByProvider: ProviderUsageState = {};
  let refreshingProviderIds = new Set<string>();
  const listeners = new Set<(snapshot: UsageSnapshot) => void>();

  function snapshot(): UsageSnapshot {
    return { usageByProvider, refreshingProviderIds: new Set(refreshingProviderIds) };
  }

  function emit() {
    const next = snapshot();
    for (const listener of listeners) listener(next);
  }

  function nextGeneration(providerId: string) {
    const next = (generations.get(providerId) ?? 0) + 1;
    generations.set(providerId, next);
    return next;
  }

  function isCurrent(providerId: string, provider: UsageQueryProvider, generation: number) {
    return providers.get(providerId) === provider && generations.get(providerId) === generation;
  }

  function invalidate(providerId: string) {
    nextGeneration(providerId);
    const nextRefreshing = new Set(refreshingProviderIds);
    nextRefreshing.delete(providerId);
    refreshingProviderIds = nextRefreshing;
    if (usageByProvider[providerId]) {
      const nextUsage = { ...usageByProvider };
      delete nextUsage[providerId];
      usageByProvider = nextUsage;
    }
  }

  return {
    getSnapshot: snapshot,
    subscribe(listener: (next: UsageSnapshot) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    syncProviders(nextProviders: readonly UsageQueryProvider[]) {
      const nextById = new Map(nextProviders.map((provider) => [provider.id, provider]));
      const ids = new Set([...providers.keys(), ...nextById.keys()]);
      let changed = false;
      for (const providerId of ids) {
        if (providers.get(providerId) === nextById.get(providerId)) continue;
        invalidate(providerId);
        changed = true;
      }
      providers = nextById;
      if (changed) emit();
    },
    async request(providerId: string, refresh: boolean) {
      const provider = providers.get(providerId);
      if (!provider) return;

      const generation = nextGeneration(providerId);
      refreshingProviderIds = new Set(refreshingProviderIds).add(providerId);
      emit();
      try {
        const result = await query(providerId, refresh);
        if (result && isCurrent(providerId, provider, generation)) {
          usageByProvider = reduceUsageState(usageByProvider, { providerId, result });
          emit();
        }
      } catch {
        if (isCurrent(providerId, provider, generation)) {
          usageByProvider = reduceUsageState(usageByProvider, {
            providerId,
            error: "Usage query failed",
          });
          emit();
        }
      } finally {
        if (isCurrent(providerId, provider, generation)) {
          refreshingProviderIds = new Set(refreshingProviderIds);
          refreshingProviderIds.delete(providerId);
          emit();
        }
      }
    },
  };
}

export function useProviderUsageWithQuery(
  query: UsageQuery,
  providers: readonly UsageQueryProvider[],
) {
  const coordinatorRef = useRef<ReturnType<typeof createProviderUsageCoordinator> | null>(null);
  if (!coordinatorRef.current) {
    coordinatorRef.current = createProviderUsageCoordinator(query);
  }
  const coordinator = coordinatorRef.current;
  const [snapshot, setSnapshot] = useState(() => coordinator.getSnapshot());
  const enabledProviderIds = useMemo(() => getEnabledUsageProviderIds(providers), [providers]);

  useEffect(() => coordinator.subscribe(setSnapshot), [coordinator]);

  useEffect(() => {
    coordinator.syncProviders(providers);
  }, [coordinator, providers]);

  useEffect(() => {
    return () => coordinator.syncProviders([]);
  }, [coordinator]);

  // 打开供应商设置页即对所有启用查询的供应商并发强制刷新一次;供应商配置
  // 变更(providers 引用变化)时对应卡片被协调器失效后也走这里重查。
  useEffect(() => {
    for (const providerId of enabledProviderIds) {
      void coordinator.request(providerId, true);
    }
  }, [coordinator, enabledProviderIds]);

  const refreshProvider = useCallback(
    (providerId: string) => coordinator.request(providerId, true),
    [coordinator],
  );

  return { ...snapshot, refreshProvider };
}
