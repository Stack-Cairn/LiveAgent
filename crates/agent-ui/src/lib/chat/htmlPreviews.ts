// HTML previews (K-brain capability `html_previews`): the backend saves the HTML of an
// "html preview" fenced block or of a Write to *.html, publishes `preview.created`, and
// serves it with a CSP meta tag. This module keeps the previews known per conversation
// (live events plus the session list) and maps a rendered fence back to its preview id.

import { useSyncExternalStore } from "react";

export const HTML_PREVIEW_FENCE_LANGUAGE = "html-preview";

export type HtmlPreviewRecord = {
  previewId: string;
  source: "message" | "file";
  title: string;
  path?: string;
  toolCallId?: string;
  bytes: number;
  /** Backend path; fetching it needs the bearer token. */
  url: string;
  createdAt?: string;
};

const PREVIEW_ID_PATTERN = /^[0-9a-f]{16}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Parses a `preview.created` payload or one entry of GET /v1/sessions/{id}/previews. */
export function parseHtmlPreview(value: unknown): HtmlPreviewRecord | null {
  if (!isRecord(value)) return null;
  const previewId = typeof value.preview_id === "string" ? value.preview_id : "";
  const url = typeof value.url === "string" ? value.url : "";
  if (!PREVIEW_ID_PATTERN.test(previewId) || !url.startsWith("/v1/sessions/")) return null;
  const path = typeof value.path === "string" && value.path ? value.path : undefined;
  const toolCallId =
    typeof value.tool_call_id === "string" && value.tool_call_id ? value.tool_call_id : undefined;
  return {
    previewId,
    source: value.source === "file" ? "file" : "message",
    title: typeof value.title === "string" ? value.title : "",
    ...(path ? { path } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    bytes: typeof value.bytes === "number" && value.bytes >= 0 ? value.bytes : 0,
    url,
    ...(typeof value.created_at === "string" ? { createdAt: value.created_at } : {}),
  };
}

const FENCE_PATTERN = /^( {0,3})(`{3,}|~{3,})[ \t]*html[ \t]+preview[ \t]*$/gm;

/**
 * Rewrites the info string of "html preview" fences to a single language token so the
 * Markdown renderer keeps it (it drops everything after the first word).
 */
export function markHtmlPreviewFences(content: string): string {
  if (!content.includes("preview")) return content;
  return content.replace(FENCE_PATTERN, `$1$2${HTML_PREVIEW_FENCE_LANGUAGE}`);
}

async function sha256Hex(text: string): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Candidate preview ids of a rendered fence body: K-brain hashes every body line followed
 * by "\n", while the renderer hands over the body without its final newline.
 */
export async function htmlPreviewIdCandidates(code: string): Promise<string[]> {
  const bodies = code.endsWith("\n") ? [code] : [`${code}\n`, code];
  const ids: string[] = [];
  for (const body of bodies) {
    const hex = await sha256Hex(body);
    if (hex) ids.push(hex.slice(0, 16));
  }
  return ids;
}

type ConversationPreviews = Map<string, HtmlPreviewRecord>;

const previewsByConversation = new Map<string, ConversationPreviews>();
const versions = new Map<string, number>();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of [...listeners]) listener();
}

export function recordHtmlPreviews(conversationId: string, previews: readonly HtmlPreviewRecord[]) {
  if (!conversationId || previews.length === 0) return;
  let bucket = previewsByConversation.get(conversationId);
  if (!bucket) {
    bucket = new Map();
    previewsByConversation.set(conversationId, bucket);
  }
  let changed = false;
  for (const preview of previews) {
    const existing = bucket.get(preview.previewId);
    // The same HTML can be published twice (message and file); keep the first record but
    // learn a tool call id when a later one carries it.
    if (existing && (existing.toolCallId || !preview.toolCallId)) continue;
    bucket.set(
      preview.previewId,
      existing ? { ...existing, toolCallId: preview.toolCallId } : preview,
    );
    changed = true;
  }
  if (!changed) return;
  versions.set(conversationId, (versions.get(conversationId) ?? 0) + 1);
  emit();
}

export function clearHtmlPreviews(conversationId: string) {
  if (!previewsByConversation.delete(conversationId)) return;
  versions.set(conversationId, (versions.get(conversationId) ?? 0) + 1);
  emit();
}

export function getHtmlPreview(conversationId: string, previewId: string) {
  return previewsByConversation.get(conversationId)?.get(previewId);
}

export function findHtmlPreviewForToolCall(conversationId: string, toolCallId: string) {
  for (const preview of previewsByConversation.get(conversationId)?.values() ?? []) {
    if (preview.toolCallId === toolCallId) return preview;
  }
  return undefined;
}

export function listHtmlPreviews(conversationId: string): HtmlPreviewRecord[] {
  return [...(previewsByConversation.get(conversationId)?.values() ?? [])];
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Re-renders when the conversation's previews change; returns a version counter. */
export function useHtmlPreviewsVersion(conversationId: string | undefined) {
  return useSyncExternalStore(
    subscribe,
    () => (conversationId ? (versions.get(conversationId) ?? 0) : 0),
    () => 0,
  );
}

// The preview the user asked to show in the right dock ("open in side panel"), per
// conversation. The dock's panel tab reads it; a newer request replaces the older one.
const sidePanelRequests = new Map<string, { previewId: string; nonce: number }>();
let sidePanelNonce = 0;

export function requestHtmlPreviewInSidePanel(conversationId: string, previewId: string) {
  sidePanelNonce += 1;
  sidePanelRequests.set(conversationId, { previewId, nonce: sidePanelNonce });
  versions.set(conversationId, (versions.get(conversationId) ?? 0) + 1);
  emit();
}

export function readHtmlPreviewSidePanelRequest(conversationId: string) {
  return sidePanelRequests.get(conversationId);
}
