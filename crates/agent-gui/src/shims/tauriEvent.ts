/**
 * Tauri event bridge shim for the headless (browser) WebUI.
 *
 * Desktop: delegates to the real `@tauri-apps/api/event` listen().
 * Browser: subscribes to the headless server's WebSocket fan-out.
 */
export { listen } from "../lib/tauriBridge";
