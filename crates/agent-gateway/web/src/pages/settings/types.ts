import type { ImageStudioClient } from "@liveagent/ui/lib/imaging/types";
import type { SttSettingsService } from "@liveagent/ui/lib/stt/types";
import type { AppSettings, SttProviderId } from "../../lib/settings";
import type { WebSettingsSaveState } from "../../lib/webSettings";

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
  | "devices"
  | "cua"
  | "remote";

import type { SettingsHostAdapter } from "@liveagent/ui/pages/settings/kbrainSettingsAdapter";

export type SettingsPageProps = {
  settings: AppSettings;
  settingsHost?: SettingsHostAdapter;
  imageClient?: ImageStudioClient;
  registerLeaveGuard?: (guard: () => boolean) => () => void;
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
  /** 共享设置页的桌面端专属入口：旧供应商导入只发生在桌面端，WebUI 不传。 */
  rejectedLegacyProviders?: SettingsRejectedLegacyProvider[];
  onRetryRejectedLegacyProviders?: () => void | Promise<void>;
  onDismissRejectedLegacyProviders?: () => void;
};

/** 与桌面端 `pages/settings/types.ts` 保持一致，供共享 UI 引用。 */
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
  saveState?: WebSettingsSaveState;
};
