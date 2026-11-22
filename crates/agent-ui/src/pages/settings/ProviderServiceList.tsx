import {
  type AppSettings,
  type CustomProvider,
  type ProviderId,
  updateCustomProviders,
} from "@liveagent/app/lib/settings";
import { Button } from "@liveagent/ui/components/ui/button";
import { useLocale } from "@liveagent/ui/i18n/index";
import { createUuid } from "@liveagent/ui/lib/shared/id";
import { getProviderLabel, PROVIDER_TABS, ProviderBrandIcon } from "./ProviderPresentation";

/**
 * The "choose a service" list shared by Settings > Providers and first-run
 * onboarding. Picking a type hands off to ProviderModal in the caller.
 */
export function ProviderServiceList(props: { onSelect: (type: ProviderId) => void }) {
  const { t } = useLocale();
  return (
    <>
      {PROVIDER_TABS.map((type) => (
        <Button
          key={type}
          variant="ghost"
          className="h-12 w-full justify-start gap-3 bg-settings-tile px-4 hover:bg-settings-tile-hover"
          onClick={() => props.onSelect(type)}
        >
          <ProviderBrandIcon type={type} />
          {getProviderLabel(type)} {t("settings.compatible")}
        </Button>
      ))}
    </>
  );
}

/** Appends a provider saved from ProviderModal (add flow). */
export function appendCustomProvider(
  prev: AppSettings,
  data: Omit<CustomProvider, "id">,
): AppSettings {
  return updateCustomProviders(prev, [...prev.customProviders, { id: createUuid(), ...data }]);
}
