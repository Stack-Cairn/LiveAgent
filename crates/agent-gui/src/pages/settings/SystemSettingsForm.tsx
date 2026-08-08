import { type ComponentProps, type ReactNode, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  ChevronRight,
  Cpu,
  MessageSquare,
  MonitorSmartphone,
  Moon,
  Settings2,
  Sun,
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
import { type Locale, SUPPORTED_LOCALES, useLocale } from "../../i18n";
import { inferRuntimePlatform } from "../../lib/runtimePlatform";
import {
  type CLOSE_WINDOW_BEHAVIOR_OPTIONS,
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
import { cn } from "../../lib/shared/utils";
import {
  buildFontFamilySelectOptions,
  FONT_FAMILY_CUSTOM_SELECT_VALUE,
  FONT_FAMILY_DEFAULT_SELECT_VALUE,
  fromFontFamilySelectValue,
  listLocalFontFamilies,
  toFontFamilySelectValue,
} from "../../lib/system/fontFamily";
import { useTrayPrefs, writeTrayPrefs } from "../../lib/tray/trayPrefs";
import { AgentActivationSwitch } from "./shared";
import type { SettingsSectionProps } from "./types";

const FONT_SCALE_OPTIONS = [0.9, 1, 1.1, 1.2] as const;

const FONT_FAMILY_FIELDS = ["interfaceFontFamily", "chatFontFamily", "codeFontFamily"] as const;

type FontFamilySettingKey = (typeof FONT_FAMILY_FIELDS)[number];

type SettingsGroupProps = {
  title: string;
  children: ReactNode;
};

function SettingsGroup({ title, children }: SettingsGroupProps) {
  return (
    <section className="space-y-2.5">
      <h2 className="px-1 text-[15px] font-semibold tracking-tight text-foreground">{title}</h2>
      <div className="overflow-hidden rounded-2xl border border-border/75 bg-card shadow-[0_1px_2px_hsl(var(--foreground)/0.02)]">
        {children}
      </div>
    </section>
  );
}

type SettingsSelectTriggerProps = ComponentProps<typeof SelectTrigger>;

function SettingsSelectTrigger({ className = "", ...props }: SettingsSelectTriggerProps) {
  return (
    <SelectTrigger
      className={cn(
        "h-8 w-fit max-w-[260px] gap-1.5 whitespace-nowrap rounded-[10px] border-border/65 bg-background px-2.5 py-0 text-[13px] font-normal leading-none shadow-[0_1px_2px_hsl(var(--foreground)/0.035)] transition-colors hover:bg-muted/25 focus-visible:ring-2 focus-visible:ring-foreground/10 [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:opacity-40",
        className,
      )}
      {...props}
    />
  );
}

type SettingsSelectContentProps = ComponentProps<typeof SelectContent>;

function SettingsSelectContent({ className = "", ...props }: SettingsSelectContentProps) {
  return (
    <SelectContent
      className={cn(
        "rounded-xl border-border/70 shadow-[0_10px_30px_hsl(var(--foreground)/0.1)] [&_[role=option]]:min-h-8 [&_[role=option]]:rounded-lg [&_[role=option]]:text-[13px]",
        className,
      )}
      {...props}
    />
  );
}

type SettingsRowProps = {
  title: string;
  description?: string;
  control: ReactNode;
  className?: string;
};

function SettingsRow({ title, description, control, className = "" }: SettingsRowProps) {
  return (
    <div
      className={cn(
        "relative flex min-h-[72px] flex-col gap-3 px-5 py-4 after:pointer-events-none after:absolute after:bottom-0 after:left-5 after:right-5 after:h-px after:bg-border/60 after:content-[''] last:after:hidden sm:flex-row sm:items-center sm:justify-between",
        className,
      )}
    >
      <div className="min-w-0 flex-1 pr-2">
        <div className="text-sm font-medium text-foreground">{title}</div>
        {description ? (
          <p className="mt-0.5 max-w-2xl text-xs leading-relaxed text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      <div className="flex w-full items-center sm:w-auto sm:shrink-0 sm:justify-end">{control}</div>
    </div>
  );
}

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
    <div className="relative flex min-h-[76px] flex-col gap-3 px-5 py-4 after:pointer-events-none after:absolute after:bottom-0 after:left-5 after:right-5 after:h-px after:bg-border/60 after:content-[''] last:after:hidden sm:flex-row sm:items-center">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls="system-proxy-details"
        onClick={onToggleDetails}
        className="group flex min-w-0 flex-1 items-center justify-between gap-4 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-foreground/10"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-foreground">{title}</span>
          <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
            {description}
          </span>
        </span>
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-border/70 bg-background px-3 py-2 text-xs font-medium text-foreground/80 shadow-xs transition-colors group-hover:bg-muted/45">
          <Settings2 className="h-3.5 w-3.5 text-muted-foreground" />
          <span>{actionLabel}</span>
          <ChevronRight
            className={cn(
              "h-3.5 w-3.5 text-muted-foreground transition-transform",
              expanded && "rotate-90",
            )}
          />
        </span>
      </button>
      <div className="flex shrink-0 items-center sm:border-l sm:border-border/60 sm:pl-4">
        {switchControl}
      </div>
    </div>
  );
}

type ExecutionModeRowProps = {
  icon: ReactNode;
  title: string;
  description: string;
  selected: boolean;
  onClick: () => void;
};

function ExecutionModeRow({ icon, title, description, selected, onClick }: ExecutionModeRowProps) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className="group relative flex w-full items-center gap-3 px-5 py-4 text-left transition-colors after:pointer-events-none after:absolute after:bottom-0 after:left-5 after:right-5 after:h-px after:bg-border/60 after:content-[''] last:after:hidden hover:bg-muted/20"
    >
      <span
        className={cn(
          "flex h-5 w-5 shrink-0 items-center justify-center transition-colors",
          selected
            ? "text-foreground/70"
            : "text-muted-foreground/45 group-hover:text-foreground/60",
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">{title}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
          {description}
        </span>
      </span>
      <span className="ml-2 flex h-5 w-5 shrink-0 items-center justify-center">
        {selected ? <CheckCircle2 className="h-4.5 w-4.5 text-foreground/80" /> : null}
      </span>
    </button>
  );
}

type SegmentedButtonProps = {
  selected: boolean;
  label: string;
  icon?: ReactNode;
  onClick: () => void;
};

function SegmentedButton({ selected, label, icon, onClick }: SegmentedButtonProps) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs transition-all",
        selected
          ? "bg-background font-medium text-foreground shadow-sm ring-1 ring-border/70"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

export function SystemSettingsForm(props: SettingsSectionProps) {
  const { settings, setSettings } = props;
  const { t } = useLocale();
  const trayPrefs = useTrayPrefs();
  const isMacPlatform = useMemo(() => inferRuntimePlatform() === "macos", []);

  const executionMode = settings.system.executionMode;
  const isClassicAgentMode = executionMode === "tools";
  const isAgentDevMode = executionMode === "agent-dev";

  function getThemeLabel(theme: Theme) {
    if (theme === "light") return t("settings.light");
    if (theme === "dark") return t("settings.dark");
    return t("settings.auto");
  }

  function renderThemeIcon(theme: Theme) {
    if (theme === "light") return <Sun className="h-3.5 w-3.5 opacity-60" />;
    if (theme === "dark") return <Moon className="h-3.5 w-3.5 opacity-60" />;
    return <MonitorSmartphone className="h-3.5 w-3.5 opacity-60" />;
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
  const [proxyDetailsOpen, setProxyDetailsOpen] = useState(false);

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

  const closeWindowDescription =
    settings.closeWindowBehavior === "minimize"
      ? t("settings.closeWindowMinimizeDesc")
      : t("settings.closeWindowExitDesc");

  return (
    <div className="settings-system-section space-y-9 pb-10">
      <SettingsGroup title={t("settings.executionMode")}>
        <fieldset aria-label={t("settings.executionMode")} className="m-0 min-w-0 border-0 p-0">
          <ExecutionModeRow
            icon={<MessageSquare className="h-4.5 w-4.5" />}
            title={t("settings.chatMode")}
            description={t("settings.chatModeDesc")}
            selected={executionMode === "text"}
            onClick={() =>
              setSettings((prev) => updateSystem(prev, { executionMode: "text" as ExecutionMode }))
            }
          />
          <ExecutionModeRow
            icon={<Wrench className="h-4.5 w-4.5" />}
            title={t("settings.agentMode")}
            description={t("settings.agentModeDesc")}
            selected={isClassicAgentMode}
            onClick={() =>
              setSettings((prev) => updateSystem(prev, { executionMode: "tools" as ExecutionMode }))
            }
          />
          <ExecutionModeRow
            icon={<Cpu className="h-4.5 w-4.5" />}
            title={t("settings.agentDevMode")}
            description={t("settings.agentDevModeDesc")}
            selected={isAgentDevMode}
            onClick={() =>
              setSettings((prev) =>
                updateSystem(prev, { executionMode: "agent-dev" as ExecutionMode }),
              )
            }
          />
        </fieldset>
      </SettingsGroup>

      <SettingsGroup title={t("settings.groupGeneral")}>
        <div>
          <SettingsRow
            title={t("settings.appearance")}
            description={t("settings.appearanceDesc")}
            control={
              <div className="flex items-center gap-0.5 rounded-xl bg-muted/55 p-1">
                {THEME_OPTIONS.map((theme) => (
                  <SegmentedButton
                    key={theme}
                    selected={settings.theme === theme}
                    label={getThemeLabel(theme)}
                    icon={renderThemeIcon(theme)}
                    onClick={() => setSettings((prev) => ({ ...prev, theme }))}
                  />
                ))}
              </div>
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

          <SettingsRow
            title={t("settings.closeWindowBehavior")}
            description={closeWindowDescription}
            control={
              <Select
                value={settings.closeWindowBehavior}
                onValueChange={(closeWindowBehavior) =>
                  setSettings((prev) => ({
                    ...prev,
                    closeWindowBehavior:
                      closeWindowBehavior as (typeof CLOSE_WINDOW_BEHAVIOR_OPTIONS)[number],
                  }))
                }
              >
                <SettingsSelectTrigger>
                  <SelectValue>
                    {settings.closeWindowBehavior === "minimize"
                      ? t("settings.closeWindowMinimize")
                      : t("settings.closeWindowExit")}
                  </SelectValue>
                </SettingsSelectTrigger>
                <SettingsSelectContent>
                  <SelectItem value="minimize">{t("settings.closeWindowMinimize")}</SelectItem>
                  <SelectItem value="exit">{t("settings.closeWindowExit")}</SelectItem>
                </SettingsSelectContent>
              </Select>
            }
          />
        </div>
      </SettingsGroup>

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
            actionLabel={
              proxyDetailsOpen ? t("settings.systemProxyDone") : t("settings.systemProxySettings")
            }
            expanded={proxyDetailsOpen}
            onToggleDetails={() => setProxyDetailsOpen((open) => !open)}
            switchControl={
              <AgentActivationSwitch
                checked={systemProxy.enabled}
                title={t("settings.systemProxyEnable")}
                disabled={proxyToggleDisabled}
                onToggle={() => patchSystemProxy({ enabled: !systemProxy.enabled })}
              />
            }
          />

          {proxyDetailsOpen ? (
            <div
              id="system-proxy-details"
              className="animate-in fade-in slide-in-from-top-1 bg-muted/10 px-5 py-4 duration-150"
            >
              <p className="mb-4 text-xs leading-relaxed text-muted-foreground">
                {t("settings.systemProxyDesc")}
              </p>
              {systemProxyInvalid || proxyToggleDisabled ? (
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

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[auto_minmax(0,1fr)_7rem] sm:items-start">
                <div className="space-y-1.5">
                  <Label className="text-xs font-medium text-muted-foreground">
                    {t("settings.systemProxyType")}
                  </Label>
                  <Select
                    value={systemProxy.type}
                    onValueChange={(value) => patchSystemProxy({ type: value as SystemProxyType })}
                  >
                    <SettingsSelectTrigger className="rounded-lg">
                      <SelectValue>{systemProxy.type === "socks5" ? "SOCKS5" : "HTTP"}</SelectValue>
                    </SettingsSelectTrigger>
                    <SettingsSelectContent>
                      <SelectItem value="http">HTTP</SelectItem>
                      <SelectItem value="socks5">SOCKS5</SelectItem>
                    </SettingsSelectContent>
                  </Select>
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
                    className="rounded-lg"
                    value={proxyHostDraft ?? systemProxy.host}
                    placeholder="127.0.0.1"
                    onChange={(event) => setProxyHostDraft(event.currentTarget.value)}
                    onBlur={commitProxyHostDraft}
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
                    className="rounded-lg"
                    type="number"
                    min={1}
                    max={65535}
                    value={proxyPortDraft ?? (systemProxy.port > 0 ? String(systemProxy.port) : "")}
                    placeholder={systemProxy.type === "socks5" ? "1080" : "7890"}
                    onChange={(event) => setProxyPortDraft(event.currentTarget.value)}
                    onBlur={commitProxyPortDraft}
                  />
                </div>
              </div>

              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label
                    htmlFor="system-proxy-username"
                    className="text-xs font-medium text-muted-foreground"
                  >
                    {t("settings.systemProxyUsername")}
                  </Label>
                  <Input
                    id="system-proxy-username"
                    className="rounded-lg"
                    value={proxyUsernameDraft ?? systemProxy.username}
                    onChange={(event) => setProxyUsernameDraft(event.currentTarget.value)}
                    onBlur={commitProxyUsernameDraft}
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
                    className="rounded-lg"
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
            </div>
          ) : null}
        </div>
      </SettingsGroup>

      <SettingsGroup title={t("settings.trayTitle")}>
        <div>
          <SettingsRow
            title={t("settings.trayShowTitles")}
            description={t("settings.trayShowTitlesDesc")}
            control={
              <AgentActivationSwitch
                checked={trayPrefs.showConversationTitles}
                title={t("settings.trayShowTitles")}
                onToggle={() =>
                  writeTrayPrefs({ showConversationTitles: !trayPrefs.showConversationTitles })
                }
              />
            }
          />
          {isMacPlatform ? (
            <SettingsRow
              title={t("settings.trayRunningBadge")}
              description={t("settings.trayRunningBadgeDesc")}
              control={
                <AgentActivationSwitch
                  checked={trayPrefs.showRunningBadge}
                  title={t("settings.trayRunningBadge")}
                  onToggle={() => writeTrayPrefs({ showRunningBadge: !trayPrefs.showRunningBadge })}
                />
              }
            />
          ) : null}
        </div>
      </SettingsGroup>

      <SettingsGroup title={t("settings.fontFamily")}>
        <div>
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
              <SettingsRow
                key={key}
                title={t(`settings.${key}`)}
                control={
                  <div className="flex w-full min-w-0 flex-col items-start gap-2 sm:w-auto sm:items-end">
                    <Select
                      value={selectValue}
                      onValueChange={(value) => handleFontFamilySelect(key, value)}
                    >
                      <SettingsSelectTrigger id={`${key}-select`}>
                        <SelectValue placeholder={t("settings.fontFamilyDefault")}>
                          {(value) => {
                            if (value === FONT_FAMILY_DEFAULT_SELECT_VALUE) {
                              return t("settings.fontFamilyDefault");
                            }
                            if (value === FONT_FAMILY_CUSTOM_SELECT_VALUE) {
                              return t("settings.fontFamilyCustom");
                            }
                            const match = fontFamilyOptions.find(
                              (option) => option.value === value,
                            );
                            return match?.label ?? String(value ?? "");
                          }}
                        </SelectValue>
                      </SettingsSelectTrigger>
                      <SettingsSelectContent className="max-h-72">
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
                      </SettingsSelectContent>
                    </Select>
                    {showCustomInput ? (
                      <Input
                        id={`${key}-custom-input`}
                        className="w-full min-w-0 rounded-xl sm:w-[240px]"
                        value={customDraft}
                        list="font-family-suggestions"
                        spellCheck={false}
                        autoComplete="off"
                        placeholder={t("settings.fontFamilyPlaceholder")}
                        onChange={(event) =>
                          setCustomFontDrafts((current) => ({
                            ...current,
                            [key]: event.currentTarget.value,
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
                }
              />
            );
          })}
        </div>
      </SettingsGroup>

      <SettingsGroup title={t("settings.fontSize")}>
        <div>
          {fontScaleZones.map((zone) => (
            <SettingsRow
              key={zone.key}
              title={zone.label}
              control={
                <div className="flex items-center gap-0.5 rounded-xl bg-muted/55 p-1">
                  {FONT_SCALE_OPTIONS.map((value) => (
                    <SegmentedButton
                      key={value}
                      selected={fontScale[zone.key] === value}
                      label={getFontScaleLabel(value)}
                      onClick={() => setZoneFontScale(zone.key, value)}
                    />
                  ))}
                </div>
              }
            />
          ))}
        </div>
      </SettingsGroup>

      <datalist id="font-family-suggestions">
        {localFontFamilies.map((family) => (
          <option key={family} value={family} />
        ))}
      </datalist>
    </div>
  );
}
