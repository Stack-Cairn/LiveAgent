import type { McpServerConfig, ToolPolicy } from "@liveagent/app/lib/settings";
import {
  CUA_DRIVER_SERVER_ID,
  effectiveServerPolicyDefault,
  isCuaDriverServerId,
} from "@liveagent/ui/contracts/mcpServerDefaults";

/**
 * CUA 设置页的纯逻辑：受管条目的查找、策略键推导、超时钳制、探测缓存、
 * 配置漂移判断。
 *
 * 与组件分开是因为这些判断全是「出了错用户才会发现」的那类——策略键算错
 * 会让页面显示的审批档位和实际执行的不是同一条，超时钳制漏了会把 "6" 存成
 * 6ms，漂移判断缺失会让界面显示一个根本不会被执行的路径。它们值得单测，
 * 而组件本身（布局、图标、文案）不值得。同 `backupSyncForm.ts` /
 * `aboutDate.ts` 的分工。
 */

export type CuaProbe = {
  installed: boolean;
  path?: string | null;
  version?: string | null;
  mcpCommand?: string | null;
  mcpArgs?: string[];
  /** 本平台是否有系统授权门槛。只有 macOS 为 true。 */
  permissionsRequired?: boolean;
  error?: string | null;
};

export type CuaPermissions = {
  supported: boolean;
  accessibility: boolean;
  screenRecording: boolean;
  attributedTo?: string | null;
  error?: string | null;
};

export type CuaInstallPreview = {
  program: string;
  args: string[];
  display: string;
  sourceUrl: string;
};

export type CuaInstallProgress = { stream: string; line: string };

export const CUA_DEFAULT_TIMEOUT_MS = 60_000;

/** 单次调用超时的上限。再长也没有意义——GUI 操作不该跑十分钟。 */
export const CUA_MAX_TIMEOUT_MS = 600_000;

/** 下限。低于这个值任何一次调用都必然超时，等于把功能关掉。 */
export const CUA_MIN_TIMEOUT_MS = 1_000;

export const CUA_INSTALL_PROGRESS_EVENT = "cua_driver_install_progress";

export const CUA_MAX_LOG_LINES = 200;

export const CUA_UPSTREAM_REPO_URL = "https://github.com/trycua/cua";

/** 找出受管的那条 cua-driver 条目（大小写与空白不敏感）。 */
export function findCuaDriverServer(servers: readonly McpServerConfig[]) {
  return servers.find((server) => isCuaDriverServerId(server.id));
}

/** 同上，返回下标——写回时要按原位置改。找不到返回 -1。 */
export function findCuaDriverServerIndex(servers: readonly McpServerConfig[]) {
  return servers.findIndex((server) => isCuaDriverServerId(server.id));
}

/**
 * 该条目的 `server:<id>` 策略键。
 *
 * 跟随条目里那份 id 的**原文**，而不是常量：已有配置可能把 id 写成
 * `CUA-DRIVER`，运行时按原文查 `server:CUA-DRIVER`，这里若硬写
 * `server:cua-driver` 就会出现「页面显示的策略与实际执行的不是同一条」。
 */
export function cuaServerPolicyKey(entry: McpServerConfig | undefined): string {
  return `server:${entry?.id.trim() || CUA_DRIVER_SERVER_ID}`;
}

/** 该条目在无显式配置时的生效策略。受管条目恒为 ask。 */
export function cuaDefaultPolicy(entry: McpServerConfig | undefined): ToolPolicy {
  return effectiveServerPolicyDefault(entry ?? { id: CUA_DRIVER_SERVER_ID });
}

/** 当前生效的审批策略：显式配置优先，否则走缺省。 */
export function readCuaPolicy(
  policies: Record<string, ToolPolicy> | undefined,
  entry: McpServerConfig | undefined,
): ToolPolicy {
  return policies?.[cuaServerPolicyKey(entry)] ?? cuaDefaultPolicy(entry);
}

/**
 * 写回审批策略，返回新的 toolPolicies（空表返回 undefined，与其他设置一致）。
 *
 * 两条规则：
 * - 只有回到缺省值才删 key。受管条目的缺省是 ask，所以「始终允许」必须显式
 *   落库，删掉反而会退回 ask；
 * - 顺手清掉规范化键那条重影。id 写成 `CUA-DRIVER` 时两个键会同时存在，留着
 *   会让 `resolveToolPolicy` 的回落读到上一次的值。
 */
export function applyCuaPolicy(
  policies: Record<string, ToolPolicy> | undefined,
  entry: McpServerConfig | undefined,
  next: ToolPolicy,
): Record<string, ToolPolicy> | undefined {
  const current = { ...(policies ?? {}) };
  const key = cuaServerPolicyKey(entry);
  delete current[`server:${CUA_DRIVER_SERVER_ID}`];
  if (next === cuaDefaultPolicy(entry)) delete current[key];
  else current[key] = next;
  return Object.keys(current).length > 0 ? current : undefined;
}

/** 由探测结果生成受管条目。 */
export function buildCuaServerConfig(probe: CuaProbe): McpServerConfig {
  return {
    id: CUA_DRIVER_SERVER_ID,
    description: "trycua/cua — CUA 驱动（跨平台）",
    docsUrl: CUA_UPSTREAM_REPO_URL,
    enabled: true,
    transport: "stdio",
    // 绝对路径而非裸命令：MCP 子进程继承的是 GUI 进程那份窄 PATH，
    // 通常不含 ~/.local/bin —— 官方安装脚本的默认落点。
    command: probe.mcpCommand || probe.path || "cua-driver",
    // 刻意不带 `--direct`：那会让 MCP 进程沿用 LiveAgent 的 TCC 归属，
    // 等于要求 LiveAgent 自己去拿辅助功能与屏幕录制授权。默认模式经
    // CuaDriver.app 的守护进程代理，授权归它。
    args: probe.mcpArgs?.length ? probe.mcpArgs : ["mcp"],
    url: "",
    timeoutMs: CUA_DEFAULT_TIMEOUT_MS,
  };
}

/** 把输入框里的草稿钳到合法区间；非法值回落到 `fallback`。 */
export function clampCuaTimeoutMs(draft: string, fallback: number): number {
  const parsed = Number.parseInt(draft.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.max(parsed, CUA_MIN_TIMEOUT_MS), CUA_MAX_TIMEOUT_MS);
}

/**
 * 条目里存着的命令与刚探测到的路径是否分叉。
 *
 * 存在的理由：界面必须显示**将要执行的东西**，而不是**碰巧存在的东西**。
 * 条目的 command 是建条目那一刻写死的，用户把 cua-driver 重装到别的位置、
 * 或导入了一份 command 指向别处的同名条目之后，两者就不是一回事了——此时
 * 显示探测路径等于让用户以为一切正常，而实际启动的是另一个二进制。
 */
export function cuaCommandDrift(
  entry: McpServerConfig | undefined,
  probe: CuaProbe | null,
): { configured: string; probed: string } | null {
  const configured = entry?.command?.trim();
  const probed = (probe?.mcpCommand || probe?.path || "").trim();
  if (!configured || !probed || configured === probed) return null;
  return { configured, probed };
}

/** 界面上应当显示的命令：有条目就显示条目里的，否则显示探测到的。 */
export function cuaDisplayCommand(
  entry: McpServerConfig | undefined,
  probe: CuaProbe | null,
): string | null {
  return entry?.command?.trim() || probe?.path?.trim() || null;
}

/** 把条目的 command / args 对齐到最新探测结果，其余字段（超时等）保留。 */
export function realignCuaServerConfig(entry: McpServerConfig, probe: CuaProbe): McpServerConfig {
  const fresh = buildCuaServerConfig(probe);
  return { ...entry, command: fresh.command, args: fresh.args };
}

/**
 * 探测结果的进程内缓存。
 *
 * 每次挂载都重新探测意味着每次切到 CUA 页都要 spawn 子进程——在 Windows 上
 * 是控制台闪窗，在 macOS 上则可能唤起 CuaDriver.app 的守护进程。这些事实在
 * 一分钟内不会变，来回切页没有重查的理由。「重新检测」、安装完成、授权完成
 * 三处显式跳过缓存。
 */
export const CUA_PROBE_CACHE_TTL_MS = 60_000;

type CuaProbeCache = { at: number; probe: CuaProbe; permissions: CuaPermissions | null };

let probeCache: CuaProbeCache | null = null;

export function readCuaProbeCache(now = Date.now()): CuaProbeCache | null {
  if (!probeCache) return null;
  return now - probeCache.at <= CUA_PROBE_CACHE_TTL_MS ? probeCache : null;
}

export function writeCuaProbeCache(
  probe: CuaProbe,
  permissions: CuaPermissions | null,
  now = Date.now(),
) {
  probeCache = { at: now, probe, permissions };
}

/** 授权状态刚变过时只更新那一半，不必把探测也作废。 */
export function patchCuaProbeCachePermissions(permissions: CuaPermissions) {
  if (probeCache) probeCache = { ...probeCache, permissions };
}

/** 供测试重置。 */
export function resetCuaProbeCache() {
  probeCache = null;
}
