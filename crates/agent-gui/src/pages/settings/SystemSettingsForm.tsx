import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  Cpu,
  Globe,
  LogOut,
  MessageSquare,
  Minimize2,
  MonitorSmartphone,
  Moon,
  ScanText,
  Sun,
  Terminal,
  Wrench,
} from "../../components/icons";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { SUPPORTED_LOCALES, useLocale } from "../../i18n";
import {
  CLOSE_WINDOW_BEHAVIOR_OPTIONS,
  type ExecutionMode,
  type FontScaleSettings,
  isValidSystemProxyHost,
  type SystemProxyConfig,
  type SystemProxyType,
  THEME_OPTIONS,
  type Theme,
  updateCustomSettings,
  updateSystem,
} from "../../lib/settings";
import {
  buildFontFamilySelectOptions,
  FONT_FAMILY_CUSTOM_SELECT_VALUE,
  FONT_FAMILY_DEFAULT_SELECT_VALUE,
  fromFontFamilySelectValue,
  listLocalFontFamilies,
  toFontFamilySelectValue,
} from "../../lib/system/fontFamily";
import { AgentActivationSwitch } from "./shared";
import type { SettingsSectionProps } from "./types";

const FONT_SCALE_OPTIONS = [0.9, 1, 1.1, 1.2] as const;

const FONT_FAMILY_FIELDS = ["interfaceFontFamily", "chatFontFamily", "codeFontFamily"] as const;

type FontFamilySettingKey = (typeof FONT_FAMILY_FIELDS)[number];

export function SystemSettingsForm(props: SettingsSectionProps) {
  const { settings, setSettings } = props;
  const { t } = useLocale();

  const executionMode = settings.system.executionMode;
  const isClassicAgentMode = executionMode === "tools";
  const isAgentDevMode = executionMode === "agent-dev";
  const appearanceIcon =
    settings.theme === "system" ? (
      <MonitorSmartphone className="h-4 w-4 text-muted-foreground" />
    ) : settings.theme === "dark" ? (
      <Moon className="h-4 w-4 text-muted-foreground" />
    ) : (
      <Sun className="h-4 w-4 text-muted-foreground" />
    );

  function getThemeLabel(theme: Theme) {
    if (theme === "light") return t("settings.light");
    if (theme === "dark") return t("settings.dark");
    return t("settings.auto");
  }

  function renderThemeIcon(theme: Theme) {
    if (theme === "light") return <Sun className="h-4.5 w-4.5" />;
    if (theme === "dark") return <Moon className="h-4.5 w-4.5" />;
    return <MonitorSmartphone className="h-4.5 w-4.5" />;
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
      for (const key of FONT_FAMILY_FIELDS) {
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
  const proxyToggleDisabled = !systemProxy.enabled && !proxyConfigValid;

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

  function commitProxyPortDraft() {
    if (proxyPortDraft !== null) {
      const parsed = Number.parseInt(proxyPortDraft, 10);
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
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Terminal className="h-4 w-4 text-muted-foreground" />
          {t("settings.executionMode")}
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <button
            type="button"
            onClick={() =>
              setSettings((prev) => updateSystem(prev, { executionMode: "text" as ExecutionMode }))
            }
            className={`group relative flex flex-col items-start gap-3 rounded-xl border-2 p-4 text-left transition-all ${
              executionMode === "text"
                ? "border-primary bg-primary/5 shadow-sm shadow-primary/10"
                : "border-transparent bg-muted/40 hover:border-border hover:bg-muted/60"
            }`}
          >
            <div
              className={`flex h-10 w-10 items-center justify-center rounded-xl transition-colors ${
                executionMode === "text"
                  ? "bg-primary/10 text-primary"
                  : "bg-muted text-muted-foreground group-hover:bg-accent"
              }`}
            >
              <MessageSquare className="h-5 w-5" />
            </div>
            <div>
              <div className="text-sm font-semibold">{t("settings.chatMode")}</div>
              <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {t("settings.chatModeDesc")}
              </div>
            </div>
            {executionMode === "text" ? (
              <div className="absolute right-3 top-3">
                <CheckCircle2 className="h-4.5 w-4.5 text-primary" />
              </div>
            ) : null}
          </button>

          <button
            type="button"
            onClick={() =>
              setSettings((prev) => updateSystem(prev, { executionMode: "tools" as ExecutionMode }))
            }
            className={`group relative flex flex-col items-start gap-3 rounded-xl border-2 p-4 text-left transition-all ${
              isClassicAgentMode
                ? "border-primary bg-primary/5 shadow-sm shadow-primary/10"
                : "border-transparent bg-muted/40 hover:border-border hover:bg-muted/60"
            }`}
          >
            <div
              className={`flex h-10 w-10 items-center justify-center rounded-xl transition-colors ${
                isClassicAgentMode
                  ? "bg-primary/10 text-primary"
                  : "bg-muted text-muted-foreground group-hover:bg-accent"
              }`}
            >
              <Wrench className="h-5 w-5" />
            </div>
            <div>
              <div className="text-sm font-semibold">{t("settings.agentMode")}</div>
              <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {t("settings.agentModeDesc")}
              </div>
            </div>
            {isClassicAgentMode ? (
              <div className="absolute right-3 top-3">
                <CheckCircle2 className="h-4.5 w-4.5 text-primary" />
              </div>
            ) : null}
          </button>

          <button
            type="button"
            onClick={() =>
              setSettings((prev) =>
                updateSystem(prev, { executionMode: "agent-dev" as ExecutionMode }),
              )
            }
            className={`group relative flex flex-col items-start gap-3 rounded-xl border-2 p-4 text-left transition-all ${
              isAgentDevMode
                ? "border-primary bg-primary/5 shadow-sm shadow-primary/10"
                : "border-transparent bg-muted/40 hover:border-border hover:bg-muted/60"
            }`}
          >
            <div
              className={`flex h-10 w-10 items-center justify-center rounded-xl transition-colors ${
                isAgentDevMode
                  ? "bg-primary/10 text-primary"
                  : "bg-muted text-muted-foreground group-hover:bg-accent"
              }`}
            >
              <Cpu className="h-5 w-5" />
            </div>
            <div>
              <div className="text-sm font-semibold">{t("settings.agentDevMode")}</div>
              <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {t("settings.agentDevModeDesc")}
              </div>
            </div>
            {isAgentDevMode ? (
              <div className="absolute right-3 top-3">
                <CheckCircle2 className="h-4.5 w-4.5 text-primary" />
              </div>
            ) : null}
          </button>
        </div>
      </div>

      <div className="border-t" />

      <div className="grid gap-4 md:grid-cols-2">
        <section className="space-y-3 rounded-2xl border border-border/60 bg-card p-4">
          <div className="flex items-start gap-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                {appearanceIcon}
                {t("settings.appearance")}
              </div>
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-3">
            {THEME_OPTIONS.map((theme) => {
              const selected = settings.theme === theme;
              return (
                <button
                  key={theme}
                  type="button"
                  onClick={() => setSettings((prev) => ({ ...prev, theme }))}
                  className={`group relative flex h-full items-start gap-3 rounded-xl border px-3.5 py-3.5 text-left transition-all ${
                    selected
                      ? "border-primary bg-primary/5 shadow-sm shadow-primary/10"
                      : "border-border/60 bg-background/80 hover:border-border hover:bg-muted/35"
                  }`}
                >
                  <div
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors ${
                      selected
                        ? "bg-primary/10 text-primary"
                        : "bg-muted text-muted-foreground group-hover:bg-accent/80"
                    }`}
                  >
                    {renderThemeIcon(theme)}
                  </div>
                  <div className="min-w-0 pr-6">
                    <div className="text-sm font-semibold">{getThemeLabel(theme)}</div>
                  </div>
                  {selected ? (
                    <div className="absolute right-3 top-3">
                      <CheckCircle2 className="h-4.5 w-4.5 text-primary" />
                    </div>
                  ) : null}
                </button>
              );
            })}
          </div>
        </section>

        <section className="space-y-3 rounded-2xl border border-border/60 bg-card p-4">
          <div className="flex items-start gap-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                <MessageSquare className="h-4 w-4 text-muted-foreground" />
                {t("settings.language")}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            {SUPPORTED_LOCALES.map((locale) => {
              const selected = settings.locale === locale;
              const localeLabel =
                locale === "zh-CN"
                  ? t("settings.chinese")
                  : locale === "en-US"
                    ? t("settings.english")
                    : locale;
              return (
                <button
                  key={locale}
                  type="button"
                  onClick={() => setSettings((prev) => ({ ...prev, locale }))}
                  className={`group relative flex items-center gap-3 rounded-xl border px-3.5 py-3 text-left transition-all ${
                    selected
                      ? "border-primary bg-primary/5 shadow-sm shadow-primary/10"
                      : "border-border/60 bg-background/80 hover:border-border hover:bg-muted/35"
                  }`}
                >
                  <span className="text-base leading-none">{locale === "zh-CN" ? "🇨🇳" : "🇺🇸"}</span>
                  <div className="min-w-0 flex-1 pr-5">
                    <div className="truncate text-sm font-semibold">{localeLabel}</div>
                    <div className="mt-0.5 text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                      {locale}
                    </div>
                  </div>
                  {selected ? (
                    <div className="absolute right-3 top-1/2 -translate-y-1/2">
                      <CheckCircle2 className="h-4.5 w-4.5 text-primary" />
                    </div>
                  ) : null}
                </button>
              );
            })}
          </div>
        </section>
      </div>

      <section className="space-y-3 rounded-2xl border border-border/60 bg-card p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Globe className="h-4 w-4 text-muted-foreground" />
            {t("settings.systemProxy")}
          </div>
          <AgentActivationSwitch
            checked={systemProxy.enabled}
            title={t("settings.systemProxyEnable")}
            disabled={proxyToggleDisabled}
            onToggle={() => patchSystemProxy({ enabled: !systemProxy.enabled })}
          />
        </div>
        <p className="text-xs text-muted-foreground">{t("settings.systemProxyDesc")}</p>
        {systemProxyInvalid ? (
          <p className="text-xs text-destructive">{t("settings.systemProxyInvalid")}</p>
        ) : proxyToggleDisabled ? (
          <p className="text-xs text-muted-foreground">{t("settings.systemProxyEnableHint")}</p>
        ) : null}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-12 lg:items-start">
          <div className="space-y-1.5 sm:col-span-2 lg:col-span-2">
            <Label className="text-xs font-medium text-muted-foreground">
              {t("settings.systemProxyType")}
            </Label>
            <Select
              value={systemProxy.type}
              onValueChange={(value) => patchSystemProxy({ type: value as SystemProxyType })}
            >
              <SelectTrigger className="w-full">
                <SelectValue>{systemProxy.type === "socks5" ? "SOCKS5" : "HTTP"}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="http">HTTP</SelectItem>
                <SelectItem value="socks5">SOCKS5</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5 lg:col-span-4">
            <Label
              htmlFor="system-proxy-host"
              className="text-xs font-medium text-muted-foreground"
            >
              {t("settings.systemProxyHost")}
            </Label>
            <Input
              id="system-proxy-host"
              value={proxyHostDraft ?? systemProxy.host}
              placeholder="127.0.0.1"
              onChange={(event) => setProxyHostDraft(event.currentTarget.value)}
              onBlur={commitProxyHostDraft}
            />
          </div>
          <div className="space-y-1.5 lg:col-span-2">
            <Label
              htmlFor="system-proxy-port"
              className="text-xs font-medium text-muted-foreground"
            >
              {t("settings.systemProxyPort")}
            </Label>
            <Input
              id="system-proxy-port"
              type="number"
              min={1}
              max={65535}
              value={proxyPortDraft ?? (systemProxy.port > 0 ? String(systemProxy.port) : "")}
              placeholder={systemProxy.type === "socks5" ? "1080" : "7890"}
              onChange={(event) => setProxyPortDraft(event.currentTarget.value)}
              onBlur={commitProxyPortDraft}
            />
          </div>
          <div className="space-y-1.5 lg:col-span-2">
            <Label
              htmlFor="system-proxy-username"
              className="text-xs font-medium text-muted-foreground"
            >
              {t("settings.systemProxyUsername")}
            </Label>
            <Input
              id="system-proxy-username"
              value={proxyUsernameDraft ?? systemProxy.username}
              onChange={(event) => setProxyUsernameDraft(event.currentTarget.value)}
              onBlur={commitProxyUsernameDraft}
            />
          </div>
          <div className="space-y-1.5 lg:col-span-2">
            <Label
              htmlFor="system-proxy-password"
              className="text-xs font-medium text-muted-foreground"
            >
              {t("settings.systemProxyPassword")}
            </Label>
            <Input
              id="system-proxy-password"
              type="password"
              value={proxyPasswordDraft ?? systemProxy.password}
              onChange={(event) => setProxyPasswordDraft(event.currentTarget.value)}
              onBlur={commitProxyPasswordDraft}
            />
            {systemProxy.passwordConfigured &&
            !(proxyPasswordDraft ?? systemProxy.password).trim() ? (
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
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
          </div>
        </div>
      </section>

      <section className="space-y-3 rounded-2xl border border-border/60 bg-card p-4">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Minimize2 className="h-4 w-4 text-muted-foreground" />
          {t("settings.closeWindowBehavior")}
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          {CLOSE_WINDOW_BEHAVIOR_OPTIONS.map((behavior) => {
            const selected = settings.closeWindowBehavior === behavior;
            const isMinimize = behavior === "minimize";
            return (
              <button
                key={behavior}
                type="button"
                onClick={() =>
                  setSettings((prev) => ({
                    ...prev,
                    closeWindowBehavior: behavior,
                  }))
                }
                className={`group relative flex h-full items-start gap-3 rounded-xl border px-3.5 py-3.5 text-left transition-all ${
                  selected
                    ? "border-primary bg-primary/5 shadow-sm shadow-primary/10"
                    : "border-border/60 bg-background/80 hover:border-border hover:bg-muted/35"
                }`}
              >
                <div
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors ${
                    selected
                      ? "bg-primary/10 text-primary"
                      : "bg-muted text-muted-foreground group-hover:bg-accent/80"
                  }`}
                >
                  {isMinimize ? (
                    <Minimize2 className="h-4.5 w-4.5" />
                  ) : (
                    <LogOut className="h-4.5 w-4.5" />
                  )}
                </div>
                <div className="min-w-0 pr-6">
                  <div className="text-sm font-semibold">
                    {isMinimize ? t("settings.closeWindowMinimize") : t("settings.closeWindowExit")}
                  </div>
                  <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                    {isMinimize
                      ? t("settings.closeWindowMinimizeDesc")
                      : t("settings.closeWindowExitDesc")}
                  </div>
                </div>
                {selected ? (
                  <div className="absolute right-3 top-3">
                    <CheckCircle2 className="h-4.5 w-4.5 text-primary" />
                  </div>
                ) : null}
              </button>
            );
          })}
        </div>
      </section>

      <section className="space-y-3 rounded-2xl border border-border/60 bg-card p-4">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <ScanText className="h-4 w-4 text-muted-foreground" />
          {t("settings.fontFamily")}
        </div>

        <div className="space-y-2">
          {FONT_FAMILY_FIELDS.map((key) => {
            const currentValue = settings.customSettings[key];
            const selectValue = toFontFamilySelectValue(
              currentValue,
              fontFamilyOptions,
              customFontModes[key] === true,
            );
            const showCustomInput = selectValue === FONT_FAMILY_CUSTOM_SELECT_VALUE;
            const customDraft = customFontDrafts[key] ?? currentValue;
            return (
              <div key={key} className="space-y-1.5">
                <Label
                  htmlFor={`${key}-select`}
                  className="text-xs font-medium text-muted-foreground"
                >
                  {t(`settings.${key}`)}
                </Label>
                <div className="flex min-w-0 items-center gap-2">
                  <Select
                    value={selectValue}
                    onValueChange={(value) => handleFontFamilySelect(key, value)}
                  >
                    <SelectTrigger
                      id={`${key}-select`}
                      className={showCustomInput ? "w-[9.5rem] shrink-0" : "w-full"}
                    >
                      <SelectValue placeholder={t("settings.fontFamilyDefault")}>
                        {(value) => {
                          if (value === FONT_FAMILY_DEFAULT_SELECT_VALUE) {
                            return t("settings.fontFamilyDefault");
                          }
                          if (value === FONT_FAMILY_CUSTOM_SELECT_VALUE) {
                            return t("settings.fontFamilyCustom");
                          }
                          const match = fontFamilyOptions.find((option) => option.value === value);
                          return match?.label ?? String(value ?? "");
                        }}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent className="max-h-72">
                      <SelectItem value={FONT_FAMILY_DEFAULT_SELECT_VALUE}>
                        {t("settings.fontFamilyDefault")}
                      </SelectItem>
                      <SelectItem value={FONT_FAMILY_CUSTOM_SELECT_VALUE}>
                        {t("settings.fontFamilyCustom")}
                      </SelectItem>
                      {fontFamilyOptions.map((option) => (
                        <SelectItem
                          key={option.value}
                          value={option.value}
                          style={{ fontFamily: option.value }}
                        >
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {showCustomInput ? (
                    <Input
                      id={`${key}-custom-input`}
                      className="min-w-0 flex-1"
                      value={customDraft}
                      list="font-family-suggestions"
                      spellCheck={false}
                      autoComplete="off"
                      placeholder={t("settings.fontFamilyPlaceholder")}
                      onChange={(event) =>
                        setCustomFontDrafts((current) => ({
                          ...current,
                          [key]: event.target.value,
                        }))
                      }
                      onBlur={() => commitCustomFontFamily(key)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.currentTarget.blur();
                        }
                      }}
                    />
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
        <datalist id="font-family-suggestions">
          {localFontFamilies.map((family) => (
            <option key={family} value={family} />
          ))}
        </datalist>
      </section>

      <section className="space-y-3 rounded-2xl border border-border/60 bg-card p-4">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <ScanText className="h-4 w-4 text-muted-foreground" />
          {t("settings.fontSize")}
        </div>

        <div className="space-y-2">
          {fontScaleZones.map((zone) => (
            <div
              key={zone.key}
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/60 bg-background/80 px-3.5 py-2.5"
            >
              <div className="text-sm font-medium text-foreground">{zone.label}</div>
              <div className="flex items-center gap-1 rounded-lg bg-muted/50 p-0.5">
                {FONT_SCALE_OPTIONS.map((value) => {
                  const selected = fontScale[zone.key] === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setZoneFontScale(zone.key, value)}
                      className={`rounded-md px-2.5 py-1 text-xs transition-all ${
                        selected
                          ? "bg-background font-semibold text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {getFontScaleLabel(value)}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
