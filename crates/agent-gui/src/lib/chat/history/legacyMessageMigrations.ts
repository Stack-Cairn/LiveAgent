/**
 * 历史消息的加载期迁移：修复旧版本写坏、已经落库的数据。
 *
 * 目前只有一条。`mcp_call_tool` 曾把 image 块的 MIME 字段以 snake_case
 * （`mime_type`）序列化——serde 的 enum 级 `rename_all` 只重命名变体名、
 * 不作用于变体字段，Rust 侧已修。但带着这种块的会话已经进了历史库：
 * pi-ai 读 `mimeType` 拿到 undefined，拼出 `data:undefined;base64,…`，
 * 续聊时整个 provider 请求被拒；UI 预览同样渲染不出来。源头修复管不到
 * 存量数据，所以在历史解析时把字段搬正，读到即修。
 *
 * 刻意做成通用的「消息树里所有 image 块」而不只限 toolResult：坏块跟着
 * 消息走（压缩、复制到新会话），出现在哪都该修。
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function migrateImageBlock(block: unknown): unknown {
  if (!isRecord(block) || block.type !== "image") return block;
  if (typeof block.mimeType === "string" || typeof block.mime_type !== "string") return block;
  const { mime_type, ...rest } = block;
  return { ...rest, mimeType: mime_type };
}

function migrateMessage(message: unknown): unknown {
  if (!isRecord(message) || !Array.isArray(message.content)) return message;
  let changed = false;
  const content = message.content.map((block) => {
    const migrated = migrateImageBlock(block);
    if (migrated !== block) changed = true;
    return migrated;
  });
  return changed ? { ...message, content } : message;
}

/** 对解析出的消息数组做全部迁移；没有可修的就原样返回（不重新分配）。 */
export function migrateLegacyMessages(messages: unknown): unknown {
  if (!Array.isArray(messages)) return messages;
  let changed = false;
  const migrated = messages.map((message) => {
    const next = migrateMessage(message);
    if (next !== message) changed = true;
    return next;
  });
  return changed ? migrated : messages;
}
