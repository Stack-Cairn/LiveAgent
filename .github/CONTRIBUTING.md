# Contributing to LiveAgent

This guide covers the contribution process only. Technical details live in the project docs and stay authoritative there — this file should rarely need updates.

## Getting started

- Toolchain: run `mise install` in the repository root to install every version pinned in `mise.toml`.
- Local development, build, test commands, ports: see [docs/operations/development.md](../docs/operations/development.md), or run `make help` for the full command list.
- Architecture and module boundaries: start from the [docs index](../docs/README.md).
- Locating source code by feature: see [docs/reference/source-map.md](../docs/reference/source-map.md).

Note: project docs and code comments are primarily written in Chinese.

## Verify before submitting

Run the checks for the modules you touched. The CI definition in [`.github/workflows/ci.yml`](workflows/ci.yml) is the source of truth for what must pass; [docs/operations/development.md](../docs/operations/development.md) explains how to run the equivalents locally.

## Code requirements

- **Stay focused**: one PR does one thing. No unrelated refactors or reformatting.
- **Keep comments and docs in sync**: match the comment language of the surrounding code; update affected comments and docs when you change code — stale comments are worse than none.
- **Never hand-edit generated code**: proto-generated Go code, WebUI build output, etc. must be regenerated via their commands (CI verifies they are in sync).
- **No secrets**: API keys, tokens, personal data, `.env` files, and local configuration must never be committed.

## Pull request process

Open an issue first (feature request / bug report), wait for it to be confirmed, then open a PR that references it with `Closes #N`. The following rules are enforced automatically — a PR failing any of them is **converted to draft**; fix it and click "Ready for review" to re-run the checks:

| Check | Requirement |
| --- | --- |
| Linked issue | Body contains `Closes #N` / `Fixes #N` / `Resolves #N` |
| Screenshots / preview | UI changes must include screenshots or a recording; backend / CLI changes should include request-response examples or logs as text |
| No merge conflicts | Resolve conflicts with the target branch on your own branch before requesting review |

Trivial fixes (typos, comments) may state an exemption reason in the PR description, at the maintainers' discretion. Do **not** report security vulnerabilities in public issues — use [Security Advisories](https://github.com/Stack-Cairn/LiveAgent/security/advisories/new) instead.

## License

By contributing, you agree that your code is licensed under this repository's [MIT License](../LICENSE).
