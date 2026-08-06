import type { Message } from "@earendil-works/pi-ai";

import { createUuid } from "../shared/id";
import { MAX_SUMMARY_CHARS } from "./types";

export function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function normalizeErrorMessage(value: unknown, fallback: string) {
  const text =
    value instanceof Error ? value.message.trim() : typeof value === "string" ? value.trim() : "";
  return text || fallback;
}

export function clampInteger(value: unknown, fallback: number, min: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export function truncateText(text: string, maxChars = MAX_SUMMARY_CHARS) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n... [truncated, total chars=${text.length}]`;
}

export function sanitizeLabelPart(value: string, fallback: string) {
  const text = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/[-.]+$/g, "")
    .replace(/^[-.]+/g, "")
    .slice(0, 80);
  return text || fallback;
}

export function assistantMessageToText(message: Message | null | undefined) {
  if (!message || message.role !== "assistant") return "";
  let text = "";
  for (const block of message.content) {
    if (block.type === "text") text += block.text;
  }
  return text;
}

export function createSequentialQueue() {
  let tail = Promise.resolve();
  return async function enqueue<T>(run: () => Promise<T>): Promise<T> {
    const next = tail.then(run, run);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
}

export function randomIdSuffix() {
  return createUuid();
}

export async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function runLoop() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(
    new Array(Math.min(items.length, Math.max(1, concurrency))).fill(0).map(() => runLoop()),
  );
  return results;
}
