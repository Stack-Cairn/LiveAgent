import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { useEffect } from "react";

import type { ActivityStore } from "@/lib/chat/stream/activityStore";
import type { ChatCommandPipeline } from "@/lib/chat/stream/chatCommandPipeline";
import type { GatewayWebSocketClient } from "@/lib/gatewaySocket";
import type { AgentStatus } from "@/lib/gatewayTypes";
import { normalizeRunningConversationItems } from "@/lib/sidebar/webSidebarBackend";

import {
  type GatewaySidebarStatusFreshnessEvent,
  INITIAL_GATEWAY_SIDEBAR_STATUS_FRESHNESS,
  reduceGatewaySidebarStatusFreshness,
} from "../sidebar/gatewaySidebarAvailability";

type Options = {
  activityStore: ActivityStore;
  api: GatewayWebSocketClient | null;
  chatCommandPipeline: ChatCommandPipeline;
  setGatewayConnectionLost: Dispatch<SetStateAction<boolean>>;
  setSidebarAgentStatusFresh: Dispatch<SetStateAction<boolean>>;
  setStatus: Dispatch<SetStateAction<AgentStatus | null>>;
  setStatusError: Dispatch<SetStateAction<string | null>>;
  statusRef: MutableRefObject<AgentStatus | null>;
};

export function useGatewayTransportStatus({
  activityStore,
  api,
  chatCommandPipeline,
  setGatewayConnectionLost,
  setSidebarAgentStatusFresh,
  setStatus,
  setStatusError,
  statusRef,
}: Options) {
  useEffect(() => {
    if (!api) {
      setGatewayConnectionLost(false);
      setSidebarAgentStatusFresh(false);
      return;
    }
    let wasConnected = false;
    let freshnessState = INITIAL_GATEWAY_SIDEBAR_STATUS_FRESHNESS;
    const applyFreshnessEvent = (event: GatewaySidebarStatusFreshnessEvent) => {
      freshnessState = reduceGatewaySidebarStatusFreshness(freshnessState, event);
      setSidebarAgentStatusFresh(freshnessState.agentStatusFresh);
    };
    setGatewayConnectionLost(false);
    setSidebarAgentStatusFresh(false);
    const unsubscribeConnection = api.subscribeConnection((connected) => {
      applyFreshnessEvent({ type: "connection", connected });
      if (connected) {
        wasConnected = true;
        setGatewayConnectionLost(false);
      } else if (wasConnected) {
        setGatewayConnectionLost(true);
      }
    });
    const unsubscribeStatus = api.subscribeStatus((nextStatus, error) => {
      applyFreshnessEvent({ type: "status" });
      statusRef.current = nextStatus;
      setStatus(nextStatus);
      setStatusError(error);
    });
    return () => {
      unsubscribeConnection();
      unsubscribeStatus();
    };
  }, [
    api,
    setGatewayConnectionLost,
    setSidebarAgentStatusFresh,
    setStatus,
    setStatusError,
    statusRef,
  ]);

  useEffect(() => {
    if (!api) {
      activityStore.clear();
      return;
    }
    return api.subscribeChatActivity((event) => {
      activityStore.applyActivityEvent(event);
      if (event.runId && (event.running ? event.state !== "queued" : true)) {
        chatCommandPipeline.handleRunSignal(
          event.conversationId,
          event.runId,
          event.clientRequestId ?? undefined,
        );
      }
    });
  }, [activityStore, api, chatCommandPipeline]);

  useEffect(() => {
    if (!api) return;
    return api.subscribeChatCommandUpdates((update) => {
      chatCommandPipeline.handleCommandUpdate(update);
    });
  }, [api, chatCommandPipeline]);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    const unsubscribe = api.subscribeConnection((connected) => {
      if (!connected || cancelled) return;
      void api
        .listChatActivities()
        .then((items) => {
          if (!cancelled) {
            activityStore.hydrate(normalizeRunningConversationItems(items), {
              keepConversationIds: chatCommandPipeline.pendingConversationIds(),
            });
          }
        })
        .catch(() => undefined);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [activityStore, api, chatCommandPipeline]);
}
