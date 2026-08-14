import { t as translate } from "@liveagent/ui/i18n/index";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { useCallback, useEffect } from "react";

import { isChatRuntimeProtocolIncompatible } from "@/lib/chat/runtimeCompatibility";
import type { GatewayWebSocketClient } from "@/lib/gatewaySocket";
import type { AgentStatus } from "@/lib/gatewayTypes";
import type { AppSettings } from "@/lib/settings";

import { asErrorMessage } from "../chatEventUtils";
import {
  CHAT_RUNTIME_FOREGROUND_PREPARE_TIMEOUT_MS,
  CHAT_RUNTIME_KEEP_WARM_INTERVAL_MS,
  CHAT_RUNTIME_PREPARE_TIMEOUT_MS,
} from "../constants";

type UseGatewayRuntimePreparationOptions = {
  api: GatewayWebSocketClient | null;
  historyShareToken: string | null;
  locale: AppSettings["locale"];
  preparePromiseRef: MutableRefObject<Promise<AgentStatus> | null>;
  setStatus: Dispatch<SetStateAction<AgentStatus | null>>;
  setStatusError: Dispatch<SetStateAction<string | null>>;
  statusOnline?: boolean;
  statusRef: MutableRefObject<AgentStatus | null>;
};

export function useGatewayRuntimePreparation({
  api,
  historyShareToken,
  locale,
  preparePromiseRef,
  setStatus,
  setStatusError,
  statusOnline,
  statusRef,
}: UseGatewayRuntimePreparationOptions) {
  const prepareChatRuntime = useCallback(
    async (
      reason: string,
      currentApi = api,
      timeoutMs = CHAT_RUNTIME_PREPARE_TIMEOUT_MS,
    ): Promise<AgentStatus> => {
      if (!currentApi) throw new Error("Gateway client is not ready.");
      if (!preparePromiseRef.current) {
        preparePromiseRef.current = currentApi
          .prepareChatRuntime(reason)
          .then((nextStatus) => {
            statusRef.current = nextStatus;
            setStatus(nextStatus);
            setStatusError(null);
            if (isChatRuntimeProtocolIncompatible(nextStatus)) {
              throw new Error(translate("chat.runtime.protocolIncompatible", locale));
            }
            return nextStatus;
          })
          .catch((error) => {
            setStatusError(asErrorMessage(error, "status request failed"));
            throw error;
          })
          .finally(() => {
            preparePromiseRef.current = null;
          });
      }
      const preparePromise = preparePromiseRef.current;
      if (!preparePromise) throw new Error("Gateway chat runtime preparation did not start.");
      if (timeoutMs <= 0) return preparePromise;

      let timeoutId: number | null = null;
      try {
        return await Promise.race([
          preparePromise,
          new Promise<AgentStatus>((_, reject) => {
            timeoutId = window.setTimeout(() => {
              reject(new Error("Desktop chat runtime is recovering. Please retry shortly."));
            }, timeoutMs);
          }),
        ]);
      } finally {
        if (timeoutId !== null) window.clearTimeout(timeoutId);
      }
    },
    [api, locale, preparePromiseRef, setStatus, setStatusError, statusRef],
  );

  useEffect(() => {
    if (!api || historyShareToken || statusOnline !== true) return;
    const nudgeRuntime = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void prepareChatRuntime("foreground", api, CHAT_RUNTIME_FOREGROUND_PREPARE_TIMEOUT_MS).catch(
        () => undefined,
      );
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") nudgeRuntime();
    };
    window.addEventListener("pageshow", nudgeRuntime);
    window.addEventListener("focus", nudgeRuntime);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    document.addEventListener("resume", nudgeRuntime);
    nudgeRuntime();
    return () => {
      window.removeEventListener("pageshow", nudgeRuntime);
      window.removeEventListener("focus", nudgeRuntime);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      document.removeEventListener("resume", nudgeRuntime);
    };
  }, [api, historyShareToken, prepareChatRuntime, statusOnline]);

  useEffect(() => {
    if (!api || historyShareToken || statusOnline !== true) return;
    const keepWarm = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void prepareChatRuntime("keep-warm", api, CHAT_RUNTIME_FOREGROUND_PREPARE_TIMEOUT_MS).catch(
        () => undefined,
      );
    };
    keepWarm();
    const intervalId = window.setInterval(keepWarm, CHAT_RUNTIME_KEEP_WARM_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [api, historyShareToken, prepareChatRuntime, statusOnline]);

  return prepareChatRuntime;
}
