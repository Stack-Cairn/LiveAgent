import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";

const OPEN_TAG = "<think>";
const CLOSE_TAG = "</think>";
/** 正文恰好以 `<` 开头时不能无限等下去——超过这个长度就判定不是思考标签。 */
const MAX_PROBE_CHARS = 64;

type Mode = "probing" | "thinking" | "answer" | "passthrough";

function splitInlineThinkText(text: string) {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith(OPEN_TAG)) {
    return { thinking: "", answer: text, matched: false };
  }
  const rest = trimmed.slice(OPEN_TAG.length);
  const closeAt = rest.indexOf(CLOSE_TAG);
  if (closeAt < 0) return { thinking: rest, answer: "", matched: true };
  return {
    thinking: rest.slice(0, closeAt),
    answer: rest.slice(closeAt + CLOSE_TAG.length).trimStart(),
    matched: true,
  };
}

function rewriteContent(content: AssistantMessage["content"]): AssistantMessage["content"] {
  const head = content[0];
  if (head?.type !== "text") return content;
  const split = splitInlineThinkText(head.text);
  if (!split.matched) return content;
  // 思考块无条件保留（哪怕为空），否则事件流里的 contentIndex 位移会和最终消息
  // 的数组下标对不上，后续工具调用会被错位读取。
  const rewritten: AssistantMessage["content"] = [{ type: "thinking", thinking: split.thinking }];
  if (split.answer.length > 0) rewritten.push({ ...head, text: split.answer });
  return [...rewritten, ...content.slice(1)];
}

function rewriteMessage(message: AssistantMessage): AssistantMessage {
  const content = rewriteContent(message.content);
  return content === message.content ? message : { ...message, content };
}

/** 末尾最长的、构成 `tag` 前缀的子串长度——用于跨 chunk 切分的闭合标签。 */
function partialTagSuffixLength(buffer: string, tag: string) {
  const max = Math.min(buffer.length, tag.length - 1);
  for (let length = max; length > 0; length -= 1) {
    if (buffer.endsWith(tag.slice(0, length))) return length;
  }
  return 0;
}

/**
 * Ollama 的 OpenAI 兼容端点会把推理模型的思考过程以字面量 `<think>...</think>`
 * 内联在 `content` 里，而不是走 `reasoning_content` 字段。这里在事件流层把它拆成
 * 独立的 thinking 块，让上层拿到和原生推理供应商一致的事件序列。
 *
 * 只有源 contentIndex 0 的文本块开头（允许前导空白）才参与识别；原生推理供应商的
 * 0 号块是 thinking，天然不会命中。
 */
export function wrapInlineThinkTagStream(
  source: AssistantMessageEventStream,
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();

  let mode: Mode = "probing";
  let headBuffer = "";
  let carry = "";
  let thinkingText = "";
  let answerText = "";
  let answerBlockCreated = false;
  let thinkingEnded = false;
  let headSettled = false;
  let headTextStartSeen = false;

  const shiftIndex = (index: number) => (index >= 1 && answerBlockCreated ? index + 1 : index);

  const pushThinkingDelta = (delta: string, partial: AssistantMessage) => {
    if (!delta) return;
    thinkingText += delta;
    output.push({
      type: "thinking_delta",
      contentIndex: 0,
      delta,
      partial: rewriteMessage(partial),
    });
  };

  const endThinking = (partial: AssistantMessage) => {
    if (thinkingEnded) return;
    thinkingEnded = true;
    output.push({
      type: "thinking_end",
      contentIndex: 0,
      content: thinkingText,
      partial: rewriteMessage(partial),
    });
  };

  const pushAnswer = (chunk: string, partial: AssistantMessage) => {
    let text = chunk;
    if (!answerBlockCreated) {
      // `</think>` 与正文之间的换行不属于回答内容。
      text = text.replace(/^\s+/, "");
      if (!text) return;
      answerBlockCreated = true;
      output.push({ type: "text_start", contentIndex: 1, partial: rewriteMessage(partial) });
    }
    if (!text) return;
    answerText += text;
    output.push({
      type: "text_delta",
      contentIndex: 1,
      delta: text,
      partial: rewriteMessage(partial),
    });
  };

  const feedThinking = (chunk: string, partial: AssistantMessage) => {
    const buffer = carry + chunk;
    carry = "";
    const closeAt = buffer.indexOf(CLOSE_TAG);
    if (closeAt >= 0) {
      pushThinkingDelta(buffer.slice(0, closeAt), partial);
      endThinking(partial);
      mode = "answer";
      pushAnswer(buffer.slice(closeAt + CLOSE_TAG.length), partial);
      return;
    }
    const hold = partialTagSuffixLength(buffer, CLOSE_TAG);
    carry = hold > 0 ? buffer.slice(buffer.length - hold) : "";
    pushThinkingDelta(buffer.slice(0, buffer.length - hold), partial);
  };

  const rejectProbe = (partial: AssistantMessage) => {
    mode = "passthrough";
    // 只补发源真的发过的 text_start，否则透传就不再是恒等的了。
    if (headTextStartSeen) {
      output.push({ type: "text_start", contentIndex: 0, partial: rewriteMessage(partial) });
    }
    if (headBuffer) {
      output.push({
        type: "text_delta",
        contentIndex: 0,
        delta: headBuffer,
        partial: rewriteMessage(partial),
      });
    }
    headBuffer = "";
  };

  const feedProbe = (chunk: string, partial: AssistantMessage) => {
    headBuffer += chunk;
    const trimmed = headBuffer.trimStart();
    if (trimmed.startsWith(OPEN_TAG)) {
      mode = "thinking";
      headBuffer = "";
      output.push({ type: "thinking_start", contentIndex: 0, partial: rewriteMessage(partial) });
      feedThinking(trimmed.slice(OPEN_TAG.length), partial);
      return;
    }
    if (OPEN_TAG.startsWith(trimmed) && headBuffer.length <= MAX_PROBE_CHARS) return;
    rejectProbe(partial);
  };

  /** 用完整文本做权威对账，补齐流式期间因缓冲而未发出的尾巴。 */
  const settleHead = (content: string, partial: AssistantMessage) => {
    if (headSettled || mode === "passthrough") return;
    headSettled = true;
    const split = splitInlineThinkText(content);

    if (!split.matched) {
      headBuffer = content;
      rejectProbe(partial);
      output.push({
        type: "text_end",
        contentIndex: 0,
        content,
        partial: rewriteMessage(partial),
      });
      return;
    }

    if (mode === "probing") {
      mode = "thinking";
      headBuffer = "";
      output.push({ type: "thinking_start", contentIndex: 0, partial: rewriteMessage(partial) });
    }
    carry = "";
    if (split.thinking.length > thinkingText.length) {
      pushThinkingDelta(split.thinking.slice(thinkingText.length), partial);
    }
    endThinking(partial);
    mode = "answer";
    if (split.answer.length > answerText.length) {
      pushAnswer(split.answer.slice(answerText.length), partial);
    }
    if (answerBlockCreated) {
      output.push({
        type: "text_end",
        contentIndex: 1,
        content: answerText,
        partial: rewriteMessage(partial),
      });
    }
  };

  const flushResidue = (message: AssistantMessage) => {
    if (headSettled || mode === "passthrough") return;
    const head = message.content[0];
    if (head?.type === "text") {
      settleHead(head.text, message);
      return;
    }
    // 中断得太早，最终消息里连 0 号文本块都没有。
    headSettled = true;
    if (mode === "probing") {
      if (headBuffer) rejectProbe(message);
      return;
    }
    pushThinkingDelta(carry, message);
    carry = "";
    endThinking(message);
  };

  void (async () => {
    for await (const event of source) {
      if (mode === "passthrough") {
        output.push(event);
        if (event.type === "done" || event.type === "error") return;
        continue;
      }

      switch (event.type) {
        case "start":
          output.push(event);
          break;
        case "text_start":
          // 0 号块暂扣：还不知道它会变成 thinking_start 还是普通正文。
          if (event.contentIndex === 0) {
            headTextStartSeen = true;
            break;
          }
          output.push({
            type: "text_start",
            contentIndex: shiftIndex(event.contentIndex),
            partial: rewriteMessage(event.partial),
          });
          break;
        case "text_delta":
          if (event.contentIndex === 0) {
            if (mode === "probing") feedProbe(event.delta, event.partial);
            else if (mode === "thinking") feedThinking(event.delta, event.partial);
            else pushAnswer(event.delta, event.partial);
            break;
          }
          output.push({
            type: "text_delta",
            contentIndex: shiftIndex(event.contentIndex),
            delta: event.delta,
            partial: rewriteMessage(event.partial),
          });
          break;
        case "text_end":
          if (event.contentIndex === 0) {
            settleHead(event.content, event.partial);
            break;
          }
          output.push({
            type: "text_end",
            contentIndex: shiftIndex(event.contentIndex),
            content: event.content,
            partial: rewriteMessage(event.partial),
          });
          break;
        // 0 号块已经是原生思考块，说明供应商走的是 reasoning_content，直接放行。
        case "thinking_start":
          if (mode === "probing" && event.contentIndex === 0) {
            mode = "passthrough";
            output.push(event);
            break;
          }
          output.push({
            type: "thinking_start",
            contentIndex: shiftIndex(event.contentIndex),
            partial: rewriteMessage(event.partial),
          });
          break;
        case "thinking_delta":
          if (mode === "probing" && event.contentIndex === 0) {
            mode = "passthrough";
            output.push(event);
            break;
          }
          output.push({
            type: "thinking_delta",
            contentIndex: shiftIndex(event.contentIndex),
            delta: event.delta,
            partial: rewriteMessage(event.partial),
          });
          break;
        case "thinking_end":
          if (mode === "probing" && event.contentIndex === 0) {
            mode = "passthrough";
            output.push(event);
            break;
          }
          output.push({
            type: "thinking_end",
            contentIndex: shiftIndex(event.contentIndex),
            content: event.content,
            partial: rewriteMessage(event.partial),
          });
          break;
        case "toolcall_start":
          output.push({
            type: "toolcall_start",
            contentIndex: shiftIndex(event.contentIndex),
            partial: rewriteMessage(event.partial),
          });
          break;
        case "toolcall_delta":
          output.push({
            type: "toolcall_delta",
            contentIndex: shiftIndex(event.contentIndex),
            delta: event.delta,
            partial: rewriteMessage(event.partial),
          });
          break;
        case "toolcall_end":
          output.push({
            type: "toolcall_end",
            contentIndex: shiftIndex(event.contentIndex),
            toolCall: event.toolCall,
            partial: rewriteMessage(event.partial),
          });
          break;
        case "done":
          flushResidue(event.message);
          output.push({
            type: "done",
            reason: event.reason,
            message: rewriteMessage(event.message),
          });
          return;
        case "error":
          flushResidue(event.error);
          output.push({ type: "error", reason: event.reason, error: rewriteMessage(event.error) });
          return;
      }
    }

    const settled = await source.result();
    flushResidue(settled);
    output.end(rewriteMessage(settled));
  })();

  return output;
}
