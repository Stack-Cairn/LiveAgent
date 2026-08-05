import type { ReactNode } from "react";
import { FolderTree, GitBranch, Globe, Key } from "../icons";
import { FileTreePanel } from "./file-tree";
import { GitReviewPanel } from "./git-review";
import { LocalTunnelPanel } from "./LocalTunnelPanel";
import { type RightDockToolContextValue, useRightDockToolContext } from "./RightDockContext";
import type { RightDockSingletonTabKind } from "./rightDockModel";
import { SshTunnelPanel } from "./SshTunnelPanel";

export type { RightDockSingletonTabKind } from "./rightDockModel";

export type RightDockToolRenderInput = {
  active: boolean;
};

export type RightDockToolDefinition = {
  kind: RightDockSingletonTabKind;
  titleKey: string;
  createTitleKey: string;
  descriptionKey: string;
  closeKey: string;
  projectRequired: boolean;
  icon: (className: string) => ReactNode;
  // Classes RightDockContent applies to the keep-alive wrapper while this tool
  // is the active tab (inactive tools stay mounted behind "hidden").
  containerActiveClassName: string;
  isAvailable: (context: RightDockToolContextValue) => boolean;
  render: (input: RightDockToolRenderInput) => ReactNode;
};

// Each tool body is a component of its own so it can read the dock context via
// useRightDockToolContext; definition.render only instantiates it.
function FileTreeTool(props: RightDockToolRenderInput) {
  // FileTreePanel reads the dock context itself and keeps per-project state
  // in an LRU bucket, so it deliberately has no projectPathKey remount key:
  // staying mounted across project switches is what makes the bucket useful.
  return <FileTreePanel active={props.active} />;
}

function GitReviewTool(props: RightDockToolRenderInput) {
  const { active } = props;
  const context = useRightDockToolContext();
  // The panel reads everything else (clients, capabilities, git callbacks)
  // from the right-dock tool context itself.
  return <GitReviewPanel key={`${context.projectPathKey}:git-review`} active={active} />;
}

function TunnelTool(props: RightDockToolRenderInput) {
  const { active } = props;
  const context = useRightDockToolContext();
  return (
    <LocalTunnelPanel
      active={active}
      client={context.clients.tunnel ?? null}
      enabled={context.capabilities.tunnelEnabled}
      disabledMessage={context.capabilities.tunnelDisabledMessage}
      projectPathKey={context.projectPathKey}
      publicBaseUrl={context.capabilities.tunnelPublicBaseUrl}
      onOpenExternal={context.openExternal}
    />
  );
}

function SshTunnelTool(props: RightDockToolRenderInput) {
  const { active } = props;
  const context = useRightDockToolContext();
  const { ssh } = context;
  return (
    <SshTunnelPanel
      active={active}
      cwd={context.cwd}
      projectPathKey={context.projectPathKey}
      hosts={ssh.hosts}
      associatedHostIds={ssh.associatedHostIds}
      client={context.clients.terminal}
      sessions={ssh.sessions}
      onSessionSnapshot={ssh.onSessionSnapshot}
      onSessionClosed={ssh.onSessionClosed}
      onSshSessionsReconcile={ssh.onSessionsReconcile}
      onOpenSession={(session, kind) => ssh.onOpenSession?.(session, kind)}
      onAssociatedHostIdsChange={(hostIds) => {
        ssh.onAssociatedHostIdsChange?.(hostIds);
      }}
    />
  );
}

function projectToolAvailable(context: RightDockToolContextValue) {
  return context.projectPathKey.trim() !== "";
}

export const RIGHT_DOCK_TOOL_DEFINITIONS: readonly RightDockToolDefinition[] = [
  {
    kind: "fileTree",
    titleKey: "projectTools.fileTreeTitle",
    createTitleKey: "projectTools.newFileTree",
    descriptionKey: "projectTools.fileTreeDescription",
    closeKey: "projectTools.closeFileTree",
    projectRequired: true,
    icon: (className) => <FolderTree className={className} />,
    containerActiveClassName: "block",
    isAvailable: projectToolAvailable,
    render: (input) => <FileTreeTool active={input.active} />,
  },
  {
    kind: "gitReview",
    titleKey: "projectTools.gitReviewTitle",
    createTitleKey: "projectTools.newGitReview",
    descriptionKey: "projectTools.gitReviewDescription",
    closeKey: "projectTools.closeGitReview",
    projectRequired: true,
    icon: (className) => <GitBranch className={className} />,
    containerActiveClassName: "flex flex-col",
    isAvailable: projectToolAvailable,
    render: (input) => <GitReviewTool active={input.active} />,
  },
  {
    kind: "tunnel",
    titleKey: "projectTools.tunnelTitle",
    createTitleKey: "projectTools.newTunnel",
    descriptionKey: "projectTools.tunnelDescription",
    closeKey: "projectTools.closeTunnelTab",
    projectRequired: false,
    icon: (className) => <Globe className={className} />,
    containerActiveClassName: "flex flex-col",
    isAvailable: (context) => Boolean(context.clients.tunnel),
    render: (input) => <TunnelTool active={input.active} />,
  },
  {
    kind: "sshTunnel",
    titleKey: "projectTools.sshTunnelTitle",
    createTitleKey: "projectTools.newSshTunnel",
    descriptionKey: "projectTools.sshTunnelDescription",
    closeKey: "projectTools.closeSshTunnelTab",
    projectRequired: true,
    icon: (className) => <Key className={className} />,
    containerActiveClassName: "flex flex-col",
    isAvailable: projectToolAvailable,
    render: (input) => <SshTunnelTool active={input.active} />,
  },
];

const RIGHT_DOCK_TOOL_DEFINITION_BY_KIND = new Map(
  RIGHT_DOCK_TOOL_DEFINITIONS.map((definition) => [definition.kind, definition]),
);

export function getRightDockToolDefinition(kind: RightDockSingletonTabKind) {
  return RIGHT_DOCK_TOOL_DEFINITION_BY_KIND.get(kind);
}
