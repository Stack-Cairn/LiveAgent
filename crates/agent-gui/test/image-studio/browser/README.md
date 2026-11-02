# ImageStudio isolated browser harness

Status: **BROWSER VERIFICATION BLOCKED / NOT ACCEPTED**.

This mounts the actual shared `ImageStudioPage`, `ImageSettings`, and `createImageStudioClient`, with GUI aliases and CSS. All imaging transport responses are in-memory test fixtures. No real provider, paid generation, production backend, personal configuration, or credentials are used. The visible yellow header identifies test mode. This cannot replace real desktop/web host acceptance.

Start from `crates/agent-gui` using already installed dependencies:

```sh
pnpm exec vite --config test/image-studio/browser/vite.config.ts
```

- Strict local port: http://127.0.0.1:18473/
- Workbench: `/`
- Settings: `/?settings`
- Navigation between these routes reloads and resets fixture state. The settings route is an isolated test surface; there is no workbench target-settings overlay.
- Draft storage is an in-memory Map.
- Browser fixture audit: `window.__fixture.audit`. It records request paths, methods, idempotency keys, Last-Event-ID, request bodies, and upload metadata. Secret write values are redacted and not retained in the audit.
- Test image bytes are generated in memory by a canvas and labelled TEST FIXTURE; no screenshot/image artifact has been saved.

## Actual evidence and limits

The earlier harness run started Vite 8.0.5 successfully on port 18473. Harness bundle build was run; see parent report for its final result. A build is not browser runtime validation.

The required browser attempt used isolated session `headless:image-studio-validation`:

```text
goto('http://127.0.0.1:18473')
Error: blocked: 127.0.0.1 is a private/internal address (set browser.allowPrivateUrls to permit)
```

**This remains blocked.** No permission changes, alternate-address bypass, or repeat browser attempt were made for the new workbench. Desktop-tool permission was denied; no desktop tools were used. No browser DOM result, interaction, screenshot, or viewport evidence exists. **Every browser acceptance scenario below remains unverified**. No production bug is asserted from a browser run.

`../workbench-layout.test.mjs` separately renders the real shared page, composer, gallery, AssetImage, hook and controller using `../helpers/dom-test-env.mjs` / `load-ts-module.mjs`, with an in-memory client. Only the error-boundary wrapper and icon rendering are stubbed. It dispatches real React DOM events for prompt/model/count, history search/filter/selection/restoration, file input change, drop, paste, submit, regeneration and cancellation. File objects and generated request bodies are checked at the client boundary. `../settings-invalidation.test.mjs` also checks that a same-client provider settings save refreshes the mounted workbench's targets while preserving its controller and draft, then unsubscribes on unmount.

Run the DOM regressions from `crates/agent-gui`:

```sh
node --test test/image-studio/workbench-layout.test.mjs test/image-studio/settings-invalidation.test.mjs
node --test test/image-studio/*.test.mjs
```

The current DOM regression run passed **18/18** tests for the two targeted files and **99/99** for the full image-studio suite. These are Node/jsdom results, not browser acceptance.

These tests verify DOM behavior only. jsdom does not render CSS layout or decode images, open an OS file picker, supply a native drag/clipboard payload, or exercise the browser network/transport pipeline. The DOM toggle assertion checks `aria-expanded`, not whether the responsive history panel is visible. It provides no evidence for desktop/mobile layout, clipping, scroll containment, overlap, contrast, focus appearance or image sizing.

## New-layout steps / pending actual browser checks

1. Open the workbench with an empty fixture. The controller should create its internal archive automatically; audit should contain one `POST /projects`. Verify the visible `视觉创作` header, `图片` label, empty `图 1` preview, composer and history. There should be no project create/rename/delete controls, version tree/compare controls, target-settings overlay or video entry.
2. Check the model selector, prompt and quantity. Empty prompt, invalid count, or unavailable model should block generation. `TEST ONLY Disabled` is a disabled native option and cannot be selected normally. To check an already selected model becoming unavailable in this fixture, mark that target disabled in `window.__fixture.settings.targets`, then refocus the model selector and inspect the refreshed UI and absence of `POST /jobs`. Configuration belongs to provider settings; no workbench target editor should appear.
3. Enter a prompt in text-to-image mode and submit using the enabled model. The fixture waits 450ms, returns a job, and sends two `asset.ready` events and `job.finished`. Verify history cards/thumbnails and the large original preview; click each history result and verify the selected preview changes while the editable prompt stays intact. Verify actual image decoding, aspect ratio and containment in the browser.
4. Exercise `文生图` and `图生图`. Upload a local PNG through `上传参考图片`, then independently drag and paste an image into the composer. Verify the actual file input, native drop and clipboard paths, multipart audit metadata, automatic image-mode selection, input thumbnail/removal and `source` input in the generated request. Switching back to text mode should clear image inputs while retaining the prompt. Check unsupported formats and oversize files; a real upload cancellation needs a slow/held upload fixture or test transport (the default fixture completes uploads immediately).
5. Generate multiple prompts. Search history by prompt and model name; combine with `全部`, `有结果`, `进行中` and `需关注`. Verify the no-match state, clearing filters, selected preview, and `恢复输入` restoring prompt/model/mode/count/parameters and input references. Check `继续修改` binds the selected output as input. The DOM regression covers restoration across existing archives; the default browser fixture starts empty.
6. Double-click submit during the 450ms pending response and verify one `POST /jobs`. After acceptance the same `生成`/`编辑` button stays; edit the prompt, click once and verify a second `POST /jobs` with a new key and the edited inputs. In Lost receipt mode, verify the `提交结果未确认` notice; the next click sends the current draft under a new key (check the history before retrying to avoid a duplicate paid job).
7. Submit error mode returns `IMAGE_INVALID_INPUT`. Verify error feedback, retained draft and recovery after changing the prompt. Pending / cancel mode keeps SSE open; `取消任务` should produce a cancelled snapshot and terminal history state. Local-only cancellation and cancel-response failure require additional fixture responses; the DOM tests cover the cancellation label/state semantics separately.
8. SSE reconnect mode ends the first stream after seq 1. Verify the next audit `Last-Event-ID` is 1 and final results appear once.
9. On the isolated settings route, saving increments revision. The conflict checkbox returns `IMAGE_REVISION_CONFLICT` on the next save and advances fixture revision. Verify draft retention, conflict review and save workflow through the actual controls. This route reload cannot prove workbench same-client invalidation; that is covered by the mounted DOM regression and still needs actual host/browser acceptance.
10. Settings secret input must use a synthetic marker only. Verify successful clearing and absence from rendered text, draft persistence and audit. The audit intentionally redacts write-only values; that alone does not establish component non-leakage.
11. Verify a desktop viewport has a large preview above its composer and history beside it; check independent scrolling, long prompts and multiple input thumbnails. At an actual narrow viewport, check stacked layout and the `历史记录` toggle, including closing history after result selection. Verify controls and parameter popover remain reachable without overlap or horizontal clipping. Do not report CSS inspection or a narrow container as mobile viewport verification. If the tool cannot resize/emulate a viewport, record mobile as unsupported/unverified.

Fixture limitations: all output images share a test canvas, success emits two outputs regardless of requested count, asset parent lineage is empty, project revision checks and event-gap reconciliation are not simulated, uploads are immediate, and exports are not configured. These are test-fixture limitations and must not be reported as product defects. The UI and controller may still be changing in the parallel parent task; rerun against their final revision.
