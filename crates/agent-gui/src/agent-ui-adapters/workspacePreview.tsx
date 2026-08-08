import { MacOsTitleBarSpacer } from "../components/MacOsTitleBarSpacer";
import { readClipboardText } from "../lib/system/clipboardText";

export const supportsExternalWorkspaceOpen = true;
export const workspaceOverlayStackClassName = "z-50";

export const readWorkspaceClipboardText = readClipboardText;

export function WorkspaceOverlayTitleBar() {
  return <MacOsTitleBarSpacer className="bg-muted/45" />;
}
