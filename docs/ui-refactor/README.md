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

## 合并前清理

- 删除本目录及全部内容。
- 删除 `docs/README.md` 中指向本目录的临时导航。
- 清理源码注释、其他文档和 PR 描述中指向本目录的引用，避免留下失效链接。
- 如有必须长期保留的规范，先提炼到正式文档，再删除临时记录。
- 检查最终 PR 差异，确认不再包含本目录文件或新增的临时文档引用。
