// The access token is a secret: it is typed into a masked single-line field,
// Enter submits the form, and every message is translated plain language.
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import * as jsxRuntime from "react/jsx-runtime";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const icon = () => null;
const loader = createWebModuleLoader({
  rootDir,
  mocks: {
    "react/jsx-runtime": jsxRuntime,
    "@liveagent/ui/components/IconSet": new Proxy({}, { get: () => icon }),
  },
});
const { LoginPage } = loader.loadModule("src/pages/LoginPage.tsx");
const auth = loader.loadModule("src/lib/gatewayAuth.ts");
const { WEBUI_TRANSLATION_OVERRIDES } = loader.loadModule("src/i18n/config.ts");

function render(props = {}) {
  return renderToStaticMarkup(
    jsxRuntime.jsx(LoginPage, {
      token: "",
      error: null,
      isSubmitting: false,
      onTokenChange() {},
      onSubmit() {},
      ...props,
    }),
  );
}

test("the token field is a masked input inside a submitting form", () => {
  const html = render({ token: "secret" });
  assert.match(html, /<form[^>]*>/);
  assert.match(html, /<input[^>]*id="access-token"[^>]*type="password"/);
  assert.doesNotMatch(html, /<textarea/);
  assert.match(html, /<button[^>]*type="submit"/);
  assert.match(html, /aria-pressed="false"/);
});

test("auth errors are translation keys rendered as text, not hard-coded Chinese", async () => {
  await assert.rejects(auth.verifyGatewayAccessToken("  \n"), {
    message: auth.GATEWAY_AUTH_ERROR_KEYS.required,
  });
  const html = render({ error: auth.GATEWAY_AUTH_ERROR_KEYS.unauthorized });
  assert.doesNotMatch(html, /login\.errorTokenInvalid/);
  assert.match(html, /role="alert"/);
  for (const locale of ["en-US", "zh-CN"]) {
    for (const key of Object.values(auth.GATEWAY_AUTH_ERROR_KEYS)) {
      assert.ok(WEBUI_TRANSLATION_OVERRIDES[locale][key], `${locale} ${key}`);
    }
  }
});

test("login copy avoids protocol jargon", () => {
  for (const locale of ["en-US", "zh-CN"]) {
    const messages = WEBUI_TRANSLATION_OVERRIDES[locale];
    const copy = Object.entries(messages)
      .filter(([key]) => key.startsWith("login."))
      .map(([, value]) => value)
      .join("\n");
    assert.doesNotMatch(copy, /tool_call|tool_result|raw JSON|原始 JSON/);
    assert.ok(messages["login.tokenLabel"] && messages["login.showToken"]);
  }
});

test("a pasted token is stored trimmed", () => {
  const storage = new Map();
  const previous = globalThis.window;
  globalThis.window = { localStorage: { setItem: (k, v) => storage.set(k, v) } };
  try {
    const { saveToken } = loader.loadModule("src/lib/storage.ts");
    saveToken("abc123\n");
    assert.deepEqual([...storage.values()], ["abc123"]);
  } finally {
    globalThis.window = previous;
  }
});
