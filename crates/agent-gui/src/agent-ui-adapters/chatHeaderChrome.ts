import { isMacOsTauri } from "../components/MacOsTitleBarSpacer";

export function isDesktopChatHeaderInset() {
  return isMacOsTauri();
}
