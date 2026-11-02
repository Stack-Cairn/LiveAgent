# PR #985 browser transport verification

Chrome on macOS, 2026-10-14. These screenshots show a local HTTP test harness importing the actual `createKBrainClient`, not the LiveAgent application interface. No real model or user data was used.

The fixture accepts the run but holds its POST response. Start and Stop are clicked in the browser before acknowledgement.

- Before: the base branch aborts the request, leaving the simulated backend running.
- After: the PR recovers the run by the original request ID, then the caller invokes the existing cancellation API. Exactly one run-creation POST is sent.
- Desktop (1120 × 700) and mobile (390 × 780) both pass.
- Separately, 29 Node client/turn tests pass, including `runKBrainTurn` against a real local HTTP fixture.

This is transport verification, not full native desktop or application UI acceptance.
