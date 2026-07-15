import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const agentDebug = loader.loadModule("src/lib/debug/agentDebug.ts");

test("debug sanitizer redacts base64 data URLs", () => {
  const payload = {
    input: [
      {
        content: [
          {
            type: "input_image",
            image_url: "data:image/png;base64,aW1hZ2U=",
          },
          {
            type: "input_file",
            file_data: "data:application/pdf;base64,cGRm",
          },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "aW1hZ2U=",
            },
          },
          {
            type: "document",
            source: {
              type: "text",
              media_type: "text/plain",
              data: "Hello Claude",
            },
          },
          {
            inlineData: {
              mimeType: "image/png",
              data: "aW1hZ2U=",
            },
          },
        ],
      },
    ],
  };

  const sanitized = agentDebug.__agentDebugTest.sanitizeDebugValue(payload);
  assert.equal(
    sanitized.input[0].content[0].image_url,
    "[redacted data URL: image/png, base64 chars=8]",
  );
  assert.equal(
    sanitized.input[0].content[1].file_data,
    "[redacted data URL: application/pdf, base64 chars=4]",
  );
  assert.equal(
    sanitized.input[0].content[2].source.data,
    "[redacted base64: image/png, chars=8]",
  );
  assert.equal(
    sanitized.input[0].content[3].source.data,
    "[redacted text document: text/plain, chars=12]",
  );
  assert.equal(
    sanitized.input[0].content[4].inlineData.data,
    "[redacted inlineData: image/png, chars=8]",
  );
});

test("debug sanitizer redacts credential fields without hiding token usage", () => {
  const payload = {
    apiKey: "sk-top-level",
    headers: {
      Authorization: "Bearer primary",
      "pRoXy_AuThOrIzAtIoN": "Basic proxy",
      "X-API-KEY": "anthropic-key",
      "x_GOOG_api_KEY": "google-key",
      Cookie: "session=secret",
      "sEt-cOoKiE": "session=rotated",
    },
    providerConfig: {
      ACCESS_TOKEN: "access-secret",
      "refresh-token": "refresh-secret",
      IdToken: "id-secret",
      authToken: "auth-secret",
      GITHUB_TOKEN: "github-secret",
      "X-Auth-Token": "header-token-secret",
      OPENAI_API_KEY: "openai-secret",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      privateKey: "private-key-secret",
      client_secret: "client-secret",
      PaSsWoRd: "password-secret",
      pwd: "pwd-secret",
      passphrase: "passphrase-secret",
      signingKey: "signing-key-secret",
      "Ocp-Apim-Subscription-Key": "azure-subscription-secret",
    },
    credential: { type: "api_key", key: "credential-key-secret" },
    providerCredentials: "provider-credential-secret",
    oauth: { access: "oauth-access-secret", refresh: "oauth-refresh-secret", expires: 123 },
    auth: "Bearer auth-field-secret",
    requestAuthorization: "Bearer request-auth-secret",
    cookies: "first=cookie-one; second=cookie-two",
    apiKeyHeader: "header-api-key-secret",
    apiKeys: ["array-key-secret"],
    namedHeader: { name: "Authorization", value: "named-header-secret" },
    usage: {
      inputTokens: 123,
      output_tokens: 45,
      maxTokens: 4096,
      totalTokenCount: 168,
      contextToken: 2048,
      hasApiKey: true,
    },
  };

  const sanitized = agentDebug.__agentDebugTest.sanitizeDebugValue(payload);
  assert.equal(sanitized.apiKey, "[redacted credential]");
  assert.deepEqual(sanitized.headers, {
    Authorization: "[redacted credential]",
    "pRoXy_AuThOrIzAtIoN": "[redacted credential]",
    "X-API-KEY": "[redacted credential]",
    "x_GOOG_api_KEY": "[redacted credential]",
    Cookie: "[redacted credential]",
    "sEt-cOoKiE": "[redacted credential]",
  });
  assert.deepEqual(sanitized.providerConfig, {
    ACCESS_TOKEN: "[redacted credential]",
    "refresh-token": "[redacted credential]",
    IdToken: "[redacted credential]",
    authToken: "[redacted credential]",
    GITHUB_TOKEN: "[redacted credential]",
    "X-Auth-Token": "[redacted credential]",
    OPENAI_API_KEY: "[redacted credential]",
    AWS_SECRET_ACCESS_KEY: "[redacted credential]",
    privateKey: "[redacted credential]",
    client_secret: "[redacted credential]",
    PaSsWoRd: "[redacted credential]",
    pwd: "[redacted credential]",
    passphrase: "[redacted credential]",
    signingKey: "[redacted credential]",
    "Ocp-Apim-Subscription-Key": "[redacted credential]",
  });
  assert.equal(sanitized.credential, "[redacted credential]");
  assert.equal(sanitized.providerCredentials, "[redacted credential]");
  assert.equal(sanitized.oauth, "[redacted credential]");
  assert.equal(sanitized.auth, "[redacted credential]");
  assert.equal(sanitized.requestAuthorization, "[redacted credential]");
  assert.equal(sanitized.cookies, "[redacted credential]");
  assert.equal(sanitized.apiKeyHeader, "[redacted credential]");
  assert.equal(sanitized.apiKeys, "[redacted credential]");
  assert.equal(sanitized.namedHeader.name, "Authorization");
  assert.equal(sanitized.namedHeader.value, "[redacted credential]");
  assert.deepEqual(sanitized.usage, payload.usage);
});

test("debug sanitizer applies credential redaction inside arrays", () => {
  const payload = [
    {
      providers: [
        { api_key: "first-key", usage: { inputTokens: 10 } },
        { headers: { authorization: "Bearer second" }, outputTokens: 20 },
      ],
    },
  ];

  const sanitized = agentDebug.__agentDebugTest.sanitizeDebugValue(payload);
  assert.deepEqual(sanitized, [
    {
      providers: [
        { api_key: "[redacted credential]", usage: { inputTokens: 10 } },
        { headers: { authorization: "[redacted credential]" }, outputTokens: 20 },
      ],
    },
  ]);
});

test("debug sanitizer redacts credentials inside JSON strings and error text", () => {
  const functionArguments = JSON.stringify({
    apiKey: "sk-json-secret",
    env: {
      GITHUB_TOKEN: "ghp-json-secret",
      AWS_SECRET_ACCESS_KEY: "aws-json-secret",
    },
    usage: { inputTokens: 10, totalTokenCount: 10 },
  });
  const error = new Error(
    'Authorization: "Bearer bearer-error-secret"; GITHUB_TOKEN=ghp-error-secret',
  );
  error.stack = [
    error.message,
    "api_key=sk-stack-secret",
    "-----BEGIN PRIVATE KEY-----",
    "private-key-material",
    "-----END PRIVATE KEY-----",
  ].join("\n");

  const sanitized = agentDebug.__agentDebugTest.sanitizeDebugValue({
    function: { arguments: functionArguments },
    error,
  });
  assert.equal(sanitized.function.arguments, '{"redacted":"credential-bearing JSON"}');

  const serialized = JSON.stringify(sanitized);
  for (const secret of [
    "sk-json-secret",
    "ghp-json-secret",
    "aws-json-secret",
    "bearer-error-secret",
    "ghp-error-secret",
    "sk-stack-secret",
    "private-key-material",
  ]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
  assert.match(sanitized.error.message, /\[redacted credential\]/);
  assert.match(sanitized.error.stack, /\[redacted private key\]/);
});

test("debug sanitizer decodes escaped JSON credential keys without rewriting safe JSON", () => {
  const escaped = String.raw`{"api\u004bey":"UNICODE_SECRET"}`;
  const nested = JSON.stringify(escaped);
  const safeEscaped = String.raw`{"safe\u004bey":"VISIBLE"}`;

  assert.equal(
    agentDebug.__agentDebugTest.sanitizeDebugValue(escaped),
    '{"redacted":"credential-bearing JSON"}',
  );
  assert.equal(
    agentDebug.__agentDebugTest.sanitizeDebugValue(nested),
    '{"redacted":"credential-bearing JSON"}',
  );
  assert.equal(agentDebug.__agentDebugTest.sanitizeDebugValue(safeEscaped), safeEscaped);
});

test("debug sanitizer redacts quoted credential keys in diagnostic text", () => {
  const diagnostic =
    'request failed: {"Authorization": "Bearer quoted-secret", "inputTokens": 12}';
  const sanitized = agentDebug.__agentDebugTest.sanitizeDebugValue(diagnostic);

  assert.equal(sanitized.includes("quoted-secret"), false);
  assert.match(sanitized, /Authorization.*\[redacted credential\]/);
  assert.match(sanitized, /inputTokens/);
});

test("debug sanitizer redacts URL credentials, multi-value cookies, and array headers", () => {
  const sanitized = agentDebug.__agentDebugTest.sanitizeDebugValue({
    url: "https://host.test/path?api_key=URL_SECRET&mode=safe",
    userInfoUrl: "https://user:URL_PASSWORD@host.test/path",
    cookie: "Cookie: first=COOKIE_ONE; second=COOKIE_TWO",
    diagnostic: 'request failed: {"Authorization":["Bearer ARRAY_SECRET"]}',
    pairDiagnostic: 'headers=[["Authorization","Bearer PAIR_SECRET"],["Accept","json"]]',
    basicDiagnostic: "proxy failed: Authorization: Basic BASIC_SECRET",
  });
  const serialized = JSON.stringify(sanitized);

  for (const secret of [
    "URL_SECRET",
    "URL_PASSWORD",
    "COOKIE_ONE",
    "COOKIE_TWO",
    "ARRAY_SECRET",
    "PAIR_SECRET",
    "BASIC_SECRET",
  ]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
  assert.match(sanitized.url, /api_key=\[redacted credential\]/);
  assert.equal(sanitized.cookie, "[redacted credential]");
});

test("debug sanitizer preserves ordinary uses of basic", () => {
  for (const text of [
    "Please build a basic calculator app",
    "Show a basic example",
    "Explain basic linear algebra",
  ]) {
    assert.equal(agentDebug.__agentDebugTest.sanitizeDebugValue(text), text);
  }
});

test("debug sanitizer scans long delimiter-free text in bounded time", () => {
  const input = "a".repeat(80 * 1024);
  const startedAt = performance.now();
  assert.equal(agentDebug.__agentDebugTest.sanitizeDebugValue(input), input);
  const elapsedMs = performance.now() - startedAt;
  assert.ok(elapsedMs < 1_500, `sanitizing took ${elapsedMs.toFixed(1)} ms`);
});

test("debug sanitizer preserves credential-free JSON strings byte-for-byte", () => {
  const diagnostic =
    '{"request_id":9007199254740993,"duplicate":1,"duplicate":2,"inputTokens":12}';
  assert.equal(agentDebug.__agentDebugTest.sanitizeDebugValue(diagnostic), diagnostic);
});

test("debug sanitizer fails closed for deeply nested credential JSON", () => {
  const depth = 4_000;
  const diagnostic = `{"apiKey":${'{"value":'.repeat(depth)}"DEEP_SECRET"${"}".repeat(
    depth,
  )}}`;
  const sanitized = agentDebug.__agentDebugTest.sanitizeDebugValue(diagnostic);

  assert.equal(sanitized, '{"redacted":"credential-bearing JSON"}');
  assert.equal(sanitized.includes("DEEP_SECRET"), false);
});

test("debug sanitizer bounds deeply nested object traversal", () => {
  const payload = {};
  let cursor = payload;
  for (let depth = 0; depth < 4_000; depth += 1) {
    cursor.child = {};
    cursor = cursor.child;
  }
  cursor.apiKey = "DEEP_OBJECT_SECRET";

  const sanitized = agentDebug.__agentDebugTest.sanitizeDebugValue(payload);
  const serialized = JSON.stringify(sanitized);
  assert.equal(serialized.includes("DEEP_OBJECT_SECRET"), false);
  assert.match(serialized, /redacted deeply nested debug value/);
});

test("debug sanitizer handles cyclic arrays", () => {
  const cyclic = [];
  cyclic.push({ token: "cycle-secret" }, cyclic);
  assert.deepEqual(agentDebug.__agentDebugTest.sanitizeDebugValue(cyclic), [
    { token: "[redacted credential]" },
    "[Circular]",
  ]);
});

test("stream request debug payload keeps API key presence without the credential", () => {
  const payload = agentDebug.buildStreamRequestDebugPayload({
    runtime: {
      baseUrl: "https://example.test",
      apiKey: "sk-runtime",
    },
    context: {
      systemPrompt: "system",
      messages: [],
    },
    options: {
      apiKey: "sk-option",
      headers: {
        Authorization: "Bearer option",
        "x-api-key": "header-key",
      },
    },
  });

  assert.equal(payload.runtime.hasApiKey, true);
  assert.equal("apiKey" in payload.runtime, false);
  assert.equal(payload.options.apiKey, "[redacted credential]");
  assert.deepEqual(payload.options.headers, {
    Authorization: "[redacted credential]",
    "x-api-key": "[redacted credential]",
  });
});

test("persisted stream request redacts the local proxy token", async () => {
  const persisted = [];
  const integrationLoader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          if (command === "proxy_get_server_info") {
            return {
              baseUrl: "http://127.0.0.1:11435",
              token: "local-proxy-secret",
            };
          }
          if (command === "system_append_debug_jsonl") {
            persisted.push(args.entry);
            return undefined;
          }
          throw new Error(`unexpected invoke: ${command}`);
        },
      },
    },
  });
  const integrationDebug = integrationLoader.loadModule("src/lib/debug/agentDebug.ts");
  const proxy = integrationLoader.loadModule("src/lib/providers/proxy.ts");
  const prepared = await proxy.prepareProxyRequest("openai", "https://api.example.test/v1", {
    Authorization: "Bearer upstream-secret",
  });
  const logger = integrationDebug.createStreamDebugLogger({
    enabled: true,
    conversationId: "debug-redaction-test",
    executionMode: "agent_dev",
    streamKind: "agent",
    providerId: "openai",
    model: "test-model",
  });

  logger.logRequest(
    integrationDebug.buildStreamRequestDebugPayload({
      runtime: {
        baseUrl: prepared.baseUrl,
        apiKey: "runtime-secret",
      },
      context: { messages: [] },
      options: { headers: prepared.headers },
    }),
  );
  await logger.flush();

  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].sanitizerVersion, 3);
  assert.equal(
    persisted[0].payload.options.headers.Authorization,
    "[redacted credential]",
  );
  assert.equal(
    persisted[0].payload.options.headers[proxy.LIVEAGENT_PROXY_TOKEN_HEADER],
    "[redacted credential]",
  );
  assert.equal(JSON.stringify(persisted).includes("local-proxy-secret"), false);
  assert.equal(JSON.stringify(persisted).includes("upstream-secret"), false);
});
