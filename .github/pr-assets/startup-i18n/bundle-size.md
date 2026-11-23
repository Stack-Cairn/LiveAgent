# Startup bundle: before / after

Measured with `node scripts/check-bundle-size.mjs --app all` (startup = entry
chunk plus its static import closure, gzip level 9). Before = `origin/main`
d57e63b6, after = this branch rebased on it.

| App | Metric | Before | After | Change |
| --- | --- | ---: | ---: | ---: |
| desktop (gui) | Startup JS gzip | 355,751 B | 256,900 B | -27.8% |
| desktop (gui) | Startup JS raw | 1,259,074 B | 869,997 B | -30.9% |
| desktop (gui) | Startup CSS gzip | 72,036 B | 72,036 B | 0.0% |
| desktop (gui) | Total dist raw | 37,846,710 B | 37,870,405 B | +0.1% |
| WebUI | Startup JS gzip | 1,600,071 B | 1,226,920 B | -23.3% |
| WebUI | Startup JS raw | 5,716,919 B | 4,242,913 B | -25.8% |
| WebUI | Startup CSS gzip | 82,958 B | 82,819 B | -0.2% |
| WebUI | Total dist raw | 37,469,717 B | 37,515,251 B | +0.1% |

The desktop budget only covers its bootstrap (the app shell is a dynamic
import). Measured over the same scope as the WebUI startup (entry + App +
ChatPage closure), the desktop goes from 1,247,243 B to 1,137,696 B gzip, so
the WebUI startup is now 1.08x the desktop chat-ready closure (it was 1.28x).

Screenshots (fake provider, empty data; each feature opened in English, then
the language switched to Chinese with the feature's translations already
loaded):

- Desktop web target: `gui-skills-hub-{en,zh}.png`, `gui-planning-{en,zh}.png`,
  `gui-settings-usage-{en,zh}.png`
- WebUI through the gateway: `webui-skills-hub-{en,zh}.png`,
  `webui-image-studio-{en,zh}.png`, `webui-settings-mcp-{en,zh}.png`

The WebUI smoke runs the gateway directly against K-brain with no desktop
agent attached. In that mode the gateway rejects persisting `locale`
(`non-provider settings persistence is unavailable`, from
`internal/kbrain/settings.go`, unchanged here), so the Chinese WebUI settings
screenshot shows the existing "save failed" badge; the language switch itself
applies to the page.
