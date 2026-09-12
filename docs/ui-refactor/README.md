# UI 重构临时文档

本目录仅用于本轮 UI 重构的迁移计划、排查记录和阶段验证，不属于长期项目文档。

**PR 合并前必须删除整个 `docs/ui-refactor/` 目录，包括本 README 和以下全部文档，不得随 PR 合入目标分支。**

## 文档索引

- [ui-color-migration.md](ui-color-migration.md)
- [ui-component-drift-audit.md](ui-component-drift-audit.md)
- [ui-design-audit.md](ui-design-audit.md)
- [ui-shadcn-migration-plan.md](ui-shadcn-migration-plan.md)
- [ui-style-variables.md](ui-style-variables.md)
- [ui-toast.md](ui-toast.md)
- [ui-tsx-split-audit.md](ui-tsx-split-audit.md)
- [pr-description.md](pr-description.md)
- [settings-ui-phase-2-plan.md](settings-ui-phase-2-plan.md)

## 合并前清理

- 删除本目录及全部内容。
- 删除 `docs/README.md` 中指向本目录的临时导航。
- 清理源码注释、其他文档和 PR 描述中指向本目录的引用，避免留下失效链接。
- 如有必须长期保留的规范，先提炼到正式文档，再删除临时记录。
- 检查最终 PR 差异，确认不再包含本目录文件或新增的临时文档引用。

## DropdownMenu 使用约定

默认使用共享 DropdownMenu 的圆角、字号、字体、边框、背景、高亮和动画。
调用方 className 只保留内容宽高、滚动、截断、排列等必要布局。
选中态使用 accent 语义颜色；危险操作保留 destructive 语义，不另造配色。
多行说明、品牌图标与状态信息允许必要的语义差异。需要新的通用外观时先评估共享组件，
不要在单个业务菜单中加入额外圆角、小字号、磨砂、投影或进退场动画。
Trigger 仍根据其按钮、图标、表单字段用途布局，不与菜单项混为同一种控件。
