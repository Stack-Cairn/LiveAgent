/**
 * Tauri-core bridge shim for the headless (browser) WebUI.
 *
 * Desktop: the same build runs inside the Tauri webview, where
 * `tauriBridge.invoke` dynamically imports the real `@tauri-apps/api/core`.
 * Browser: it POSTs to the headless server over /api/invoke.
 */
export { invoke } from "../lib/tauriBridge";
