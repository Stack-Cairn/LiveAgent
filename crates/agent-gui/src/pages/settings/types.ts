import type { SttSettingsService } from "@liveagent/ui/lib/stt/types";
import type { CuaService } from "@liveagent/ui/pages/settings/CuaSection";
import type { AppUpdateController } from "../../lib/appUpdates";
import type { AppSettings, SttProviderId } from "../../lib/settings";
import type { SettingsSaveState } from "../../lib/settings/storage";

export type SetSettingsFn = (updater: (prev: AppSettings) => AppSettings) => void;

export type SectionId =
  | "system"
  | "shortcuts"
  | "systemTools"
  | "stt"
  | "providers"
  | "agents"
  | "ssh"
  | "memory"
  | "hooks"
  | "cron"
  | "remote"
  | "cua"
  | "about";

export type SettingsPageProps = {
  settings: AppSettings;
  setSettings: SetSettingsFn;
  saveState: SettingsSaveState;
  onBack: () => void;
  initialSection?: SectionId;
  initialProviderId?: string;
  hiddenSections?: SectionId[];
  appUpdate: AppUpdateController;
  sttSettingsService: SttSettingsService;
  /** 临时切换语音输入运行供应商，不触发配置保存。 */
  onSttProviderChange?: (provider: SttProviderId) => void;
  /** 绕过 setSettings 从 SQLite 重新载入（备份还原后用，见 SettingsSectionProps）。 */
  reloadSettings?: () => Promise<void>;
  /** CUA 后端桥；桌面端由 `settingsExtension` 注入，WebUI 不提供。 */
  cuaService?: CuaService;
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
