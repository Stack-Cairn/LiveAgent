import type { CompactionPayload, SerializedGenericCompactionMessage } from "./payload";

// 只需要判断"摘要该用什么语言"，扫最近的用户输入即可，无需全量统计。
const MAX_SCANNED_CHARS = 4_000;
// CJK 字符占字母类字符的比例达到该阈值即认为会话以 CJK 语言为主。
// 中英夹杂的技术对话里大量标识符是英文，阈值不宜过高。
const CJK_DOMINANCE_THRESHOLD = 0.25;
// 样本过小时不做判断，维持默认（英文）摘要。
const MIN_SCANNED_LETTERS = 8;

type ScriptCounts = {
  han: number;
  kana: number;
  hangul: number;
  latin: number;
};

function tallyScripts(text: string, counts: ScriptCounts) {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if ((code >= 0x3400 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff)) {
      counts.han += 1;
    } else if (code >= 0x3040 && code <= 0x30ff) {
      counts.kana += 1;
    } else if (
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0x1100 && code <= 0x11ff) ||
      (code >= 0x3130 && code <= 0x318f)
    ) {
      counts.hangul += 1;
    } else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) {
      counts.latin += 1;
    }
  }
}

function collectRecentUserTexts(payload: CompactionPayload): string[] {
  const texts: string[] = [];
  let scannedChars = 0;
  const push = (text: string | undefined) => {
    if (!text || scannedChars >= MAX_SCANNED_CHARS) return;
    const slice = text.slice(0, MAX_SCANNED_CHARS - scannedChars);
    scannedChars += slice.length;
    texts.push(slice);
  };

  push(payload.next_user_message);
  const messages = payload.active_segment_messages;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (scannedChars >= MAX_SCANNED_CHARS) break;
    const message = messages[index];
    if (message.role !== "user") continue;
    push((message as SerializedGenericCompactionMessage).content);
  }
  return texts;
}

/**
 * 从压缩 payload 的用户消息推断摘要语言。返回英文语言名（如 "Chinese"），
 * 供 buildCompactionSystemPrompt 生成语言指令；返回 undefined 表示维持
 * 默认的英文摘要（西文会话或样本不足）。
 */
export function detectCompactionSummaryLanguage(payload: CompactionPayload): string | undefined {
  const counts: ScriptCounts = { han: 0, kana: 0, hangul: 0, latin: 0 };
  for (const text of collectRecentUserTexts(payload)) {
    tallyScripts(text, counts);
  }

  const cjk = counts.han + counts.kana + counts.hangul;
  const letters = cjk + counts.latin;
  if (letters < MIN_SCANNED_LETTERS || cjk / letters < CJK_DOMINANCE_THRESHOLD) {
    return undefined;
  }
  // 日文正文必然混入假名；中文没有假名。谚文占比过半视为韩文。
  if (counts.kana > 0 && counts.kana * 20 >= cjk) return "Japanese";
  if (counts.hangul * 2 >= cjk) return "Korean";
  return "Chinese";
}
