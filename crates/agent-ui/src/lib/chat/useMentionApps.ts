import { invoke } from "@liveagent/app/shims/tauriCore";
import type { MentionComposerApp } from "@liveagent/ui/components/chat/MentionComposer";
import { isCuaDriverServer } from "@liveagent/ui/contracts/mcpServerDefaults";
import { registerAppMentionIcons } from "@liveagent/ui/lib/chat/appMentionIcons";
import type { McpServerConfig } from "@liveagent/ui/lib/settings/types";
import { useEffect, useMemo, useState } from "react";

type InstalledApp = {
  name: string;
  bundleId: string;
  path: string;
  iconDataUrl?: string;
};

const EMPTY_APPS: MentionComposerApp[] = [];

/**
 * 输入框 @ 提及的应用候选（computer use 操作目标）。
 *
 * 门控与 cua-driver 的接入状态一致：当前会话的工作区资源里挂着
 * cua-driver（按 id 或 command 判定，与审批缺省/自指闸门同一份裁决，见
 * contracts/mcpServerDefaults.ts）且处于 agent 模式时才枚举；否则返回空
 * 数组，@ 弹层的行为与从前完全一致。
 *
 * 列表在门控首次满足时取一次并缓存整个会话周期——安装应用集合的变化
 * 频率远低于会话生命周期，实时性不值得每次开弹层都扫一遍磁盘。枚举
 * 失败置 fetched 后本挂载周期内不再重试（组件重挂载才会再扫），避免
 * 门控反复翻转时重复扫磁盘。宿主自身已在 Rust 侧剔除（cuaSelfGuard
 * 会拒绝以宿主为目标的操作）。
 *
 * 双端共用：`invoke` 经 `@liveagent/app/shims/tauriCore` 按宿主解析——
 * GUI 直连 Tauri 命令 `cua_driver_list_installed_apps`；WebUI 的 shim 把
 * 同名命令经 Gateway 直通中继到已连接的桌面 Agent（installed_apps_list
 * 臂），列出的是**桌面宿主本机**的已安装应用，与远程会话跑在桌面、
 * cua-driver 操作桌面屏幕的模型一致。
 *
 * 平台收窄：枚举实现见 services/cua_driver/installed_apps.rs——macOS 扫
 * 应用目录、Windows 扫开始菜单快捷方式，其他平台（Linux 等）返回空
 * 列表，@ 弹层不出现应用分组。
 */
export function useMentionApps(mcpServers: readonly McpServerConfig[], isAgentMode: boolean) {
  const cuaEnabled = useMemo(
    () => isAgentMode && mcpServers.some((server) => isCuaDriverServer(server)),
    [isAgentMode, mcpServers],
  );
  const [apps, setApps] = useState<MentionComposerApp[]>(EMPTY_APPS);
  const [fetched, setFetched] = useState(false);

  useEffect(() => {
    if (!cuaEnabled || fetched) return;
    let cancelled = false;
    invoke<InstalledApp[]>("cua_driver_list_installed_apps")
      .then((installed) => {
        if (cancelled) return;
        setFetched(true);
        const mapped = installed.map((app) => ({
          name: app.name,
          bundleId: app.bundleId || undefined,
          path: app.path,
          iconDataUrl: app.iconDataUrl || undefined,
        }));
        // chip 与用户气泡按身份从注册表取 logo（data URL 不进序列化），
        // 列表落地时登记一次即可覆盖三处展示面。
        registerAppMentionIcons(mapped);
        setApps(mapped);
      })
      .catch(() => {
        // 枚举失败按"没有应用候选"降级，见模块注释的重试语义。
        if (!cancelled) setFetched(true);
      });
    return () => {
      cancelled = true;
    };
  }, [cuaEnabled, fetched]);

  return cuaEnabled ? apps : EMPTY_APPS;
}
