import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const sharedDrawer = readFileSync(
  new URL("../../../agent-ui/src/components/chat/WorkspaceResourceSettingsDrawer.tsx", import.meta.url),
  "utf8",
);
const sharedResourceTabs = readFileSync(
  new URL("../../../agent-ui/src/components/resources/ResourceTabsList.tsx", import.meta.url),
  "utf8",
);
const sharedResourceCard = readFileSync(
  new URL("../../../agent-ui/src/components/resources/ResourceSelectionCard.tsx", import.meta.url),
  "utf8",
);
const sharedSheet = readFileSync(
  new URL("../../../agent-ui/src/components/ui/sheet.tsx", import.meta.url),
  "utf8",
);
const sharedSidebar = readFileSync(
  new URL("../../../agent-ui/src/components/chat/ChatHistorySidebarRows.tsx", import.meta.url),
  "utf8",
);
const sendRuntime = readFileSync(
  new URL("../../src/pages/chat/runtime/useSendChatTurn.ts", import.meta.url),
  "utf8",
);
const guiChatPage = readFileSync(new URL("../../src/pages/ChatPage.tsx", import.meta.url), "utf8");
const guiWorkspaceRemoval = readFileSync(
  new URL("../../src/pages/chat/workspace/useWorkspaceProjectRemoval.tsx", import.meta.url),
  "utf8",
);
const sharedWorkspaceRemoval = readFileSync(
  new URL("../../../agent-ui/src/lib/workspaceProjectRemoval.ts", import.meta.url),
  "utf8",
);
const sharedWorkspaceRemovalHook = readFileSync(
  new URL("../../../agent-ui/src/lib/useWorkspaceProjectRemoval.tsx", import.meta.url),
  "utf8",
);
const webGatewayApp = readFileSync(
  new URL("../../../agent-gateway/web/src/app/GatewayApp.tsx", import.meta.url),
  "utf8",
);
const sharedSkillsHub = readFileSync(
  new URL("../../../agent-ui/src/pages/skills-hub/SkillsHubPage.tsx", import.meta.url),
  "utf8",
);
const sharedMcpServerCard = readFileSync(
  new URL("../../../agent-ui/src/pages/mcp-hub/McpServerCard.tsx", import.meta.url),
  "utf8",
);

test("workspace resources use one entry and one combined settings drawer", () => {
  assert.match(sharedSidebar, /chat\.workspaceResources/);
  assert.match(sharedSidebar, /onConfigureProjectResources\(project\)/);
  assert.match(sharedDrawer, /\["inherit", "custom", "off"\]/);
  assert.match(sharedDrawer, /value: "skills"/);
  assert.match(sharedDrawer, /value: "mcp"/);
  assert.match(sharedDrawer, /<ResourceTabsList/);
  assert.match(sharedDrawer, /<StoreCategoryChips/);
  assert.match(sharedDrawer, /<Input/);
  assert.match(sharedDrawer, /<ResourceSelectionCard/);
  assert.match(sharedDrawer, /getMcpTransportMeta/);
  assert.match(sharedDrawer, /<SheetPopup[\s\S]*variant="inset"/);
  assert.match(sharedDrawer, /<SheetHeader[\s\S]*<SheetTitle/);
  assert.match(sharedDrawer, /<SheetPanel/);
  assert.match(sharedDrawer, /<SheetFooter/);
  assert.match(sharedDrawer, /<SheetClose render=\{<Button variant="outline"/);
  assert.match(sharedResourceTabs, /<TabsList[\s\S]*<TabsTrigger/);
  assert.match(sharedResourceCard, /ResourceActivationSwitch/);
  assert.match(sharedSheet, /export const SheetViewport/);
  assert.match(sharedSheet, /export const SheetPopup/);
  assert.match(sharedSheet, /export const SheetPanel/);
  assert.match(sharedSheet, /SheetPopup as SheetContent/);
  assert.doesNotMatch(sharedDrawer, /<input|<select/);
  assert.doesNotMatch(sharedDrawer, /createPortal|role="dialog"/);
  assert.doesNotMatch(sharedDrawer, /McpImportView|McpRegistryBrowser|SkillsStoreView/);
});

test("chat runtime resolves and snapshots workspace resources from the effective workdir", () => {
  assert.match(sendRuntime, /resolveWorkspaceResources\(settings, effectiveWorkdir\)/);
  assert.match(sendRuntime, /workspaceResources\.skillNames/);
  assert.match(sendRuntime, /filterMcpSettingsForWorkspace\(getMcpSettings\(\), workspaceResources\)/);
  assert.match(sendRuntime, /getMcpSettings: getEffectiveMcpSettings/);
  assert.match(sendRuntime, /missing\.length > 0 && workspaceResources\.mode !== "custom"/);
  assert.match(guiChatPage, /resolveWorkspaceResources\(settings, displayedConversationWorkdir\)/);
  assert.match(guiChatPage, /skillsEnabled: settings\.skills\.enabled && isAgentMode/);
  assert.match(sharedDrawer, /chat\.workspaceResourcesMissingSkill/);
});

test("workspace and resource deletion paths clear workspace-scoped references", () => {
  assert.match(guiWorkspaceRemoval, /useSharedWorkspaceProjectRemoval/);
  assert.match(webGatewayApp, /useWorkspaceProjectSettingsActions/);
  assert.match(webGatewayApp, /useWorkspaceProjectDeletion/);
  assert.match(sharedWorkspaceRemovalHook, /useWorkspaceProjectSettingsActions/);
  assert.match(sharedWorkspaceRemoval, /resetWorkspaceResourceSettings\(nextSettings, pathKey\)/);
  assert.match(sharedSkillsHub, /removeWorkspaceResourceReferences\(/);
  assert.match(sharedSkillsHub, /skillNames: \[skillName\]/);
  assert.match(sharedMcpServerCard, /removeWorkspaceResourceReferences\(/);
  assert.match(sharedMcpServerCard, /mcpServerIds: \[server\.id\]/);
  assert.match(sendRuntime, /change\.action !== "delete"/);
  assert.match(sendRuntime, /skillNames: change\.names/);
  assert.match(sendRuntime, /op\.kind === "remove"/);
  assert.match(sendRuntime, /mcpServerIds: removedIds/);
});

test("workspace settings control the actual Skill prompt and MCP tool registry", async () => {
  const listedServerIds = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          if (command !== "mcp_list_tools") {
            throw new Error(`Unexpected invoke: ${command}`);
          }
          const servers = args.servers ?? [];
          listedServerIds.push(servers.map((server) => server.id));
          return servers.map((server) => ({
            serverId: server.id,
            serverLabel: server.id,
            name: "probe",
            description: `Probe ${server.id}`,
            inputSchema: { type: "object" },
          }));
        },
      },
      "@tauri-apps/api/path": {
        async homeDir() {
          return "/home/test";
        },
      },
    },
  });
  const settingsModule = loader.loadModule("src/lib/settings/index.ts");
  const skillsModule = loader.loadModule("@liveagent/ui/lib/skills/index.ts");
  const { buildBuiltinToolRegistry } = loader.loadModule("src/lib/tools/builtinRegistry.ts");
  const { createFileToolState } = loader.loadModule("src/lib/tools/fileToolState.ts");

  const appSettings = settingsModule.normalizeSettings({
    skills: { enabled: true, selected: ["global-skill"] },
    mcp: {
      servers: [
        {
          id: "global-mcp",
          enabled: true,
          transport: "stdio",
          command: "global-mcp",
          args: [],
          env: {},
        },
        {
          id: "workspace-mcp",
          enabled: true,
          transport: "stdio",
          command: "workspace-mcp",
          args: [],
          env: {},
        },
      ],
    },
    system: {
      workspaceResourceSettings: {
        "/repo/custom": {
          mode: "custom",
          skillNames: ["workspace-skill"],
          mcpServerIds: ["workspace-mcp"],
          stateVersion: 1,
          writerId: "test",
          updatedAt: 1,
        },
        "/repo/off": {
          mode: "off",
          stateVersion: 1,
          writerId: "test",
          updatedAt: 1,
        },
      },
    },
  });
  const skillCatalog = [
    {
      name: "global-skill",
      description: "Global skill marker",
      skillFile: "global-skill/SKILL.md",
      baseDir: "global-skill",
    },
    {
      name: "workspace-skill",
      description: "Workspace skill marker",
      skillFile: "workspace-skill/SKILL.md",
      baseDir: "workspace-skill",
    },
  ];

  async function exposeResources(workdir) {
    const resources = settingsModule.resolveWorkspaceResources(appSettings, workdir);
    const selectedSkills = skillCatalog.filter((skill) =>
      resources.skillNames.includes(skill.name),
    );
    const skillPrompt = resources.skillsEnabled
      ? skillsModule.buildSkillsSystemPrompt({ rootDir: "/skills", selected: selectedSkills })
      : "";
    const registry = await buildBuiltinToolRegistry({
      workdir,
      providerId: "codex",
      fileState: createFileToolState(),
      skillsEnabled: resources.skillsEnabled,
      runtimeScope: "chat",
      getMcpSettings: () => ({ ...appSettings.mcp, servers: resources.mcpServers }),
    });
    return { resources, skillPrompt, toolNames: registry.tools.map((tool) => tool.name) };
  }

  const inherited = await exposeResources("/repo/inherit");
  assert.match(inherited.skillPrompt, /global-skill\/SKILL\.md/);
  assert.doesNotMatch(inherited.skillPrompt, /workspace-skill\/SKILL\.md/);
  assert.ok(inherited.toolNames.includes("mcp_global-mcp_probe"));
  assert.ok(inherited.toolNames.includes("mcp_workspace-mcp_probe"));

  const custom = await exposeResources("/repo/custom");
  assert.match(custom.skillPrompt, /workspace-skill\/SKILL\.md/);
  assert.doesNotMatch(custom.skillPrompt, /global-skill\/SKILL\.md/);
  assert.ok(custom.toolNames.includes("mcp_workspace-mcp_probe"));
  assert.ok(!custom.toolNames.includes("mcp_global-mcp_probe"));

  const off = await exposeResources("/repo/off");
  assert.equal(off.skillPrompt, "");
  assert.ok(!off.toolNames.some((name) => name.startsWith("mcp_")));
  assert.deepEqual(listedServerIds, [
    ["global-mcp", "workspace-mcp"],
    ["workspace-mcp"],
  ]);
});
