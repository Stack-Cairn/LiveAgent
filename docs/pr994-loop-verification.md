# PR #994 loop integration

## Runtime dependency

The desktop lock uses K-brain `v0.107.6-beta.14` at
`473db05596c6554dcb4dec7645ae26f9aa62875c`, including merged K-brain #37.
All four desktop platform entries use the published release's SHA-256 checksums.
Desktop release builds download these assets; they do not compile K-brain.

## Implemented behavior

- GUI and WebUI forward interval strings to K-brain instead of approximating
  elapsed intervals with calendar cron expressions.
- Positive integer `s`, `m`, `h`, `d` intervals, up to seven days; K-brain clamps
  intervals shorter than one minute. Examples: `90s`, `90m`, `25h`.
- Immediate first occurrence, persisted deadlines, no overlapping workers or
  catch-up queue, seven-day expiry, maximum 50 active loops per backend.
- Each occurrence runs in an independent backend context with configured tools.
  Prompts must contain all necessary context. Results enter the parent history
  only when idle, with idempotent delivery. Cancelling stops the loop worker,
  not the parent turn. Deleting the conversation also removes its loops.
- The visible desktop conversation watches backend history events with a
  disposable, reconnecting subscription and refreshes the existing sidebar
  state. Existing transcript hydration preserves drafts and active turns.
- Command errors retain the draft. Creation feedback explains execution,
  expiration, limits and cancellation in English and Chinese.

## Verification on macOS

- Backend: full Go suite, vet, and race tests for backend/agent/goalloop.
- GUI: 3,221 frontend tests passed, one skipped.
- WebUI: 793 tests passed.
- Published macOS backend: 12 composer/goal/loop/history-watcher tests passed.
- Gateway Go suite, GUI/WebUI type checks and production builds passed.
- Packaging: 11 preparation/verification tests passed; both published macOS
  binaries verified against the release checksum manifest and prepared with
  `locked-download` origin. Direct Node download initially timed out in this
  environment; the same assets were downloaded with GitHub CLI and placed in
  the checksum-verified cache before retrying preparation successfully.
- Chrome integration harness rendered the production MentionComposer with
  GUI and WebUI hosts, forwarding to a real local K-brain process with a
  scripted model provider. At 1280 px and 390 px widths, both hosts passed
  create, immediate result in backend history, list, invalid-draft retention
  and cancel, without browser errors or horizontal overflow.

The Chrome harness is not a full native desktop or remote Gateway deployment
acceptance test. WebUI RPC/desktop bridge routing is additionally covered by
the automated gateway and composer-action suites.

## Explicit limits

An explicit interval is required: natural-language frequency parsing is not
implemented. Each occurrence starts fresh instead of continuing the same
worker's context. The backend must remain running. Parent result messages are
truncated at 4,000 runes, with fuller output in bounded scheduled-task logs.

A final backend regression also verifies that prior worker compaction summaries
are cleared before the next occurrence; this fix is included in beta.14.
