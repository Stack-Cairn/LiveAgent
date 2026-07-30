import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { normalizeToolParametersSchema } = loader.loadModule("src/lib/tools/toolSchema.ts");

test("合法 object schema 原样返回", () => {
  const schema = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
  assert.deepEqual(normalizeToolParametersSchema(schema, "x"), schema);
});

test("缺 type 的对象补成 object schema", () => {
  const out = normalizeToolParametersSchema({ properties: { a: {} } }, "x");
  assert.equal(out.type, "object");
  assert.deepEqual(out.properties, { a: {} });
});

test("顶层 type 非 object 被矫正为 object", () => {
  const out = normalizeToolParametersSchema({ type: "array", items: {} }, "x");
  assert.equal(out.type, "object");
});

test("非对象/数组/undefined 一律回退安全默认值", () => {
  assert.deepEqual(normalizeToolParametersSchema(undefined, "x"), { type: "object" });
  assert.deepEqual(normalizeToolParametersSchema(null, "x"), { type: "object" });
  assert.deepEqual(normalizeToolParametersSchema("nope", "x"), { type: "object" });
  assert.deepEqual(normalizeToolParametersSchema([1, 2], "x"), { type: "object" });
});
