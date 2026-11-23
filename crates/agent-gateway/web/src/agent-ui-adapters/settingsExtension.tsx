import { CircleHelp, Keyboard, MonitorSmartphone } from "@liveagent/ui/components/IconSet";
import { onDemand } from "@liveagent/ui/components/OnDemand";
import { SettingsCard, SettingsSection } from "@liveagent/ui/components/settings/SettingsLayout";
import type { SettingsSectionDefinition, UiExtensionSlots } from "@liveagent/ui/contracts/registry";
import {
  type KBrainWebSearchSettings,
  type KBrainWebSearchUpdate,
  recordWebSearchFallbackState,
  webSearchFallbackStateFrom,
} from "@liveagent/ui/lib/providers/webSearchFallback";
import {
  configureResourceHostCapabilities,
  kbrainResourceHostCapabilities,
} from "@liveagent/ui/lib/resourceHost";
import type { SettingsSearchExtension } from "@liveagent/ui/lib/settings/settingsSearchIndex";
import type { GatewaySettingsSyncUpdatePayload } from "@liveagent/ui/lib/settings/sync";
import type {
  KBrainMemoryConfig,
  KBrainMemoryOrganizerConfig,
  KBrainSettingsAdapter,
  KBrainSettingsDocument,
  PermissionRule,
} from "@liveagent/ui/pages/settings/kbrainSettingsAdapter";
import { getGatewayWebSocketClient } from "../lib/gatewaySocket";
import { loadToken } from "../lib/storage";
import type { SettingsPageProps } from "../pages/settings/types";
import { gatewaySkillsAdapter } from "./kbrainSkills";
import { WEB_UNSUPPORTED_SHORTCUT_COMMANDS, webSettingsSearch } from "./settingsSearch";

// This module is loaded with the app (for `settingsHostAdapter`); the section
// bodies load with the settings page that renders them.
const ShortcutCommandsSection = onDemand(
  async () =>
    (await import("@liveagent/ui/pages/settings/ShortcutCommandsSection")).ShortcutCommandsSection,
);
const DevicesSection = onDemand(
  async () => (await import("../pages/settings/DevicesSection")).DevicesSection,
);
const DiagnosticsExportRow = onDemand(
  async () => (await import("@liveagent/ui/pages/settings/HelpSettingsRows")).DiagnosticsExportRow,
);

export function createSettingsExtension(props: SettingsPageProps): {
  surface: "web";
  iconClassName: string;
  slots: UiExtensionSlots;
  sections: SettingsSectionDefinition<void>[];
  search: SettingsSearchExtension;
} {
  return {
    surface: "web",
    iconClassName: "size-4",
    search: webSettingsSearch,
    slots: {},
    sections: [
      {
        id: "shortcuts",
        groupKey: "settings.groupGeneral",
        groupOrder: 10,
        order: 40,
        labelKey: "settings.navShortcuts",
        icon: <Keyboard className="size-4" />,
        showSaveIndicator: false,
        render: () => (
          <ShortcutCommandsSection excludeCommandIds={WEB_UNSUPPORTED_SHORTCUT_COMMANDS} />
        ),
      },
      {
        id: "devices",
        groupKey: "settings.groupConnectivity",
        groupOrder: 40,
        order: 30,
        labelKey: "settings.navAgentManagement",
        icon: <MonitorSmartphone className="size-4" />,
        showSaveIndicator: false,
        render: () => <DevicesSection onDirectoryChanged={props.onAgentDirectoryChanged} />,
      },
      {
        id: "help",
        groupKey: "settings.groupConnectivity",
        groupOrder: 40,
        order: 90,
        labelKey: "settings.aboutHelp",
        icon: <CircleHelp className="size-4" />,
        showSaveIndicator: false,
        render: () => (
          <SettingsSection>
            <SettingsCard>
              <DiagnosticsExportRow data-settings-anchor="web-diagnostics" />
            </SettingsCard>
          </SettingsSection>
        ),
      },
    ],
  };
}

configureResourceHostCapabilities({
  ...kbrainResourceHostCapabilities,
  skillsAdapter: gatewaySkillsAdapter,
});

const computerSettingsAdapter: KBrainSettingsAdapter = {
  isKbrain: true,
  runtimeConnection: () => null,
  getConnection: () => null,
  async getSettings() {
    const document = await getGatewayWebSocketClient(loadToken().trim()).getSettings();
    const projected: KBrainSettingsDocument = {
      mode: "kbrain",
      defaultModel: "",
      defaultProvider: "",
      providers: [],
      models: document.customProviders.flatMap((p) =>
        p.models
          .filter((m) => !p.activeModels || p.activeModels.includes(m.id))
          .map((m) => ({ provider: p.id, id: m.id, name: m.displayName || m.id })),
      ),
      aiApproval: document.aiApproval,
      computer: document.computer,
      memory: document.kbrainMemory,
      memoryOrganizer: document.kbrainMemoryOrganizer,
      // readWebSearchSettings checks the shape wherever it is read.
      ...(document.kbrainWebSearch
        ? { webSearch: document.kbrainWebSearch as KBrainWebSearchSettings }
        : {}),
    };
    recordWebSearchFallbackState(webSearchFallbackStateFrom(projected));
    return projected;
  },
  async updateSettings(update) {
    // Gateway carries the K-brain memory switch as `kbrainMemory`, the organizer
    // schedule as `kbrainMemoryOrganizer` and the web search service as
    // `kbrainWebSearch`: its `memory` key is LiveAgent's own settings.
    const { memory, memoryOrganizer, webSearch, ...rest } = update as Omit<
      GatewaySettingsSyncUpdatePayload,
      "kbrainMemoryOrganizer" | "kbrainWebSearch"
    > & {
      memory?: KBrainMemoryConfig;
      memoryOrganizer?: Partial<KBrainMemoryOrganizerConfig>;
      webSearch?: KBrainWebSearchUpdate;
    };
    await getGatewayWebSocketClient(loadToken().trim()).updateSettings({
      ...rest,
      ...(memory ? { kbrainMemory: memory } : {}),
      // A partial schedule is forwarded as is; K-brain keeps the field left out.
      ...(memoryOrganizer
        ? { kbrainMemoryOrganizer: memoryOrganizer as KBrainMemoryOrganizerConfig }
        : {}),
      ...(webSearch ? { kbrainWebSearch: webSearch } : {}),
    });
    return this.getSettings();
  },
};

type WirePermissionRule = {
  id: string;
  rule: string;
  effect: PermissionRule["effect"];
  scope: PermissionRule["scope"];
  created_at?: string;
  source_session?: string;
};

function permissionRuleFromWire(rule: WirePermissionRule): PermissionRule {
  return {
    id: rule.id,
    rule: rule.rule,
    effect: rule.effect,
    scope: rule.scope,
    ...(rule.created_at ? { createdAt: rule.created_at } : {}),
    ...(rule.source_session ? { sourceSession: rule.source_session } : {}),
  };
}

const gatewayClient = () => getGatewayWebSocketClient(loadToken().trim());

// Settings → 权限 on the WebUI: the desktop (or a direct K-brain target) answers through
// the Gateway; an old desktop is refused by the Gateway with an "update LiveAgent" message.
computerSettingsAdapter.listPermissionRules = async ({ workspace }) => {
  const list = await gatewayClient().permissionRules<{
    project_root?: string;
    rules?: WirePermissionRule[];
  }>("list", workspace ? { workspace } : {});
  return {
    ...(list.project_root ? { projectRoot: list.project_root } : {}),
    rules: (list.rules ?? []).map(permissionRuleFromWire),
  };
};
computerSettingsAdapter.addPermissionRule = async (input) =>
  permissionRuleFromWire(
    await gatewayClient().permissionRules<WirePermissionRule>("add", { ...input }),
  );
computerSettingsAdapter.deletePermissionRule = async (ref) => {
  await gatewayClient().permissionRules("delete", { ...ref });
};

// Settings → 用量统计 on the WebUI, read-only through the Gateway. The desktop (or a
// direct K-brain target) answers `available: false` for a K-brain without the capability;
// an old desktop is refused by the Gateway with an "update LiveAgent" message.
computerSettingsAdapter.getUsageStats = (query) =>
  gatewayClient().usageStats({ days: query.days, timezone: query.timezone });

export const settingsHostAdapter = { isKbrain: true as const, kbrain: computerSettingsAdapter };
