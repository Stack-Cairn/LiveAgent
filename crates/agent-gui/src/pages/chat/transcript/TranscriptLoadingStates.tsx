import { useLocale } from "@liveagent/ui/i18n/index";
import { PaneLoadingSkeleton } from "../../../components/app/PaneLoadingSkeleton";

// Full-pane, opaque and hit-blocking on purpose: it sits at z-30 above every
// transcript control. ChatTranscript suspends TranscriptWidthControls for as
// long as this is mounted, so no handle hides beneath it and the handles
// return with its exit (#749).
export function HistorySwitchLoadingOverlay() {
  const { t } = useLocale();
  const label = t("chat.loadingConversation");

  return <PaneLoadingSkeleton label={label} className="absolute inset-0 z-30" />;
}
