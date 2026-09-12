import iconSimpleUrl from "../../../src-tauri/icons/icon-simple.png";

export function AppBootShell(props: { loadingLabel: string }) {
  return (
    <div
      data-app-boot-shell=""
      className="app-boot-screen"
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
  );
}
