// The diagnostics bundle is an allowlist: these tests feed it a settings object
// full of synthetic secrets and user content and check what comes out.
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// jszip is a dependency of the shared UI package, which writes the browser zip.
const JSZip = createRequire(new URL("../../../agent-ui/package.json", import.meta.url))("jszip");
const { loadModule } = createTsModuleLoader();
const bundleModule = loadModule("@liveagent/ui/lib/diagnostics/bundle.ts");
const { normalizeSettings } = loadModule("@liveagent/ui/lib/settings/index.ts");
const {
  buildDiagnosticsBundle,
  copyDiagnosticsSummary,
  createDiagnosticsZip,
  diagnosticsFileName,
  tailText,
  DIAGNOSTICS_LOG_BUDGET_BYTES,
  requestDiagnosticsExport,
  subscribeDiagnosticsExportRequests,
} = bundleModule;

const HOME = "/Users/fixture-user";
const LEAKS = [
  "sk-fixture-provider-key-0123456789",
  "hunter2-password",
  "ghp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "mcp-header-secret-value",
  "ssh-host-secret-password",
  "SECRET SYSTEM PROMPT TEXT",
  "private conversation text",
  "fixture.person@example.com",
  "fixture-user",
  "--token",
];

function fixtureSettings() {
  const settings = normalizeSettings({});
  settings.customProviders = [
    {
      ...settings.customProviders[0],
      id: "fake-openai",
      name: "Fake OpenAI-compatible",
      type: "openai",
      baseUrl: "http://user:hunter2-password@127.0.0.1:18080/v1?api_key=sk-fixture-provider-key-0123456789",
      apiKey: "sk-fixture-provider-key-0123456789",
      apiKeyConfigured: true,
      customHeaders: [{ key: "X-Org", value: "hunter2-password" }],
      models: [{ id: "fake-model-a" }, { id: "fake-model-b" }],
      activeModels: ["fake-model-a"],
    },
  ];
  settings.selectedModel = { customProviderId: "fake-openai", model: "fake-model-a" };
  settings.mcp = {
    ...settings.mcp,
    servers: [
      {
        id: "files",
        enabled: true,
        transport: "stdio",
        command: `${HOME}/bin/mcp-files --token ghp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`,
        args: ["--token", "ghp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
        env: { GITHUB_TOKEN: "ghp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
        headers: {},
        url: "",
        timeoutMs: 30000,
      },
      {
        id: "remote",
        enabled: true,
        transport: "http",
        command: "",
        url: "https://mcp.example.test/path?key=mcp-header-secret-value",
        headers: { Authorization: "Bearer mcp-header-secret-value" },
        env: {},
      },
      { id: "disabled", enabled: false, transport: "http", command: "", url: "https://off.example.test" },
    ],
    selected: ["files"],
  };
  settings.ssh = {
    ...settings.ssh,
    hosts: [{ id: "h1", name: "box", host: "10.0.0.2", user: "fixture-user", password: "ssh-host-secret-password" }],
  };
  settings.agents = [{ id: "a1", name: "Template", systemPrompt: "SECRET SYSTEM PROMPT TEXT" }];
  settings.system = {
    ...settings.system,
    workspaceProjects: [
      ...settings.system.workspaceProjects,
      { id: "p1", name: "proj", path: `${HOME}/code/proj`, kind: "managed" },
    ],
  };
  return settings;
}

function fixtureInput(overrides = {}) {
  return {
    generatedAt: new Date("2026-03-04T05:06:07Z"),
    host: "desktop",
    app: { version: "1.2.3-beta.1", channel: "prerelease", os: "macos", osVersion: "15.1", arch: "aarch64" },
    kbrain: {
      health: {
        legacy: false,
        protocol: { name: "kbrain", major: 1, minor: 4 },
        build: { version: "0.9.0", channel: "stable" },
        startupContract: 2,
        instanceId: "inst-1",
        capabilityRevision: 7,
        capabilities: { sessions: true, mcp: true },
      },
      connection: {
        state: "connected",
        endpoint: "http://127.0.0.1:47000/api?token=sk-fixture-provider-key-0123456789",
        latencyMs: 4.2,
      },
    },
    settings: fixtureSettings(),
    sessionCount: 12,
    recentErrors: [
      {
        at: Date.UTC(2026, 2, 4, 5, 0, 0),
        level: "error",
        source: "window.onerror",
        message: `fetch failed Authorization: Bearer sk-fixture-provider-key-0123456789`,
      },
      {
        at: Date.UTC(2026, 2, 4, 5, 0, 2),
        level: "error",
        source: "console",
        message: `cannot read ${HOME}/x.ts shared by fixture.person@example.com`,
      },
    ],
    appLog: [
      { at: Date.UTC(2026, 2, 4, 5, 0, 1), level: "warn", source: "console", message: "slow render 120ms" },
    ],
    logFiles: [
      {
        name: "k-brain.log",
        content: `boot ok\nload ${HOME}/.liveagent/config token=ghp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nready\n`,
        truncated: false,
        originalBytes: 120,
      },
      { name: "../escape.log", content: "x\n", truncated: false, originalBytes: 2 },
    ],
    homeDirs: [HOME],
    dataRoot: `${HOME}/.liveagent`,
    ...overrides,
  };
}

test("bundle lists the expected files and leaks nothing from the fixture", () => {
  const bundle = buildDiagnosticsBundle(fixtureInput());
  const paths = bundle.files.map((file) => file.path);
  assert.deepEqual(paths, [
    "README.txt",
    "summary.txt",
    "app.json",
    "kbrain/health.json",
    "kbrain/connection.json",
    "settings.json",
    "providers.json",
    "mcp.json",
    "workspaces.json",
    "errors.json",
    "logs/app.log",
    "logs/k-brain.log",
    "logs/.._escape.log",
    "logs/index.json",
  ]);
  assert.equal(bundle.fileName, "liveagent-diagnostics-20260304-050607.zip");
  for (const file of bundle.files) {
    for (const leak of LEAKS) {
      assert.ok(!file.content.includes(leak), `${file.path} leaked ${leak}\n${file.content}`);
    }
    assert.equal(file.bytes, new TextEncoder().encode(file.content).length, file.path);
  }
  for (const leak of LEAKS) assert.ok(!bundle.summary.includes(leak), `summary leaked ${leak}`);
  assert.ok(bundle.redactions.homePath > 0);
  assert.ok(bundle.redactions.authHeader > 0);
  assert.ok(bundle.redactions.email > 0);
});

test("bundle keeps the facts a bug report needs", () => {
  const bundle = buildDiagnosticsBundle(fixtureInput());
  const file = (path) => bundle.files.find((entry) => entry.path === path).content;
  const app = JSON.parse(file("app.json"));
  assert.equal(app.version, "1.2.3-beta.1");
  assert.equal(app.arch, "aarch64");
  assert.equal(app.dataRoot, "~/.liveagent");

  const health = JSON.parse(file("kbrain/health.json"));
  assert.equal(health.available, true);
  assert.equal(health.build.version, "0.9.0");
  assert.deepEqual(health.capabilities, { sessions: true, mcp: true });

  const connection = JSON.parse(file("kbrain/connection.json"));
  assert.equal(connection.state, "connected");
  assert.equal(connection.endpoint, "http://127.0.0.1:47000");

  const [provider] = JSON.parse(file("providers.json"));
  assert.equal(provider.endpoint, "http://127.0.0.1:18080/v1");
  assert.deepEqual(provider.models, ["fake-model-a", "fake-model-b"]);
  assert.equal(provider.apiKeyConfigured, true);
  assert.deepEqual(provider.customHeaderNames, ["X-Org"]);
  assert.ok(!("apiKey" in provider));

  const mcp = JSON.parse(file("mcp.json"));
  assert.deepEqual(
    mcp.servers.map((server) => server.id),
    ["files", "remote"],
    "only enabled servers",
  );
  assert.equal(mcp.servers[0].command, "mcp-files");
  assert.deepEqual(mcp.servers[0].envNames, ["GITHUB_TOKEN"]);
  assert.equal(mcp.servers[1].endpoint, "https://mcp.example.test");
  assert.deepEqual(mcp.servers[1].headerNames, ["Authorization"]);

  const workspaces = JSON.parse(file("workspaces.json"));
  assert.equal(workspaces.sessions, 12);
  assert.ok(workspaces.workspaces >= 1);

  const settings = JSON.parse(file("settings.json"));
  assert.equal(settings.counts.sshHosts, 1);
  assert.equal(settings.counts.promptTemplates, 1);
  assert.deepEqual(settings.selectedModel, { providerId: "fake-openai", model: "fake-model-a" });

  assert.equal(JSON.parse(file("errors.json")).length, 2);
  assert.match(file("logs/k-brain.log"), /ready/);
  assert.match(bundle.summary, /App: 1\.2\.3-beta\.1 \(prerelease\) \[desktop\]/);
  assert.match(bundle.summary, /K-brain: 0\.9\.0 \(stable\)/);
  assert.match(bundle.summary, /Backend: connected \(4 ms\)/);
  assert.match(bundle.summary, /Providers: 1 \(openai:2\)/);
  assert.match(bundle.summary, /Sessions: 12/);
});

test("log text is bounded by the bundle budget and cut on a line boundary", () => {
  const line = "2026-03-04 INFO steady state line with some padding text\n";
  const big = line.repeat(Math.ceil((DIAGNOSTICS_LOG_BUDGET_BYTES * 1.5) / line.length));
  const bundle = buildDiagnosticsBundle(
    fixtureInput({
      logFiles: [
        { name: "k-brain.log", content: big, truncated: false, originalBytes: big.length },
        { name: "k-brain.log.1", content: big, truncated: false, originalBytes: big.length },
      ],
    }),
  );
  const logBytes = bundle.files
    .filter((file) => file.path.startsWith("logs/") && file.path !== "logs/index.json")
    .reduce((sum, file) => sum + file.bytes, 0);
  assert.ok(logBytes <= DIAGNOSTICS_LOG_BUDGET_BYTES, `${logBytes} > budget`);
  const main = bundle.files.find((file) => file.path === "logs/k-brain.log");
  assert.ok(main.content.startsWith("2026-03-04 INFO"), "starts on a full line");
  const older = bundle.files.find((file) => file.path === "logs/k-brain.log.1");
  assert.ok(!older || older.bytes <= line.length, "the older log only gets what is left");
  const index = JSON.parse(bundle.files.find((file) => file.path === "logs/index.json").content);
  assert.equal(index[0].truncated, true);

  const tail = tailText("ab\ncd\nef", 4);
  assert.deepEqual(tail, { text: "ef", truncated: true });
  assert.deepEqual(tailText("short", 100), { text: "short", truncated: false });
});

test("missing settings and an unreachable backend still produce a valid bundle", () => {
  const bundle = buildDiagnosticsBundle(
    fixtureInput({
      host: "webui",
      settings: null,
      sessionCount: null,
      logFiles: [],
      kbrain: { health: null, healthError: "timeout", connection: { state: "unreachable", error: "timeout" } },
    }),
  );
  const paths = bundle.files.map((file) => file.path);
  assert.ok(!paths.includes("settings.json"));
  assert.ok(!paths.includes("logs/index.json"));
  assert.deepEqual(JSON.parse(bundle.files.find((f) => f.path === "kbrain/health.json").content), {
    available: false,
    error: "timeout",
  });
  assert.match(bundle.summary, /Backend: unreachable - timeout/);
});

test("errors scrubbed at capture time still show up in the redaction tally", () => {
  const { createDiagnosticsCapture } = loadModule("@liveagent/ui/lib/diagnostics/recentErrors.ts");
  const printed = [];
  const fakeConsole = { error: (...args) => printed.push(args), warn: (...args) => printed.push(args) };
  const capture = createDiagnosticsCapture({ console: fakeConsole }, () => 1000);
  try {
    fakeConsole.error(
      "GET https://api.example.test/v1/models?api_key=sk-fixture-provider-key-0123456789",
      { headers: { Authorization: "Bearer sk-fixture-provider-key-0123456789" } },
    );
    fakeConsole.warn(`scan failed at ${HOME}/projects/demo for fixture.person@example.com`);
    assert.equal(printed.length, 2, "the original console still receives the call");
    const [error] = capture.errors();
    assert.ok(!error.message.includes("sk-fixture-provider-key"), error.message);
    assert.ok(error.redactions.secretField >= 1, "structured header counted");
    assert.ok(!capture.log()[1].message.includes("fixture-user"));

    const bundle = buildDiagnosticsBundle(
      fixtureInput({ recentErrors: capture.errors(), appLog: capture.log(), logFiles: [] }),
    );
    const baseline = buildDiagnosticsBundle(
      fixtureInput({
        recentErrors: capture.errors().map(({ redactions: _r, ...entry }) => entry),
        appLog: capture.log().map(({ redactions: _r, ...entry }) => entry),
        logFiles: [],
      }),
    );
    const total = (counts) => Object.values(counts).reduce((sum, n) => sum + n, 0);
    assert.ok(total(bundle.redactions) > total(baseline.redactions), "capture counts are merged");
    assert.ok(bundle.redactions.email >= 1 && bundle.redactions.homePath >= 1);
    const errorsJson = bundle.files.find((file) => file.path === "errors.json").content;
    assert.ok(!errorsJson.includes("redactions"), "the capture tally is not exported");
    for (const file of bundle.files) {
      for (const leak of LEAKS) assert.ok(!file.content.includes(leak), `${file.path} leaks ${leak}`);
    }
  } finally {
    capture.dispose();
  }
  assert.equal(typeof fakeConsole.error, "function");
});

test("zip contains exactly the previewed files with identical content", async () => {
  const bundle = buildDiagnosticsBundle(fixtureInput());
  const bytes = await createDiagnosticsZip(bundle);
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.values(zip.files)
    .filter((entry) => !entry.dir)
    .map((entry) => entry.name);
  assert.deepEqual(names.sort(), bundle.files.map((file) => file.path).sort());
  for (const file of bundle.files) {
    assert.equal(await zip.file(file.path).async("string"), file.content, file.path);
  }
});

test("copy summary writes the redacted summary to an injected clipboard only", async () => {
  const bundle = buildDiagnosticsBundle(fixtureInput());
  const writes = [];
  const fakeClipboard = { writeText: async (text) => void writes.push(text) };
  assert.equal(await copyDiagnosticsSummary(bundle, fakeClipboard), true);
  assert.deepEqual(writes, [bundle.summary]);
  for (const leak of LEAKS) assert.ok(!writes[0].includes(leak), `clipboard got ${leak}`);
  // No clipboard available (null skips the navigator default): reports failure instead of throwing.
  assert.equal(await copyDiagnosticsSummary(bundle, null), false);
});

test("export requests reach every subscriber until it unsubscribes", () => {
  let calls = 0;
  const unsubscribe = subscribeDiagnosticsExportRequests(() => {
    calls += 1;
  });
  requestDiagnosticsExport();
  unsubscribe();
  requestDiagnosticsExport();
  assert.equal(calls, 1);
  assert.equal(diagnosticsFileName(new Date("2026-12-31T23:59:58Z")), "liveagent-diagnostics-20261231-235958.zip");
});
