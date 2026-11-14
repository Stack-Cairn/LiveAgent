import type { ImageStudioClient } from "@liveagent/ui/lib/imaging/types";
import type { SttSettingsService } from "@liveagent/ui/lib/stt/types";
import type { AppUpdateController } from "../../lib/appUpdates";
import type { ReleaseAnnouncementController } from "../../lib/releaseAnnouncement";
import type { AppSettings, SttProviderId } from "../../lib/settings";
import type { SettingsSaveState } from "../../lib/settings/storage";

export type SetSettingsFn = (updater: (prev: AppSettings) => AppSettings) => void;

export type SectionId =
  | "system"
  | "shortcuts"
  | "skills"
  | "mcp"
  | "systemTools"
  | "webSearch"
  | "permissions"
  | "stt"
  | "providers"
  | "agents"
  | "ssh"
  | "memory"
  | "hooks"
  | "cron"
  | "image-studio"
  | "planning"
  | "remote"
  | "cua"
  | "about";

import type { SettingsHostAdapter } from "@liveagent/ui/pages/settings/kbrainSettingsAdapter";

export type SettingsPageProps = {
  settings: AppSettings;
  settingsHost?: SettingsHostAdapter;
  imageClient?: ImageStudioClient;
  registerLeaveGuard?: (guard: () => boolean) => () => void;
  setSettings: SetSettingsFn;
  saveState: SettingsSaveState;
  onBack: () => void;
  initialSection?: SectionId;
  initialProviderId?: string;
  hiddenSections?: SectionId[];
  appUpdate: AppUpdateController;
  releaseAnnouncement: ReleaseAnnouncementController;
  sttSettingsService: SttSettingsService;
  /** 临时切换语音输入运行供应商，不触发配置保存。 */
  onSttProviderChange?: (provider: SttProviderId) => void;
  /** 绕过 setSettings 从 SQLite 重新载入（备份还原后用，见 SettingsSectionProps）。 */
  reloadSettings?: () => Promise<void>;
  /** 旧供应商导入被 K-brain 拒绝的记录，用于在供应商设置里给出可见提示。 */
  rejectedLegacyProviders?: SettingsRejectedLegacyProvider[];
  /** 用户点击“重试导入”时调用。 */
  onRetryRejectedLegacyProviders?: () => void | Promise<void>;
  /** 用户确认关闭提示后调用；关闭不可撤销。 */
  onDismissRejectedLegacyProviders?: () => void;
};

/** 一条旧供应商导入失败的本地记录（与 agent-gui 的持久化结构一致）。 */
export type SettingsRejectedLegacyProvider = {
  id: string;
  name: string;
  fingerprint: string;
  reason: string;
  rejectedAt: number;
};

export type SettingsSectionProps = {
  settings: AppSettings;
  setSettings: SetSettingsFn;
  saveState?: SettingsSaveState;
  /**
   * 从 SQLite 重新载入设置，**不触发落盘**。
   *
   * 备份还原（导入 / WebDAV 下载）是后端直接改库，前端 store 完全不知情。
   * 不重载的话，用户之后编辑任一域，`persistSettings` 会拿还原前的内存值去 diff，
   * 把旧配置原样写回库，再由标脏推上远端 —— 还原被静默回滚。
   *
   * 必须走这条路径而不是 `setSettings`：后者每次都 `queueSettingsSave`，
   * 会把刚落库的数据再写一遍并触发自动上传。
   */
  reloadSettings?: () => Promise<void>;
};
