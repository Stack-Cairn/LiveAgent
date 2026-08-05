import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const core = loader.loadModule("src/lib/providers/cliIdentityCore.ts");
const headers = loader.loadModule("src/lib/providers/customHeaders.ts");
const settings = loader.loadModule("src/lib/settings/index.ts");

test("CLI 身份默认值与 UA 模板保持供应商协议语义", () => {
  const profiles = core.getDefaultCliIdentitySettings();
  assert.equal(profiles.claude_code.mode, "auto");
  assert.equal(profiles.claude_code.version, "2.1.71");
  assert.equal(
    core.formatCliIdentityUserAgent("claude_code", "2.1.212"),
    "claude-cli/2.1.212 (external, cli)",
  );
  assert.equal(
    core.formatCliIdentityUserAgent("codex", "0.145.0"),
    "codex_cli_rs/0.145.0 (Ubuntu 24.4.0; x86_64) WindowsTerminal",
  );
  assert.equal(
    core.formatCliIdentityUserAgent("xai", "0.2.112"),
    "grok-shell/0.2.112 (linux; x86_64)",
  );
});

test("CLI 身份只接受稳定 SemVer 并按数值比较", () => {
  assert.equal(core.normalizeStableCliVersion(" 0.145.0 "), "0.145.0");
  assert.equal(core.normalizeStableCliVersion("0.146.0-alpha.1"), undefined);
  assert.equal(core.normalizeStableCliVersion("01.2.3"), undefined);
  assert.equal(core.compareCliVersions("0.145.0", "0.72.0"), 1);
  assert.equal(core.compareCliVersions("2.1.10", "2.1.9") > 0, true);
  assert.equal(core.compareCliVersions("2.1.9", "2.1.9"), 0);
  assert.equal(
    core.compareCliVersions("999999999999999999999.0.0", "999999999999999999998.0.0"),
    1,
  );
  assert.equal(core.normalizeStableCliVersion(`${"9".repeat(65)}.0.0`), undefined);
});

test("CLI 身份支持版本应用、内置模式与单步回滚", () => {
  const initial = core.getDefaultCliIdentitySettings().codex;
  const updated = core.applyCliIdentityVersion(initial, "0.145.0");
  assert.equal(updated.version, "0.145.0");
  assert.equal(updated.previousVersion, "0.72.0");
  // 已在最新版上，自动跟随无事可做。
  assert.equal(core.followLatestCliIdentityVersion(updated), updated);

  const rolledBack = core.rollbackCliIdentityVersion(updated);
  assert.equal(rolledBack.version, "0.72.0");
  assert.equal(rolledBack.previousVersion, "0.145.0");

  const builtin = core.setCliIdentityMode("codex", updated, "builtin");
  assert.equal(core.getAppliedCliIdentityVersion("codex", builtin), "0.72.0");
  assert.equal(core.setCliIdentityMode("codex", builtin, "auto").mode, "auto");
});

test("设置规范化补齐身份配置并过滤非法远端版本", () => {
  const defaults = settings.normalizeSettings({ customSettings: {} });
  assert.equal(defaults.customSettings.providerIdentities.codex.version, "0.72.0");

  const normalized = settings.normalizeSettings({
    customSettings: {
      providerIdentities: {
        codex: {
          mode: "auto",
          version: "0.145.0",
          previousVersion: "0.72.0",
          latestVersion: "0.146.0-alpha.1",
          lastCheckedAt: 1234,
        },
      },
    },
  });
  assert.equal(normalized.customSettings.providerIdentities.codex.mode, "auto");
  assert.equal(normalized.customSettings.providerIdentities.codex.version, "0.145.0");
  assert.equal(normalized.customSettings.providerIdentities.codex.latestVersion, undefined);
  assert.equal(normalized.customSettings.providerIdentities.codex.lastCheckedAt, 1234);
});

test("全局身份只填补默认 UA，自定义覆盖和协议例外保持优先", () => {
  const identities = core.getDefaultCliIdentitySettings();
  identities.codex = core.applyCliIdentityVersion(identities.codex, "0.145.0");

  const managed = headers.resolveProviderCustomHeaders(
    {
      type: "codex",
      apiKey: "secret",
      requestFormat: "openai-responses",
      customHeaders: [{ key: "X-Environment", value: "test" }],
    },
    identities,
  );
  assert.deepEqual(managed, [
    {
      key: "User-Agent",
      value: "codex_cli_rs/0.145.0 (Ubuntu 24.4.0; x86_64) WindowsTerminal",
    },
    { key: "X-Environment", value: "test" },
  ]);

  const custom = [{ key: "user-agent", value: "relay-client/3.2.1" }];
  assert.equal(
    headers.resolveProviderCustomHeaders(
      { type: "codex", apiKey: "secret", requestFormat: "openai-responses", customHeaders: custom },
      identities,
    ),
    custom,
  );
  assert.equal(
    headers.resolveProviderCustomHeaders(
      {
        type: "codex",
        apiKey: "secret",
        requestFormat: "openai-responses",
        customHeaders: [{ key: "User-Agent", value: "" }],
      },
      identities,
    )[0].value,
    "",
  );
  assert.equal(
    headers.resolveProviderCustomHeaders(
      {
        type: "codex",
        apiKey: "secret",
        requestFormat: "openai-responses",
        customHeaders: [{ key: "User-Agent", value: "bad\nvalue" }],
      },
      identities,
    )[0].value,
    "codex_cli_rs/0.145.0 (Ubuntu 24.4.0; x86_64) WindowsTerminal",
  );
  assert.deepEqual(
    headers.resolveProviderCustomHeaders(
      { type: "codex", apiKey: "secret", requestFormat: "openai-completions", customHeaders: [] },
      identities,
    ),
    [],
  );
  assert.deepEqual(
    headers.resolveProviderCustomHeaders(
      { type: "claude_code", apiKey: "sk-ant-oat-test", customHeaders: [] },
      identities,
    ),
    [],
  );
});

test("后台检查只查询过期身份，内置模式只记录不应用，自动跟随立即应用", () => {
  const rootDir = fileURLToPath(new URL("../..", import.meta.url));
  const hubFetchPath = path.join(rootDir, "src/lib/hubFetch.ts");
  const runtimeEnvPath = path.join(rootDir, "src/lib/runtimeEnv.ts");
  const updateLoader = createTsModuleLoader({
    mocks: {
      [hubFetchPath]: { hubFetch: async () => new Response() },
      [runtimeEnvPath]: { isGatewayWebuiRuntime: () => false },
    },
  });
  const updates = updateLoader.loadModule("src/lib/providers/cliIdentityUpdates.ts");
  const now = 1_900_000_000_000;
  const identities = core.getDefaultCliIdentitySettings();
  identities.claude_code.lastCheckedAt = now;
  identities.xai = core.setCliIdentityMode("xai", identities.xai, "builtin");

  assert.deepEqual(updates.cliIdentityProvidersNeedingCheck(identities, now), ["codex"]);
  identities.claude_code.lastCheckedAt = now + 1;
  assert.deepEqual(updates.cliIdentityProvidersNeedingCheck(identities, now), [
    "claude_code",
    "codex",
  ]);
  identities.claude_code.lastCheckedAt = now;
  assert.deepEqual(updates.cliIdentityProvidersNeedingCheck(identities, now, true), [
    "codex",
    "xai",
  ]);

  const merged = updates.mergeCliIdentityCheckResults(
    identities,
    [
      { providerId: "claude_code", status: "success", version: "2.1.212" },
      { providerId: "codex", status: "error", message: "offline" },
      { providerId: "xai", status: "success", version: "0.2.112" },
    ],
    now + 1,
  );
  assert.equal(merged.identities.claude_code.version, "2.1.212");
  assert.equal(merged.identities.claude_code.previousVersion, "2.1.71");
  assert.equal(merged.identities.claude_code.latestVersion, "2.1.212");
  assert.equal(merged.identities.xai.version, "0.2.110");
  assert.equal(merged.identities.xai.latestVersion, "0.2.112");
  assert.equal(merged.identities.codex.lastCheckedAt, undefined);
  assert.equal(merged.errors.codex, "offline");
  assert.equal(merged.changed, true);
});

test("在线检查使用固定官方包和稳定 dist-tag，单个失败不阻塞其它供应商", async () => {
  const rootDir = fileURLToPath(new URL("../..", import.meta.url));
  const hubFetchPath = path.join(rootDir, "src/lib/hubFetch.ts");
  const requested = [];
  const networkLoader = createTsModuleLoader({
    mocks: {
      [hubFetchPath]: {
        async hubFetch(url) {
          requested.push(url);
          if (url.includes("anthropic-ai")) {
            return new Response(JSON.stringify({ stable: "2.1.212", latest: "2.1.220" }));
          }
          if (url.includes("openai")) {
            return new Response(JSON.stringify({ latest: "0.146.0-alpha.1" }));
          }
          return new Response(JSON.stringify({ latest: "0.2.112" }));
        },
      },
    },
  });
  const updates = networkLoader.loadModule("src/lib/providers/cliIdentityUpdates.ts");
  const results = await updates.checkCliIdentityVersions(["claude_code", "codex", "xai"]);

  assert.equal(results[0].status, "success");
  assert.equal(results[0].version, "2.1.212");
  assert.equal(results[1].status, "error");
  assert.match(results[1].message, /stable semantic version/);
  assert.equal(results[2].status, "success");
  assert.equal(results[2].version, "0.2.112");
  assert.equal(requested.length, 3);
  assert.ok(requested.every((url) => url.startsWith("https://registry.npmjs.org/-/package/")));
});

test("内置兼容恒用内置版本且不自动跟随，切回自动跟随立即补装最新版", () => {
  const profile = {
    ...core.getDefaultCliIdentitySettings().claude_code,
    latestVersion: "2.1.212",
  };
  const pinned = core.setCliIdentityMode("claude_code", profile, "builtin");
  assert.equal(pinned.mode, "builtin");
  assert.equal(core.getAppliedCliIdentityVersion("claude_code", pinned), "2.1.71");
  assert.equal(core.followLatestCliIdentityVersion(pinned), pinned);

  const followed = core.followLatestCliIdentityVersion(
    core.setCliIdentityMode("claude_code", pinned, "auto"),
  );
  assert.equal(followed.mode, "auto");
  assert.equal(followed.version, "2.1.212");
  assert.equal(followed.previousVersion, "2.1.71");
});

test("回滚记下被否决版本，自动跟随不得把它装回去但更高版本照常跟随", () => {
  const rootDir = fileURLToPath(new URL("../..", import.meta.url));
  const hubFetchPath = path.join(rootDir, "src/lib/hubFetch.ts");
  const runtimeEnvPath = path.join(rootDir, "src/lib/runtimeEnv.ts");
  const updates = createTsModuleLoader({
    mocks: {
      [hubFetchPath]: { hubFetch: async () => new Response() },
      [runtimeEnvPath]: { isGatewayWebuiRuntime: () => false },
    },
  }).loadModule("src/lib/providers/cliIdentityUpdates.ts");
  const now = 1_900_000_000_000;

  const rolled = core.rollbackCliIdentityVersion({
    mode: "auto",
    version: "2.1.212",
    previousVersion: "2.1.71",
    latestVersion: "2.1.212",
  });
  assert.equal(rolled.version, "2.1.71");
  assert.equal(rolled.rejectedVersion, "2.1.212");
  assert.equal(core.followLatestCliIdentityVersion(rolled), rolled);

  const identities = { ...core.getDefaultCliIdentitySettings(), claude_code: rolled };
  const rechecked = updates.mergeCliIdentityCheckResults(
    identities,
    [{ providerId: "claude_code", status: "success", version: "2.1.212" }],
    now,
  );
  assert.equal(rechecked.identities.claude_code.version, "2.1.71");

  const bumped = updates.mergeCliIdentityCheckResults(
    identities,
    [{ providerId: "claude_code", status: "success", version: "2.1.213" }],
    now,
  );
  assert.equal(bumped.identities.claude_code.version, "2.1.213");
});

test("检查失败进入退避窗口，成功后清除失败标记", () => {
  const rootDir = fileURLToPath(new URL("../..", import.meta.url));
  const hubFetchPath = path.join(rootDir, "src/lib/hubFetch.ts");
  const runtimeEnvPath = path.join(rootDir, "src/lib/runtimeEnv.ts");
  const updates = createTsModuleLoader({
    mocks: {
      [hubFetchPath]: { hubFetch: async () => new Response() },
      [runtimeEnvPath]: { isGatewayWebuiRuntime: () => false },
    },
  }).loadModule("src/lib/providers/cliIdentityUpdates.ts");
  const now = 1_900_000_000_000;

  const failed = updates.mergeCliIdentityCheckResults(
    core.getDefaultCliIdentitySettings(),
    [{ providerId: "claude_code", status: "error", message: "offline" }],
    now,
  );
  assert.equal(failed.identities.claude_code.lastFailedAt, now);
  assert.equal(failed.identities.claude_code.lastCheckedAt, undefined);
  assert.equal(failed.changed, true);

  assert.ok(
    !updates.cliIdentityProvidersNeedingCheck(failed.identities, now + 1).includes("claude_code"),
  );
  assert.ok(
    updates
      .cliIdentityProvidersNeedingCheck(
        failed.identities,
        now + updates.CLI_IDENTITY_FAILURE_BACKOFF_MS,
      )
      .includes("claude_code"),
  );
  // 时钟回拨不得永久卡住检查。
  assert.ok(
    updates.cliIdentityProvidersNeedingCheck(failed.identities, now - 1).includes("claude_code"),
  );

  const recovered = updates.mergeCliIdentityCheckResults(
    failed.identities,
    [{ providerId: "claude_code", status: "success", version: "2.1.212" }],
    now + 1,
  );
  assert.equal(recovered.identities.claude_code.lastFailedAt, undefined);
  assert.equal(recovered.identities.claude_code.lastCheckedAt, now + 1);
});

test("身份配置经规范化保留否决版本与失败时间戳，遗留确认模式归一为自动跟随", () => {
  const normalized = settings.normalizeCustomSettings({
    providerIdentities: {
      claude_code: {
        mode: "auto",
        version: "2.1.71",
        rejectedVersion: "2.1.212",
        lastFailedAt: 1_900_000_000_000,
      },
      codex: { mode: "notify", version: "0.72.0", rejectedVersion: "not-a-version" },
      xai: { mode: "builtin", version: "0.2.110" },
    },
  }).providerIdentities;

  assert.equal(normalized.claude_code.rejectedVersion, "2.1.212");
  assert.equal(normalized.claude_code.lastFailedAt, 1_900_000_000_000);
  assert.equal(normalized.codex.mode, "auto");
  assert.equal(normalized.codex.rejectedVersion, undefined);
  assert.equal(normalized.xai.mode, "builtin");
});
