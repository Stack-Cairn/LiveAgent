import { useLocale } from "@liveagent/ui/i18n/index";
import { PaneLoadingSkeleton } from "../../../components/app/PaneLoadingSkeleton";

export function HistorySwitchLoadingOverlay() {
  const { t } = useLocale();
  const label = t("chat.loadingConversation");

  return <PaneLoadingSkeleton label={label} className="absolute inset-0 z-30" />;
}
