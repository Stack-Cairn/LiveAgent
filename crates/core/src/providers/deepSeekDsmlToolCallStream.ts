import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  ToolCall,
} from "@earendil-works/pi-ai";
import { parseDsmlToolCallMarkup } from "../chat/runner/deepSeekDsml";
import {
  comparableToolCall,
  findFlattenedToolRequestOpenStart,
  findMalformedLabeledFlattenedToolRequestEndAtStart,
  findPotentialFlattenedToolRequestOpenStart,
  type ParsedFlattenedToolRequest,
  parseFlattenedToolRequestAtStart,
} from "../chat/runner/flattenedToolCallText";

const DSML_TAG_PREFIX = String.raw`(?:\uFF5C{2}|\|{2})\s*DSML\s*(?:\uFF5C{2}|\|{2})`;
const DSML_TOOL_CALLS_OPEN_PATTERN = new RegExp(
  String.raw`<\s*${DSML_TAG_PREFIX}\s*tool_calls\s*>`,
  "i",
);
const DSML_TOOL_CALLS_CLOSE_PATTERN = new RegExp(
  String.raw`<\/\s*${DSML_TAG_PREFIX}\s*tool_calls\s*>`,
  "i",
);
const DSML_CLOSE_TAG_SCAN_PATTERN = new RegExp(
  String.raw`<\/\s*${DSML_TAG_PREFIX}\s*(?:parameter|invoke|tool_calls)\s*>`,
  "gi",
);
const DSML_CLOSE_TAG_AT_START_PATTERN = new RegExp(
  String.raw`^<\/\s*${DSML_TAG_PREFIX}\s*(?:parameter|invoke|tool_calls)\s*>`,
  "i",
);
const DSML_OPEN_HOLD_LIMIT = 96;
const DSML_SWALLOW_BUFFER_LIMIT = 64 * 1024;
const FLATTENED_TOOL_REQUEST_SWALLOW_BUFFER_LIMIT = 64 * 1024;

let deepSeekDsmlRepairStreamSequence = 0;

type IndexedAssistantEvent = Extract<AssistantMessageEvent, { contentIndex: number }>;

function cloneBlock<T>(block: T): T {
  if (!block || typeof block !== "object") return block;
  return { ...(block as Record<string, unknown>) } as T;
}

function snapshotAssistant(message: AssistantMessage): AssistantMessage {
  return {
    ...message,
    content: message.content.map(cloneBlock),
  };
}

function isTerminalEvent(event: AssistantMessageEvent) {
  return event.type === "done" || event.type === "error";
}

function terminalMessage(event: AssistantMessageEvent) {
  if (event.type === "done") return event.message;
  if (event.type === "error") return event.error;
  return null;
}

function createFallbackAssistant(message?: AssistantMessage): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: message?.api ?? "anthropic-messages",
    provider: message?.provider ?? "anthropic",
    model: message?.model ?? "unknown",
    usage: message?.usage ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: message?.stopReason ?? "stop",
    timestamp: message?.timestamp ?? Date.now(),
  };
}

function findPattern(pattern: RegExp, value: string) {
  const match = pattern.exec(value);
  if (!match || match.index === undefined) return null;
  return {
    index: match.index,
    text: match[0],
  };
}

function findPotentialDsmlOpenStart(value: string) {
  const index = value.lastIndexOf("<");
  if (index < 0) return -1;
  return value.length - index <= DSML_OPEN_HOLD_LIMIT ? index : -1;
}

function findPotentialDsmlOrphanCloseStart(value: string) {
  const index = value.lastIndexOf("<");
  if (index < 0 || value.length - index > DSML_OPEN_HOLD_LIMIT) return -1;
  const suffix = value.slice(index);
  if (!"</".startsWith(suffix) && !suffix.startsWith("</")) return -1;
  return /^\s*$/.test(value.slice(0, index)) ? 0 : index;
}

function readDsmlCloseRun(value: string, start: number) {
  let index = start;
  let seenCloseTag = false;

  while (index < value.length) {
    const whitespace = /^\s*/.exec(value.slice(index))?.[0] ?? "";
    index += whitespace.length;
    const closeTag = DSML_CLOSE_TAG_AT_START_PATTERN.exec(value.slice(index));
    if (!closeTag) break;
    index += closeTag[0].length;
    seenCloseTag = true;
  }

  return seenCloseTag ? { start, end: index } : null;
}

function findDsmlOrphanCloseRun(value: string) {
  DSML_CLOSE_TAG_SCAN_PATTERN.lastIndex = 0;
  const match = DSML_CLOSE_TAG_SCAN_PATTERN.exec(value);
  if (!match || match.index === undefined) return null;

  const leadingText = value.slice(0, match.index);
  const start = /^\s*$/.test(leadingText) ? 0 : match.index;
  return readDsmlCloseRun(value, start);
}

function normalizeDoneReason(stopReason: AssistantMessage["stopReason"]) {
  return stopReason === "toolUse" || stopReason === "length" ? stopReason : "stop";
}

function readErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isRecoverableAnthropicStreamEndError(error: unknown) {
  const message = readErrorMessage(error);
  return (
    message.includes("Anthropic stream ended before message_stop") ||
    message.includes('before receiving "message_stop"')
  );
}

export function wrapDeepSeekDsmlToolCallStream(
  source: AssistantMessageEventStream,
): AssistantMessageEventStream {
  const streamSourceKey = `stream:${++deepSeekDsmlRepairStreamSequence}`;
  const queue: AssistantMessageEvent[] = [];
  const waiting: Array<(result: IteratorResult<AssistantMessageEvent>) => void> = [];
  let closed = false;
  let finalResolved = false;
  let resolveFinal!: (message: AssistantMessage) => void;
  const finalResult = new Promise<AssistantMessage>((resolve) => {
    resolveFinal = resolve;
  });

  let output: AssistantMessage | null = null;
  let extractedToolCalls = false;
  let activeTextSourceIndex: number | null = null;
  let activeTextOutputIndex: number | null = null;
  let activeThinkingSourceIndex: number | null = null;
  let activeThinkingOutputIndex: number | null = null;
  let textBuffer = "";
  let thinkingBuffer = "";
  let dsmlBuffer = "";
  let thinkingDsmlBuffer = "";
  let flattenedToolRequestBuffer = "";
  let pendingFlattenedToolRequests: ToolCall[] = [];
  let inDsml = false;
  let inThinkingDsml = false;
  let inFlattenedToolRequest = false;
  let activeDsmlOpenTag = "";
  let activeThinkingDsmlOpenTag = "";
  let dsmlBlockSequence = 0;
  const sourceToOutputIndex = new Map<number, number>();

  const ensureOutput = (partial?: AssistantMessage) => {
    if (!output) {
      output = createFallbackAssistant(partial);
      return output;
    }
    if (partial) {
      output = {
        ...partial,
        content: output.content,
        stopReason:
          extractedToolCalls && partial.stopReason === "stop" ? "toolUse" : partial.stopReason,
      };
    }
    return output;
  };

  const buildPartial = (partial?: AssistantMessage) => snapshotAssistant(ensureOutput(partial));

  const buildFinalMessage = (sourceMessage: AssistantMessage) => {
    if (!output) {
      return sourceMessage;
    }
    return {
      ...sourceMessage,
      content: output.content.map(cloneBlock),
      stopReason:
        extractedToolCalls && sourceMessage.stopReason === "stop"
          ? "toolUse"
          : sourceMessage.stopReason,
    } satisfies AssistantMessage;
  };

  const settleFinal = (message: AssistantMessage) => {
    if (finalResolved) return;
    finalResolved = true;
    resolveFinal(message);
  };

  const notifyDone = () => {
    while (waiting.length > 0) {
      waiting.shift()?.({ value: undefined, done: true });
    }
  };

  const enqueue = (event: AssistantMessageEvent) => {
    if (closed) return;
    const terminal = isTerminalEvent(event);
    const message = terminalMessage(event);
    if (message) {
      settleFinal(message);
    }

    const waiter = waiting.shift();
    if (waiter) {
      waiter({ value: event, done: false });
    } else {
      queue.push(event);
    }

    if (terminal) {
      closed = true;
      if (queue.length === 0) notifyDone();
    }
  };

  const close = () => {
    if (closed) return;
    closed = true;
    notifyDone();
  };

  const emitError = (error: unknown) => {
    const errorMessage = readErrorMessage(error);
    const message = {
      ...ensureOutput(),
      stopReason: "error",
      errorMessage,
    } satisfies AssistantMessage;
    enqueue({ type: "error", reason: "error", error: snapshotAssistant(message) });
  };

  const hasRecoverableOutput = () =>
    Boolean(output?.content.length) ||
    Boolean(
      textBuffer ||
        dsmlBuffer ||
        thinkingBuffer ||
        thinkingDsmlBuffer ||
        activeDsmlOpenTag ||
        activeThinkingDsmlOpenTag ||
        flattenedToolRequestBuffer ||
        pendingFlattenedToolRequests.length,
    );

  const ensureTextBlock = (sourceIndex: number, partial?: AssistantMessage) => {
    const nextOutput = ensureOutput(partial);
    if (activeTextSourceIndex !== sourceIndex) {
      activeTextSourceIndex = sourceIndex;
      activeTextOutputIndex = null;
    }
    if (activeTextOutputIndex !== null) return activeTextOutputIndex;

    const sourceBlock = partial?.content[sourceIndex];
    const textBlock = {
      type: "text",
      text: "",
      ...(sourceBlock?.type === "text" && sourceBlock.textSignature
        ? { textSignature: sourceBlock.textSignature }
        : {}),
    } as const;
    const outputIndex = nextOutput.content.length;
    nextOutput.content.push(textBlock);
    activeTextOutputIndex = outputIndex;
    enqueue({
      type: "text_start",
      contentIndex: outputIndex,
      partial: buildPartial(partial),
    });
    return outputIndex;
  };

  const emitTextDelta = (sourceIndex: number, delta: string, partial?: AssistantMessage) => {
    if (!delta) return;
    const outputIndex = ensureTextBlock(sourceIndex, partial);
    const block = ensureOutput(partial).content[outputIndex];
    if (block?.type !== "text") return;
    block.text += delta;
    enqueue({
      type: "text_delta",
      contentIndex: outputIndex,
      delta,
      partial: buildPartial(partial),
    });
  };

  const endActiveTextBlock = (partial?: AssistantMessage) => {
    if (activeTextOutputIndex === null) return;
    const outputIndex = activeTextOutputIndex;
    const block = ensureOutput(partial).content[outputIndex];
    if (block?.type === "text") {
      enqueue({
        type: "text_end",
        contentIndex: outputIndex,
        content: block.text,
        partial: buildPartial(partial),
      });
    }
    activeTextOutputIndex = null;
  };

  const ensureThinkingBlock = (sourceIndex: number, partial?: AssistantMessage) => {
    const nextOutput = ensureOutput(partial);
    if (activeThinkingSourceIndex !== sourceIndex) {
      activeThinkingSourceIndex = sourceIndex;
      activeThinkingOutputIndex = null;
    }
    if (activeThinkingOutputIndex !== null) return activeThinkingOutputIndex;

    const sourceBlock = partial?.content[sourceIndex];
    const thinkingBlock = {
      type: "thinking",
      thinking: "",
      ...(sourceBlock?.type === "thinking" && sourceBlock.thinkingSignature
        ? { thinkingSignature: sourceBlock.thinkingSignature }
        : {}),
    } as const;
    const outputIndex = nextOutput.content.length;
    nextOutput.content.push(thinkingBlock);
    sourceToOutputIndex.set(sourceIndex, outputIndex);
    activeThinkingOutputIndex = outputIndex;
    enqueue({
      type: "thinking_start",
      contentIndex: outputIndex,
      partial: buildPartial(partial),
    });
    return outputIndex;
  };

  const emitThinkingDelta = (sourceIndex: number, delta: string, partial?: AssistantMessage) => {
    if (!delta) return;
    const outputIndex = ensureThinkingBlock(sourceIndex, partial);
    const block = ensureOutput(partial).content[outputIndex];
    if (block?.type !== "thinking") return;
    block.thinking += delta;
    enqueue({
      type: "thinking_delta",
      contentIndex: outputIndex,
      delta,
      partial: buildPartial(partial),
    });
  };

  const endActiveThinkingBlock = (partial?: AssistantMessage) => {
    if (activeThinkingOutputIndex === null) return;
    const outputIndex = activeThinkingOutputIndex;
    const block = ensureOutput(partial).content[outputIndex];
    if (block?.type === "thinking") {
      enqueue({
        type: "thinking_end",
        contentIndex: outputIndex,
        content: block.thinking,
        partial: buildPartial(partial),
      });
    }
    activeThinkingOutputIndex = null;
  };

  const emitToolCall = (toolCall: ToolCall, partial?: AssistantMessage) => {
    const nextOutput = ensureOutput(partial);
    const outputIndex = nextOutput.content.length;
    const normalizedToolCall = cloneBlock(toolCall);
    nextOutput.content.push(normalizedToolCall);
    const delta = JSON.stringify(normalizedToolCall.arguments ?? {});
    enqueue({
      type: "toolcall_start",
      contentIndex: outputIndex,
      partial: buildPartial(partial),
    });
    enqueue({
      type: "toolcall_delta",
      contentIndex: outputIndex,
      delta,
      partial: buildPartial(partial),
    });
    enqueue({
      type: "toolcall_end",
      contentIndex: outputIndex,
      toolCall: normalizedToolCall,
      partial: buildPartial(partial),
    });
  };

  const outputHasComparableToolCall = (toolCall: ToolCall) => {
    const comparable = comparableToolCall(toolCall);
    return Boolean(
      output?.content.some(
        (block) => block.type === "toolCall" && comparableToolCall(block) === comparable,
      ),
    );
  };

  const outputHasAnyToolCall = () =>
    Boolean(output?.content.some((block) => block.type === "toolCall"));

  const addPendingFlattenedToolRequest = (toolCall: ToolCall) => {
    const comparable = comparableToolCall(toolCall);
    if (
      pendingFlattenedToolRequests.some((pending) => comparableToolCall(pending) === comparable)
    ) {
      return;
    }
    pendingFlattenedToolRequests.push(toolCall);
  };

  const discardPendingMatchingToolCall = (toolCall: ToolCall) => {
    const comparable = comparableToolCall(toolCall);
    pendingFlattenedToolRequests = pendingFlattenedToolRequests.filter(
      (pending) => comparableToolCall(pending) !== comparable,
    );
  };

  const emitPendingFlattenedToolRequests = (partial?: AssistantMessage) => {
    if (pendingFlattenedToolRequests.length === 0) return;
    const pending = pendingFlattenedToolRequests;
    pendingFlattenedToolRequests = [];
    for (const toolCall of pending) {
      if (outputHasComparableToolCall(toolCall)) continue;
      extractedToolCalls = true;
      emitToolCall(toolCall, partial);
    }
  };

  const drainDsmlBuffer = (sourceIndex: number, partial?: AssistantMessage) => {
    const recoverDsmlMarkup = (markup: string) => {
      const toolCalls = parseDsmlToolCallMarkup(markup, {
        sourceKey: `${streamSourceKey}:${sourceIndex}:${dsmlBlockSequence++}`,
      });
      if (toolCalls.length === 0) return false;
      extractedToolCalls = true;
      for (const toolCall of toolCalls) {
        emitToolCall(toolCall, partial);
      }
      return true;
    };

    const closeTag = findPattern(DSML_TOOL_CALLS_CLOSE_PATTERN, dsmlBuffer);
    if (!closeTag) {
      if (dsmlBuffer.length > DSML_SWALLOW_BUFFER_LIMIT) {
        recoverDsmlMarkup(`${activeDsmlOpenTag}${dsmlBuffer}`);
        dsmlBuffer = "";
        activeDsmlOpenTag = "";
        inDsml = false;
      }
      return;
    }

    const blockContent = dsmlBuffer.slice(0, closeTag.index);
    const remainder = dsmlBuffer.slice(closeTag.index + closeTag.text.length);
    const markup = `${activeDsmlOpenTag}${blockContent}${closeTag.text}`;
    recoverDsmlMarkup(markup);

    dsmlBuffer = "";
    activeDsmlOpenTag = "";
    inDsml = false;
    textBuffer = remainder;
  };

  const drainThinkingDsmlBuffer = (sourceIndex: number, partial?: AssistantMessage) => {
    const recoverDsmlMarkup = (markup: string) => {
      const toolCalls = parseDsmlToolCallMarkup(markup, {
        sourceKey: `${streamSourceKey}:thinking:${sourceIndex}:${dsmlBlockSequence++}`,
      });
      if (toolCalls.length === 0) return false;
      extractedToolCalls = true;
      for (const toolCall of toolCalls) {
        emitToolCall(toolCall, partial);
      }
      return true;
    };

    const closeTag = findPattern(DSML_TOOL_CALLS_CLOSE_PATTERN, thinkingDsmlBuffer);
    if (!closeTag) {
      if (thinkingDsmlBuffer.length > DSML_SWALLOW_BUFFER_LIMIT) {
        recoverDsmlMarkup(`${activeThinkingDsmlOpenTag}${thinkingDsmlBuffer}`);
        thinkingDsmlBuffer = "";
        activeThinkingDsmlOpenTag = "";
        inThinkingDsml = false;
      }
      return;
    }

    const blockContent = thinkingDsmlBuffer.slice(0, closeTag.index);
    const remainder = thinkingDsmlBuffer.slice(closeTag.index + closeTag.text.length);
    const markup = `${activeThinkingDsmlOpenTag}${blockContent}${closeTag.text}`;
    recoverDsmlMarkup(markup);

    thinkingDsmlBuffer = "";
    activeThinkingDsmlOpenTag = "";
    inThinkingDsml = false;
    thinkingBuffer = remainder;
  };

  const drainFlattenedToolRequestBuffer = (sourceIndex: number, partial?: AssistantMessage) => {
    const stripMalformedHistoricalRequest = () => {
      const malformedEnd = findMalformedLabeledFlattenedToolRequestEndAtStart(
        flattenedToolRequestBuffer,
      );
      if (malformedEnd === null) return false;
      const remainder = flattenedToolRequestBuffer.slice(malformedEnd);
      textBuffer = /^\s*$/.test(remainder) ? "" : remainder;
      flattenedToolRequestBuffer = "";
      inFlattenedToolRequest = false;
      return true;
    };

    let parsed: ParsedFlattenedToolRequest | null = null;
    try {
      parsed = parseFlattenedToolRequestAtStart(flattenedToolRequestBuffer);
    } catch {
      if (stripMalformedHistoricalRequest()) {
        return;
      }
      emitTextDelta(sourceIndex, flattenedToolRequestBuffer, partial);
      flattenedToolRequestBuffer = "";
      inFlattenedToolRequest = false;
      return;
    }

    if (!parsed) {
      if (stripMalformedHistoricalRequest()) {
        return;
      }
      if (flattenedToolRequestBuffer.length > FLATTENED_TOOL_REQUEST_SWALLOW_BUFFER_LIMIT) {
        emitTextDelta(sourceIndex, flattenedToolRequestBuffer, partial);
        flattenedToolRequestBuffer = "";
        inFlattenedToolRequest = false;
      }
      return;
    }

    if (parsed.hasExplicitId) {
      extractedToolCalls = true;
      emitToolCall(parsed.toolCall, partial);
    } else {
      addPendingFlattenedToolRequest(parsed.toolCall);
    }
    textBuffer = flattenedToolRequestBuffer.slice(parsed.end);
    flattenedToolRequestBuffer = "";
    inFlattenedToolRequest = false;
  };

  const drainTextBuffer = (sourceIndex: number, partial?: AssistantMessage) => {
    while (textBuffer.length > 0) {
      const openTag = findPattern(DSML_TOOL_CALLS_OPEN_PATTERN, textBuffer);
      const orphanCloseRun = outputHasAnyToolCall() ? findDsmlOrphanCloseRun(textBuffer) : null;
      const flattenedStart = findFlattenedToolRequestOpenStart(textBuffer);
      if (
        orphanCloseRun &&
        (!openTag || orphanCloseRun.start <= openTag.index) &&
        (flattenedStart < 0 || orphanCloseRun.start <= flattenedStart)
      ) {
        emitTextDelta(sourceIndex, textBuffer.slice(0, orphanCloseRun.start), partial);
        textBuffer = textBuffer.slice(orphanCloseRun.end);
        continue;
      }
      if (flattenedStart >= 0 && (!openTag || flattenedStart < openTag.index)) {
        emitTextDelta(sourceIndex, textBuffer.slice(0, flattenedStart), partial);
        endActiveTextBlock(partial);
        flattenedToolRequestBuffer = textBuffer.slice(flattenedStart);
        textBuffer = "";
        inFlattenedToolRequest = true;
        drainFlattenedToolRequestBuffer(sourceIndex, partial);
        if (inFlattenedToolRequest) return;
        continue;
      }
      if (!openTag) {
        const dsmlHoldIndex = findPotentialDsmlOpenStart(textBuffer);
        const orphanCloseHoldIndex = outputHasAnyToolCall()
          ? findPotentialDsmlOrphanCloseStart(textBuffer)
          : -1;
        const flattenedHoldIndex = findPotentialFlattenedToolRequestOpenStart(textBuffer);
        const holdIndexes = [dsmlHoldIndex, orphanCloseHoldIndex, flattenedHoldIndex].filter(
          (index) => index >= 0,
        );
        const holdIndex = holdIndexes.length > 0 ? Math.min(...holdIndexes) : -1;
        if (holdIndex >= 0) {
          emitTextDelta(sourceIndex, textBuffer.slice(0, holdIndex), partial);
          textBuffer = textBuffer.slice(holdIndex);
          return;
        }
        emitTextDelta(sourceIndex, textBuffer, partial);
        textBuffer = "";
        return;
      }

      emitTextDelta(sourceIndex, textBuffer.slice(0, openTag.index), partial);
      endActiveTextBlock(partial);
      activeDsmlOpenTag = openTag.text;
      dsmlBuffer = textBuffer.slice(openTag.index + openTag.text.length);
      textBuffer = "";
      inDsml = true;
      drainDsmlBuffer(sourceIndex, partial);
      if (inDsml) return;
    }
  };

  const drainThinkingBuffer = (sourceIndex: number, partial?: AssistantMessage) => {
    while (thinkingBuffer.length > 0) {
      const openTag = findPattern(DSML_TOOL_CALLS_OPEN_PATTERN, thinkingBuffer);
      const orphanCloseRun = outputHasAnyToolCall() ? findDsmlOrphanCloseRun(thinkingBuffer) : null;
      if (orphanCloseRun && (!openTag || orphanCloseRun.start <= openTag.index)) {
        emitThinkingDelta(sourceIndex, thinkingBuffer.slice(0, orphanCloseRun.start), partial);
        thinkingBuffer = thinkingBuffer.slice(orphanCloseRun.end);
        continue;
      }
      if (!openTag) {
        const dsmlHoldIndex = findPotentialDsmlOpenStart(thinkingBuffer);
        const orphanCloseHoldIndex = outputHasAnyToolCall()
          ? findPotentialDsmlOrphanCloseStart(thinkingBuffer)
          : -1;
        const holdIndexes = [dsmlHoldIndex, orphanCloseHoldIndex].filter((index) => index >= 0);
        const holdIndex = holdIndexes.length > 0 ? Math.min(...holdIndexes) : -1;
        if (holdIndex >= 0) {
          emitThinkingDelta(sourceIndex, thinkingBuffer.slice(0, holdIndex), partial);
          thinkingBuffer = thinkingBuffer.slice(holdIndex);
          return;
        }
        emitThinkingDelta(sourceIndex, thinkingBuffer, partial);
        thinkingBuffer = "";
        return;
      }

      emitThinkingDelta(sourceIndex, thinkingBuffer.slice(0, openTag.index), partial);
      endActiveThinkingBlock(partial);
      activeThinkingDsmlOpenTag = openTag.text;
      thinkingDsmlBuffer = thinkingBuffer.slice(openTag.index + openTag.text.length);
      thinkingBuffer = "";
      inThinkingDsml = true;
      drainThinkingDsmlBuffer(sourceIndex, partial);
      if (inThinkingDsml) return;
    }
  };

  const flushTextState = (sourceIndex: number, partial?: AssistantMessage) => {
    if (inFlattenedToolRequest) {
      drainFlattenedToolRequestBuffer(sourceIndex, partial);
      if (inFlattenedToolRequest) {
        emitTextDelta(sourceIndex, flattenedToolRequestBuffer, partial);
        flattenedToolRequestBuffer = "";
        inFlattenedToolRequest = false;
      }
    }
    if (inDsml) {
      const markup = `${activeDsmlOpenTag}${dsmlBuffer}`;
      const toolCalls = parseDsmlToolCallMarkup(markup, {
        sourceKey: `${streamSourceKey}:${sourceIndex}:flush:${dsmlBlockSequence++}`,
      });
      if (toolCalls.length > 0) {
        extractedToolCalls = true;
        for (const toolCall of toolCalls) {
          emitToolCall(toolCall, partial);
        }
      }
      dsmlBuffer = "";
      activeDsmlOpenTag = "";
      inDsml = false;
    }
    if (textBuffer) {
      emitTextDelta(sourceIndex, textBuffer, partial);
      textBuffer = "";
    }
    endActiveTextBlock(partial);
  };

  const flushThinkingState = (sourceIndex: number, partial?: AssistantMessage) => {
    if (inThinkingDsml) {
      const markup = `${activeThinkingDsmlOpenTag}${thinkingDsmlBuffer}`;
      const toolCalls = parseDsmlToolCallMarkup(markup, {
        sourceKey: `${streamSourceKey}:thinking:${sourceIndex}:flush:${dsmlBlockSequence++}`,
      });
      if (toolCalls.length > 0) {
        extractedToolCalls = true;
        for (const toolCall of toolCalls) {
          emitToolCall(toolCall, partial);
        }
      }
      thinkingDsmlBuffer = "";
      activeThinkingDsmlOpenTag = "";
      inThinkingDsml = false;
    }
    if (thinkingBuffer) {
      emitThinkingDelta(sourceIndex, thinkingBuffer, partial);
      thinkingBuffer = "";
    }
    endActiveThinkingBlock(partial);
  };

  const mirrorIndexedEvent = (event: IndexedAssistantEvent) => {
    const nextOutput = ensureOutput(event.partial);
    const sourceBlock = event.partial.content[event.contentIndex];
    let outputIndex = sourceToOutputIndex.get(event.contentIndex);
    if (outputIndex === undefined) {
      outputIndex = nextOutput.content.length;
      sourceToOutputIndex.set(event.contentIndex, outputIndex);
    }
    nextOutput.content[outputIndex] = cloneBlock(sourceBlock);
    const partial = buildPartial(event.partial);
    if (event.type === "toolcall_end") {
      const toolCall = nextOutput.content[outputIndex] as ToolCall;
      enqueue({ ...event, contentIndex: outputIndex, toolCall, partial });
      return;
    }
    enqueue({ ...event, contentIndex: outputIndex, partial } as AssistantMessageEvent);
  };

  void (async () => {
    try {
      for await (const event of source) {
        switch (event.type) {
          case "start": {
            output = createFallbackAssistant(event.partial);
            pendingFlattenedToolRequests = [];
            enqueue({ type: "start", partial: buildPartial(event.partial) });
            break;
          }
          case "text_start": {
            activeTextSourceIndex = event.contentIndex;
            activeTextOutputIndex = null;
            textBuffer = "";
            dsmlBuffer = "";
            flattenedToolRequestBuffer = "";
            inDsml = false;
            inFlattenedToolRequest = false;
            activeDsmlOpenTag = "";
            ensureOutput(event.partial);
            break;
          }
          case "thinking_start": {
            activeThinkingSourceIndex = event.contentIndex;
            activeThinkingOutputIndex = null;
            thinkingBuffer = "";
            thinkingDsmlBuffer = "";
            inThinkingDsml = false;
            activeThinkingDsmlOpenTag = "";
            ensureOutput(event.partial);
            break;
          }
          case "text_delta": {
            activeTextSourceIndex = event.contentIndex;
            if (inFlattenedToolRequest) {
              flattenedToolRequestBuffer += event.delta;
              drainFlattenedToolRequestBuffer(event.contentIndex, event.partial);
              if (!inFlattenedToolRequest && textBuffer) {
                drainTextBuffer(event.contentIndex, event.partial);
              }
            } else if (inDsml) {
              dsmlBuffer += event.delta;
              drainDsmlBuffer(event.contentIndex, event.partial);
            } else {
              textBuffer += event.delta;
              drainTextBuffer(event.contentIndex, event.partial);
            }
            break;
          }
          case "thinking_delta": {
            activeThinkingSourceIndex = event.contentIndex;
            if (inThinkingDsml) {
              thinkingDsmlBuffer += event.delta;
              drainThinkingDsmlBuffer(event.contentIndex, event.partial);
              if (!inThinkingDsml && thinkingBuffer) {
                drainThinkingBuffer(event.contentIndex, event.partial);
              }
            } else {
              thinkingBuffer += event.delta;
              drainThinkingBuffer(event.contentIndex, event.partial);
            }
            break;
          }
          case "text_end": {
            flushTextState(event.contentIndex, event.partial);
            activeTextSourceIndex = null;
            break;
          }
          case "thinking_end": {
            flushThinkingState(event.contentIndex, event.partial);
            activeThinkingSourceIndex = null;
            break;
          }
          case "done": {
            if (activeTextSourceIndex !== null) {
              flushTextState(activeTextSourceIndex, event.message);
              activeTextSourceIndex = null;
            }
            if (activeThinkingSourceIndex !== null) {
              flushThinkingState(activeThinkingSourceIndex, event.message);
              activeThinkingSourceIndex = null;
            }
            emitPendingFlattenedToolRequests(event.message);
            const message = buildFinalMessage(event.message);
            enqueue({
              type: "done",
              reason: normalizeDoneReason(message.stopReason),
              message,
            });
            break;
          }
          case "error": {
            if (activeTextSourceIndex !== null) {
              flushTextState(activeTextSourceIndex, event.error);
              activeTextSourceIndex = null;
            }
            if (activeThinkingSourceIndex !== null) {
              flushThinkingState(activeThinkingSourceIndex, event.error);
              activeThinkingSourceIndex = null;
            }
            emitPendingFlattenedToolRequests(event.error);
            enqueue({
              type: "error",
              reason: event.reason,
              error: buildFinalMessage(event.error),
            });
            break;
          }
          case "toolcall_start":
          case "toolcall_delta":
          case "toolcall_end": {
            if (event.type === "toolcall_end") {
              discardPendingMatchingToolCall(event.toolCall);
            }
            mirrorIndexedEvent(event);
            break;
          }
        }
      }
      if (!closed) {
        if (activeThinkingSourceIndex !== null) {
          flushThinkingState(activeThinkingSourceIndex);
          activeThinkingSourceIndex = null;
        }
        emitPendingFlattenedToolRequests();
        settleFinal(snapshotAssistant(ensureOutput()));
        close();
      }
    } catch (error) {
      if (isRecoverableAnthropicStreamEndError(error) && hasRecoverableOutput()) {
        const sourceIndex = activeTextSourceIndex ?? 0;
        if (activeTextSourceIndex !== null) {
          flushTextState(sourceIndex);
        }
        if (activeThinkingSourceIndex !== null) {
          flushThinkingState(activeThinkingSourceIndex);
        }
        activeTextSourceIndex = null;
        activeThinkingSourceIndex = null;
        emitPendingFlattenedToolRequests();
        const message = buildFinalMessage(snapshotAssistant(ensureOutput()));
        enqueue({
          type: "done",
          reason: normalizeDoneReason(message.stopReason),
          message,
        });
        return;
      }
      emitError(error);
    }
  })();

  return {
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (queue.length > 0) {
          const event = queue.shift();
          if (event) {
            yield event;
          }
          if (closed && queue.length === 0) notifyDone();
          continue;
        }
        if (closed) return;
        const result = await new Promise<IteratorResult<AssistantMessageEvent>>((resolve) =>
          waiting.push(resolve),
        );
        if (result.done) return;
        yield result.value;
      }
    },
    result() {
      return finalResult;
    },
  } as unknown as AssistantMessageEventStream;
}
