import type { TerminalClient, TerminalRequestIdentity } from "@liveagent/ui/lib/terminal/types";
import type { GatewayWebSocketClientLike } from "@/lib/gatewaySocket";

type TerminalIdentitySource = () => Partial<TerminalRequestIdentity> | null | undefined;

function canonicalIdentity(source?: TerminalIdentitySource) {
  const identity = source?.();
  const conversationId = identity?.conversationId?.trim() ?? "";
  const runId = identity?.runId?.trim() ?? "";
  return conversationId && runId ? { conversationId, runId } : undefined;
}

export function createGatewayTerminalClient(
  api: GatewayWebSocketClientLike,
  identitySource?: TerminalIdentitySource,
): TerminalClient {
  return {
    shellOptions() {
      return api.terminalShellOptions();
    },
    list(projectPathKey, identity) {
      const canonical = canonicalIdentity(() => ({
        ...canonicalIdentity(identitySource),
        ...identity,
      }));
      return api.listTerminals(canonical ? { projectPathKey, ...canonical } : projectPathKey);
    },
    create(params) {
      const identity = canonicalIdentity(() => ({
        ...canonicalIdentity(identitySource),
        ...params,
      }));
      return api.createTerminal(identity ? { ...params, ...identity } : params);
    },
    createSsh(params) {
      return api.createSshTerminal(params);
    },
    answerSshPrompt(params) {
      return api.answerSshTerminalPrompt(params);
    },
    async cancelSshPrompt(promptId) {
      await api.cancelSshTerminalPrompt(promptId);
    },
    sshReconnect(sessionId, projectPathKey) {
      return api.reconnectSshTerminal(sessionId, projectPathKey);
    },
    sshLatency(sessionId, projectPathKey) {
      return api.sshTerminalLatency(sessionId, projectPathKey);
    },
    listSshTerminalTabs(projectPathKey) {
      return api.listSshTerminalTabs(projectPathKey);
    },
    openSshTerminalTab(params) {
      return api.openSshTerminalTab(params);
    },
    closeSshTerminalTab(tabId) {
      return api.closeSshTerminalTab(tabId);
    },
    rename(sessionId, title, projectPathKey) {
      return api.renameTerminal(sessionId, title, projectPathKey);
    },
    close(sessionId, projectPathKey) {
      return api.closeTerminal(sessionId, projectPathKey);
    },
    closeProject(projectPathKey) {
      return api.closeProjectTerminals(projectPathKey);
    },
    subscribe(listener) {
      return api.subscribeTerminal(listener);
    },
    stream: api.terminalStream,
  };
}
