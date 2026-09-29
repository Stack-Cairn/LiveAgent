import { useState } from "react";
import ReactDOM from "react-dom/client";
import "../src/index.css";
import { LocaleContext, useLocaleContextValue } from "@liveagent/ui/i18n/index";
import { PlanningPage } from "@liveagent/ui/pages/planning/PlanningPage";
import { CalendarSection } from "@liveagent/ui/pages/settings/CalendarSection";
import { getDefaultSettings } from "@liveagent/app/lib/settings";
const q = new URLSearchParams(location.search);
if (q.get("view") || q.get("cron")) localStorage.setItem("planning.display", JSON.stringify({ view: q.get("view") ?? "week", showCronTasks: q.get("cron") === "1" }));
if (q.get("zoom")) document.documentElement.style.zoom = q.get("zoom") as string;
document.documentElement.classList.toggle("dark", q.get("theme") !== "light");
function Root() {
  const value = useLocaleContextValue(q.get("lang") === "en" ? "en-US" : "zh-CN");
  const [settings, setSettings] = useState<any>({ customSettings: { sidebarShortcuts: { skills: true, mcp: true, cron: true, planning: true, memory: true } } });
  return (
    <LocaleContext.Provider value={value}>
      {q.get("page") === "settings" ? (
        <div className="h-full overflow-auto bg-background p-10 text-foreground">
          <CalendarSection settings={settings} setSettings={(fn: any) => setSettings((p: any) => fn(p))} />
        </div>
      ) : (
        <div style={{ display: "flex", height: "100%" }} className="bg-background text-foreground"><PlanningPage /></div>
      )}
    </LocaleContext.Provider>
  );
}
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<Root />);
const later = (ms: number, fn: () => void) => setTimeout(fn, ms);
if (q.get("click")) later(1200, () => (document.querySelector(`[aria-label="${q.get("click")}"]`) as HTMLElement | null)?.click());
if (q.get("quick")) later(1500, () => {
  const col = document.querySelectorAll<HTMLElement>("[data-planning-day]")[Number(q.get("quick"))];
  if (!col) return;
  const r = col.getBoundingClientRect();
  const y = r.top + (r.height / 24) * 13.5;
  const o = { bubbles: true, clientX: r.left + 20, clientY: y, pointerId: 1, button: 0, pointerType: "mouse", isPrimary: true };
  col.dispatchEvent(new PointerEvent("pointerdown", o));
  document.dispatchEvent(new PointerEvent("pointermove", { ...o, clientY: y + (r.height / 24) * 1.5 }));
  col.dispatchEvent(new PointerEvent("pointerup", { ...o, clientY: y + (r.height / 24) * 1.5 }));
  later(400, () => {
    const input = document.querySelector<HTMLInputElement>('[data-slot=popover-content] input');
    if (!input) return;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "季度规划评审");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
});
