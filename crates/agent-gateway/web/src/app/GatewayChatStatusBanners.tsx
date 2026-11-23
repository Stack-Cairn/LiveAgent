import { Button } from "@liveagent/ui/components/ui/button";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useEffect, useState } from "react";
import { agentDisplayName, suggestAlternativeAgent } from "@/lib/gatewayAgentSelection";
import type { GatewayWebSocketClientLike } from "@/lib/gatewaySocket";
import { isGatewayTransportFailure } from "@/lib/gatewayTransportErrors";
import type { AgentStatus } from "@/lib/gatewayTypes";
import { GatewayConnectionBanner } from "./GatewayConnectionBanner";

const ERROR_BANNER_CLASS = cn(
  "gateway-banner-error mx-20px mt-12px mb-0",
  "rounded-xl border border-destructive/16 bg-destructive/8 px-12px py-10px text-sm text-destructive",
  "max-640:mx-10px max-640:mt-8px max-640:mb-0",
);

type AgentDirectoryApi = Pick<
  GatewayWebSocketClientLike,
  "getActiveAgent" | "setActiveAgent" | "subscribeAgents" | "listAgents"
>;

/**
 * The Agent directory as the transport knows it (filled by agent_list and
 * status events). A stored target skips the initial agent_list, so the
 * directory is fetched once the target reports offline: the banner needs the
 * target's name and an online alternative.
 */
export function useGatewayAgentDirectory(
  api: AgentDirectoryApi | null,
  targetReportedOffline: boolean,
): AgentStatus[] {
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  useEffect(() => {
    setAgents([]);
    return api?.subscribeAgents(setAgents);
  }, [api]);
  useEffect(() => {
    if (!api || !targetReportedOffline) return;
    api.listAgents().catch(() => undefined);
  }, [api, targetReportedOffline]);
  return agents;
}

export type GatewayTargetOffline = {
  name: string;
  alternative: { id: string; name: string } | null;
};

/**
 * The selected Agent is known to be offline while the Gateway itself is
 * reachable. Carries the best chat-capable alternative, if any.
 */
export function resolveGatewayTargetOffline(options: {
  agents: readonly AgentStatus[];
  activeAgentId: string;
  status: AgentStatus | null;
  gatewayDisconnected: boolean;
}): GatewayTargetOffline | null {
  const { agents, activeAgentId, status, gatewayDisconnected } = options;
  if (gatewayDisconnected || !status || status.online) return null;
  const activeId = activeAgentId.trim();
  if (!activeId) return null;
  const current = agents.find((agent) => agent.agent_id?.trim() === activeId) ?? status;
  const alternative = suggestAlternativeAgent(agents, activeId);
  return {
    name: agentDisplayName({ ...current, agent_id: activeId }),
    alternative: alternative
      ? { id: (alternative.agent_id ?? "").trim(), name: agentDisplayName(alternative) }
      : null,
  };
}

/** The selected Agent, when it is offline, and what to offer instead. */
export function useGatewayTargetOffline(
  api: AgentDirectoryApi | null,
  status: AgentStatus | null,
  gatewayDisconnected: boolean,
): GatewayTargetOffline | null {
  const agents = useGatewayAgentDirectory(api, status?.online === false && !gatewayDisconnected);
  return resolveGatewayTargetOffline({
    agents,
    activeAgentId: api?.getActiveAgent() ?? "",
    status,
    gatewayDisconnected,
  });
}

function GatewayTargetOfflineBanner({
  target,
  onSwitch,
}: {
  target: GatewayTargetOffline;
  onSwitch: (agentId: string) => void;
}) {
  const { t } = useLocale();
  const { alternative } = target;
  return (
    <div
      role="status"
      data-testid="gateway-target-offline"
      className={cn(
        "mx-20px mt-12px mb-0 flex flex-wrap items-center gap-8px rounded-xl border px-12px py-8px",
        "border-border bg-muted/50 text-sm text-foreground",
        "max-640:mx-10px max-640:mt-8px max-640:mb-0",
      )}
    >
      <span aria-hidden="true" className="size-8px shrink-0 rounded-full bg-destructive" />
      <span className="min-w-0 flex-1">
        {alternative
          ? t("gatewayWeb.target.offlineWithAlternative").replace("{name}", target.name)
          : t("gatewayWeb.target.offline").replace("{name}", target.name)}
      </span>
      {alternative ? (
        <Button type="button" size="sm" onClick={() => onSwitch(alternative.id)}>
          {t("gatewayWeb.target.switchTo").replace("{name}", alternative.name)}
        </Button>
      ) : null}
    </div>
  );
}

type GatewayChatStatusBannersProps = {
  api: AgentDirectoryApi & { retryConnectionNow(): void };
  gatewayDisconnected: boolean;
  targetOffline: GatewayTargetOffline | null;
  onSwitchAgent: (agentId: string) => void;
  statusError: string | null;
  chatProtocolIncompatibleMessage: string | null;
  settingsSyncError: string | null;
  chatError: string | null;
};

/**
 * Status rows above the chat: connection state, an offline target with a
 * one-click switch, and the remaining runtime/sync errors. Raw transport text
 * and the "agent offline" errors an offline target causes are never shown;
 * the connection and target banners explain those states.
 */
export function GatewayChatStatusBanners(props: GatewayChatStatusBannersProps) {
  const { api, gatewayDisconnected, targetOffline, onSwitchAgent } = props;
  const quiet = gatewayDisconnected || targetOffline !== null;
  const statusError =
    props.statusError && !quiet && !isGatewayTransportFailure(props.statusError)
      ? props.statusError
      : null;
  const errors = [
    statusError,
    props.chatProtocolIncompatibleMessage && !props.statusError
      ? props.chatProtocolIncompatibleMessage
      : null,
    quiet ? null : props.settingsSyncError,
    props.chatError,
  ];
  return (
    <>
      <GatewayConnectionBanner
        disconnected={gatewayDisconnected}
        onRetryNow={() => api.retryConnectionNow()}
      />
      {targetOffline ? (
        <GatewayTargetOfflineBanner
          target={targetOffline}
          onSwitch={(agentId) => {
            api.setActiveAgent(agentId);
            onSwitchAgent(agentId);
          }}
        />
      ) : null}
      {errors.map((message, index) =>
        message ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed slots, one per error source.
          <div key={index} className={ERROR_BANNER_CLASS}>
            {message}
          </div>
        ) : null,
      )}
    </>
  );
}
