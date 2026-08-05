import { providerSupportsNativeWebSearch } from "../../providers/nativeWebSearch";
import type { ProviderId } from "../../settings";

export const PROVIDER_NATIVE_WEB_SEARCH_STATUS = "正在联网搜索...";
export const PROVIDER_NATIVE_WEB_SEARCH_STATUS_DELAY_MS = 1_200;

export function resolveProviderNativeWebSearchStatus(params: {
  providerId: ProviderId;
  api: string | undefined;
  enabled?: boolean;
  baseUrl?: string;
  modelId?: string;
}) {
  if (!params.enabled) return null;
  return providerSupportsNativeWebSearch(params.providerId, params.api, {
    baseUrl: params.baseUrl,
    modelId: params.modelId,
  })
    ? PROVIDER_NATIVE_WEB_SEARCH_STATUS
    : null;
}

export function createDeferredProviderNativeWebSearchStatus(params: {
  status: string | null;
  onStatus: (status: string | null) => void;
  delayMs?: number;
}) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let active = false;
  let armed = false;
  const delayMs = params.delayMs ?? PROVIDER_NATIVE_WEB_SEARCH_STATUS_DELAY_MS;

  const clearTimer = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  const clearActive = () => {
    if (!active) return;
    active = false;
    params.onStatus(null);
  };

  const schedule = () => {
    if (!params.status) return;
    armed = true;
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      if (!armed) return;
      active = true;
      params.onStatus(params.status);
    }, delayMs);
  };

  return {
    schedule,
    noteVisibleActivity() {
      if (!params.status || !armed) return;
      clearTimer();
      clearActive();
      schedule();
    },
    pause() {
      armed = false;
      clearTimer();
      clearActive();
    },
    finish() {
      armed = false;
      clearTimer();
      clearActive();
    },
  };
}
