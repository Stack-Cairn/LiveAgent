import { SttSettingsRequestError } from "@liveagent/ui/lib/stt/errors";
import type { SttConnectionTestResponse, SttSettingsService } from "@liveagent/ui/lib/stt/types";
import { type AppSettings, normalizeSttSettings } from "@/lib/settings";
import { loadToken } from "@/lib/storage";

function authorizationHeaders() {
  return { authorization: `Bearer ${loadToken()}` };
}

async function requestError(response: Response) {
  const body = (await response.text().catch(() => "")).trim();
  return new SttSettingsRequestError(`HTTP ${response.status}${body ? `: ${body}` : ""}`);
}

async function readSettingsResponse(response: Response) {
  if (!response.ok) throw await requestError(response);
  return normalizeSttSettings((await response.json()) as AppSettings["stt"]);
}

export function createWebSttSettingsService(
  syncDesktop?: (settings: AppSettings["stt"]) => Promise<void>,
): SttSettingsService {
  return {
    runtime: "webui",
    // Browser settings never receive stored credential values. The shared
    // password control displays the field name when the eye button is active.
    secretRevealMode: "field-name",
    async get() {
      return readSettingsResponse(
        await fetch("/api/v2/stt/settings", { headers: authorizationHeaders() }),
      );
    },
    async update(settings) {
      const redacted = await readSettingsResponse(
        await fetch("/api/v2/stt/settings", {
          method: "PUT",
          headers: { ...authorizationHeaders(), "content-type": "application/json" },
          body: JSON.stringify(settings),
        }),
      );
      await syncDesktop?.(settings);
      return redacted;
    },
    async test(provider) {
      const response = await fetch(
        `/api/v2/stt/settings/test?provider=${encodeURIComponent(provider)}`,
        { method: "POST", headers: authorizationHeaders() },
      );
      if (!response.ok) throw await requestError(response);
      return (await response.json()) as SttConnectionTestResponse;
    },
  };
}

export const webSttSettingsService = createWebSttSettingsService();
