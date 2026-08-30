import { terminalLaunchSpecIsInProject } from "./projectScope";
import {
  type PaneNode,
  surfaceIdentityKey,
  WORKBENCH_LAYOUT_SCHEMA_VERSION,
  type WorkbenchLayout,
} from "./types";

export type WorkbenchLayoutIssueCode =
  | "cyclic-tree"
  | "duplicate-conversation"
  | "duplicate-pane-reference"
  | "duplicate-split-id"
  | "duplicate-surface"
  | "invalid-empty-layout"
  | "invalid-focus"
  | "invalid-pane-record"
  | "invalid-project-ref"
  | "invalid-ratio"
  | "invalid-revision"
  | "invalid-schema-version"
  | "missing-pane-record"
  | "orphan-pane-record"
  | "terminal-cwd-outside-project";

export type WorkbenchLayoutIssue = {
  code: WorkbenchLayoutIssueCode;
  path: string;
  message: string;
};

function issue(
  code: WorkbenchLayoutIssueCode,
  path: string,
  message: string,
): WorkbenchLayoutIssue {
  return { code, path, message };
}

/**
 * Find the pane hosting the surface with the given identity key (see
 * `surfaceIdentityKey`). Unsupported surfaces never match: they carry no
 * usable identity.
 */
export function findPaneIdBySurfaceKey(
  layout: Pick<WorkbenchLayout, "panes">,
  surfaceKey: string,
): string | null {
  if (!surfaceKey) return null;
  for (const [paneId, pane] of Object.entries(layout.panes)) {
    if (pane.surface.kind === "unsupported") continue;
    if (surfaceIdentityKey(pane.surface) === surfaceKey) {
      return paneId;
    }
  }
  return null;
}

export function findPaneIdByConversationId(
  layout: Pick<WorkbenchLayout, "panes">,
  conversationId: string,
): string | null {
  const targetId = conversationId.trim();
  if (!targetId) return null;
  return findPaneIdBySurfaceKey(layout, `conversation:${targetId}`);
}

/**
 * The split directly hosting `paneId` as one of its two children — the split a
 * pane-scoped equalize acts on. Null when the pane is the whole tree (a lone
 * root leaf has no parent split) or is not mounted at all.
 */
export function findParentSplitId(
  layout: Pick<WorkbenchLayout, "root">,
  paneId: string,
): string | null {
  const targetId = paneId.trim();
  if (!targetId || !layout.root) return null;
  const walk = (node: PaneNode): string | null => {
    if (node.type === "leaf") return null;
    const hostsTarget =
      (node.first.type === "leaf" && node.first.paneId === targetId) ||
      (node.second.type === "leaf" && node.second.paneId === targetId);
    if (hostsTarget) return node.splitId;
    return walk(node.first) ?? walk(node.second);
  };
  return walk(layout.root);
}

export function collectWorkbenchLayoutIssues(layout: WorkbenchLayout): WorkbenchLayoutIssue[] {
  const issues: WorkbenchLayoutIssue[] = [];
  if (layout.schemaVersion !== WORKBENCH_LAYOUT_SCHEMA_VERSION) {
    issues.push(
      issue(
        "invalid-schema-version",
        "schemaVersion",
        `Expected schema version ${WORKBENCH_LAYOUT_SCHEMA_VERSION}.`,
      ),
    );
  }
  if (!Number.isInteger(layout.revision) || layout.revision < 0) {
    issues.push(issue("invalid-revision", "revision", "Revision must be a non-negative integer."));
  }

  const paneKeys = Object.keys(layout.panes);
  if (layout.root === null) {
    if (paneKeys.length > 0 || layout.focusedPaneId !== null) {
      issues.push(
        issue(
          "invalid-empty-layout",
          "root",
          "An empty tree cannot retain pane records or a focused pane.",
        ),
      );
    }
    return issues;
  }

  const referencedPaneIds = new Set<string>();
  const splitIds = new Set<string>();
  const visitedNodes = new WeakSet<object>();

  const visit = (node: PaneNode, path: string) => {
    if (visitedNodes.has(node)) {
      issues.push(issue("cyclic-tree", path, "Pane tree nodes cannot contain cycles."));
      return;
    }
    visitedNodes.add(node);

    if (node.type === "leaf") {
      const paneId = node.paneId.trim();
      if (!paneId || !layout.panes[paneId]) {
        issues.push(
          issue(
            "missing-pane-record",
            `${path}.paneId`,
            `Leaf references missing pane record '${node.paneId}'.`,
          ),
        );
        return;
      }
      if (referencedPaneIds.has(paneId)) {
        issues.push(
          issue(
            "duplicate-pane-reference",
            `${path}.paneId`,
            `Pane '${paneId}' is referenced more than once.`,
          ),
        );
        return;
      }
      referencedPaneIds.add(paneId);
      return;
    }

    const splitId = node.splitId.trim();
    if (!splitId || splitIds.has(splitId)) {
      issues.push(
        issue(
          "duplicate-split-id",
          `${path}.splitId`,
          `Split id '${node.splitId}' must be non-empty and unique.`,
        ),
      );
    } else {
      splitIds.add(splitId);
    }
    if (!Number.isFinite(node.ratio) || node.ratio <= 0 || node.ratio >= 1) {
      issues.push(
        issue(
          "invalid-ratio",
          `${path}.ratio`,
          "Split ratio must be greater than 0 and less than 1.",
        ),
      );
    }
    visit(node.first, `${path}.first`);
    visit(node.second, `${path}.second`);
  };

  visit(layout.root, "root");

  const surfacePaneIds = new Map<string, string>();
  for (const [paneKey, pane] of Object.entries(layout.panes)) {
    const panePath = `panes.${paneKey}`;
    if (!referencedPaneIds.has(paneKey)) {
      issues.push(
        issue(
          "orphan-pane-record",
          panePath,
          `Pane record '${paneKey}' is not referenced by the tree.`,
        ),
      );
    }
    if (!pane.paneId.trim() || pane.paneId !== paneKey) {
      issues.push(
        issue(
          "invalid-pane-record",
          `${panePath}.paneId`,
          "Pane record id must be non-empty and match its record key.",
        ),
      );
    }

    const surface = pane.surface;
    let identityValid = false;
    if (surface.kind === "conversation") {
      if (!surface.conversationId.trim()) {
        issues.push(
          issue(
            "invalid-pane-record",
            `${panePath}.surface.conversationId`,
            "Conversation id must be non-empty.",
          ),
        );
      } else {
        identityValid = true;
      }
    } else if (surface.kind === "fileTree") {
      identityValid = Boolean(surface.project.projectPathKey.trim());
      if (!identityValid) {
        issues.push(
          issue(
            "invalid-pane-record",
            `${panePath}.surface.project.projectPathKey`,
            "File tree surfaces require a project path key.",
          ),
        );
      }
    } else if (surface.kind === "localTerminal" || surface.kind === "sshTerminal") {
      if (!surface.surfaceId.trim()) {
        issues.push(
          issue(
            "invalid-pane-record",
            `${panePath}.surface.surfaceId`,
            "Terminal surface id must be non-empty.",
          ),
        );
      } else {
        identityValid = true;
      }
      if (!surface.launchSpec.cwd.trim()) {
        issues.push(
          issue(
            "invalid-pane-record",
            `${panePath}.surface.launchSpec.cwd`,
            "Terminal launch specs require a working directory.",
          ),
        );
      } else if (!terminalLaunchSpecIsInProject(surface)) {
        // Layout JSON is not an authorization credential: a cwd that claims a
        // project it does not live under is reported here and refused again by
        // the backend when the session is created.
        issues.push(
          issue(
            "terminal-cwd-outside-project",
            `${panePath}.surface.launchSpec.cwd`,
            `Terminal working directory '${surface.launchSpec.cwd.trim()}' is outside project '${surface.project.projectPathKey.trim()}'.`,
          ),
        );
      }
    }

    // Unsupported passthrough panes carry no usable identity or project ref;
    // they are exempt from uniqueness and project validation by design.
    if (surface.kind !== "unsupported") {
      if (identityValid) {
        const surfaceKey = surfaceIdentityKey(surface);
        const previousPaneId = surfacePaneIds.get(surfaceKey);
        if (previousPaneId) {
          if (surface.kind === "conversation") {
            issues.push(
              issue(
                "duplicate-conversation",
                `${panePath}.surface.conversationId`,
                `Conversation '${surface.conversationId.trim()}' is already bound to pane '${previousPaneId}'.`,
              ),
            );
          } else if (surface.kind === "fileTree") {
            issues.push(
              issue(
                "duplicate-surface",
                `${panePath}.surface.project.projectPathKey`,
                `File tree for project '${surface.project.projectPathKey.trim()}' is already bound to pane '${previousPaneId}'.`,
              ),
            );
          } else {
            issues.push(
              issue(
                "duplicate-surface",
                `${panePath}.surface.surfaceId`,
                `Terminal surface '${surface.surfaceId.trim()}' is already bound to pane '${previousPaneId}'.`,
              ),
            );
          }
        } else {
          surfacePaneIds.set(surfaceKey, paneKey);
        }
      }
      if (!surface.project.projectId.trim() || !surface.project.projectPathKey.trim()) {
        issues.push(
          issue(
            "invalid-project-ref",
            `${panePath}.surface.project`,
            "Project references require both projectId and projectPathKey.",
          ),
        );
      }
    }
  }

  if (layout.focusedPaneId === null || !referencedPaneIds.has(layout.focusedPaneId)) {
    issues.push(
      issue(
        "invalid-focus",
        "focusedPaneId",
        "A non-empty layout must focus one pane referenced by the tree.",
      ),
    );
  }
  return issues;
}

export function isWorkbenchLayoutValid(layout: WorkbenchLayout): boolean {
  return collectWorkbenchLayoutIssues(layout).length === 0;
}

export class WorkbenchLayoutInvariantError extends Error {
  readonly issues: WorkbenchLayoutIssue[];

  constructor(issues: WorkbenchLayoutIssue[]) {
    super(issues.map((item) => `${item.path}: ${item.message}`).join("\n"));
    this.name = "WorkbenchLayoutInvariantError";
    this.issues = issues;
  }
}

export function assertWorkbenchLayout(layout: WorkbenchLayout): void {
  const issues = collectWorkbenchLayoutIssues(layout);
  if (issues.length > 0) {
    throw new WorkbenchLayoutInvariantError(issues);
  }
}
