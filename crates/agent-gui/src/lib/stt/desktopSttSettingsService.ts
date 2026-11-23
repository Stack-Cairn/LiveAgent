import { invoke } from "@liveagent/app/shims/tauriCore";
import { SttSettingsRequestError } from "@liveagent/ui/lib/stt/errors";
import type {
  SttConnectionTestResponse,
  SttSecretField,
  SttSettingsService,
} from "@liveagent/ui/lib/stt/types";
import { type AppSettings, normalizeSttSettings } from "../../lib/settings";

export const desktopSttSettingsService: SttSettingsService = {
  runtime: "desktop",
  secretRevealMode: "value",
  revealSecret(provider, field: SttSecretField) {
    return invoke<string>("settings_reveal_stt_secret", { provider, field });
  },
  async get() {
    const response = await invoke<{ stt?: AppSettings["stt"] }>("settings_load_all");
    if (!response.stt)
      throw new SttSettingsRequestError("settings_load_all returned no stt section");
    return normalizeSttSettings(response.stt);
  },
  async update(settings) {
    return normalizeSttSettings(
      await invoke<AppSettings["stt"]>("settings_save_stt", { payload: settings }),
    );
  },
  async test(provider) {
    return invoke<SttConnectionTestResponse>("settings_test_stt", {
      provider,
    });
  },
};
