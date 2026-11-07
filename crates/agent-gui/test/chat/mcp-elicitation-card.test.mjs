import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// MCP form elicitation card (Stack-Cairn/K-brain#174): the pending form with every field
// type and its constraints, the resolved summary, and the client-side validation that
// mirrors K-brain's.

const rootDir = fileURLToPath(new URL("../..", import.meta.url));
const requireFromRoot = createRequire(path.join(rootDir, "package.json"));
const jsxRuntime = requireFromRoot("react/jsx-runtime");
const { renderToStaticMarkup } = requireFromRoot("react-dom/server");

function NullIcon() {
  return null;
}

const loader = createTsModuleLoader({
  rootDir,
  mocks: {
    "react/jsx-runtime": jsxRuntime,
    "@liveagent/ui/i18n/index": { useLocale: () => ({ t: (key) => key }) },
    "@liveagent/ui/components/IconSet": new Proxy({}, { get: () => NullIcon }),
  },
});
const card = loader.loadModule("@liveagent/ui/components/chat/McpElicitationCard.tsx");
const shared = loader.loadModule("@liveagent/ui/lib/chat/mcpElicitation.ts");

const request = shared.parseMcpElicitationRequest({
  elicitation_id: "el-1",
  tool_call_id: "call-1",
  run_id: "run-1",
  deadline_at: Date.now() + 120_000,
  server: "deploy <b>prod</b>",
  tool: "ship",
  message: "Confirm the release\n<script>alert(1)</script>",
  fields: [
    { name: "name", type: "string", title: "Release name", description: "Shown in the changelog", required: true, min_length: 2, max_length: 40, default: "v2" },
    { name: "token", type: "string", title: "API token", required: true, sensitive: true },
    { name: "email", type: "string", format: "email" },
    { name: "code", type: "string", pattern: "^[A-Z]{3}$" },
    { name: "replicas", type: "integer", minimum: 1, maximum: 9, default: 3 },
    { name: "notify", type: "boolean", default: true },
    { name: "env", type: "string", options: [{ value: "prod", label: "Production" }, { value: "stage", label: "Staging" }], default: "stage" },
    { name: "regions", type: "array", options: [{ value: "eu", label: "Europe" }, { value: "us", label: "US" }, { value: "ap", label: "Asia" }], min_items: 1, max_items: 2 },
  ],
});

function render(element) {
  return renderToStaticMarkup(element);
}

test("pending form shows the server, the message as text and every field with its constraints", () => {
  assert.ok(request);
  const html = render(jsxRuntime.jsx(card.McpElicitationForm, { request, interactive: true, onSubmit: async () => ({ ok: true }) }));
  // Server name first and prominent; server-supplied text is escaped, never markup.
  assert.match(html, /data-mcp-elicitation-server="[^"]*"[^>]*>deploy &lt;b&gt;prod&lt;\/b&gt;</);
  assert.ok(html.indexOf("data-mcp-elicitation-server") < html.indexOf("Confirm the release"));
  assert.equal(html.includes("<script>"), false);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  // Sensitive field: masked input, badge, reveal toggle and the trust warning.
  assert.match(html, /<input[^>]*type="password"[^>]*data-mcp-elicitation-sensitive="true"|<input[^>]*data-mcp-elicitation-sensitive="true"[^>]*type="password"/);
  assert.match(html, /chat\.mcpElicitation\.sensitiveBadge/);
  assert.match(html, /chat\.mcpElicitation\.showValue/);
  assert.match(html, /role="note"[^>]*>[\s\S]*chat\.mcpElicitation\.sensitiveWarning/);
  // Labels, required markers, descriptions, hints and defaults.
  for (const label of ["Release name", "API token", "email", "code", "replicas", "notify", "env", "regions", "Shown in the changelog"]) {
    assert.ok(html.includes(label), `missing ${label}`);
  }
  assert.equal((html.match(/chat\.mcpElicitation\.required/g) ?? []).length >= 2, true);
  for (const hint of ["lengthRange", "email", "pattern", "integer", "range", "itemsRange"]) {
    assert.ok(html.includes(`chat.mcpElicitation.hint.${hint}`), `missing hint ${hint}`);
  }
  assert.match(html, /value="v2"/);
  assert.match(html, /value="3"/);
  assert.match(html, /<input[^>]*type="email"/);
  // Single choice (radio), multi choice (checkbox) and boolean (yes/no).
  for (const option of ["Production", "Staging", "Europe", "US", "Asia", "chat.mcpElicitation.yes", "chat.mcpElicitation.no"]) {
    assert.ok(html.includes(option), `missing option ${option}`);
  }
  assert.match(html, /role="radio"[^>]*aria-checked="true"[^>]*>[\s\S]*?Staging|aria-checked="true"[^>]*role="radio"[^>]*>[\s\S]*?Staging/);
  assert.match(html, /role="checkbox"/);
  // Buttons and the deadline countdown.
  for (const action of ["submit", "decline", "cancel", "countdown"]) {
    assert.ok(html.includes(`chat.mcpElicitation.${action}`), `missing ${action}`);
  }
});

test("a form this side cannot answer shows no live controls", () => {
  const html = render(jsxRuntime.jsx(card.McpElicitationForm, { request, interactive: false, onSubmit: async () => ({ ok: true }) }));
  assert.match(html, /chat\.mcpElicitation\.serverLabel/);
  assert.equal(/<button[^>]*type="submit"(?![^>]*disabled)/.test(html), false);
});

test("resolved summaries: accepted values with redaction, declined, cancelled, timed out, auto-declined", () => {
  const accepted = shared.parseMcpElicitationRecord({
    elicitation_id: "el-1", server: "deploy", message: "Confirm the release", fields: request.fields.map((field) => ({ ...field, min_length: field.minLength })),
    action: "accept", reason: "user", content: { name: "v2", token: "leaked-secret", regions: ["eu", "us"], notify: false }, redacted: ["token"],
  });
  // A sensitive value that slipped through is dropped and shown as redacted.
  assert.equal("token" in accepted.content, false);
  const html = render(jsxRuntime.jsx(card.McpElicitationSummary, { record: accepted }));
  assert.match(html, /data-mcp-elicitation-summary="accepted"/);
  assert.match(html, /chat\.mcpElicitation\.outcome\.accepted/);
  assert.match(html, /Release name/);
  assert.match(html, /chat\.mcpElicitation\.redacted/);
  assert.match(html, /Europe, US|Europe/);
  assert.equal(html.includes("leaked-secret"), false);

  for (const [action, reason, outcome] of [["decline", "user", "declined"], ["cancel", "user", "cancelled"], ["cancel", "timeout", "timedOut"]]) {
    const record = shared.parseMcpElicitationRecord({ elicitation_id: `el-${outcome}`, server: "deploy", message: "Confirm", action, reason });
    const summary = render(jsxRuntime.jsx(card.McpElicitationSummary, { record }));
    assert.match(summary, new RegExp(`data-mcp-elicitation-summary="${outcome}"`));
  }
  const auto = shared.parseMcpElicitationRecord({ server: "deploy", message: "Confirm", action: "decline", reason: "no_client" });
  const note = render(jsxRuntime.jsx(card.McpElicitationSummary, { record: auto }));
  assert.match(note, /data-mcp-elicitation-note="no_client"/);
  assert.match(note, /chat\.mcpElicitation\.auto\.no_client/);
  assert.equal(note.includes("data-mcp-elicitation-summary"), false);
});

test("client validation mirrors K-brain and builds typed content", () => {
  const fields = request.fields;
  const draft = shared.initialMcpElicitationDraft(fields);
  assert.equal(draft.name, "v2");
  assert.equal(draft.replicas, "3");
  assert.equal(draft.notify, true);
  assert.equal(draft.env, "stage");

  const missing = shared.buildMcpElicitationContent(fields, draft);
  assert.equal(missing.ok, false);
  assert.equal(missing.issues.token.key, "chat.mcpElicitation.error.required");
  // An optional field left empty is absent, so its own limits do not apply.
  assert.equal(missing.issues.regions, undefined);

  const bad = shared.buildMcpElicitationContent(fields, {
    ...draft, name: "x", token: "t", email: "not-an-email", code: "abc", replicas: "12", regions: ["eu", "us", "ap"],
  });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.issues.name, { key: "chat.mcpElicitation.error.minLength", values: { count: 2 } });
  assert.equal(bad.issues.email.key, "chat.mcpElicitation.error.email");
  assert.equal(bad.issues.code.key, "chat.mcpElicitation.error.pattern");
  assert.deepEqual(bad.issues.replicas, { key: "chat.mcpElicitation.error.maximum", values: { value: "9" } });
  assert.deepEqual(bad.issues.regions, { key: "chat.mcpElicitation.error.maxItems", values: { count: 2 } });
  assert.equal(shared.validateMcpElicitationField(fields[4], "2.5").key, "chat.mcpElicitation.error.integer");
  assert.equal(shared.validateMcpElicitationField(fields[6], "dev").key, "chat.mcpElicitation.error.choice");
  assert.equal(shared.validateMcpElicitationField({ name: "d", type: "string", format: "date" }, "2026-02-30").key, "chat.mcpElicitation.error.date");
  // Multi-byte characters count as one, as in Go.
  assert.equal(shared.validateMcpElicitationField({ name: "n", type: "string", maxLength: 2 }, "日本"), null);

  const good = shared.buildMcpElicitationContent(fields, {
    ...draft, token: "s3cret", email: "", code: "ABC", replicas: "4", regions: ["us", "eu"],
  });
  assert.equal(good.ok, true);
  // Empty optional fields are left out, numbers are numbers, choices in option order.
  assert.deepEqual(good.content, { name: "v2", token: "s3cret", code: "ABC", replicas: 4, notify: true, env: "stage", regions: ["eu", "us"] });
});

test("synthetic elicitation keys are stripped from model arguments and hidden from display", () => {
  const approval = loader.loadModule("@liveagent/ui/lib/chat/toolApprovalArgs.ts");
  for (const key of ["__mcpElicitationPending", "__mcpElicitations"]) {
    assert.ok(approval.TOOL_APPROVAL_SYNTHETIC_ARG_KEYS.includes(key), `${key} is not stripped from model arguments`);
  }
  const ui = loader.loadModule("@liveagent/ui/lib/chat/uiMessages.ts");
  const display = ui.toolCallArgsForDisplay({ id: "c", name: "mcp__deploy__ship", arguments: { path: "a", __mcpElicitationPending: [{}], __mcpElicitations: [{}] } });
  assert.deepEqual(display, { path: "a" });
  const entries = shared.collectMcpElicitationEntries({
    args: { __mcpElicitationPending: [{ elicitation_id: "el-2", tool_call_id: "call-1", server: "s", message: "m", fields: [] }], __mcpElicitations: [{ elicitation_id: "el-1", server: "s", message: "m", action: "decline", reason: "user" }] },
    details: { kbrainElicitations: [{ elicitation_id: "el-1", server: "s", message: "m", action: "decline", reason: "user" }] },
  });
  // The recorded copy wins over the live one; pending forms come last.
  assert.deepEqual(entries.map((entry) => entry.kind), ["record", "pending"]);
  assert.equal(shared.hasPendingMcpElicitation({ __mcpElicitationPending: [{ elicitation_id: "x", tool_call_id: "c", fields: [] }] }), true);
});
