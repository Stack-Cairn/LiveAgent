# Issue #842：Git 审查分支下拉增加筛选输入框

- 上游 Issue：https://github.com/Stack-Cairn/LiveAgent/issues/842
- 基线：`develop` @ `9aadbc5f`
- 分支：`feat/git-review-branch-filter`

## 背景

Git 审查面板顶部的分支切换下拉（`GitReviewBranchMenu`）只平铺全部分支，没有筛选入口；Composer 里的 `GitBranchSelector` 已经有「筛选分支」搜索框。用户希望两处一致。

## 改动

只改一个文件：`crates/agent-ui/src/components/project-tools/git-review/Toolbar.tsx`

- `GitReviewBranchMenu` 新增 `filter` 状态；下拉标题下方放一个带放大镜图标的 `Input`。
- 匹配规则与 Composer 一致：`fullName` 大小写不敏感子串匹配，本地与远程同时过滤。
- 输入框 `onKeyDown` 调用 `stopPropagation`，避免触发菜单 typeahead；`Esc` 只清空筛选不关菜单；输入法合成中不处理。
- 菜单关闭时重置筛选。
- 远程分支 40 条截断在筛选后应用，并新增「还有 N 个远端分支未显示」提示（复用 `git.branchSelector.moreRemoteBranches`）。
- 无匹配时显示 `git.branchSelector.noMatches`。
- 容器改为 `flex-col` + `max-h-[min(400px,75dvh)]`，列表区独立滚动，搜索框固定在顶部。

复用了已有 i18n 键，没有新增翻译。

## 验证

- `pnpm exec biome check --write` 该文件：通过
- `pnpm --filter @liveagent/ui typecheck`：通过
- 未做真机手测（需启动 Tauri 端）。
