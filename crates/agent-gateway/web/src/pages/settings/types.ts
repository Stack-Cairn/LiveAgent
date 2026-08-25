import type { SttSettingsService } from "@liveagent/ui/lib/stt/types";
import type { AppSettings, SttProviderId } from "../../lib/settings";
import type { WebSettingsSaveState } from "../../lib/webSettings";

export type SetSettingsFn = (updater: (prev: AppSettings) => AppSettings) => void;

export type SectionId =
  | "system"
  | "systemTools"
  | "stt"
  | "providers"
  | "agents"
  | "ssh"
  | "memory"
  | "hooks"
  | "cron"
  | "devices"
  | "remote"
  | "cua";

export type SettingsPageProps = {
  settings: AppSettings;
  setSettings: SetSettingsFn;
  saveState: WebSettingsSaveState;
  onBack: () => void;
  initialSection?: SectionId;
  initialProviderId?: string;
  hiddenSections?: SectionId[];
  onAgentDirectoryChanged?: () => void | Promise<void>;
  sttSettingsService: SttSettingsService;
  /** 临时切换语音输入运行供应商，不触发配置保存。 */
  onSttProviderChange?: (provider: SttProviderId) => void;
  /** CUA 后端桥；WebUI 不提供（无 cuaService 时 SettingsPage 不渲染 CUA 段）。 */
  cuaService?: never;
};

export type SettingsSectionProps = {
  settings: AppSettings;
  setSettings: SetSettingsFn;
  saveState?: WebSettingsSaveState;
};
