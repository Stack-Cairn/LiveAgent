import { useMemo } from "react";

import { getGatewayWebSocketClient } from "@/lib/gatewaySocket";
import { createGatewayGitClient } from "@/lib/git/gatewayGitClient";
import { createGatewaySftpClient } from "@/lib/sftp/gatewaySftpClient";
import { createGatewayTerminalClient } from "@/lib/terminal/gatewayTerminalClient";

type TerminalIdentitySource = () => { conversationId?: string; runId?: string } | null | undefined;

export function useGatewayClients(token: string, terminalIdentity?: TerminalIdentitySource) {
  const api = useMemo(() => (token ? getGatewayWebSocketClient(token) : null), [token]);
  const terminalClient = useMemo(
    () => (api ? createGatewayTerminalClient(api, terminalIdentity) : null),
    [api, terminalIdentity],
  );
  const sftpClient = useMemo(() => (api ? createGatewaySftpClient(api) : null), [api]);
  const gitClient = useMemo(() => (api ? createGatewayGitClient(api) : null), [api]);

  return {
    api,
    terminalClient,
    sftpClient,
    gitClient,
  };
}
