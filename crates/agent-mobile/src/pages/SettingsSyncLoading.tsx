import { getAssistantAvatarUrl } from "@liveagent/adapters/assistantAvatar";
import { type Locale, t as translate } from "@liveagent/ui/i18n/index";

type SettingsSyncLoadingProps = {
  locale: Locale;
};

export function SettingsSyncLoading({ locale }: SettingsSyncLoadingProps) {
  return (
    <div className="sync-loading sync-loading-entrance" role="status" aria-live="polite">
      <div className="sync-loading-orb sync-loading-orb--1" aria-hidden="true" />
      <div className="sync-loading-orb sync-loading-orb--2" aria-hidden="true" />

      <div className="sync-loading-stage">
        <div className="sync-loading-icon">
          <img
            src={getAssistantAvatarUrl()}
            alt=""
            width={60}
            height={60}
            className="sync-loading-logo"
            draggable={false}
          />
        </div>
      </div>

      <strong className="sync-loading-title">
        {translate("chat.runtime.settingsSyncTitle", locale)}
      </strong>

      <span className="sync-loading-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    </div>
  );
}
