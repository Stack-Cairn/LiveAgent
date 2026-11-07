---
tags: [ci, actions, 运维]
---

# Actions 事件策略清单(上游 Stack-Cairn)

GitHub 从 2026-12-02 起默认拦截公开仓库的 `pull_request_target`,除非 Actions 事件策略显式允许。以下设置需要有 admin 权限的人在上游仓库操作,maintain 权限看不到也改不了。

依据:[变更日志](https://github.blog/changelog/2026-11-02-pull_request_target-blocked-by-default-december-2/)。入口名称和字段以仓库 Settings → Actions 页面实际显示为准,本文未在 UI 里核对过。

## Stack-Cairn/LiveAgent

| 项 | 操作 | 原因 |
|---|---|---|
| 事件策略 | 允许 `pull_request_target` | `.github/workflows/pr-governance.yml` 用它给 fork PR 写评论、转 draft;fork 的 `pull_request` 事件拿不到 secrets |
| 其余事件 | 保持默认 | 其他 workflow 只用 `pull_request`、`push`、`schedule`、`workflow_dispatch` |

该 workflow 不检出 PR 代码,不需要 `allow-unsafe-pr-checkout`。以后若要在其中加 `actions/checkout`,必须检出基线分支,不能检出 PR 的 head 或 merge 引用。

## Stack-Cairn/K-brain

| 项 | 操作 | 原因 |
|---|---|---|
| 事件策略 | 无需改动 | 没有 `pull_request_target`,也没有 `workflow_run` |

## 验证

- 2026-12-02 之前 GitHub 有两次演练拦截,演练期间 PR 治理检查会不触发。事先配置好策略即可避免。
- 配置后开一个测试 PR,确认 PR Governance 检查正常出现。
