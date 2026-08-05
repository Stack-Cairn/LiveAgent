<!--
Read .github/CONTRIBUTING.md before submitting.
A PR failing any of the following is automatically converted to draft:
  1. The body references an issue via Closes/Fixes/Resolves #123;
  2. UI / feature / backend behavior changes include screenshots or a runtime preview;
  3. No merge conflicts with the target branch.
-->

## Linked issue

<!-- Required. Feature and bug-fix PRs must reference an issue; use a closing keyword so it closes automatically on merge. -->

Closes #

## Summary

<!-- What problem does this solve and how. Keep the PR focused; no unrelated refactors. -->

## Change scope

<!-- List the affected modules and key files/directories so reviewers can locate the change quickly. -->

- Modules: <!-- e.g. frontend / backend / src-tauri -->
- Key paths:

## Screenshots / preview

<!-- Evidence of the change in action:
  - UI changes: before/after screenshots or a recording (required);
  - Backend/CLI changes: request-response examples or run logs (secrets removed);
  - Performance changes: before/after numbers (benchmark, latency, memory).
  For pure refactors/docs, write "N/A" with a reason. -->

## Verification

<!-- How you verified this change:
  - Checks you ran, e.g. cargo test --workspace
  - Tests added or updated for behavior changes (or why none were needed).
-->

## Pre-submit checklist

- [ ] A requirement issue is linked (or this is a trivial fix that needs no issue, as explained in the summary).
- [ ] Synced with the target branch; no merge conflicts.
- [ ] The change is focused, with no unrelated modifications.
- [ ] No secrets, tokens, or personal data included.
- [ ] Docs are updated for changes affecting user behavior, deployment, or configuration.
