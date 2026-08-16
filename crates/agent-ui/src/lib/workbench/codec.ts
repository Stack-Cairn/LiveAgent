import { clampSplitRatio } from "./geometry";
import { collectWorkbenchLayoutIssues } from "./invariants";
import {
  createEmptyWorkbenchLayout,
  type PaneNode,
  type PaneRecord,
  type ProjectRef,
  surfaceIdentityKey,
  WORKBENCH_LAYOUT_SCHEMA_VERSION,
  type WorkbenchLayout,
  type WorkbenchSurfaceSpec,
} from "./types";

export type WorkbenchLayoutDecodeResult =
  | { ok: true; layout: WorkbenchLayout; repaired: boolean }
  | { ok: false; reason: "corrupted-json" | "unsupported-schema" | "unrecoverable" };

export function encodeWorkbenchLayout(layout: WorkbenchLayout): string {
  // Unsupported passthrough surfaces serialize as their original raw payload,
  // so a newer build that understands the kind gets its record back intact.
  let panes: WorkbenchLayout["panes"] = layout.panes;
  if (Object.values(layout.panes).some((pane) => pane.surface.kind === "unsupported")) {
    const rewritten: Record<string, unknown> = {};
    for (const [paneId, pane] of Object.entries(layout.panes)) {
      rewritten[paneId] =
        pane.surface.kind === "unsupported" ? { ...pane, surface: pane.surface.raw } : pane;
    }
    panes = rewritten as WorkbenchLayout["panes"];
  }
  return JSON.stringify({
    schemaVersion: layout.schemaVersion,
    revision: layout.revision,
    root: layout.root,
    panes,
    focusedPaneId: layout.focusedPaneId,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function readProjectRef(value: unknown): ProjectRef | null {
  if (!isRecord(value)) return null;
  const projectId = readString(value.projectId);
  const projectPathKey = readString(value.projectPathKey);
  if (!projectId || !projectPathKey) return null;
  return { projectId, projectPathKey };
}

function readSurface(value: unknown): WorkbenchSurfaceSpec | null {
  if (!isRecord(value)) return null;
  const kind = readString(value.kind);
  if (!kind) return null;

  if (kind === "conversation") {
    const conversationId = readString(value.conversationId);
    if (!conversationId) return null;
    const project = readProjectRef(value.project);
    if (!project) return null;
    return { kind: "conversation", conversationId, project };
  }

  if (kind === "localTerminal" || kind === "sshTerminal") {
    const surfaceId = readString(value.surfaceId);
    if (!surfaceId) return null;
    const project = readProjectRef(value.project);
    if (!project) return null;
    const launchSpec = value.launchSpec;
    if (!isRecord(launchSpec)) return null;
    const cwd = readString(launchSpec.cwd);
    if (!cwd) return null;
    const shell = readString(launchSpec.shell) ?? undefined;
    const title = readString(launchSpec.title) ?? undefined;
    if (kind === "localTerminal") {
      return {
        kind: "localTerminal",
        surfaceId,
        project,
        launchSpec: { cwd, ...(shell ? { shell } : {}), ...(title ? { title } : {}) },
      };
    }
    const sshHostId = readString(launchSpec.sshHostId);
    if (!sshHostId) return null;
    return {
      kind: "sshTerminal",
      surfaceId,
      project,
      launchSpec: {
        cwd,
        sshHostId,
        ...(title ? { title } : {}),
        ...(launchSpec.sftpEnabled === true ? { sftpEnabled: true } : {}),
      },
    };
  }

  if (kind === "unsupported") {
    // Re-decoding a previously passed-through record: keep the original kind
    // and raw payload instead of double-wrapping.
    const originalKind = readString(value.originalKind);
    const raw = value.raw;
    if (!originalKind || !isRecord(raw)) return null;
    return { kind: "unsupported", originalKind, raw };
  }

  // Unknown kind from a newer build: preserve it verbatim so a round-trip
  // through this build never destroys the pane. Not a repair.
  return { kind: "unsupported", originalKind: kind, raw: value };
}

function readPaneRecord(paneId: string, value: unknown): PaneRecord | null {
  if (!isRecord(value)) return null;
  const surface = readSurface(value.surface);
  if (!surface) return null;
  const view = isRecord(value.view) ? value.view : {};
  return {
    paneId,
    surface,
    view: view.compactChrome === true ? { compactChrome: true } : {},
  };
}

type RebuildContext = {
  panes: Record<string, PaneRecord>;
  usedPaneIds: Set<string>;
  usedIdentityKeys: Set<string>;
  usedSplitIds: Set<string>;
  repaired: boolean;
  splitSequence: number;
};

/**
 * Rebuild a tree node from untrusted JSON. Invalid leaves are dropped and
 * their parent splits collapse; duplicate pane or conversation references
 * keep only the first occurrence.
 */
function rebuildNode(value: unknown, context: RebuildContext): PaneNode | null {
  if (!isRecord(value)) {
    context.repaired = true;
    return null;
  }
  if (value.type === "leaf") {
    const paneId = readString(value.paneId);
    if (!paneId || !context.panes[paneId] || context.usedPaneIds.has(paneId)) {
      context.repaired = true;
      return null;
    }
    const surface = context.panes[paneId].surface;
    // Unsupported passthrough panes carry no usable identity: exempt from dedup.
    if (surface.kind !== "unsupported") {
      const identityKey = surfaceIdentityKey(surface);
      if (context.usedIdentityKeys.has(identityKey)) {
        context.repaired = true;
        return null;
      }
      context.usedIdentityKeys.add(identityKey);
    }
    context.usedPaneIds.add(paneId);
    return { type: "leaf", paneId };
  }
  if (value.type === "split") {
    const first = rebuildNode(value.first, context);
    const second = rebuildNode(value.second, context);
    if (!first && !second) return null;
    if (!first || !second) {
      context.repaired = true;
      return first ?? second;
    }
    let splitId = readString(value.splitId);
    if (!splitId || context.usedSplitIds.has(splitId)) {
      context.repaired = true;
      context.splitSequence += 1;
      splitId = `split-repaired-${context.splitSequence}`;
    }
    context.usedSplitIds.add(splitId);
    const rawRatio = typeof value.ratio === "number" ? value.ratio : Number.NaN;
    const ratio = clampSplitRatio(rawRatio);
    if (ratio !== rawRatio) context.repaired = true;
    return {
      type: "split",
      splitId,
      axis: value.axis === "vertical" ? "vertical" : "horizontal",
      ratio,
      first,
      second,
    };
  }
  context.repaired = true;
  return null;
}

/**
 * Decode a persisted layout payload. Structural damage is repaired where a
 * valid subset survives; JSON corruption and unknown schema versions fail so
 * the caller can keep a diagnostic backup and fall back safely.
 */
export function decodeWorkbenchLayout(raw: string): WorkbenchLayoutDecodeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "corrupted-json" };
  }
  if (!isRecord(parsed)) return { ok: false, reason: "corrupted-json" };
  if (parsed.schemaVersion !== WORKBENCH_LAYOUT_SCHEMA_VERSION) {
    return { ok: false, reason: "unsupported-schema" };
  }

  const context: RebuildContext = {
    panes: {},
    usedPaneIds: new Set(),
    usedIdentityKeys: new Set(),
    usedSplitIds: new Set(),
    repaired: false,
    splitSequence: 0,
  };
  if (isRecord(parsed.panes)) {
    for (const [paneId, paneValue] of Object.entries(parsed.panes)) {
      const record = readPaneRecord(paneId, paneValue);
      if (record) {
        context.panes[paneId] = record;
      } else {
        context.repaired = true;
      }
    }
  } else if (parsed.panes !== undefined) {
    context.repaired = true;
  }

  const root = parsed.root === null ? null : rebuildNode(parsed.root, context);
  const revision =
    Number.isInteger(parsed.revision) && (parsed.revision as number) >= 0
      ? (parsed.revision as number)
      : 0;
  if (revision !== parsed.revision) context.repaired = true;

  if (root === null) {
    if (parsed.root !== null || Object.keys(context.panes).length > 0) context.repaired = true;
    const layout = { ...createEmptyWorkbenchLayout(), revision };
    return { ok: true, layout, repaired: context.repaired };
  }

  // Drop orphan pane records the (possibly repaired) tree no longer uses.
  const panes: Record<string, PaneRecord> = {};
  for (const paneId of context.usedPaneIds) {
    panes[paneId] = context.panes[paneId];
  }
  if (Object.keys(panes).length !== Object.keys(context.panes).length) context.repaired = true;

  const focusCandidate = readString(parsed.focusedPaneId);
  let focusedPaneId = focusCandidate && panes[focusCandidate] ? focusCandidate : null;
  if (!focusedPaneId) {
    focusedPaneId = firstLeafId(root);
    if (focusCandidate !== focusedPaneId) context.repaired = true;
  }

  const layout: WorkbenchLayout = {
    schemaVersion: WORKBENCH_LAYOUT_SCHEMA_VERSION,
    revision,
    root,
    panes,
    focusedPaneId,
  };
  if (collectWorkbenchLayoutIssues(layout).length > 0) {
    return { ok: false, reason: "unrecoverable" };
  }
  return { ok: true, layout, repaired: context.repaired };
}

function firstLeafId(node: PaneNode): string {
  return node.type === "leaf" ? node.paneId : firstLeafId(node.first);
}
