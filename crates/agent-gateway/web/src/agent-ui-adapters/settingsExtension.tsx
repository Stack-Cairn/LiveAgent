import { MonitorSmartphone } from "@liveagent/ui/components/IconSet";
import type { SettingsSectionDefinition, UiExtensionSlots } from "@liveagent/ui/contracts/registry";
import {
  configureResourceHostCapabilities,
  kbrainResourceHostCapabilities,
} from "@liveagent/ui/lib/resourceHost";
import type { GatewaySettingsSyncUpdatePayload } from "@liveagent/ui/lib/settings/sync";
import type {
  KBrainMemoryConfig,
  KBrainSettingsAdapter,
  PermissionRule,
} from "@liveagent/ui/pages/settings/kbrainSettingsAdapter";
import { getGatewayWebSocketClient } from "../lib/gatewaySocket";
import { loadToken } from "../lib/storage";
import { DevicesSection } from "../pages/settings/DevicesSection";
import type { SettingsPageProps } from "../pages/settings/types";
import { gatewaySkillsAdapter } from "./kbrainSkills";

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
    return {
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
    };
  },
  async updateSettings(update) {
    // Gateway carries the K-brain memory switch as `kbrainMemory`: its `memory` key is
    // LiveAgent's own organizer settings.
    const { memory, ...rest } = update as GatewaySettingsSyncUpdatePayload & {
      memory?: KBrainMemoryConfig;
    };
    await getGatewayWebSocketClient(loadToken().trim()).updateSettings(
      memory ? { ...rest, kbrainMemory: memory } : rest,
    );
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
