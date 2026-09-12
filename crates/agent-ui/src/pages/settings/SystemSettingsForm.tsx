import {
  buildFontFamilySelectOptions,
  FONT_FAMILY_CUSTOM_SELECT_VALUE,
  FONT_FAMILY_DEFAULT_SELECT_VALUE,
  fromFontFamilySelectValue,
  listLocalFontFamilies,
  SystemSettingsExtensions,
  toFontFamilySelectValue,
} from "@liveagent/adapters/systemSettings";
import {
  type ExecutionMode,
  type FontScaleSettings,
  isValidSystemProxyHost,
  type SystemProxyConfig,
  type SystemProxyType,
  THEME_OPTIONS,
  type Theme,
  updateCustomSettings,
  updateSystem,
} from "@liveagent/app/lib/settings";
import type { SettingsSectionProps } from "@liveagent/app/pages/settings/types";
import { Settings2 } from "@liveagent/ui/components/IconSet";
import { FormField, FormFieldLabel } from "@liveagent/ui/components/settings/FormField";
import {
  SettingsCombobox,
  type SettingsComboboxOption,
} from "@liveagent/ui/components/settings/SettingsCombobox";
import {
  SettingsSelectContent,
  SettingsSelectTrigger,
} from "@liveagent/ui/components/settings/SettingsSelect";
import {
  SettingsToggleGroup,
  SettingsToggleGroupItem,
} from "@liveagent/ui/components/settings/SettingsToggleGroup";
import { Button } from "@liveagent/ui/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@liveagent/ui/components/ui/dialog";
import { Input } from "@liveagent/ui/components/ui/input";
import { Select, SelectItem, SelectValue } from "@liveagent/ui/components/ui/select";
import { type Locale, SUPPORTED_LOCALES, useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import {
  AgentActivationSwitch,
  SettingsGroup,
  SettingsRow,
} from "@liveagent/ui/pages/settings/shared";
import { type ReactNode, useEffect, useMemo, useState } from "react";

import { SidebarShortcutsSection } from "./SidebarShortcutsSection";

const FONT_SCALE_OPTIONS = [0.9, 1, 1.1, 1.2] as const;
type FontFamilySettingKey = "interfaceFontFamily" | "chatFontFamily" | "codeFontFamily";

const FONT_FAMILY_FIELDS: ReadonlyArray<{ key: FontFamilySettingKey; labelKey: string }> = [
  { key: "interfaceFontFamily", labelKey: "settings.interfaceFontFamily" },
  { key: "chatFontFamily", labelKey: "settings.chatFontFamily" },
  { key: "codeFontFamily", labelKey: "settings.codeFontFamily" },
];

type ProxySettingsRowProps = {
  title: string;
  description: string;
  actionLabel: string;
  expanded: boolean;
  switchControl: ReactNode;
  onToggleDetails: () => void;
};

function ProxySettingsRow({
  title,
  description,
  actionLabel,
  expanded,
  switchControl,
  onToggleDetails,
}: ProxySettingsRowProps) {
  return (
    <div
      className={cn(
        "flex min-h-18 flex-col gap-3 rounded-xl bg-settings-tile px-4 py-3.5",
        "sm:flex-row sm:items-center",
      )}
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-haspopup="dialog"
        aria-controls="system-proxy-details"
        onClick={onToggleDetails}
        className={cn(
          "group flex min-w-0 flex-1 items-center justify-between gap-4",
          "rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-foreground/10",
        )}
      >
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-foreground">{title}</span>
          <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
            {description}
          </span>
        </span>
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5",
            "rounded-lg bg-background px-3 py-2",
            "text-xs font-medium text-foreground/80 transition-colors duration-150 group-hover:bg-settings-tile-hover",
          )}
        >
          <Settings2 className="size-3.5 text-muted-foreground" />
          <span>{actionLabel}</span>
        </span>
      </button>
      <div className="flex shrink-0 items-center sm:pl-2">{switchControl}</div>
    </div>
  );
}

export function SystemSettingsForm(props: SettingsSectionProps) {
  const { settings, setSettings } = props;
  const { t } = useLocale();

  const executionMode = settings.system.executionMode;

  const executionModeOptions: Array<{
    value: ExecutionMode;
    label: string;
    description: string;
  }> = [
    {
      value: "text",
      label: t("settings.chatMode"),
      description: t("settings.chatModeDesc"),
    },
    {
      value: "tools",
      label: t("settings.agentMode"),
      description: t("settings.agentModeDesc"),
    },
    {
      value: "agent-dev",
      label: t("settings.agentDevMode"),
      description: t("settings.agentDevModeDesc"),
    },
  ];
  const activeExecutionMode =
    executionModeOptions.find((option) => option.value === executionMode) ??
    executionModeOptions[0];

  function getThemeLabel(theme: Theme) {
    if (theme === "light") return t("settings.light");
    if (theme === "dark") return t("settings.dark");
    return t("settings.auto");
  }

  const fontScale = settings.customSettings.fontScale;
  const fontScaleZones: Array<{ key: keyof FontScaleSettings; label: string }> = [
    { key: "sidebar", label: t("settings.fontSizeSidebar") },
    { key: "chat", label: t("settings.fontSizeChat") },
    { key: "rightDock", label: t("settings.fontSizeRightDock") },
  ];

  function getFontScaleLabel(value: number) {
    if (value === 0.9) return t("settings.fontSizeSmall");
    if (value === 1.1) return t("settings.fontSizeLarge");
    if (value === 1.2) return t("settings.fontSizeXLarge");
    return t("settings.fontSizeStandard");
  }

  const [localFontFamilies, setLocalFontFamilies] = useState<string[]>([]);
  const [customFontDrafts, setCustomFontDrafts] = useState<
    Partial<Record<FontFamilySettingKey, string>>
  >({});
  const [customFontModes, setCustomFontModes] = useState<
    Partial<Record<FontFamilySettingKey, boolean>>
  >({});
  const fontFamilyOptions = useMemo(
    () => buildFontFamilySelectOptions(localFontFamilies),
    [localFontFamilies],
  );
  const fontFamilyComboboxOptions = useMemo<SettingsComboboxOption[]>(
    () => [
      {
        value: FONT_FAMILY_DEFAULT_SELECT_VALUE,
        label: t("settings.fontFamilyDefault"),
      },
      {
        value: FONT_FAMILY_CUSTOM_SELECT_VALUE,
        label: t("settings.fontFamilyCustom"),
      },
      ...fontFamilyOptions.map((option) => ({
        ...option,
        style: { fontFamily: option.value },
      })),
    ],
    [fontFamilyOptions, t],
  );

  useEffect(() => {
    let cancelled = false;
    void listLocalFontFamilies().then((families) => {
      if (!cancelled) setLocalFontFamilies(families);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setCustomFontDrafts((current) => {
      let changed = false;
      const next = { ...current };
      for (const { key } of FONT_FAMILY_FIELDS) {
        if (Object.hasOwn(current, key)) continue;
        const value = settings.customSettings[key];
        if (toFontFamilySelectValue(value, fontFamilyOptions) === FONT_FAMILY_CUSTOM_SELECT_VALUE) {
          next[key] = value;
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [fontFamilyOptions, settings.customSettings]);

  function commitFontFamily(key: FontFamilySettingKey, value: string) {
    setSettings((prev) => updateCustomSettings(prev, { [key]: value }));
  }

  function handleFontFamilySelect(key: FontFamilySettingKey, selectValue: string) {
    if (selectValue === FONT_FAMILY_CUSTOM_SELECT_VALUE) {
      setCustomFontModes((current) => ({ ...current, [key]: true }));
      setCustomFontDrafts((current) => ({
        ...current,
        [key]: current[key] ?? settings.customSettings[key],
      }));
      return;
    }

    setCustomFontModes((current) => {
      if (!Object.hasOwn(current, key)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
    setCustomFontDrafts((current) => {
      if (!Object.hasOwn(current, key)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
    commitFontFamily(key, fromFontFamilySelectValue(selectValue));
  }

  function commitCustomFontFamily(key: FontFamilySettingKey) {
    const draft = customFontDrafts[key] ?? settings.customSettings[key];
    const normalized = fromFontFamilySelectValue(draft);
    // Empty custom input falls back to the built-in stack.
    commitFontFamily(key, normalized);
    setCustomFontDrafts((current) => {
      if (!Object.hasOwn(current, key)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
    if (!normalized) {
      setCustomFontModes((current) => {
        if (!Object.hasOwn(current, key)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
    }
  }

  function setZoneFontScale(zone: keyof FontScaleSettings, value: number) {
    setSettings((prev) =>
      updateCustomSettings(prev, {
        fontScale: { ...prev.customSettings.fontScale, [zone]: value },
      }),
    );
  }

  const systemProxy = settings.system.systemProxy;
  // host/port/username/password 走"本地草稿 + blur 提交"：失焦才写入 settings，
  // 避免逐字符触发同步；且 WebUI 设置 state 持久前会脱敏密码，草稿避免输入即被清空。
  const [proxyHostDraft, setProxyHostDraft] = useState<string | null>(null);
  const [proxyPortDraft, setProxyPortDraft] = useState<string | null>(null);
  const [proxyUsernameDraft, setProxyUsernameDraft] = useState<string | null>(null);
  const [proxyPasswordDraft, setProxyPasswordDraft] = useState<string | null>(null);
  // 护栏 A：host + port 有效才算配置可用（端口在启用时必填有效）。
  // 用"草稿优先"的生效值计算：blur 提交前开关若仍禁用，点击开关触发的 blur
  // 会先把按钮变回可用，但落在禁用按钮上的这次 click 已被浏览器吞掉，需点两次。
  const effectiveProxyHost = (proxyHostDraft ?? systemProxy.host).trim();
  const effectiveProxyPort =
    proxyPortDraft !== null ? Number.parseInt(proxyPortDraft, 10) : systemProxy.port;
  const proxyConfigValid =
    isValidSystemProxyHost(effectiveProxyHost) &&
    Number.isInteger(effectiveProxyPort) &&
    effectiveProxyPort >= 1 &&
    effectiveProxyPort <= 65535;
  const systemProxyInvalid = systemProxy.enabled && !proxyConfigValid;
  // 配置无效且当前未启用时禁止开启开关（护栏 A）；已启用时始终允许关闭。
  const proxyNeedsConfiguration = !systemProxy.enabled && !proxyConfigValid;
  const [proxyDetailsOpen, setProxyDetailsOpen] = useState(false);

  function handleProxyDialogOpenChange(open: boolean) {
    if (!open) {
      commitProxyHostDraft();
      commitProxyPortDraft();
      commitProxyUsernameDraft();
      commitProxyPasswordDraft();
    }
    setProxyDetailsOpen(open);
  }

  function patchSystemProxy(patch: Partial<SystemProxyConfig>) {
    setSettings((prev) =>
      updateSystem(prev, {
        systemProxy: { ...prev.system.systemProxy, ...patch },
      }),
    );
  }

  function commitProxyHostDraft() {
    if (proxyHostDraft !== null) {
      patchSystemProxy({ host: proxyHostDraft.trim() });
      setProxyHostDraft(null);
    }
  }

  function commitProxyPortDraft(nextDraft = proxyPortDraft) {
    if (nextDraft !== null) {
      const parsed = Number.parseInt(nextDraft, 10);
      patchSystemProxy({ port: Number.isNaN(parsed) ? 0 : parsed });
      setProxyPortDraft(null);
    }
  }

  function commitProxyUsernameDraft() {
    if (proxyUsernameDraft !== null) {
      patchSystemProxy({ username: proxyUsernameDraft.trim() });
      setProxyUsernameDraft(null);
    }
  }

  function commitProxyPasswordDraft() {
    if (proxyPasswordDraft !== null) {
      patchSystemProxy({ password: proxyPasswordDraft });
      setProxyPasswordDraft(null);
    }
  }

  return (
    <div className="settings-system-section space-y-8 pb-10">
      <SettingsGroup title={t("settings.executionMode")}>
        <SettingsRow
          title={t("settings.defaultExecutionMode")}
          description={activeExecutionMode.description}
          control={
            <Select
              value={executionMode}
              onValueChange={(value) =>
                setSettings((prev) => updateSystem(prev, { executionMode: value as ExecutionMode }))
              }
            >
              <SettingsSelectTrigger className="min-w-36 justify-between">
                <SelectValue>{activeExecutionMode.label}</SelectValue>
              </SettingsSelectTrigger>
              <SettingsSelectContent>
                {executionModeOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SettingsSelectContent>
            </Select>
          }
        />
      </SettingsGroup>

      <SettingsGroup title={t("settings.groupGeneral")}>
        <SettingsRow
          title={t("settings.appearance")}
          description={t("settings.appearanceDesc")}
          control={
            <SettingsToggleGroup
              value={[settings.theme]}
              aria-label={t("settings.appearance")}
              onValueChange={(values) => {
                const theme = THEME_OPTIONS.find((option) => option === values[0]);
                if (theme) setSettings((prev) => ({ ...prev, theme }));
              }}
            >
              {THEME_OPTIONS.map((theme) => (
                <SettingsToggleGroupItem key={theme} value={theme}>
                  {getThemeLabel(theme)}
                </SettingsToggleGroupItem>
              ))}
            </SettingsToggleGroup>
          }
        />

        <SettingsRow
          title={t("settings.language")}
          control={
            <Select
              value={settings.locale}
              onValueChange={(locale) =>
                setSettings((prev) => ({ ...prev, locale: locale as Locale }))
              }
            >
              <SettingsSelectTrigger>
                <SelectValue>
                  {settings.locale === "zh-CN" ? "🇨🇳  简体中文" : "🇺🇸  English"}
                </SelectValue>
              </SettingsSelectTrigger>
              <SettingsSelectContent>
                {SUPPORTED_LOCALES.map((locale) => (
                  <SelectItem key={locale} value={locale}>
                    {locale === "zh-CN"
                      ? `🇨🇳  ${t("settings.chinese")}`
                      : `🇺🇸  ${t("settings.english")}`}
                  </SelectItem>
                ))}
              </SettingsSelectContent>
            </Select>
          }
        />
      </SettingsGroup>

      <SidebarShortcutsSection settings={settings} setSettings={setSettings} />

      <SettingsGroup title={t("settings.systemProxy")}>
        <div>
          <ProxySettingsRow
            title={t("settings.systemProxyEnable")}
            description={
              systemProxy.enabled && proxyConfigValid
                ? `${systemProxy.type === "socks5" ? "SOCKS5" : "HTTP"} · ${effectiveProxyHost}:${effectiveProxyPort}`
                : systemProxy.enabled
                  ? t("settings.systemProxyInvalid")
                  : t("settings.systemProxyDisabled")
            }
            actionLabel={t("settings.systemProxySettings")}
            expanded={proxyDetailsOpen}
            onToggleDetails={() => setProxyDetailsOpen((open) => !open)}
            switchControl={
              <AgentActivationSwitch
                checked={systemProxy.enabled}
                title={t(
                  proxyNeedsConfiguration
                    ? "settings.systemProxySettings"
                    : "settings.systemProxyEnable",
                )}
                onToggle={() => {
                  if (proxyNeedsConfiguration) {
                    setProxyDetailsOpen(true);
                    return;
                  }
                  patchSystemProxy({ enabled: !systemProxy.enabled });
                }}
              />
            }
          />

          <Dialog open={proxyDetailsOpen} onOpenChange={handleProxyDialogOpenChange}>
            <DialogContent
              id="system-proxy-details"
              className="flex max-h-[calc(100dvh-2rem)] max-w-lg flex-col"
              showCloseButton
            >
              <DialogHeader>
                <DialogTitle>{t("settings.systemProxySettings")}</DialogTitle>
                <DialogDescription>{t("settings.systemProxyDialogDesc")}</DialogDescription>
              </DialogHeader>
              <DialogBody>
                {systemProxyInvalid || proxyNeedsConfiguration ? (
                  <p
                    className={cn(
                      "mb-4 text-xs leading-relaxed",
                      systemProxyInvalid ? "text-destructive" : "text-muted-foreground",
                    )}
                  >
                    {systemProxyInvalid
                      ? t("settings.systemProxyInvalid")
                      : t("settings.systemProxyEnableHint")}
                  </p>
                ) : null}

                <div className="space-y-4">
                  <FormField density="compact">
                    <FormFieldLabel htmlFor="system-proxy-type" size="compact" className="block">
                      {t("settings.systemProxyType")}
                    </FormFieldLabel>
                    <Select
                      value={systemProxy.type}
                      onValueChange={(value) =>
                        patchSystemProxy({ type: value as SystemProxyType })
                      }
                    >
                      <SettingsSelectTrigger
                        id="system-proxy-type"
                        className="flex h-9 w-full justify-between rounded-lg bg-settings-tile-hover px-3 shadow-none"
                      >
                        <SelectValue>
                          {systemProxy.type === "socks5" ? "SOCKS5" : "HTTP"}
                        </SelectValue>
                      </SettingsSelectTrigger>
                      <SettingsSelectContent>
                        <SelectItem value="http">HTTP</SelectItem>
                        <SelectItem value="socks5">SOCKS5</SelectItem>
                      </SettingsSelectContent>
                    </Select>
                  </FormField>
                  <FormField density="compact">
                    <FormFieldLabel htmlFor="system-proxy-host" size="compact">
                      {t("settings.systemProxyHost")}
                    </FormFieldLabel>
                    <Input
                      variant="plain"
                      id="system-proxy-host"
                      className="rounded-lg"
                      value={proxyHostDraft ?? systemProxy.host}
                      placeholder="127.0.0.1"
                      onChange={(event) => setProxyHostDraft(event.currentTarget.value)}
                      onBlur={commitProxyHostDraft}
                    />
                  </FormField>
                  <FormField density="compact">
                    <FormFieldLabel htmlFor="system-proxy-port" size="compact">
                      {t("settings.systemProxyPort")}
                    </FormFieldLabel>
                    <Input
                      variant="plain"
                      id="system-proxy-port"
                      className="rounded-lg"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={65535}
                      step={1}
                      value={
                        proxyPortDraft ?? (systemProxy.port > 0 ? String(systemProxy.port) : "")
                      }
                      placeholder={systemProxy.type === "socks5" ? "1080" : "7890"}
                      onChange={(event) => setProxyPortDraft(event.currentTarget.value)}
                      onBlur={() => commitProxyPortDraft()}
                    />
                  </FormField>
                </div>

                <div className="mt-4 space-y-4">
                  <FormField density="compact">
                    <FormFieldLabel htmlFor="system-proxy-username" size="compact">
                      {t("settings.systemProxyUsername")}
                    </FormFieldLabel>
                    <Input
                      variant="plain"
                      id="system-proxy-username"
                      className="rounded-lg"
                      value={proxyUsernameDraft ?? systemProxy.username}
                      onChange={(event) => setProxyUsernameDraft(event.currentTarget.value)}
                      onBlur={commitProxyUsernameDraft}
                    />
                  </FormField>
                  <FormField density="compact">
                    <FormFieldLabel htmlFor="system-proxy-password" size="compact">
                      {t("settings.systemProxyPassword")}
                    </FormFieldLabel>
                    <Input
                      variant="plain"
                      id="system-proxy-password"
                      className="rounded-lg"
                      type="password"
                      value={proxyPasswordDraft ?? systemProxy.password}
                      onChange={(event) => setProxyPasswordDraft(event.currentTarget.value)}
                      onBlur={commitProxyPasswordDraft}
                    />
                    {systemProxy.passwordConfigured &&
                    !(proxyPasswordDraft ?? systemProxy.password).trim() ? (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span>{t("settings.systemProxyPasswordConfigured")}</span>
                        <button
                          type="button"
                          className="underline-offset-2 hover:text-foreground hover:underline"
                          onClick={() => {
                            setProxyPasswordDraft(null);
                            patchSystemProxy({ password: "", passwordConfigured: false });
                          }}
                        >
                          {t("settings.systemProxyPasswordClear")}
                        </button>
                      </div>
                    ) : null}
                  </FormField>
                </div>
                <details className="mt-4 text-xs text-muted-foreground">
                  <summary className="cursor-pointer rounded py-1 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    {t("settings.systemProxyScope")}
                  </summary>
                  <p className="mt-2 leading-relaxed">{t("settings.systemProxyDesc")}</p>
                </details>
              </DialogBody>
              <DialogFooter>
                <Button onClick={() => handleProxyDialogOpenChange(false)}>
                  {t("settings.systemProxyDone")}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </SettingsGroup>

      <SystemSettingsExtensions settings={settings} setSettings={setSettings} />

      <SettingsGroup title={t("settings.fontFamily")}>
        {FONT_FAMILY_FIELDS.map(({ key, labelKey }) => {
          const currentValue = settings.customSettings[key];
          const selectValue = toFontFamilySelectValue(
            currentValue,
            fontFamilyOptions,
            customFontModes[key] === true,
          );
          const showCustomInput = selectValue === FONT_FAMILY_CUSTOM_SELECT_VALUE;
          const customDraft = customFontDrafts[key] ?? currentValue;
          return (
            <SettingsRow
              key={key}
              title={t(labelKey)}
              control={
                <div className="flex w-full min-w-0 flex-col items-start gap-2 sm:w-auto sm:items-end">
                  <SettingsCombobox
                    value={selectValue}
                    options={fontFamilyComboboxOptions}
                    ariaLabel={t(labelKey)}
                    searchPlaceholder={t("settings.fontFamilySearchPlaceholder")}
                    emptyLabel={t("settings.fontFamilyNoResults")}
                    onValueChange={(value) => handleFontFamilySelect(key, value)}
                  />
                  {showCustomInput ? (
                    <Input
                      id={`${key}-custom-input`}
                      className="w-full min-w-0 rounded-xl sm:w-240px"
                      value={customDraft}
                      list="font-family-suggestions"
                      spellCheck={false}
                      autoComplete="off"
                      placeholder={t("settings.fontFamilyPlaceholder")}
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        setCustomFontDrafts((current) => ({
                          ...current,
                          [key]: value,
                        }));
                      }}
                      onBlur={() => commitCustomFontFamily(key)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.currentTarget.blur();
                        }
                      }}
                    />
                  ) : null}
                </div>
              }
            />
          );
        })}
      </SettingsGroup>

      <SettingsGroup title={t("settings.fontSize")}>
        {fontScaleZones.map((zone) => (
          <SettingsRow
            key={zone.key}
            title={zone.label}
            control={
              <SettingsToggleGroup
                value={[String(fontScale[zone.key])]}
                aria-label={zone.label}
                onValueChange={(values) => {
                  const nextValue = values[0];
                  if (nextValue) setZoneFontScale(zone.key, Number(nextValue));
                }}
              >
                {FONT_SCALE_OPTIONS.map((value) => (
                  <SettingsToggleGroupItem key={value} value={String(value)}>
                    {getFontScaleLabel(value)}
                  </SettingsToggleGroupItem>
                ))}
              </SettingsToggleGroup>
            }
          />
        ))}
      </SettingsGroup>

      <datalist id="font-family-suggestions">
        {localFontFamilies.map((family) => (
          <option key={family} value={family} />
        ))}
      </datalist>
    </div>
  );
}
