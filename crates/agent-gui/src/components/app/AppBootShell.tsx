import iconSimpleUrl from "../../../src-tauri/icons/icon-simple.png";
import { WindowsTitleBar } from "../WindowsTitleBar";

export function AppBootShell(props: { loadingLabel: string }) {
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
        <div className="app-boot-content" aria-hidden="true">
          <img className="app-boot-icon" src={iconSimpleUrl} alt="" />
          <div className="app-boot-progress">
            <span />
          </div>
        </div>
      </div>
    </div>
  );
}
