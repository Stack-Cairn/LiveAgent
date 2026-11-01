import type {
  GatewaySettingsAppliedClientSeqs,
  GatewaySettingsSyncUpdatePayload,
  GatewaySettingsSyncVersion,
} from "@liveagent/ui/lib/settings/sync";

import type { AppSettings } from "@/lib/settings";

// 本地连续改设置时，桌面端对较早那次修改推回的整份快照会晚到。在途字段保留本地值，
// 等桌面端回执（appliedClientSeqs）或保存链静默后再放开，旧回声就盖不回去。
export const SETTINGS_ECHO_SETTLE_MS = 1_000;
export const SETTINGS_ECHO_ACK_TIMEOUT_MS = 10_000;

export type PendingSettingsField = Extract<
  keyof GatewaySettingsSyncUpdatePayload,
  keyof AppSettings
>;

const SIDECAR_FIELDS: Partial<
  Record<keyof GatewaySettingsSyncUpdatePayload, PendingSettingsField>
> = {
  sshPatch: "ssh",
  sshSecretUpdates: "ssh",
  projectPrompts: "system",
  systemProxyPasswordUpdate: "system",
  providerApiKeyUpdates: "customProviders",
  providerUsageQuerySecretUpdates: "customProviders",
  sttSecretUpdate: "stt",
};

const SETTINGS_FIELDS = new Set<string>([
  "system",
  "customProviders",
  "mcp",
  "agents",
  "ssh",
  "remote",
  "stt",
  "memory",
  "modelFailover",
  "customSettings",
  "skills",
  "chatRuntimeControls",
  "selectedModel",
  "theme",
  "locale",
] satisfies PendingSettingsField[]);

/** 一次更新会让 WebUI 本地哪些设置字段进入在途状态。 */
export function pendingFieldsForUpdate(
  update: GatewaySettingsSyncUpdatePayload,
): PendingSettingsField[] {
  const fields = new Set<PendingSettingsField>();
  for (const key of Object.keys(update) as (keyof GatewaySettingsSyncUpdatePayload)[]) {
    const sidecar = SIDECAR_FIELDS[key];
    if (sidecar) fields.add(sidecar);
    else if (SETTINGS_FIELDS.has(key)) fields.add(key as PendingSettingsField);
  }
  return [...fields];
}

/** 桌面端回执表；缺失表示对端（旧版桌面端或 K-brain relay）不支持回执。 */
export function readAppliedClientSeqs(payload: unknown): GatewaySettingsAppliedClientSeqs | null {
  const acks = (payload as { appliedClientSeqs?: unknown } | null)?.appliedClientSeqs;
  return acks && typeof acks === "object" && !Array.isArray(acks)
    ? (acks as GatewaySettingsAppliedClientSeqs)
    : null;
}

/** 快照的缓存版本；缺失表示对端不带版本（旧版桌面端或 K-brain relay）。 */
export function readSettingsSyncVersion(payload: unknown): GatewaySettingsSyncVersion | null {
  const version = (payload as { settingsSyncVersion?: Partial<GatewaySettingsSyncVersion> } | null)
    ?.settingsSyncVersion;
  if (!version || typeof version.epoch !== "string" || !version.epoch) return null;
  if (typeof version.generation !== "number" || !Number.isFinite(version.generation)) return null;
  return { epoch: version.epoch, generation: version.generation };
}

export function keepPendingFields(
  next: AppSettings,
  local: AppSettings,
  pending: ReadonlyMap<PendingSettingsField, unknown>,
): AppSettings {
  if (pending.size === 0) return next;
  const kept = { ...next } as Record<PendingSettingsField, unknown>;
  for (const field of pending.keys()) kept[field] = local[field];
  return kept as AppSettings;
}

export function createSettingsSyncClientId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  return random ?? `webui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
