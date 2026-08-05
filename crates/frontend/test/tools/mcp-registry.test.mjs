import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const registry = loader.loadModule("src/lib/mcpRegistry/index.ts");

function mockFetch(handler) {
  return async (url, init) => {
    const result = handler(String(url), init ?? {});
    return {
      ok: result.status === undefined || (result.status >= 200 && result.status < 300),
      status: result.status ?? 200,
      async json() {
        return result.body;
      },
    };
  };
}

test("official registry npm stdio packages become LiveAgent MCP drafts", async () => {
  const result = await registry.searchMcpRegistry({
    source: "official",
    query: "filesystem",
    limit: 3,
    fetchImpl: mockFetch((url) => {
      assert.match(url, /registry\.modelcontextprotocol\.io\/v0\.1\/servers/);
      assert.match(url, /search=filesystem/);
      return {
        body: {
          servers: [
            {
              server: {
                name: "com.example/remote-filesystem",
                description: "Remote filesystem",
                version: "0.1.2",
                packages: [
                  {
                    registryType: "npm",
                    identifier: "remote-filesystem-mcp-server",
                    runtimeHint: "npx",
                    transport: { type: "stdio" },
                    runtimeArguments: [{ type: "positional", value: "-y" }],
                    environmentVariables: [
                      { name: "GCS_BUCKET", isRequired: true },
                      { name: "GCS_MAKE_PUBLIC", default: "false" },
                    ],
                  },
                ],
              },
              _meta: {
                "io.modelcontextprotocol.registry/official": { status: "active" },
              },
            },
          ],
          metadata: { nextCursor: "next", count: 1 },
        },
      };
    }),
  });

  assert.equal(result.items.length, 1);
  assert.equal(result.nextCursor, "next");
  const draft = result.items[0].installDraft;
  assert.equal(draft.status, "needs_config");
  assert.equal(draft.server.enabled, false);
  assert.equal(draft.server.id, "remote-filesystem");
  assert.equal(draft.server.transport, "stdio");
  assert.equal(draft.server.command, "npx");
  assert.deepEqual(draft.server.args, ["-y", "remote-filesystem-mcp-server"]);
  assert.deepEqual(draft.server.env, {
    GCS_BUCKET: "...",
    GCS_MAKE_PUBLIC: "false",
  });
  assert.deepEqual(draft.requiredConfig.map((input) => input.name), ["GCS_BUCKET"]);
});

test("smithery search cards resolve detail endpoint before install", async () => {
  const fetchImpl = mockFetch((url) => {
    if (url === "https://api.smithery.ai/servers?q=drive&pageSize=18&page=1") {
      return {
        body: {
          servers: [
            {
              qualifiedName: "googledrive",
              displayName: "Google Drive",
              description: "Drive tools",
              remote: true,
              isDeployed: true,
              verified: true,
              useCount: 42,
            },
          ],
          pagination: { currentPage: 1, totalPages: 1, totalCount: 1 },
        },
      };
    }
    if (url === "https://api.smithery.ai/servers/googledrive") {
      return {
        body: {
          qualifiedName: "googledrive",
          displayName: "Google Drive",
          deploymentUrl: "https://googledrive.run.tools",
          connections: [
            {
              type: "http",
              deploymentUrl: "https://googledrive.run.tools",
              configSchema: { type: "object", properties: {} },
            },
          ],
        },
      };
    }
    throw new Error(`unexpected url: ${url}`);
  });

  const result = await registry.searchMcpRegistry({
    source: "smithery",
    query: "drive",
    fetchImpl,
  });
  assert.equal(result.items[0].installDraft, undefined);

  const resolved = await registry.resolveMcpRegistryInstallDraft(result.items[0], { fetchImpl });
  assert.equal(resolved.installDraft.server.transport, "http");
  assert.equal(resolved.installDraft.server.url, "https://googledrive.run.tools");
  assert.equal(resolved.installDraft.server.enabled, true);
});

test("smithery local stdio details prefill command args and config", async () => {
  const fetchImpl = mockFetch((url) => {
    if (url === "https://api.smithery.ai/servers/local/kibela") {
      return {
        body: {
          qualifiedName: "local/kibela",
          displayName: "Kibela",
          remote: false,
          connections: [
            {
              type: "stdio",
              bundleUrl: "https://backend.smithery.ai/storage/v1/object/public/bundles/@local/kibela/server.mcpb",
              runtime: "node",
              configSchema: {
                type: "object",
                required: ["kibelaTeam", "kibelaToken"],
                properties: {
                  kibelaTeam: { type: "string", description: "Team name" },
                  kibelaToken: { type: "string", description: "API token" },
                },
              },
            },
          ],
        },
      };
    }
    throw new Error(`unexpected url: ${url}`);
  });
  const card = {
    source: "smithery",
    id: "smithery:local/kibela",
    sourceId: "local/kibela",
    name: "local/kibela",
    displayName: "Kibela",
    description: "",
    verified: false,
    remote: false,
    tags: [],
    transportHints: [],
  };

  const resolved = await registry.resolveMcpRegistryInstallDraft(card, { fetchImpl });
  assert.equal(resolved.remote, false);
  assert.equal(resolved.installDraft.status, "needs_config");
  assert.equal(resolved.installDraft.server.command, "npx");
  assert.deepEqual(resolved.installDraft.server.args, [
    "-y",
    "@smithery/cli@latest",
    "run",
    "local/kibela",
  ]);
  assert.deepEqual(
    resolved.installDraft.requiredConfig.map((input) => [input.name, input.target]),
    [
      ["kibelaTeam", "config"],
      ["kibelaToken", "config"],
    ],
  );

  const configured = registry.applyMcpRegistryInstallConfig(resolved.installDraft, {
    [registry.mcpRegistryConfigInputKey(resolved.installDraft.requiredConfig[0])]: "docs",
    [registry.mcpRegistryConfigInputKey(resolved.installDraft.requiredConfig[1])]: "secret-token",
  });
  assert.deepEqual(configured.server.args, [
    "-y",
    "@smithery/cli@latest",
    "run",
    "local/kibela",
    "--config",
    "{\"kibelaTeam\":\"docs\",\"kibelaToken\":\"secret-token\"}",
  ]);
});

test("required registry config is applied before adding local MCP", async () => {
  const card = {
    source: "official",
    id: "official:bucket:latest",
    sourceId: "bucket",
    name: "bucket",
    displayName: "bucket",
    description: "",
    verified: true,
    remote: false,
    tags: [],
    transportHints: ["stdio"],
    installDraft: {
      server: {
        id: "bucket",
        enabled: false,
        transport: "stdio",
        command: "npx",
        args: ["-y", "bucket-server"],
        env: { GCS_BUCKET: "..." },
        url: "",
        timeoutMs: 60_000,
      },
      status: "needs_config",
      requiredConfig: [
        {
          name: "GCS_BUCKET",
          required: true,
          secret: false,
          target: "env",
        },
      ],
      warnings: [],
      commandPreview: "npx -y bucket-server",
    },
  };

  const configured = registry.applyMcpRegistryInstallConfig(card.installDraft, {
    [registry.mcpRegistryConfigInputKey(card.installDraft.requiredConfig[0])]: "docs-bucket",
  });

  assert.equal(configured.status, "ready");
  assert.equal(configured.server.enabled, true);
  assert.deepEqual(configured.server.env, { GCS_BUCKET: "docs-bucket" });
});

test("smithery config schema targets URL query and headers", async () => {
  const fetchImpl = mockFetch((url) => {
    if (url === "https://api.smithery.ai/servers/remote-demo") {
      return {
        body: {
          qualifiedName: "remote-demo",
          displayName: "Remote Demo",
          deploymentUrl: "https://remote-demo.run.tools/mcp",
          connections: [
            {
              type: "http",
              deploymentUrl: "https://remote-demo.run.tools/mcp",
              configSchema: {
                type: "object",
                required: ["apiKey", "profile"],
                properties: {
                  apiKey: {
                    title: "API Key",
                    description: "Demo API key",
                    "x-from": { query: "api_key" },
                  },
                  profile: {
                    title: "Profile",
                    "x-from": { header: "X-Demo-Profile" },
                  },
                },
              },
            },
          ],
        },
      };
    }
    throw new Error(`unexpected url: ${url}`);
  });
  const card = {
    source: "smithery",
    id: "smithery:remote-demo",
    sourceId: "remote-demo",
    name: "remote-demo",
    displayName: "Remote Demo",
    description: "",
    verified: true,
    remote: true,
    tags: [],
    transportHints: ["http"],
  };

  const resolved = await registry.resolveMcpRegistryInstallDraft(card, { fetchImpl });
  assert.equal(resolved.installDraft.status, "needs_config");
  assert.deepEqual(
    resolved.installDraft.requiredConfig.map((input) => [input.name, input.target, input.targetName]),
    [
      ["apiKey", "url", "api_key"],
      ["profile", "header", "X-Demo-Profile"],
    ],
  );

  const values = Object.fromEntries(
    resolved.installDraft.requiredConfig.map((input) => [
      registry.mcpRegistryConfigInputKey(input),
      input.name === "apiKey" ? "secret-token" : "default",
    ]),
  );
  const configured = registry.applyMcpRegistryInstallConfig(resolved.installDraft, values);
  assert.equal(configured.server.url, "https://remote-demo.run.tools/mcp?api_key=secret-token");
  assert.deepEqual(configured.server.headers, { "X-Demo-Profile": "default" });
});

test("glama manual cards include editable stdio draft and env inputs", async () => {
  const result = await registry.searchMcpRegistry({
    source: "glama",
    query: "terminal",
    fetchImpl: mockFetch((url) => {
      assert.match(url, /glama\.ai\/api\/mcp\/v1\/servers/);
      return {
        body: {
          pageInfo: { hasNextPage: false },
          servers: [
            {
              id: "abc",
              name: "terminal-share",
              namespace: "wu-yu-pei",
              attributes: ["hosting:local-only"],
              repository: { url: "https://github.com/example/terminal-share" },
              environmentVariablesJsonSchema: {
                type: "object",
                properties: {
                  MCP_TERMINAL_SHARE_DIR: { type: "string" },
                },
              },
            },
          ],
        },
      };
    }),
  });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].installDraft, undefined);
  assert.equal(result.items[0].installUnavailableReason, "needs-manual-command");
  assert.equal(result.items[0].manualDraft.server.command, "npx");
  assert.deepEqual(result.items[0].manualDraft.server.args, ["-y", "terminal-share"]);
  assert.deepEqual(
    result.items[0].manualDraft.requiredConfig.map((input) => [input.name, input.target]),
    [["MCP_TERMINAL_SHARE_DIR", "env"]],
  );
  assert.equal(result.items[0].repositoryUrl, "https://github.com/example/terminal-share");
});

test("glama manual env examples are rendered as env draft values", async () => {
  const result = await registry.searchMcpRegistry({
    source: "glama",
    query: "gridpulse",
    fetchImpl: mockFetch((url) => {
      assert.match(url, /glama\.ai\/api\/mcp\/v1\/servers/);
      return {
        body: {
          pageInfo: { hasNextPage: false },
          servers: [
            {
              id: "grid",
              name: "GridPulse Energy",
              slug: "gridpulse-energy",
              attributes: ["hosting:local-only"],
              environmentVariablesJsonSchema: {
                type: "object",
                example: {
                  GRIDPULSE_API_KEY: "your_key_here",
                },
                properties: {
                  GRIDPULSE_API_KEY: {
                    description: "API key for GridPulse",
                    type: "string",
                  },
                },
              },
            },
          ],
        },
      };
    }),
  });

  assert.deepEqual(result.items[0].manualDraft.server.env, {
    GRIDPULSE_API_KEY: "your_key_here",
  });
});

test("server ids are made unique before adding a registry draft", () => {
  const draft = {
    server: {
      id: "demo",
      enabled: true,
      transport: "stdio",
      command: "npx",
      args: ["-y", "demo"],
      url: "",
      timeoutMs: 60_000,
    },
    status: "ready",
    requiredConfig: [],
    warnings: [],
    commandPreview: "npx -y demo",
  };

  const unique = registry.withUniqueMcpServerId(draft, [
    { ...draft.server, id: "demo" },
    { ...draft.server, id: "demo-2" },
  ]);
  assert.equal(unique.server.id, "demo-3");
});
