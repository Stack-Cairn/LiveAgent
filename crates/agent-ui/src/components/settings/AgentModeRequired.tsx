import { useLocale } from "../../i18n/index";
import { Button } from "../ui/button";

export function AgentModeRequired({ onSwitch }: { onSwitch: () => void }) {
  const { t } = useLocale();
  return (
    <section className="flex flex-col items-center gap-4 rounded-xl bg-settings-tile px-6 py-12 text-center">
      <div className="max-w-md space-y-2">
        <h3 className="text-base font-semibold text-foreground">
          {t("settings.skillsAgentModeRequired")}
        </h3>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {t("settings.skillsAgentModeExplanation")}
        </p>
      </div>
      <Button size="sm" onClick={onSwitch}>
        {t("settings.switchToAgentMode")}
      </Button>
    </section>
  );
}
