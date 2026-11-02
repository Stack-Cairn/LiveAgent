import type { CodexRequestFormat, ProviderId } from "@liveagent/app/lib/settings";
import type { CustomHeader } from "@liveagent/ui/lib/providers/customHeaders";

export type ProviderModelDiscoveryInput = {
  type: ProviderId;
  requestFormat?: CodexRequestFormat;
  baseUrl: string;
  apiKey: string;
  useSystemProxy?: boolean;
  isFullUrl?: boolean;
  modelsUrl?: string;
  providerId?: string;
  customHeaders?: readonly CustomHeader[];
};
