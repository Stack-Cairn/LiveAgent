import { useState } from "react";
import { createRoot } from "react-dom/client";
import "@liveagent/app/index.css";
import { t } from "@liveagent/app/i18n/config";
import { LocaleContext } from "@liveagent/ui/i18n/LocaleContext";
import { AIApprovalSection } from "@liveagent/ui/pages/settings/AIApprovalSection";
import { KBrainComputerSection } from "@liveagent/ui/pages/settings/KBrainComputerSection";
import type { KBrainSettingsAdapter, KBrainSettingsDocument } from "@liveagent/ui/pages/settings/kbrainSettingsAdapter";

// Browser-only fixture; requests are intercepted by the acceptance script.
const kbrain: KBrainSettingsAdapter = {
  isKbrain: true,
  runtimeConnection: () => null,
  getConnection: () => new URLSearchParams(location.search).has("web") ? null : ({ baseUrl: location.origin, token: "fixture" }),
  getSettings: () => request(),
  updateSettings: (update) => request(update),
};
async function request(update?: unknown): Promise<KBrainSettingsDocument> {
  const response = await fetch("/fixture/settings", update ? { method: "PUT", headers: {"Content-Type":"application/json"}, body: JSON.stringify(update) } : undefined);
  const body = await response.json();
  if (!response.ok) throw Error(body.error);
  return body;
}
function App() {
  const [locale, setLocale] = useState<"zh-CN" | "en-US">("zh-CN");
  const computer = new URLSearchParams(location.search).has("computer");
  return <LocaleContext.Provider value={{ locale, t: (key) => t(key, locale) }}>
    <main data-surface="desktop" className="mx-auto max-w-3xl space-y-4 p-4">
      <header className="text-sm">Isolated browser fixture — no model calls <button onClick={() => setLocale(locale === "zh-CN" ? "en-US" : "zh-CN")}>Language</button></header>
      {computer ? <KBrainComputerSection kbrain={kbrain}/> : <AIApprovalSection kbrain={kbrain}/>}
    </main>
  </LocaleContext.Provider>;
}
createRoot(document.getElementById("root")!).render(<App/>);
