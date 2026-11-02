#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseReleaseVersion } from "./release-version.mjs";

const DEFAULT_KBRAIN_URL = "http://127.0.0.1:47321";
const DEFAULT_PROVIDER = "deepseek";
const DEFAULT_MODEL = "deepseek-flash";
const DEFAULT_MAX_OUTPUT_TOKENS = 8000;
const MAX_CONTEXT_CHARS = 22000;

const REASONING_TYPES = new Set([
  "analysis",
  "reasoning",
  "reasoning_text",
  "summary_text",
  "thinking",
]);

let fallbackNotesPath;
let outputPath;
let releaseVersion;

function usage() {
  return "Usage: create-ai-release-notes.mjs <release-tag> <output-path> [fallback-notes-file]";
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function initializeFromCli() {
  const [releaseTagArg, outputPathArg, fallbackNotesPathArg] = process.argv.slice(2);
  if (!releaseTagArg || !outputPathArg) fail(usage());
  try {
    releaseVersion = parseReleaseVersion(releaseTagArg);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  outputPath = outputPathArg;
  fallbackNotesPath = fallbackNotesPathArg;
}

function runGit(args, options = {}) {
  const result = spawnSync("git", args, {
    cwd: options.cwd ?? process.cwd(),
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) {
    if (options.optional) return "";
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function compact(value, maxChars = MAX_CONTEXT_CHARS) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[truncated]`;
}

function fallbackNotes() {
  if (fallbackNotesPath) {
    try {
      const fallback = readFileSync(fallbackNotesPath, "utf8").trim();
      if (fallback) return fallback;
    } catch {
      // Use the minimal note when the optional fallback file is unavailable.
    }
  }
  return `# LiveAgent ${releaseVersion.releaseTag}\n\nRelease ${releaseVersion.releaseTag}.`;
}

function writeFallback(reason) {
  const notes = fallbackNotes();
  writeFileSync(outputPath, `${notes.trim()}\n`);
  console.warn(`Using fallback release notes: ${reason}`);
}

function stripCodeFence(markdown) {
  const trimmed = markdown.trim();
  const match = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
  return match ? match[1].trim() : trimmed;
}

export function normalizeMarkdown(markdown, releaseTag) {
  const output = stripCodeFence(markdown);
  if (!output) return "";
  const heading = `# LiveAgent ${releaseTag}`;
  const lines = output.split("\n");
  const headingIndex = lines.findIndex((line) => line.trim() === heading);
  if (headingIndex === -1) return "";
  return `${lines.slice(headingIndex).join("\n").trim()}\n`;
}

function previousTagFor(releaseCommit) {
  return runGit(["describe", "--tags", "--abbrev=0", `${releaseCommit}^`], { optional: true });
}

function collectContext() {
  const releaseCommit = runGit(["rev-list", "-n", "1", releaseVersion.releaseTag]);
  const previousTag = previousTagFor(releaseCommit);
  const range = previousTag ? `${previousTag}..${releaseCommit}` : releaseCommit;
  const repository = process.env.GITHUB_REPOSITORY?.trim() || "Stack-Cairn/LiveAgent";
  const commitLog = runGit(["log", "--date=short", "--format=%h%x09%ad%x09%an%x09%s", range]);
  const diffStat = previousTag
    ? runGit(["diff", "--stat", previousTag, releaseCommit], { optional: true })
    : runGit(["show", "--stat", "--oneline", "--no-renames", releaseCommit], { optional: true });
  const changedFiles = previousTag
    ? runGit(["diff", "--name-status", previousTag, releaseCommit], { optional: true })
    : runGit(["show", "--name-status", "--format=", releaseCommit], { optional: true });
  const githubNotes = fallbackNotesPath ? readFileSync(fallbackNotesPath, "utf8").trim() : "";
  return {
    appVersion: releaseVersion.appVersion,
    changedFiles: compact(changedFiles, 7000),
    commitLog: compact(commitLog, 10000),
    diffStat: compact(diffStat, 7000),
    githubNotes: compact(githubNotes, 8000),
    previousTag,
    range,
    releaseCommit,
    releaseTag: releaseVersion.releaseTag,
    repository,
  };
}

function buildPrompt(context) {
  return [
    `Repository: ${context.repository}`,
    `Release tag: ${context.releaseTag}`,
    `App version: ${context.appVersion}`,
    `Previous tag: ${context.previousTag || "none"}`,
    `Commit range: ${context.range}`,
    "",
    "Write polished GitHub release notes in Markdown for this release.",
    "",
    "Rules:",
    "- Output Markdown only.",
    "- Do not invent features, fixes, metrics, dates, warnings, contributors, or compatibility claims.",
    "- Use only the provided GitHub notes, commit log, diff stat, and changed files.",
    "- Write for end users first, developers second.",
    `- Start with exactly this H1: # LiveAgent ${context.releaseTag}`,
    "- Add a one-sentence blockquote summary after the H1.",
    "- Use concise sections: Overview, Highlights, Added, Changed, Fixed, Internal.",
    "- Omit a section if there is no evidence for it.",
    "- Keep the release notes useful and skimmable, not a raw commit dump.",
    "- Mention PR numbers and contributors only when present in the context.",
    "",
    "GitHub generated notes:",
    "```markdown",
    context.githubNotes || "(none)",
    "```",
    "",
    "Commit log:",
    "```text",
    context.commitLog || "(none)",
    "```",
    "",
    "Diff stat:",
    "```text",
    context.diffStat || "(none)",
    "```",
    "",
    "Changed files:",
    "```text",
    context.changedFiles || "(none)",
    "```",
  ].join("\n");
}

function isReasoningOutput(value) {
  const type = typeof value === "string" ? value : value && typeof value === "object" ? value.type : undefined;
  return typeof type === "string" && REASONING_TYPES.has(type.toLowerCase());
}

export function responseText(payload) {
  if (!payload || typeof payload !== "object") return "";
  if (typeof payload.text === "string") return payload.text;
  if (typeof payload.output_text === "string") return payload.output_text;
  const output = Array.isArray(payload.output) ? payload.output : [];
  const outputParts = [];
  for (const item of output) {
    if (!item || typeof item !== "object" || isReasoningOutput(item.type)) continue;
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (!part || typeof part !== "object" || isReasoningOutput(part.type)) continue;
      if (typeof part.text === "string") outputParts.push(part.text);
    }
  }
  if (outputParts.length > 0) return outputParts.join("\n");
  const choice = payload.choices?.[0]?.message?.content;
  if (typeof choice === "string") return choice;
  if (Array.isArray(choice)) {
    return choice
      .filter((part) => !isReasoningOutput(part?.type))
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function normalizeReasoningEffort(value) {
  const effort = value.trim().toLowerCase();
  if (!effort || effort === "none" || effort === "off" || effort === "false" || effort === "xhigh") return "";
  return effort;
}

async function fetchJsonWithTimeout(endpoint, { token, body, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`K-brain returned HTTP ${response.status}: ${text.slice(0, 500)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timeout);
  }
}

async function generateWithKBrain({ token, baseUrl, provider, model, maxOutputTokens, prompt, timeoutMs }) {
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/v1/text/generate`;
  const payload = await fetchJsonWithTimeout(endpoint, {
    token,
    timeoutMs,
    body: {
      model: { provider, model },
      messages: [
        {
          role: "system",
          content: [{ type: "text", text: "You are a precise release-notes editor. You never make claims that are not grounded in the provided repository context." }],
        },
        { role: "user", content: [{ type: "text", text: prompt }] },
      ],
      output: "text",
      max_output_tokens: maxOutputTokens,
    },
  });
  if (payload.version !== "kbrain.agent.v1" || typeof payload.text !== "string") {
    throw new Error("K-brain returned a malformed text-generation response");
  }
  return payload.text;
}

async function main() {
  initializeFromCli();
  const token = process.env.KBRAIN_TOKEN?.trim() || process.env.K_BRAIN_TOKEN?.trim();
  if (!token) {
    writeFallback("missing KBRAIN_TOKEN/K_BRAIN_TOKEN");
    return;
  }
  const baseUrl = process.env.KBRAIN_URL?.trim() || process.env.K_BRAIN_URL?.trim() || DEFAULT_KBRAIN_URL;
  const provider = process.env.AI_RELEASE_NOTES_PROVIDER?.trim() || DEFAULT_PROVIDER;
  const model = process.env.AI_RELEASE_NOTES_MODEL?.trim() || DEFAULT_MODEL;
  const reasoningEffort = normalizeReasoningEffort(process.env.AI_RELEASE_NOTES_REASONING_EFFORT ?? "");
  const parsedTimeoutMs = Number.parseInt(process.env.AI_RELEASE_NOTES_TIMEOUT_MS ?? "60000", 10);
  const timeoutMs = Number.isFinite(parsedTimeoutMs) ? parsedTimeoutMs : 60000;
  const parsedMaxOutputTokens = Number.parseInt(process.env.AI_RELEASE_NOTES_MAX_OUTPUT_TOKENS ?? String(DEFAULT_MAX_OUTPUT_TOKENS), 10);
  const maxOutputTokens = Number.isFinite(parsedMaxOutputTokens) ? parsedMaxOutputTokens : DEFAULT_MAX_OUTPUT_TOKENS;
  try {
    const context = collectContext();
    const prompt = [
      buildPrompt(context),
      "",
      `Write concise Markdown release notes. Start with the exact heading \`# LiveAgent ${releaseVersion.releaseTag}\`.`,
      reasoningEffort ? `Reasoning preference: ${reasoningEffort}.` : "",
    ].filter(Boolean).join("\n");
    const markdown = normalizeMarkdown(
      await generateWithKBrain({ token, baseUrl, provider, model, maxOutputTokens, prompt, timeoutMs }),
      releaseVersion.releaseTag,
    );
    if (!markdown) {
      writeFallback("K-brain returned notes without the required heading");
      return;
    }
    writeFileSync(outputPath, markdown);
    console.log(`Wrote K-brain release notes with ${provider}/${model}: ${outputPath}`);
  } catch (error) {
    writeFallback(error instanceof Error ? error.message : String(error));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
