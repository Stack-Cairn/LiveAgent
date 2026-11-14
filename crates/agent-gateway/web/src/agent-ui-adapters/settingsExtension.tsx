import { Keyboard, MonitorSmartphone } from "@liveagent/ui/components/IconSet";
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
import type { GatewaySettingsSyncUpdatePayload } from "@liveagent/ui/lib/settings/sync";
import type { ShortcutCommandId } from "@liveagent/ui/lib/shortcuts/shortcutCommands";
import type {
  KBrainMemoryConfig,
  KBrainMemoryOrganizerConfig,
  KBrainSettingsAdapter,
  KBrainSettingsDocument,
  PermissionRule,
} from "@liveagent/ui/pages/settings/kbrainSettingsAdapter";
import { ShortcutCommandsSection } from "@liveagent/ui/pages/settings/ShortcutCommandsSection";
import { getGatewayWebSocketClient } from "../lib/gatewaySocket";
import { loadToken } from "../lib/storage";
import { DevicesSection } from "../pages/settings/DevicesSection";
import type { SettingsPageProps } from "../pages/settings/types";
import { gatewaySkillsAdapter } from "./kbrainSkills";

// The WebUI transcript has no find bar; the browser keeps its own Cmd/Ctrl+F.
const WEB_UNSUPPORTED_SHORTCUT_COMMANDS: readonly ShortcutCommandId[] = ["findInConversation"];

export function createSettingsExtension(props: SettingsPageProps): {
  surface: "web";
  iconClassName: string;
  slots: UiExtensionSlots;
  sections: SettingsSectionDefinition<void>[];
} {
  return {
    surface: "web",
    iconClassName: "size-4",
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

const permissionRulesClient = () => getGatewayWebSocketClient(loadToken().trim());

// Settings → 权限 on the WebUI: the desktop (or a direct K-brain target) answers through
// the Gateway; an old desktop is refused by the Gateway with an "update LiveAgent" message.
computerSettingsAdapter.listPermissionRules = async ({ workspace }) => {
  const list = await permissionRulesClient().permissionRules<{
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
    await permissionRulesClient().permissionRules<WirePermissionRule>("add", { ...input }),
  );
computerSettingsAdapter.deletePermissionRule = async (ref) => {
  await permissionRulesClient().permissionRules("delete", { ...ref });
};

export const settingsHostAdapter = { isKbrain: true as const, kbrain: computerSettingsAdapter };
