import { useEffect, useState } from "react";
import { Check } from "@/components/icons";
import { DropdownMenuItem, DropdownMenuLabel } from "@/components/ui/dropdown-menu";
import { useLocale } from "@/i18n";
import type { GatewayWebSocketClientLike } from "@/lib/gatewaySocket";
import type { AgentStatus } from "@/lib/gatewayTypes";

function truncateMiddle(value: string, maxLength = 30): string {
  if (value.length <= maxLength) return value;
  const headLength = Math.ceil((maxLength - 1) / 2);
  const tailLength = Math.floor((maxLength - 1) / 2);
  return `${value.slice(0, headLength)}…${value.slice(-tailLength)}`;
}

function agentLabel(agent: AgentStatus): string {
  return agent.name?.trim() || agent.agent_id?.trim() || "Agent";
}

function sortAgents(agents: AgentStatus[], activeAgent: string): AgentStatus[] {
  return [...agents].sort((left, right) => {
    const leftID = left.agent_id?.trim() || "";
    const rightID = right.agent_id?.trim() || "";
    if ((leftID === activeAgent) !== (rightID === activeAgent)) {
      return leftID === activeAgent ? -1 : 1;
    }
    if (left.online !== right.online) {
      return left.online ? -1 : 1;
    }
    return agentLabel(left).localeCompare(agentLabel(right));
  });
}

// AgentSelector 渲染头像菜单内的 Agent 目录。目录由打标 status 事件与
// agent_list 响应驱动；单客户端显示身份与状态，多客户端才显示切换列表。
export function AgentSelector({
  api,
  onAgentChange,
}: {
  api: GatewayWebSocketClientLike;
  onAgentChange?: (agentId: string) => void;
}) {
  const { t } = useLocale();
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  const [activeAgent, setActiveAgent] = useState(() => api.getActiveAgent());

  useEffect(() => {
    const unsubscribe = api.subscribeAgents(setAgents);
    // 主动拉一次目录：离线/仅签发凭证的 Agent 不会有 status 事件。
    api
      .listAgents()
      .then(() => {
        const agentId = api.getActiveAgent();
        setActiveAgent(agentId);
        onAgentChange?.(agentId);
      })
      .catch(() => {
        // 目录拉取失败不阻塞页面；status 事件仍会渐进填充在线条目。
      });
    return unsubscribe;
  }, [api, onAgentChange]);

  if (agents.length === 0) {
    return null;
  }

  const handleChange = (agentId: string) => {
    setActiveAgent(agentId);
    api.setActiveAgent(agentId);
    onAgentChange?.(agentId);
  };

  const sortedAgents = sortAgents(agents, activeAgent);

  if (sortedAgents.length === 1) {
    const [agent] = sortedAgents;
    const agentID = agent.agent_id?.trim() || "";
    const name = agent.name?.trim() || "";
    const statusLabel = agent.online
      ? t("settings.devicesOnlineStatus")
      : t("settings.devicesOfflineStatus");
    return (
      <div className="px-1">
        <DropdownMenuLabel className="px-2 pb-1 pt-2 text-xs font-medium text-muted-foreground">
          {t("settings.devicesTitle")}
        </DropdownMenuLabel>
        <div className="px-2.5 pb-2.5 pt-1">
          <div className="flex min-w-0 items-center gap-2.5">
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${
                agent.online
                  ? "bg-emerald-500 shadow-[0_0_0_3px_rgb(16_185_129_/_0.12)]"
                  : "bg-rose-500 shadow-[0_0_0_3px_rgb(244_63_94_/_0.10)]"
              }`}
              title={statusLabel}
            >
              <span className="sr-only">{statusLabel}</span>
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium" title={name || agentID}>
                {name || truncateMiddle(agentID)}
              </span>
              <span className="block truncate font-mono text-[11px] text-muted-foreground">
                {truncateMiddle(agentID)}
              </span>
            </span>
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                agent.online
                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : "bg-rose-500/10 text-rose-600 dark:text-rose-400"
              }`}
            >
              {statusLabel}
            </span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <DropdownMenuLabel className="px-3 pb-1 pt-2 text-xs font-medium text-muted-foreground">
        {t("settings.devicesTitle")}
      </DropdownMenuLabel>
      <div className="max-h-64 overflow-y-auto px-1">
        {sortedAgents.map((agent) => {
          const agentID = agent.agent_id?.trim() || "";
          const name = agent.name?.trim() || "";
          const selected = agentID === activeAgent;
          const statusLabel = agent.online
            ? t("settings.devicesOnlineStatus")
            : t("settings.devicesOfflineStatus");
          return (
            <DropdownMenuItem
              key={agentID}
              aria-current={selected ? "true" : undefined}
              className="min-h-11 cursor-pointer gap-2.5 px-2.5 py-2"
              onSelect={() => handleChange(agentID)}
            >
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${
                  agent.online
                    ? "bg-emerald-500 shadow-[0_0_0_3px_rgb(16_185_129_/_0.12)]"
                    : "bg-rose-500 shadow-[0_0_0_3px_rgb(244_63_94_/_0.10)]"
                }`}
                title={statusLabel}
              >
                <span className="sr-only">{statusLabel}</span>
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium" title={name || agentID}>
                  {name || truncateMiddle(agentID)}
                </span>
                {name ? (
                  <span
                    className="block truncate font-mono text-[11px] text-muted-foreground"
                    title={agentID}
                  >
                    {truncateMiddle(agentID)}
                  </span>
                ) : null}
              </span>
              {selected ? <Check className="h-4 w-4 shrink-0 text-emerald-600" /> : null}
            </DropdownMenuItem>
          );
        })}
      </div>
    </>
  );
}
