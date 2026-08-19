import type {
  SttConnectionTestResponse,
  SttSecretField,
  SttSettingsService,
} from "@liveagent/ui/lib/stt/types";
import { invoke } from "@tauri-apps/api/core";
import { type AppSettings, normalizeSttSettings } from "../../lib/settings";

export const desktopSttSettingsService: SttSettingsService = {
  runtimeLabel: "桌面端（同步到 Gateway WebUI）",
  secretRevealMode: "value",
  revealSecret(provider, field: SttSecretField) {
    return invoke<string>("settings_reveal_stt_secret", { provider, field });
  },
  async get() {
    const response = await invoke<{ stt?: AppSettings["stt"] }>("settings_load_all");
    if (!response.stt) throw new Error("无法读取 STT 配置");
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
