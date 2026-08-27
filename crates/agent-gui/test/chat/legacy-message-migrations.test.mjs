import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

/**
 * 历史消息的加载期迁移。测的是真实事故的形状：mcp_call_tool 曾以 snake_case
 * 序列化 image 块的 MIME 字段（serde 的 enum 级 rename_all 不作用于变体字段），
 * 带着这种块的会话每次续聊都被 provider 拒掉
 * （"unsupported MIME type 'undefined'"）。
 */

const loader = createTsModuleLoader();
const { migrateLegacyMessages } = loader.loadModule(
  "src/lib/chat/history/legacyMessageMigrations.ts",
);

test("落库的 snake_case mime_type 被搬正为 mimeType", () => {
  // 与事故会话里 mcp_cua-driver_get_window_state 的结果同构。
  const messages = [
    {
      role: "toolResult",
      toolName: "mcp_cua-driver_get_window_state",
      content: [
        { type: "image", data: "aW1n", mime_type: "image/png" },
        { type: "text", text: "✅ Window state" },
      ],
    },
  ];

  const [migrated] = migrateLegacyMessages(messages);
  assert.deepEqual(migrated.content[0], { type: "image", data: "aW1n", mimeType: "image/png" });
  // 旧字段必须删掉——留着会在再次落库时把坏形状继续传下去。
  assert.equal("mime_type" in migrated.content[0], false);
  assert.deepEqual(migrated.content[1], { type: "text", text: "✅ Window state" });
});

test("已是 camelCase 的块原样返回，数组引用不变", () => {
  const messages = [
    {
      role: "toolResult",
      toolName: "mcp_x_shot",
      content: [{ type: "image", data: "aW1n", mimeType: "image/png" }],
    },
    { role: "user", content: "hi" },
  ];
  assert.equal(migrateLegacyMessages(messages), messages);
});

test("两个字段并存时以 mimeType 为准，不覆盖", () => {
  const messages = [
    {
      role: "toolResult",
      toolName: "t",
      content: [{ type: "image", data: "x", mimeType: "image/png", mime_type: "image/gif" }],
    },
  ];
  const [migrated] = migrateLegacyMessages(messages);
  assert.equal(migrated.content[0].mimeType, "image/png");
});

test("非 image 块与畸形输入不受影响", () => {
  const messages = [
    { role: "assistant", content: [{ type: "text", text: "a" }, null, 42] },
    { role: "user", content: "plain" },
    null,
  ];
  assert.equal(migrateLegacyMessages(messages), messages);
  assert.equal(migrateLegacyMessages(undefined), undefined);
  assert.equal(migrateLegacyMessages("nope"), "nope");
});
