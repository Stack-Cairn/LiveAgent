# AI approval settings browser verification

The fixture renders the actual shared AI approval settings, model picker and
computer settings. Playwright intercepts fixture settings requests; it never
calls a model provider or writes the user's application configuration.

From `crates/agent-gui`:

```sh
pnpm exec vite --config test/settings/ai-approval-browser/vite.config.ts
# In a second terminal with Playwright installed and Google Chrome available:
node test/settings/ai-approval-browser/check.cjs
```

`PLAYWRIGHT_MODULE` can point to an external Playwright installation.
The test covers all three modes, model search, desktop and mobile layouts,
Chinese and English, draft-discard confirmation, save/load failures and retry,
unavailable models, WebUI notices, and the computer-settings page sharing the
backend document. Screenshots are written to `/tmp/la-ai-approval-*.png`.
