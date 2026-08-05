import type { Tool } from "@earendil-works/pi-ai";

// 动态来源(MCP server / 插件 manifest)提供的是标准 JSON Schema,而 pi-ai 的
// Tool.parameters 形式上是 typebox TSchema——二者运行时同构(都是普通对象),
// 但类型不同,故必须 as 过界。危险不在类型转换本身,而在于未经校验的畸形值直接
// 送给 provider 会引发难以定位的 API 报错。本函数在过界前做一次轻量结构守卫:
// 保证是「非空、非数组、type 为 object(或缺省补上)」的对象,否则回退安全默认值。
export function normalizeToolParametersSchema(input: unknown, label: string): Tool["parameters"] {
  const fallback = { type: "object" as const };
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    if (input !== undefined && input !== null) {
      console.warn(
        `[tools] ${label} parameters is not a JSON Schema object; using {type:"object"}.`,
      );
    }
    return fallback as unknown as Tool["parameters"];
  }
  const obj = input as Record<string, unknown>;
  const type = obj.type;
  if (type !== undefined && type !== "object") {
    // 顶层不是 object 型 schema(如 array/string)——tool-calling 参数必须是对象。
    console.warn(
      `[tools] ${label} parameters has top-level type "${String(type)}"; coercing to object schema.`,
    );
    return { ...obj, type: "object" } as unknown as Tool["parameters"];
  }
  if (type === undefined) {
    // 缺 type 的对象补成 object schema,避免 provider 因缺字段报错。
    return { type: "object", ...obj } as unknown as Tool["parameters"];
  }
  return obj as unknown as Tool["parameters"];
}
