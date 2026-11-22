// Deterministic synthetic conversation data for the transcript performance
// harness. Nothing here comes from a real session: the text is assembled from
// a fixed vocabulary with a seeded PRNG, so every run renders the same rows.

import type { Message } from "@liveagent/ui/lib/chat/agentTypes";

export function createRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = (
  "render frame layout commit buffer stream parser module request response cache " +
  "index vector worker thread signal pointer record segment window scroll row " +
  "measure height offset viewport anchor marker transcript message delta token " +
  "history config option value result error status update handler listener " +
  "the a of to and in for with on that this is it as be by from at or an"
).split(" ");

function words(random: () => number, count: number) {
  const out: string[] = [];
  for (let index = 0; index < count; index += 1) {
    out.push(WORDS[Math.floor(random() * WORDS.length)] ?? "row");
  }
  return out.join(" ");
}

function sentence(random: () => number) {
  const text = words(random, 8 + Math.floor(random() * 10));
  const decorated =
    random() < 0.2 ? text.replace(/ (\w+) /, " **$1** ") : random() < 0.2 ? `${text} \`cache\`` : text;
  return `${decorated.charAt(0).toUpperCase()}${decorated.slice(1)}.`;
}

function paragraph(random: () => number) {
  const count = 2 + Math.floor(random() * 4);
  return Array.from({ length: count }, () => sentence(random)).join(" ");
}

function codeBlock(random: () => number) {
  const lines = 4 + Math.floor(random() * 8);
  const body = Array.from(
    { length: lines },
    (_, index) =>
      `  const ${WORDS[index % WORDS.length]}${index} = await load("${words(random, 1)}", ${index});`,
  ).join("\n");
  return `\`\`\`ts\nexport async function run() {\n${body}\n}\n\`\`\``;
}

function list(random: () => number) {
  const count = 3 + Math.floor(random() * 4);
  return Array.from({ length: count }, (_, index) => `${index + 1}. ${sentence(random)}`).join(
    "\n",
  );
}

/** Markdown of roughly `targetChars` characters: paragraphs, lists, code, headings. */
export function markdownDocument(random: () => number, targetChars: number) {
  const parts: string[] = [];
  let size = 0;
  while (size < targetChars) {
    const roll = random();
    const part =
      roll < 0.12
        ? `### ${words(random, 3)}`
        : roll < 0.28
          ? list(random)
          : roll < 0.4
            ? codeBlock(random)
            : paragraph(random);
    parts.push(part);
    size += part.length + 2;
  }
  return parts.join("\n\n");
}

export function buildMessages(count: number, assistantChars = 2048, seed = 7): Message[] {
  const random = createRandom(seed);
  const messages: Message[] = [];
  let timestamp = 1_700_000_000_000;
  for (let index = 0; index < count; index += 1) {
    timestamp += 1000;
    if (index % 2 === 0) {
      messages.push({
        role: "user",
        content: sentence(random) + (random() < 0.3 ? ` ${sentence(random)}` : ""),
        timestamp,
      } as Message);
    } else {
      messages.push({
        role: "assistant",
        content: [{ type: "text", text: markdownDocument(random, assistantChars) }],
        api: "fake",
        provider: "fake",
        model: "fake-model",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp,
      } as Message);
    }
  }
  return messages;
}

/**
 * A tool-using conversation of `count` messages with ids: each turn is a user
 * message and two assistant rounds (thinking, markdown, two tool calls), each
 * followed by its two tool results.
 */
export function buildAgentMessages(count: number, seed = 5): Message[] {
  const random = createRandom(seed);
  const messages: Message[] = [];
  let timestamp = 1_700_000_000_000;
  let call = 0;
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  while (messages.length < count) {
    timestamp += 1000;
    messages.push({
      id: `user-${messages.length}`,
      role: "user",
      content: paragraph(random) + paragraph(random),
      timestamp,
    } as Message);
    for (let round = 0; round < 2; round += 1) {
      const ids = [`call-${call++}`, `call-${call++}`];
      timestamp += 1000;
      messages.push({
        id: `assistant-${messages.length}`,
        role: "assistant",
        content: [
          { type: "thinking", thinking: paragraph(random) },
          { type: "text", text: markdownDocument(random, 800) },
          ...ids.map((id) => ({
            type: "toolCall",
            id,
            name: "read_file",
            arguments: { path: `src/${words(random, 1)}/${id}.ts` },
          })),
        ],
        api: "fake",
        provider: "fake",
        model: "fake-model",
        usage,
        stopReason: "toolUse",
        timestamp,
      } as Message);
      for (const id of ids) {
        messages.push({
          id: `result-${id}`,
          role: "toolResult",
          toolCallId: id,
          toolName: "read_file",
          content: [{ type: "text", text: markdownDocument(random, 2000) }],
          isError: false,
          timestamp,
        } as Message);
      }
    }
  }
  return messages.slice(0, count);
}

/** The text the streaming scenario reveals, chunked like provider deltas. */
export function streamingCorpus(chars: number, seed = 11) {
  return markdownDocument(createRandom(seed), chars).slice(0, chars);
}

/** A source file of `lines` lines and an edited copy (every 7th line changed). */
export function editFixture(lines: number) {
  const random = createRandom(lines);
  const before: string[] = [];
  const after: string[] = [];
  for (let index = 0; index < lines; index += 1) {
    const line = `  const ${WORDS[index % WORDS.length]}${index} = compute("${words(random, 2)}", ${index});`;
    before.push(line);
    after.push(index % 7 === 3 ? line.replace("compute", "computeFast") : line);
  }
  return { before: before.join("\n"), after: after.join("\n") };
}

/** A unified patch touching `files` files with `hunkLines` changed lines each. */
export function gitPatchFixture(files: number, hunkLines: number) {
  const random = createRandom(files * 31 + hunkLines);
  const chunks: string[] = [];
  const statLines: string[] = [];
  for (let file = 0; file < files; file += 1) {
    const name = `src/module${file}/file${file}.ts`;
    const body: string[] = [];
    for (let line = 0; line < hunkLines; line += 1) {
      const text = `  const value${line} = compute("${words(random, 2)}", ${line});`;
      if (line % 5 === 2) {
        body.push(`-${text}`);
        body.push(`+${text.replace("compute", "computeFast")}`);
      } else {
        body.push(` ${text}`);
      }
    }
    const oldCount = body.filter((line) => !line.startsWith("+")).length;
    const newCount = body.filter((line) => !line.startsWith("-")).length;
    chunks.push(
      [
        `diff --git a/${name} b/${name}`,
        "index 1111111..2222222 100644",
        `--- a/${name}`,
        `+++ b/${name}`,
        `@@ -1,${oldCount} +1,${newCount} @@`,
        ...body,
      ].join("\n"),
    );
    const changed = Math.floor(hunkLines / 5);
    statLines.push(` ${name} | ${changed * 2} ${"+".repeat(4)}${"-".repeat(4)}`);
  }
  statLines.push(` ${files} files changed`);
  return { patch: `${chunks.join("\n")}\n`, stat: statLines.join("\n") };
}
