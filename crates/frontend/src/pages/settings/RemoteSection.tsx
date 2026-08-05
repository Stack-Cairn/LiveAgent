import {
  Cloud,
  GitBranch,
  type IconComponent,
  Server,
  Share2,
  Terminal,
} from "../../components/icons";

import { useLocale } from "../../i18n";
import { peekStoredEndpoint } from "../../lib/backend/endpoint";
import type { AppSettings } from "../../lib/settings";
import { AgentActivationSwitch } from "./shared";
import type { SettingsSectionProps } from "./types";

function ToggleOptionCard({
  icon: Icon,
  title,
  hint,
  checked,
  disabled,
  onToggle,
}: {
  icon: IconComponent;
  title: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-4 rounded-lg bg-muted/30 px-4 py-3 ${
        disabled ? "opacity-50" : ""
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          {title}
        </div>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{hint}</p>
      </div>
      <AgentActivationSwitch
        checked={checked}
        title={title}
        disabled={disabled}
        onToggle={onToggle}
      />
    </div>
  );
}

function updateRemoteSettings(
  setSettings: SettingsSectionProps["setSettings"],
  patch: Partial<AppSettings["remote"]>,
) {
  setSettings((prev) => ({
    ...prev,
    remote: {
      ...prev.remote,
      ...patch,
    },
  }));
}

/**
 * 远程访问控制：本机就是后端，这里只决定连过来的远程前端能干什么，
 * 不再有「连到哪个 Gateway」的地址、令牌和心跳。
 */
export function RemoteSection(props: SettingsSectionProps) {
  const { settings, setSettings } = props;
  const { t } = useLocale();
  const { remote } = settings;
  const storedEndpoint = peekStoredEndpoint();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-sky-500/10">
            <Cloud className="h-[18px] w-[18px] text-sky-500" />
          </div>
          <div>
            <h3 className="text-sm font-semibold">{t("settings.remoteTitle")}</h3>
            <p className="text-xs text-muted-foreground">{t("settings.remoteDesc")}</p>
          </div>
        </div>

        <AgentActivationSwitch
          checked={remote.enabled}
          title={remote.enabled ? t("settings.remoteDisable") : t("settings.remoteEnable")}
          onToggle={() => updateRemoteSettings(setSettings, { enabled: !remote.enabled })}
        />
      </div>

      <div className="flex items-center justify-between gap-4 rounded-xl border border-border/60 bg-card p-5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Server className="h-4 w-4 text-muted-foreground" />
            {t("settings.backendServerTitle")}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {storedEndpoint
              ? `${storedEndpoint.host}:${storedEndpoint.port}`
              : t("settings.backendServerEmbedded")}
          </p>
        </div>
        <button
          type="button"
          className="shrink-0 rounded-md border border-border px-3 py-1.5 text-xs text-foreground hover:bg-muted"
          onClick={() => {
            // 整页导航到连接页（AuthGate 识别 ?connect）：换服务器后所有
            // 连接与缓存都要重建，整页重载是最干净的路径。
            const url = new URL(window.location.href);
            url.searchParams.set("connect", "1");
            window.location.assign(url);
          }}
        >
          {t("settings.backendServerChange")}
        </button>
      </div>

      <div className="space-y-4 rounded-xl border border-border/60 bg-card p-5">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Server className="h-4 w-4 text-muted-foreground" />
          {t("settings.remoteAccessControl")}
        </div>
        <p className="text-[11px] leading-relaxed text-muted-foreground/70">
          {t("settings.remoteAccessControlHint")}
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <ToggleOptionCard
            icon={Terminal}
            title={t("settings.remoteWebTerminal")}
            hint={t("settings.remoteWebTerminalHint")}
            checked={remote.enableWebTerminal}
            disabled={!remote.enabled}
            onToggle={() =>
              updateRemoteSettings(setSettings, {
                enableWebTerminal: !remote.enableWebTerminal,
              })
            }
          />

          <ToggleOptionCard
            icon={Server}
            title={t("settings.remoteWebSshTerminal")}
            hint={t("settings.remoteWebSshTerminalHint")}
            checked={remote.enableWebSshTerminal}
            disabled={!remote.enabled}
            onToggle={() =>
              updateRemoteSettings(setSettings, {
                enableWebSshTerminal: !remote.enableWebSshTerminal,
              })
            }
          />

          <ToggleOptionCard
            icon={GitBranch}
            title={t("settings.remoteWebGit")}
            hint={t("settings.remoteWebGitHint")}
            checked={remote.enableWebGit}
            disabled={!remote.enabled}
            onToggle={() =>
              updateRemoteSettings(setSettings, {
                enableWebGit: !remote.enableWebGit,
              })
            }
          />

          <ToggleOptionCard
            icon={Share2}
            title={t("settings.remoteWebTunnels")}
            hint={t("settings.remoteWebTunnelsHint")}
            checked={remote.enableWebTunnels}
            disabled={!remote.enabled}
            onToggle={() =>
              updateRemoteSettings(setSettings, {
                enableWebTunnels: !remote.enableWebTunnels,
              })
            }
          />
        </div>
      </div>
    </div>
  );
}
