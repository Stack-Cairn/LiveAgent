import iconSimpleUrl from "../../../src-tauri/icons/icon-simple.png";
import { WindowsTitleBar } from "../WindowsTitleBar";

/** Shown once loading has waited too long, so a stuck backend never leaves a silent screen. */
export type AppBootStall = {
  message: string;
  actionLabel: string;
  busy?: boolean;
  onAction: () => void;
};

export function AppBootShell(props: { loadingLabel: string; stall?: AppBootStall }) {
  const { stall } = props;
  return (
    <div className="flex size-full min-h-0 flex-col">
      <WindowsTitleBar />
      <div
        data-app-boot-shell=""
        className="app-boot-screen min-h-0 flex-1"
        role="status"
        aria-live="polite"
        aria-label={props.loadingLabel}
        aria-busy="true"
      >
        <div className="app-boot-content">
          <img className="app-boot-icon" src={iconSimpleUrl} alt="" aria-hidden="true" />
          <div className="app-boot-progress" aria-hidden="true">
            <span />
          </div>
          {stall ? (
            <>
              <p className="app-boot-waiting" data-app-boot-stalled="">
                {stall.message}
              </p>
              <button
                className="app-boot-retry"
                type="button"
                disabled={stall.busy}
                onClick={stall.onAction}
              >
                {stall.actionLabel}
              </button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
