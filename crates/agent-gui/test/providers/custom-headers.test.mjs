import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const customHeaders = loader.loadModule("@liveagent/ui/lib/providers/customHeaders.ts");

function errorHasCode(code) {
  return (error) => error?.code === code;
}

test("parses JSON objects and arrays", () => {
  assert.deepEqual(
    customHeaders.parseCustomHeadersImport(
      '{"X-Title":"LiveAgent","X-Environment":"production"}',
    ),
    {
      headers: [
        { key: "X-Title", value: "LiveAgent" },
        { key: "X-Environment", value: "production" },
      ],
      issues: [],
    },
  );

  assert.deepEqual(
    customHeaders.parseCustomHeadersImport(
      '[{"key":"X-Title","value":"LiveAgent"}]',
    ),
    {
      headers: [{ key: "X-Title", value: "LiveAgent" }],
      issues: [],
    },
  );
});

test("converts JSON number and boolean values and skips nested values", () => {
  const result = customHeaders.parseCustomHeadersImport(
    JSON.stringify({
      "X-String": "literal",
      "X-Number": 42,
      "X-Boolean": false,
      "X-Null": null,
      "X-Object": { nested: true },
      "X-Array": ["nested"],
    }),
  );

  assert.deepEqual(result.headers, [
    { key: "X-String", value: "literal" },
    { key: "X-Number", value: "42" },
    { key: "X-Boolean", value: "false" },
  ]);
  assert.deepEqual(
    result.issues.map(({ key, reason }) => ({ key, reason })),
    [
      { key: "X-Null", reason: "unsupported-value" },
      { key: "X-Object", reason: "unsupported-value" },
      { key: "X-Array", reason: "unsupported-value" },
    ],
  );
  assert.ok(result.issues.every((issue) => !("value" in issue)));
});

test("extracts quoted cURL headers across Bash, PowerShell, and CMD continuations", () => {
  const bash = [
    'curl "https://example.test" \\',
    '  -H "X-Double: one" \\',
    "  --header 'X-Single: two'",
  ].join("\n");
  const powershell = [
    'curl "https://example.test" ' + String.fromCharCode(96),
    '  --header "X-PowerShell: three"',
  ].join("\n");
  const cmd = [
    'curl "https://example.test" ^',
    '  -H "X-Cmd: four"',
  ].join("\r\n");

  assert.deepEqual(customHeaders.parseCustomHeadersImport(bash).headers, [
    { key: "X-Double", value: "one" },
    { key: "X-Single", value: "two" },
  ]);
  assert.deepEqual(customHeaders.parseCustomHeadersImport(powershell).headers, [
    { key: "X-PowerShell", value: "three" },
  ]);
  assert.deepEqual(customHeaders.parseCustomHeadersImport(cmd).headers, [
    { key: "X-Cmd", value: "four" },
  ]);
});

test("supports --header=value, preserves value colons, and ignores non-header cURL options", () => {
  const result = customHeaders.parseCustomHeadersImport(
    'curl "https://example.test" -X POST --data "secret-body" --cookie "secret-cookie" ' +
      '--header="X-Endpoint: https://api.example.test:8443/v1"',
  );

  assert.deepEqual(result, {
    headers: [{ key: "X-Endpoint", value: "https://api.example.test:8443/v1" }],
    issues: [],
  });
});

test("uses the last case-insensitive duplicate from imported content", () => {
  const result = customHeaders.parseCustomHeadersImport(
    '[{"key":"X-Title","value":"first"},{"key":"x-title","value":"last"}]',
  );

  assert.deepEqual(result.headers, [{ key: "x-title", value: "last" }]);
});

test("overwrites existing names in place and appends new headers without mutating inputs", () => {
  const current = [
    { key: "X-First", value: "one" },
    { key: "X-Title", value: "old" },
    { key: "X-Last", value: "three" },
    { key: "x-title", value: "duplicate" },
  ];
  const imported = [
    { key: "x-TITLE", value: "new" },
    { key: "X-New", value: "four" },
  ];

  const merged = customHeaders.mergeImportedCustomHeaders(current, imported);

  assert.deepEqual(merged, {
    headers: [
      { key: "X-First", value: "one" },
      { key: "x-TITLE", value: "new" },
      { key: "X-Last", value: "three" },
      { key: "X-New", value: "four" },
    ],
    importedCount: 2,
    overwrittenCount: 1,
  });
  assert.deepEqual(current, [
    { key: "X-First", value: "one" },
    { key: "X-Title", value: "old" },
    { key: "X-Last", value: "three" },
    { key: "x-title", value: "duplicate" },
  ]);
  assert.deepEqual(imported, [
    { key: "x-TITLE", value: "new" },
    { key: "X-New", value: "four" },
  ]);
});

test("skips protected names, invalid names, and CR/LF values without exposing values", () => {
  const result = customHeaders.parseCustomHeadersImport(
    JSON.stringify({
      Authorization: "secret-auth",
      "x-api-key": "secret-api",
      "x-goog-api-key": "secret-google",
      "anthropic-beta": "secret-beta",
      Host: "secret-host",
      "Content-Length": 10,
      "Bad Header": "secret-invalid",
      "X-Line": "secret\r\ninjected",
      "X-Okay": "kept",
    }),
  );

  assert.deepEqual(result.headers, [{ key: "X-Okay", value: "kept" }]);
  assert.deepEqual(
    result.issues.map(({ key, reason }) => ({ key, reason })),
    [
      { key: "Authorization", reason: "reserved" },
      { key: "x-api-key", reason: "reserved" },
      { key: "x-goog-api-key", reason: "reserved" },
      { key: "anthropic-beta", reason: "reserved" },
      { key: "Host", reason: "reserved" },
      { key: "Content-Length", reason: "reserved" },
      { key: "Bad Header", reason: "invalid-key" },
      { key: "X-Line", reason: "invalid-value" },
    ],
  );
  assert.ok(result.issues.every((issue) => !("value" in issue)));
});

test("reports empty input, malformed JSON, and unterminated cURL quotes", () => {
  assert.throws(
    () => customHeaders.parseCustomHeadersImport("   "),
    errorHasCode("empty"),
  );
  assert.throws(
    () => customHeaders.parseCustomHeadersImport('{"X-Title":'),
    errorHasCode("invalid-json"),
  );
  assert.throws(
    () => customHeaders.parseCustomHeadersImport('curl -H "X-Title: open'),
    errorHasCode("unterminated-quote"),
  );
});

test("does not read @files and leaves current headers unchanged when nothing is valid", () => {
  const current = [{ key: "X-Existing", value: "unchanged" }];
  const fileResult = customHeaders.parseCustomHeadersImport("curl -H @headers.txt");
  assert.deepEqual(fileResult, {
    headers: [],
    issues: [{ reason: "malformed-header" }],
  });

  const protectedResult = customHeaders.parseCustomHeadersImport(
    '{"Authorization":"secret"}',
  );
  const merged = customHeaders.mergeImportedCustomHeaders(
    current,
    protectedResult.headers,
  );
  assert.deepEqual(merged, {
    headers: [{ key: "X-Existing", value: "unchanged" }],
    importedCount: 0,
    overwrittenCount: 0,
  });
  assert.deepEqual(current, [{ key: "X-Existing", value: "unchanged" }]);
});

test("buildCliIdentityHeaders(claude_code) writes UA plus the Anthropic fingerprint minus Content-Type", () => {
  const headers = customHeaders.buildCliIdentityHeaders("claude_code");
  assert.deepEqual(headers[0], {
    key: "User-Agent",
    value: customHeaders.CLI_IDENTITY_USER_AGENTS.claude_code,
  });
  const map = new Map(headers.map((header) => [header.key, header.value]));
  // Content-Type 不写入（发请求侧按 body 决定）。
  assert.equal(map.has("Content-Type"), false);
  // 其余 Anthropic 指纹头逐条写入且取值一致。
  for (const [key, value] of Object.entries(customHeaders.ANTHROPIC_DEFAULT_REQUEST_HEADERS)) {
    if (key.toLowerCase() === "content-type") continue;
    assert.equal(map.get(key), value);
  }
});

test("buildCliIdentityHeaders(codex) adds static originator + version headers matched to the UA", () => {
  const ua = customHeaders.CLI_IDENTITY_USER_AGENTS.codex;
  const codexVersion = ua.slice("codex_cli_rs/".length).split(" ")[0];
  assert.deepEqual(customHeaders.buildCliIdentityHeaders("codex"), [
    { key: "User-Agent", value: ua },
    { key: "originator", value: "codex_cli_rs" },
    { key: "version", value: codexVersion },
  ]);
});

test("buildCliIdentityHeaders(xai) adds the grok-shell client identity headers matched to the UA", () => {
  const ua = customHeaders.CLI_IDENTITY_USER_AGENTS.xai;
  const grokVersion = ua.slice("grok-shell/".length).split(" ")[0];
  assert.deepEqual(customHeaders.buildCliIdentityHeaders("xai"), [
    { key: "User-Agent", value: ua },
    { key: "x-grok-client-identifier", value: "grok-shell" },
    { key: "x-grok-client-version", value: grokVersion },
    { key: "x-grok-client-mode", value: "interactive" },
    { key: "X-XAI-Token-Auth", value: "xai-grok-cli" },
    { key: "x-authenticateresponse", value: "authenticate-response" },
  ]);
});

test("listCliIdentityProviderIds puts the matching provider first", () => {
  assert.deepEqual(customHeaders.listCliIdentityProviderIds(), [
    "claude_code",
    "codex",
    "xai",
  ]);
  assert.deepEqual(customHeaders.listCliIdentityProviderIds("xai"), [
    "xai",
    "claude_code",
    "codex",
  ]);
  assert.deepEqual(customHeaders.listCliIdentityProviderIds("gemini"), [
    "claude_code",
    "codex",
    "xai",
  ]);
});

test("every CLI identity header set is valid, unreserved, and merges without duplicates", () => {
  for (const id of customHeaders.CLI_IDENTITY_PROVIDER_IDS) {
    const identity = customHeaders.buildCliIdentityHeaders(id);
    for (const { key, value } of identity) {
      assert.ok(customHeaders.isValidCustomHeaderKey(key), `invalid key: ${key}`);
      assert.ok(customHeaders.isValidCustomHeaderValue(value), `invalid value for ${key}`);
      assert.equal(
        customHeaders.isReservedCustomHeaderKey(key),
        false,
        `reserved key leaked into identity: ${key}`,
      );
    }
    const merged = customHeaders.mergeImportedCustomHeaders([], identity);
    assert.equal(merged.headers.length, identity.length, `duplicate keys for ${id}`);
  }
});

test("applyCliIdentity replaces the previous CLI's whole fingerprint instead of layering on top", () => {
  const business = [{ key: "X-Relay-Channel", value: "vip" }];
  const claude = customHeaders.applyCliIdentity(business, "claude_code");
  assert.equal(claude.removedCount, 0);
  assert.equal(claude.overwrittenCount, 0);
  assert.equal(
    claude.headers.length,
    1 + customHeaders.buildCliIdentityHeaders("claude_code").length,
  );

  // 用户手填了 Claude 的会话头，然后切到 Codex。
  const withDynamic = [
    ...claude.headers,
    { key: customHeaders.CLAUDE_SESSION_ID_HEADER, value: "sess-1" },
  ];
  const codex = customHeaders.applyCliIdentity(withDynamic, "codex");
  const keys = codex.headers.map((header) => header.key.toLowerCase());

  // Anthropic 家族整套消失，包括手填的会话头。
  assert.ok(!keys.includes("x-app"));
  assert.ok(!keys.some((key) => key.startsWith("x-stainless-")));
  assert.ok(!keys.includes("anthropic-version"));
  assert.ok(!keys.includes("anthropic-dangerous-direct-browser-access"));
  assert.ok(!keys.includes(customHeaders.CLAUDE_SESSION_ID_HEADER.toLowerCase()));

  // 业务头原样保留在原位；UA 就地换成 Codex。
  assert.deepEqual(codex.headers[0], { key: "X-Relay-Channel", value: "vip" });
  const map = new Map(codex.headers.map((header) => [header.key, header.value]));
  assert.equal(map.get("User-Agent"), customHeaders.CLI_IDENTITY_USER_AGENTS.codex);
  assert.equal(map.get("originator"), "codex_cli_rs");

  // 结果恰好 = 业务头 + Codex 整套身份头，没有残留。
  assert.equal(codex.headers.length, 1 + customHeaders.buildCliIdentityHeaders("codex").length);
  assert.equal(codex.overwrittenCount, 1);
  // 只有业务头和共享的 User-Agent 留下，其余都是被剥掉的 Anthropic 头。
  assert.equal(codex.removedCount, withDynamic.length - 2);
  // 输入未被改动。
  assert.equal(withDynamic.length, claude.headers.length + 1);
});

test("applyCliIdentity strips hand-filled x-grok-* per-turn headers when leaving Grok", () => {
  const start = [
    ...customHeaders.buildCliIdentityHeaders("xai"),
    { key: "x-grok-conv-id", value: "conv-1" },
    { key: "X-Title", value: "mine" },
  ];
  const claude = customHeaders.applyCliIdentity(start, "claude_code");
  const keys = claude.headers.map((header) => header.key.toLowerCase());
  assert.ok(!keys.some((key) => key.startsWith("x-grok-")));
  assert.ok(!keys.includes("x-xai-token-auth"));
  assert.ok(!keys.includes("x-authenticateresponse"));
  assert.ok(keys.includes("x-title"));
  assert.equal(
    claude.headers.length,
    1 + customHeaders.buildCliIdentityHeaders("claude_code").length,
  );
  assert.equal(claude.removedCount, start.length - 2);
});

test("re-applying the same CLI keeps its own hand-filled per-session headers", () => {
  const start = [
    ...customHeaders.buildCliIdentityHeaders("codex"),
    { key: customHeaders.CODEX_OFFICIAL_SESSION_ID_HEADER, value: "thread-1" },
    { key: customHeaders.CLIENT_REQUEST_ID_HEADER, value: "req-1" },
  ];
  const again = customHeaders.applyCliIdentity(start, "codex");
  const map = new Map(again.headers.map((header) => [header.key, header.value]));
  assert.equal(map.get(customHeaders.CODEX_OFFICIAL_SESSION_ID_HEADER), "thread-1");
  assert.equal(map.get(customHeaders.CLIENT_REQUEST_ID_HEADER), "req-1");
  assert.equal(again.removedCount, 0);
  assert.equal(again.overwrittenCount, customHeaders.buildCliIdentityHeaders("codex").length);
  assert.equal(again.headers.length, start.length);
});

test("x-client-request-id survives a Claude <-> Codex switch but not a switch to Grok", () => {
  const start = [
    ...customHeaders.buildCliIdentityHeaders("claude_code"),
    { key: customHeaders.CLIENT_REQUEST_ID_HEADER, value: "req-1" },
  ];
  const codex = customHeaders.applyCliIdentity(start, "codex");
  assert.ok(
    codex.headers.some(
      (header) => header.key === customHeaders.CLIENT_REQUEST_ID_HEADER && header.value === "req-1",
    ),
  );
  const grok = customHeaders.applyCliIdentity(start, "xai");
  assert.ok(
    !grok.headers.some(
      (header) => header.key.toLowerCase() === customHeaders.CLIENT_REQUEST_ID_HEADER.toLowerCase(),
    ),
  );
});

test("parsed and saved headers reach runtime merge while CR/LF values are rejected", () => {
  const parsed = customHeaders.parseCustomHeadersImport(
    '{"X-Imported":"sentinel"}',
  );
  const saved = customHeaders.mergeImportedCustomHeaders([], parsed.headers);

  assert.deepEqual(
    customHeaders.mergeCustomHeaders(
      { Accept: "application/json" },
      [
        ...saved.headers,
        { key: "X-Line", value: "bad\nvalue" },
      ],
    ),
    {
      Accept: "application/json",
      "X-Imported": "sentinel",
    },
  );
});
