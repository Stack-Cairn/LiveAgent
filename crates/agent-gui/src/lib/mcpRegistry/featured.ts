import type { McpServerConfig } from "../settings";
import type { McpRegistryCard, McpRegistryConfigInput } from "./index";

type TranslateFn = (key: string) => string;

// 精选连接：本地内置的安装草稿（不发起网络请求），复用 Store 的
// needs_config → 配置弹窗 → applyMcpRegistryInstallConfig 安装链路。
// 文案经调用方传入的 t() 取自 i18n，保证 GUI/WebUI 双端一致。

const OBSIDIAN_DEFAULT_HOST = "127.0.0.1";
const OBSIDIAN_DEFAULT_PORT = "27124";

function buildObsidianConfigInputs(t: TranslateFn): McpRegistryConfigInput[] {
  return [
    {
      name: "OBSIDIAN_API_KEY",
      label: t("mcpHub.featuredObsidianApiKeyLabel"),
      description: t("mcpHub.featuredObsidianApiKeyDesc"),
      required: true,
      secret: true,
      target: "env",
    },
    {
      name: "OBSIDIAN_HOST",
      label: t("mcpHub.featuredObsidianHostLabel"),
      description: t("mcpHub.featuredObsidianHostDesc"),
      required: false,
      secret: false,
      target: "env",
    },
    {
      name: "OBSIDIAN_PORT",
      label: t("mcpHub.featuredObsidianPortLabel"),
      description: t("mcpHub.featuredObsidianPortDesc"),
      required: false,
      secret: false,
      target: "env",
    },
  ];
}

function buildObsidianCard(t: TranslateFn): McpRegistryCard {
  // Local REST API 插件默认监听 https://127.0.0.1:27124（自签名证书），
  // mcp-obsidian 在进程启动时读取这些 env，故 host/port/protocol 预填即可生效。
  const server: McpServerConfig = {
    id: "obsidian",
    // needs_config 草稿保持禁用，配置弹窗应用 API Key 后由安装链路置为启用。
    enabled: false,
    transport: "stdio",
    command: "uvx",
    args: ["mcp-obsidian"],
    env: {
      OBSIDIAN_API_KEY: "...",
      OBSIDIAN_HOST: OBSIDIAN_DEFAULT_HOST,
      OBSIDIAN_PORT: OBSIDIAN_DEFAULT_PORT,
      OBSIDIAN_PROTOCOL: "https",
    },
    url: "",
    timeoutMs: 60_000,
  };

  return {
    source: "featured",
    id: "featured:obsidian",
    sourceId: "obsidian",
    name: "mcp-obsidian",
    displayName: "Obsidian",
    description: t("mcpHub.featuredObsidianDesc"),
    homepageUrl: "https://github.com/coddingtonbear/obsidian-local-rest-api",
    repositoryUrl: "https://github.com/MarkusPfundstein/mcp-obsidian",
    verified: true,
    remote: false,
    tags: ["notes", "knowledge-base", "local-rest-api"],
    transportHints: ["stdio"],
    installDraft: {
      server,
      status: "needs_config",
      requiredConfig: buildObsidianConfigInputs(t),
      warnings: [t("mcpHub.featuredObsidianRequirement")],
      commandPreview: "uvx mcp-obsidian",
    },
    detailUrl: "https://github.com/MarkusPfundstein/mcp-obsidian",
  };
}

export function getFeaturedMcpRegistryCards(t: TranslateFn): McpRegistryCard[] {
  return [buildObsidianCard(t)];
}
