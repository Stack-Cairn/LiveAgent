import { useMemo } from "react";
import {
  SettingsCombobox,
  type SettingsComboboxOption,
} from "../../components/settings/SettingsCombobox";
import { planningDateLocale } from "../../lib/planning/i18n";
import { usePlanningT } from "./usePlanningT";

// Intl has no localized city names; cover common zones so Chinese searches like "东京" work.
// Engines differ between canonical and legacy IDs (Asia/Kolkata vs Asia/Calcutta), so both are listed.
const ZH_CITIES: Record<string, string> = {
  "Asia/Shanghai": "上海 北京",
  "Asia/Urumqi": "乌鲁木齐",
  "Asia/Hong_Kong": "香港",
  "Asia/Macau": "澳门",
  "Asia/Taipei": "台北",
  "Asia/Tokyo": "东京",
  "Asia/Seoul": "首尔",
  "Asia/Singapore": "新加坡",
  "Asia/Kuala_Lumpur": "吉隆坡",
  "Asia/Bangkok": "曼谷",
  "Asia/Ho_Chi_Minh": "胡志明市",
  "Asia/Saigon": "胡志明市",
  "Asia/Jakarta": "雅加达",
  "Asia/Manila": "马尼拉",
  "Asia/Kolkata": "加尔各答 新德里 孟买",
  "Asia/Calcutta": "加尔各答 新德里 孟买",
  "Asia/Dubai": "迪拜",
  "Asia/Riyadh": "利雅得",
  "Asia/Jerusalem": "耶路撒冷 特拉维夫",
  "Europe/Istanbul": "伊斯坦布尔",
  "Europe/Moscow": "莫斯科",
  "Europe/London": "伦敦",
  "Europe/Dublin": "都柏林",
  "Europe/Paris": "巴黎",
  "Europe/Berlin": "柏林",
  "Europe/Amsterdam": "阿姆斯特丹",
  "Europe/Madrid": "马德里",
  "Europe/Rome": "罗马",
  "Europe/Zurich": "苏黎世",
  "Europe/Stockholm": "斯德哥尔摩",
  "America/New_York": "纽约",
  "America/Toronto": "多伦多",
  "America/Chicago": "芝加哥",
  "America/Denver": "丹佛",
  "America/Phoenix": "凤凰城",
  "America/Los_Angeles": "洛杉矶 旧金山",
  "America/Vancouver": "温哥华",
  "America/Mexico_City": "墨西哥城",
  "America/Sao_Paulo": "圣保罗",
  "America/Argentina/Buenos_Aires": "布宜诺斯艾利斯",
  "America/Buenos_Aires": "布宜诺斯艾利斯",
  "Australia/Sydney": "悉尼",
  "Australia/Melbourne": "墨尔本",
  "Australia/Perth": "珀斯",
  "Pacific/Auckland": "奥克兰",
  "Pacific/Honolulu": "檀香山",
  "Africa/Cairo": "开罗",
  "Africa/Johannesburg": "约翰内斯堡",
};

function zoneName(zone: string, locale: string, style: "shortOffset" | "longGeneric", at: Date) {
  try {
    return (
      new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: style })
        .formatToParts(at)
        .find((part) => part.type === "timeZoneName")?.value ?? ""
    );
  } catch {
    return "";
  }
}

function offsetMinutes(offset: string) {
  const match = offset.match(/([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0);
  return match[1] === "-" ? -minutes : minutes;
}

// Building ~420 options creates two Intl formatters per zone, which takes hundreds of
// milliseconds in WebKit. Cache per locale and day (offsets only change with DST) so opening
// the display settings popover does not rebuild it every time.
const optionCache = new Map<string, SettingsComboboxOption[]>();
function timeZoneOptions(locale: string) {
  const at = new Date();
  const key = `${locale}|${at.toDateString()}`;
  const cached = optionCache.get(key);
  if (cached) return cached;
  const zones = new Set<string>(
    typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [],
  );
  zones.add("UTC");
  const options = [...zones]
    .map((zone) => {
      const offset = zoneName(zone, "en-US", "shortOffset", at) || "GMT";
      const name = zoneName(zone, locale, "longGeneric", at);
      const city = locale === "zh-CN" ? ZH_CITIES[zone] : undefined;
      return {
        minutes: offsetMinutes(offset),
        option: {
          value: zone,
          label: [offset, city, name, zone].filter(Boolean).join(" · "),
        } satisfies SettingsComboboxOption,
      };
    })
    .sort((a, b) => a.minutes - b.minutes || a.option.value.localeCompare(b.option.value))
    .map(({ option }) => option);
  optionCache.clear();
  optionCache.set(key, options);
  return options;
}

/** Warm the cache while the browser is idle, before the picker is first opened. */
export function preloadTimeZoneOptions(locale: string) {
  const run = () => timeZoneOptions(locale);
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(run, { timeout: 3000 });
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(run, 500);
  return () => clearTimeout(id);
}

/** Searchable IANA time zone list, ordered by current UTC offset. */
function useTimeZoneOptions(current: string, locale: string) {
  return useMemo(() => {
    const options = timeZoneOptions(locale);
    return !current || options.some((option) => option.value === current)
      ? options
      : [{ value: current, label: current }, ...options];
  }, [current, locale]);
}

export function TimeZonePicker({
  value,
  onChange,
  label,
  id,
  disabled,
}: {
  value: string;
  onChange(zone: string): void;
  label: string;
  id?: string;
  disabled?: boolean;
}) {
  const { t, locale } = usePlanningT();
  const options = useTimeZoneOptions(value, planningDateLocale(locale));
  return (
    <SettingsCombobox
      value={value}
      options={options}
      onValueChange={onChange}
      ariaLabel={label}
      searchPlaceholder={t("planner.zone.search")}
      emptyLabel={t("planner.zone.empty")}
      triggerClassName="w-full max-w-none"
      disabled={disabled}
      id={id}
    />
  );
}
