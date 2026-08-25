import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { formatCuaError, formatUnknownCuaError, normalizeCuaError } = loader.loadModule(
  "@liveagent/ui/lib/cua/formatCuaError.ts",
);
const { t, DEFAULT_LOCALE } = loader.loadModule("@liveagent/app/i18n/config");

test("formatCuaError: en-US locale renders disabled message in English", () => {
  const payload = {
    kind: "cua.errors.disabled",
    message: "CUA is not enabled.",
    params: null,
  };
  const out = formatCuaError(payload, t, "en-US");
  assert.ok(out.includes("CUA is not enabled"));
  assert.ok(!out.includes("CUA 未启用"), `unexpected Chinese leak: ${out}`);
});

test("formatCuaError: zh-CN locale renders disabled message in Chinese", () => {
  const payload = {
    kind: "cua.errors.disabled",
    message: "CUA is not enabled.",
    params: null,
  };
  const out = formatCuaError(payload, t, "zh-CN");
  assert.ok(out.includes("CUA 未启用"));
  assert.ok(!out.startsWith("CUA is not enabled"));
});

test("formatCuaError: deniedByAllowlist interpolates target + allowed list", () => {
  const payload = {
    kind: "cua.errors.deniedByAllowlist",
    message: "denied",
    params: { target: "Safari", allowed: ["Finder"] },
  };
  const en = formatCuaError(payload, t, "en-US");
  const zh = formatCuaError(payload, t, "zh-CN");
  assert.match(en, /Safari/);
  assert.match(en, /Finder/);
  assert.doesNotMatch(en, /\{allowed\}/);
  assert.match(zh, /Safari/);
  assert.match(zh, /Finder/);
});

test("formatCuaError: missing kind falls back to English message", () => {
  const payload = {
    kind: "cua.errors.does.not.exist",
    message: "English fallback",
    params: null,
  };
  const out = formatCuaError(payload, t, "zh-CN");
  assert.equal(out, "English fallback");
});

test("normalizeCuaError: recognizes IPC error JSON thrown by Rust", () => {
  const rawError = new Error(
    JSON.stringify({
      kind: "cua.errors.disabled",
      message: "CUA is not enabled.",
      params: null,
    }),
  );
  const parsed = normalizeCuaError(rawError);
  assert.ok(parsed);
  assert.equal(parsed.kind, "cua.errors.disabled");
});

test("normalizeCuaError: returns null for unrelated messages", () => {
  const parsed = normalizeCuaError(new Error("boom"));
  assert.equal(parsed, null);
});

test("formatUnknownCuaError: en-US renders structured error translated", () => {
  const input = new Error(
    JSON.stringify({
      kind: "cua.errors.disabled",
      message: "fallback",
      params: null,
    }),
  );
  const out = formatUnknownCuaError(input, t, "en-US");
  assert.ok(out.includes("CUA is not enabled"));
});

test("DEFAULT_LOCALE is one of the supported locales", () => {
  assert.ok(DEFAULT_LOCALE === "en-US" || DEFAULT_LOCALE === "zh-CN");
});
