#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseReleaseVersion } from "./release-version.mjs";

const DEFAULT_BASE_URL = "https://codex-api.packycode.com/v1";
const DEFAULT_MODEL = "gpt-5.5";
const MAX_CONTEXT_CHARS = 22000;

const [releaseTagArg, outputPath, fallbackNotesPath] = process.argv.slice(2);

function usage() {
  return "Usage: create-ai-release-notes.mjs <release-tag> <output-path> [fallback-notes-file]";
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

if (!releaseTagArg || !outputPath) {
  fail(usage());
}

let releaseVersion;
try {
  releaseVersion = parseReleaseVersion(releaseTagArg);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
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
      // Fall through to a minimal note.
    }
  }
  return `# LiveAgent ${releaseVersion.releaseTag}\n\nRelease ${releaseVersion.releaseTag}.`;
}

function writeFallback(reason) {
  console.warn(`AI release notes unavailable: ${reason}`);
  if (fallbackNotesPath) {
    try {
      copyFileSync(fallbackNotesPath, outputPath);
      console.log(`Wrote fallback release notes: ${outputPath}`);
      return;
    } catch {
      // Fall through to generated fallback notes.
    }
  }
  writeFileSync(outputPath, `${fallbackNotes()}\n`);
  console.log(`Wrote fallback release notes: ${outputPath}`);
}

function stripCodeFence(markdown) {
  const trimmed = markdown.trim();
  const match = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
  return match ? match[1].trim() : trimmed;
}

function normalizeMarkdown(markdown) {
  let output = stripCodeFence(markdown);
  if (!output) return "";
  if (!output.startsWith("#")) {
    output = `# LiveAgent ${releaseVersion.releaseTag}\n\n${output}`;
  }
  return `${output.trim()}\n`;
}

function previousTagFor(releaseCommit) {
  return runGit(["describe", "--tags", "--abbrev=0", `${releaseCommit}^`], {
    optional: true,
  });
}

function collectContext() {
  const releaseCommit = runGit(["rev-list", "-n", "1", releaseVersion.releaseTag]);
  const previousTag = previousTagFor(releaseCommit);
  const range = previousTag ? `${previousTag}..${releaseCommit}` : releaseCommit;
  const repository = process.env.GITHUB_REPOSITORY?.trim() || "Stack-Cairn/LiveAgent";

  const commitLog = runGit([
    "log",
    "--date=short",
    "--format=%h%x09%ad%x09%an%x09%s",
    range,
  ]);
  const diffStat = previousTag
    ? runGit(["diff", "--stat", previousTag, releaseCommit], { optional: true })
    : runGit(["show", "--stat", "--oneline", "--no-renames", releaseCommit], { optional: true });
  const changedFiles = previousTag
    ? runGit(["diff", "--name-status", previousTag, releaseCommit], { optional: true })
    : runGit(["show", "--name-status", "--format=", releaseCommit], { optional: true });
  const githubNotes = fallbackNotesPath
    ? readFileSync(fallbackNotesPath, "utf8").trim()
    : "";

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
    "- Start with exactly this H1: # LiveAgent " + context.releaseTag,
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

function responseText(payload) {
  if (typeof payload.output_text === "string") return payload.output_text;

  const output = payload.output;
  if (Array.isArray(output)) {
    const parts = [];
    for (const item of output) {
      if (!Array.isArray(item.content)) continue;
      for (const content of item.content) {
        if (typeof content.text === "string") parts.push(content.text);
      }
    }
    if (parts.length > 0) return parts.join("\n");
  }

  const choice = payload.choices?.[0]?.message?.content;
  if (typeof choice === "string") return choice;
  if (Array.isArray(choice)) {
    return choice
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n");
  }

  return "";
}

async function createResponse({ apiKey, baseUrl, model, prompt }) {
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/responses`;
  const timeoutMs = Number.parseInt(process.env.AI_RELEASE_NOTES_TIMEOUT_MS ?? "60000", 10);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) ? timeoutMs : 60000);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    signal: controller.signal,
    body: JSON.stringify({
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: "You are a precise release-notes editor. You never make claims that are not grounded in the provided repository context.",
            },
          ],
        },
        {
          role: "user",
          content: [{ type: "input_text", text: prompt }],
        },
      ],
      max_output_tokens: 3000,
      model,
    }),
  }).finally(() => clearTimeout(timeout));

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Responses API returned HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  return JSON.parse(text);
}

async function main() {
  const apiKey =
    process.env.AI_RELEASE_NOTES_API_KEY?.trim() ||
    process.env.PACKYCODE_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    writeFallback("missing AI_RELEASE_NOTES_API_KEY/PACKYCODE_API_KEY/OPENAI_API_KEY");
    return;
  }

  const baseUrl = process.env.AI_RELEASE_NOTES_BASE_URL?.trim() || DEFAULT_BASE_URL;
  const model = process.env.AI_RELEASE_NOTES_MODEL?.trim() || DEFAULT_MODEL;

  try {
    const context = collectContext();
    const prompt = buildPrompt(context);
    const payload = await createResponse({ apiKey, baseUrl, model, prompt });
    const markdown = normalizeMarkdown(responseText(payload));
    if (!markdown) {
      writeFallback("model returned empty release notes");
      return;
    }
    writeFileSync(outputPath, markdown);
    console.log(`Wrote AI release notes with ${model}: ${outputPath}`);
  } catch (error) {
    writeFallback(error instanceof Error ? error.message : String(error));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
