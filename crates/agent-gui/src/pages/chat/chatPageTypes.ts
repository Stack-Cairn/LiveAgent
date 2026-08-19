import type { Context } from "@earendil-works/pi-ai";
import type { AppUpdateController } from "../../lib/appUpdates";
import type { AppSettings, SttProviderId } from "../../lib/settings";
import type { SectionId } from "../settings/types";

export type ChatPageProps = {
  settings: AppSettings;
  setSettings: (updater: (prev: AppSettings) => AppSettings) => void;
  sttProviderOverride?: SttProviderId | null;
  getMcpSettings: () => AppSettings["mcp"];
  getToolPolicies: () => AppSettings["system"]["toolPolicies"];
  context: Context;
  setContext: (next: Context) => void;
  onOpenSettings: (section?: SectionId, providerId?: string) => void;
  onToggleTheme: () => void;
  appUpdate?: AppUpdateController;
  onRunningConversationCountChange?: (count: number) => void;
};
