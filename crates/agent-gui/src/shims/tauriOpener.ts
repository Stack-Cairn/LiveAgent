/**
 * Plugin-opener bridge shim for the headless (browser) WebUI.
 *
 * Desktop: delegates to the real `@tauri-apps/plugin-opener`.
 * Browser: `openUrl` opens a new tab; `revealItemInDir` is a no-op (the
 * headless server has no OS file manager to reveal into).
 */
export { openUrl, revealItemInDir } from "../lib/tauriBridge";
