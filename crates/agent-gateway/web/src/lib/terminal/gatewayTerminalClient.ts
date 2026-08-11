import type { TerminalClient } from "@liveagent/ui/lib/terminal/types";
import type { GatewayWebSocketClientLike } from "@/lib/gatewaySocket";

export function createGatewayTerminalClient(api: GatewayWebSocketClientLike): TerminalClient {
  return {
    shellOptions() {
      return api.terminalShellOptions();
    },
    list(projectPathKey) {
      return api.listTerminals(projectPathKey);
    },
    create(params) {
      return api.createTerminal(params);
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
