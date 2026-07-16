import { useState } from "react";
import {
  CheckCircle2,
  Cpu,
  Globe,
  MessageSquare,
  MonitorSmartphone,
  Moon,
  ScanText,
  Shield,
  Sun,
  Terminal,
  Wrench,
} from "../../components/icons";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { SUPPORTED_LOCALES, useLocale } from "../../i18n";
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
} from "../../lib/settings";
import { AgentActivationSwitch } from "./shared";
import type { SettingsSectionProps } from "./types";

const FONT_SCALE_OPTIONS = [0.9, 1, 1.1, 1.2] as const;

export function SystemSettingsForm(props: SettingsSectionProps) {
  const { settings, setSettings } = props;
  const { t } = useLocale();

  const executionMode = settings.system.executionMode;
  const isClassicAgentMode = executionMode === "tools" || executionMode === "agent-dev";
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

  function setZoneFontScale(zone: keyof FontScaleSettings, value: number) {
    setSettings((prev) =>
      updateCustomSettings(prev, {
        fontScale: { ...prev.customSettings.fontScale, [zone]: value },
      }),
    );
  }

  const systemProxy = settings.system.systemProxy;
  const systemProxyInvalid =
    systemProxy.enabled &&
    (!isValidSystemProxyHost(systemProxy.host) ||
      !Number.isInteger(systemProxy.port) ||
      systemProxy.port < 1 ||
      systemProxy.port > 65535);
  // 密码走"本地草稿 + blur 提交"：WebUI 的设置 state 持久前会被脱敏（密码置空），
  // 直接绑定 state 会导致输入即被清空；草稿只在提交时进入 settings。
  const [proxyPasswordDraft, setProxyPasswordDraft] = useState<string | null>(null);

  function patchSystemProxy(patch: Partial<SystemProxyConfig>) {
    setSettings((prev) =>
      updateSystem(prev, {
        systemProxy: { ...prev.system.systemProxy, ...patch },
      }),
    );
  }

  function commitProxyPasswordDraft() {
    if (proxyPasswordDraft !== null) {
      patchSystemProxy({ password: proxyPasswordDraft });
      setProxyPasswordDraft(null);
    }
  }

  return (
    <div className="settings-system-section space-y-6">
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Terminal className="h-4 w-4 text-muted-foreground" />
          {t("settings.executionMode")}
        </div>

        <div className="settings-choice-grid grid grid-cols-1 gap-3 md:grid-cols-3">
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
              setSettings((prev) =>
                updateSystem(prev, { executionMode: "readonly" as ExecutionMode }),
              )
            }
            className={`group relative flex flex-col items-start gap-3 rounded-xl border-2 p-4 text-left transition-all ${
              executionMode === "readonly"
                ? "border-emerald-500/45 bg-emerald-500/5 shadow-sm shadow-emerald-500/10"
                : "border-transparent bg-muted/40 hover:border-border hover:bg-muted/60"
            }`}
          >
            <div
              className={`flex h-10 w-10 items-center justify-center rounded-xl transition-colors ${
                executionMode === "readonly"
                  ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                  : "bg-muted text-muted-foreground group-hover:bg-accent"
              }`}
            >
              <Shield className="h-5 w-5" />
            </div>
            <div>
              <div className="text-sm font-semibold">{t("settings.readonlyAgentMode")}</div>
              <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {t("settings.readonlyAgentModeDesc")}
              </div>
            </div>
            {executionMode === "readonly" ? (
              <div className="absolute right-3 top-3">
                <CheckCircle2 className="h-4.5 w-4.5 text-emerald-600" />
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
        </div>

        {isClassicAgentMode ? (
          <button
            type="button"
            role="switch"
            aria-checked={isAgentDevMode}
            onClick={() =>
              setSettings((prev) =>
                updateSystem(prev, {
                  executionMode: isAgentDevMode ? "tools" : "agent-dev",
                }),
              )
            }
            className="flex w-full items-center justify-between gap-4 rounded-lg border border-border/60 bg-background/70 px-3.5 py-3 text-left transition-colors hover:bg-muted/35"
          >
            <span className="flex min-w-0 items-center gap-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <Cpu className="h-4 w-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium">{t("settings.agentTrace")}</span>
                <span className="block text-xs text-muted-foreground">
                  {t("settings.agentTraceDesc")}
                </span>
              </span>
            </span>
            <span
              aria-hidden
              className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
                isAgentDevMode ? "bg-primary" : "bg-muted-foreground/25"
              }`}
            >
              <span
                className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
                  isAgentDevMode ? "translate-x-[18px]" : "translate-x-0.5"
                }`}
              />
            </span>
          </button>
        ) : null}
      </div>

      <div className="border-t" />

      <div className="settings-preferences-grid grid gap-4 md:grid-cols-2">
        <section className="space-y-3 rounded-2xl border border-border/60 bg-card p-4">
          <div className="flex items-start gap-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                {appearanceIcon}
                {t("settings.appearance")}
              </div>
            </div>
          </div>

          <div className="settings-choice-grid settings-appearance-grid grid gap-2 sm:grid-cols-3">
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

          <div className="settings-choice-grid settings-language-grid grid grid-cols-2 gap-2">
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
            onToggle={() => patchSystemProxy({ enabled: !systemProxy.enabled })}
          />
        </div>
        <p className="text-xs text-muted-foreground">{t("settings.systemProxyDesc")}</p>
        {systemProxyInvalid ? (
          <p className="text-xs text-destructive">{t("settings.systemProxyInvalid")}</p>
        ) : null}
        {systemProxy.enabled ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label className="text-xs font-medium text-muted-foreground">
                {t("settings.systemProxyType")}
              </Label>
              <div className="grid grid-cols-2 gap-2 rounded-xl border border-border/60 bg-background p-1">
                {(["socks5", "http"] as SystemProxyType[]).map((type) => (
                  <button
                    key={type}
                    type="button"
                    className={`rounded-lg px-3 py-2 text-xs font-medium transition-colors ${
                      systemProxy.type === type
                        ? "bg-muted text-foreground shadow-sm"
                        : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                    }`}
                    onClick={() => patchSystemProxy({ type })}
                  >
                    {type === "socks5" ? "SOCKS5" : "HTTP"}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label
                htmlFor="system-proxy-host"
                className="text-xs font-medium text-muted-foreground"
              >
                {t("settings.systemProxyHost")}
              </Label>
              <Input
                id="system-proxy-host"
                value={systemProxy.host}
                placeholder="127.0.0.1"
                onChange={(event) => patchSystemProxy({ host: event.currentTarget.value })}
              />
            </div>
            <div className="space-y-1.5">
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
                value={systemProxy.port > 0 ? systemProxy.port : ""}
                placeholder={systemProxy.type === "socks5" ? "1080" : "7890"}
                onChange={(event) => {
                  const parsed = Number.parseInt(event.currentTarget.value, 10);
                  patchSystemProxy({ port: Number.isNaN(parsed) ? 0 : parsed });
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label
                htmlFor="system-proxy-username"
                className="text-xs font-medium text-muted-foreground"
              >
                {t("settings.systemProxyUsername")}
              </Label>
              <Input
                id="system-proxy-username"
                value={systemProxy.username}
                onChange={(event) => patchSystemProxy({ username: event.currentTarget.value })}
              />
            </div>
            <div className="space-y-1.5">
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
        ) : null}
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
