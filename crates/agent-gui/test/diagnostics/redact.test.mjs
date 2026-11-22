// Redaction must remove every credential shape a bug report could leak, and say
// how many it removed without showing the values. Fixtures are synthetic.
import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const { loadModule } = createTsModuleLoader();
const redact = loadModule("@liveagent/ui/lib/diagnostics/redact.ts");
const { redactText, redactJson, emptyRedactionCounts, totalRedactions, urlWithoutSecrets, urlOrigin } =
  redact;

const HOME = "/Users/fixture-user";

// Values that must never survive, whatever wraps them.
const SECRETS = [
  "hunter2-password",
  "sk-abcdefghijklmnopqrstuvwxyz0123",
  "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX",
  "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "AKIAABCDEFGHIJKLMNOP",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlLXZhbHVl",
  "AbCd1234EfGh5678IjKl",
  "s3ss10n-c00kie-value",
  "q-param-secret-123",
  "b3BlbnNzaC1rZXktdjEAAAAABG5vbmU",
  "fixture.person@example.com",
  "fixture-user",
];

function assertClean(output, label) {
  for (const secret of SECRETS) {
    assert.ok(!output.includes(secret), `${label}: leaked ${secret}\n${output}`);
  }
}

test("keys in URLs: userinfo and secret query parameters are removed, the rest stays", () => {
  const counts = emptyRedactionCounts();
  const out = redactText(
    [
      "GET https://user:hunter2-password@api.example.test/v1/models?api_key=q-param-secret-123&model=m1",
      "wss://gw.example.test/ws?token=sk-abcdefghijklmnopqrstuvwxyz0123&client=desk",
      "http://127.0.0.1:8080/v1/chat?key=AbCd1234EfGh5678IjKl&stream=true",
    ].join("\n"),
    { counts, homeDirs: [HOME] },
  );
  assertClean(out, "urls");
  assert.match(out, /api\.example\.test\/v1\/models/);
  assert.match(out, /model=m1/);
  assert.match(out, /client=desk/);
  assert.match(out, /stream=true/);
  assert.ok(counts.urlCredential >= 1);
  assert.ok(counts.urlSecretParam >= 2);

  assert.equal(
    urlWithoutSecrets("https://a:b@h.example.test/v1?key=zzz&x=1"),
    "https://h.example.test/v1",
    "provider endpoints keep scheme, host and path only",
  );
  assert.equal(urlOrigin("https://a:b@h.example.test:8443/v1/path?key=zzz"), "https://h.example.test:8443");
});

test("keys in headers: auth, api-key and cookie headers lose their values", () => {
  const counts = emptyRedactionCounts();
  const out = redactText(
    [
      "Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz0123",
      "authorization: Basic aHVudGVyMi1wYXNzd29yZA==",
      "x-api-key: AbCd1234EfGh5678IjKl",
      "Cookie: sid=s3ss10n-c00kie-value; theme=dark",
      "Set-Cookie: sid=s3ss10n-c00kie-value; HttpOnly",
      'curl -H "Authorization: Bearer ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" https://h.example.test',
      "Content-Type: application/json",
    ].join("\n"),
    { counts },
  );
  assertClean(out, "headers");
  assert.ok(!out.includes("aHVudGVyMi1wYXNzd29yZA=="), out);
  assert.match(out, /Content-Type: application\/json/);
  assert.ok(counts.authHeader >= 2, JSON.stringify(counts));
  assert.ok(counts.cookie >= 1, JSON.stringify(counts));
});

test("keys in JSON: secret fields, header maps, env maps and content fields are dropped", () => {
  const counts = emptyRedactionCounts();
  const out = redactJson(
    {
      providers: [
        {
          name: "Fixture",
          apiKey: "sk-abcdefghijklmnopqrstuvwxyz0123",
          api_key: "AbCd1234EfGh5678IjKl",
          baseUrl: "https://user:hunter2-password@h.example.test/v1?key=q-param-secret-123",
          customHeaders: [{ key: "X-Api-Key", value: "AbCd1234EfGh5678IjKl" }],
          headers: { Authorization: "Bearer ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
          apiKeyConfigured: true,
          maxTokens: 4096,
        },
      ],
      mcp: { env: { GITHUB_TOKEN: "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", HOME } },
      session: {
        messages: [{ role: "user", content: "my password is hunter2-password" }],
        prompt: "summarise /Users/fixture-user/secret-plan.md",
        title: "contact fixture.person@example.com",
      },
      nested: { deeper: { password: "hunter2-password", cookie: "s3ss10n-c00kie-value" } },
      emptyKey: "",
    },
    { counts, homeDirs: [HOME] },
  );
  const text = JSON.stringify(out);
  assertClean(text, "json");
  // Structure that helps debugging stays.
  assert.equal(out.providers[0].name, "Fixture");
  assert.equal(out.providers[0].apiKeyConfigured, true);
  assert.equal(out.providers[0].maxTokens, 4096);
  assert.equal(out.providers[0].customHeaders[0].key, "X-Api-Key");
  assert.deepEqual(Object.keys(out.mcp.env), ["GITHUB_TOKEN", "HOME"]);
  assert.equal(out.emptyKey, "");
  assert.ok(counts.secretField >= 4, JSON.stringify(counts));
  assert.ok(counts.contentField >= 2, JSON.stringify(counts));
});

test("keys in logs: assignments, CLI flags, provider key shapes, JWTs and PEM blocks", () => {
  const counts = emptyRedactionCounts();
  const log = [
    "2026-01-01T00:00:00Z INFO start provider=fixture api_key=sk-abcdefghijklmnopqrstuvwxyz0123",
    "2026-01-01T00:00:01Z WARN retry token=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa attempt=2",
    "2026-01-01T00:00:02Z ERROR aws AKIAABCDEFGHIJKLMNOP denied",
    "2026-01-01T00:00:03Z DEBUG jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlLXZhbHVl",
    "cli --api-key AbCd1234EfGh5678IjKl --password=hunter2-password --verbose",
    '{"level":"error","apiKey":"sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX","msg":"bad key"}',
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "b3BlbnNzaC1rZXktdjEAAAAABG5vbmU",
    "-----END OPENSSH PRIVATE KEY-----",
    "commit 0123456789abcdef0123456789abcdef01234567 attempt=2",
  ].join("\n");
  const out = redactText(log, { counts });
  assertClean(out, "logs");
  assert.match(out, /attempt=2/);
  assert.match(out, /--verbose/);
  assert.match(out, /"msg":"bad key"/);
  // Git hashes are not secrets and stay readable.
  assert.match(out, /0123456789abcdef0123456789abcdef01234567/);
  assert.equal(counts.privateKey, 1);
  assert.ok(counts.jwt >= 1);
  assert.ok(counts.apiKey >= 1);
});

test("env dumps: every secret-looking variable is cleared, harmless ones stay", () => {
  const counts = emptyRedactionCounts();
  const env = [
    "OPENAI_API_KEY=sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX",
    "export GITHUB_TOKEN=\"ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"",
    "AWS_SECRET_ACCESS_KEY='AbCd1234EfGh5678IjKl'",
    "DB_PASSWORD=hunter2-password",
    "SESSION_ID=s3ss10n-c00kie-value",
    `HOME=${HOME}`,
    `PATH=${HOME}/bin:/usr/bin`,
    "LANG=en_US.UTF-8",
    "MAX_TOKENS=4096",
  ].join("\n");
  const out = redactText(env, { counts, homeDirs: [HOME] });
  assertClean(out, "env");
  assert.match(out, /HOME=~/);
  assert.match(out, /PATH=~\/bin:\/usr\/bin/);
  assert.match(out, /LANG=en_US\.UTF-8/);
  assert.ok(counts.secretAssignment >= 4, JSON.stringify(counts));
});

test("home paths fold to ~ in every spelling, including unknown users; emails are removed", () => {
  const counts = emptyRedactionCounts();
  const out = redactText(
    [
      `open ${HOME}/code/project/src/index.ts`,
      "linux /home/another-user/.config/app",
      "windows C:\\Users\\WinUser\\AppData\\Roaming\\app",
      "file:///Users/fixture-user/notes.txt",
      "mail fixture.person@example.com",
    ].join("\n"),
    { counts, homeDirs: [HOME] },
  );
  assertClean(out, "home");
  assert.ok(!out.includes("another-user"), out);
  assert.ok(!out.includes("WinUser"), out);
  assert.match(out, /~\/code\/project\/src\/index\.ts/);
  assert.ok(counts.homePath >= 4, JSON.stringify(counts));
  assert.equal(counts.email, 1);
});

test("redaction is idempotent and leaves ordinary text alone", () => {
  const once = redactText("Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz0123 at /Users/fixture-user", {
    homeDirs: [HOME],
  });
  const counts = emptyRedactionCounts();
  assert.equal(redactText(once, { counts, homeDirs: [HOME] }), once);
  assert.equal(totalRedactions(counts), 0);

  const plain = "Request failed: 503 Service Unavailable after 3 retries (model m1, 120 ms)";
  const plainCounts = emptyRedactionCounts();
  assert.equal(redactText(plain, { counts: plainCounts }), plain);
  assert.equal(totalRedactions(plainCounts), 0);
});
