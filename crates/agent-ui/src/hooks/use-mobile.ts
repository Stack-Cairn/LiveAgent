import { useSyncExternalStore } from "react";

// Keep the gateway's existing 820px breakpoint; native compact windows use 768px.
function query() {
  return window.matchMedia(
    document.documentElement.dataset.liveagentWebui === "gateway"
      ? "(max-width: 820px)"
      : "(max-width: 767px)",
  );
}
function subscribe(listener: () => void) {
  const media = query();
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}
function snapshot() {
  return query().matches;
}
export function useIsMobile() {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
