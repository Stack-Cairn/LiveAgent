import { getNextTheme, type Theme } from "@liveagent/app/lib/settings";
import { MonitorSmartphone, Moon, Sun } from "@liveagent/ui/components/IconSet";
import { IconButton } from "@liveagent/ui/components/ui/icon-button";
import { useLocale } from "@liveagent/ui/i18n/index";

/** Cycles light → dark → system; the icon previews the theme the next click applies. */
export function ThemeToggleButton({
  theme,
  onToggle,
  className,
}: {
  theme: Theme;
  onToggle: () => void;
  className?: string;
}) {
  const { t } = useLocale();
  const next = getNextTheme(theme);
  const title =
    next === "light"
      ? t("tooltip.switchToLight")
      : next === "dark"
        ? t("tooltip.switchToDark")
        : t("tooltip.switchToAuto");
  const Icon = next === "light" ? Sun : next === "dark" ? Moon : MonitorSmartphone;
  return (
    <IconButton label={title} onClick={onToggle} className={className}>
      <Icon className="size-4" />
    </IconButton>
  );
}
