import { isMacOsTauri, MacOsTitleBarSpacer } from "../components/MacOsTitleBarSpacer";

export const usesOverlayTitleBar = isMacOsTauri();

export function HubTitleBar() {
  return <MacOsTitleBarSpacer />;
}
