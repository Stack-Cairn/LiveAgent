import { invoke } from "@liveagent/app/shims/tauriCore";
import { isKBrainBrowserHost } from "./host";

/**
 * Whether the first-run guide may open on its own. The test harness turns it
 * off so specs never race the guide's startup decision: through
 * `LIVEAGENT_SKIP_ONBOARDING=1` for a debug desktop build, or the build-time
 * `VITE_LIVEAGENT_SKIP_ONBOARDING=1` (passed in as `browserSkipFlag`) for the
 * browser host. Anything unexpected keeps the guide on.
 */
export async function resolveOnboardingAutoStart(browserSkipFlag: unknown): Promise<boolean> {
  if (isKBrainBrowserHost()) return browserSkipFlag !== "1";
  try {
    return (await invoke<boolean>("app_onboarding_auto_start")) !== false;
  } catch {
    return true;
  }
}
