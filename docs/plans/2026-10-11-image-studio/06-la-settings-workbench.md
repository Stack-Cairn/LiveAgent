# 06：LA 图像设置与共享工作台实施计划

> 执行者逐任务勾选，优先使用 subagent-driven-development 或 executing-plans；不可用时按本文执行。验收前不提交。

**Goal：**用户在桌面和WebUI配置图像目标，完成生成、挑选、继续编辑、版本比较和导出。

**Architecture：**agent-ui拥有纯UI、表单与任务状态模型，host Adapter提供design的ImageStudioClient。设计项目和历史由K-Brain管理，草稿仅本地保存并以owner/backend/project隔离。

**Tech Stack：**React19、TypeScript、现有共享UI组件和测试runner，不引入完整图形编辑器。

**Spec：**[统一规格](design.md)，依赖01类型、05客户端。

## 2026-10-14 用户界面修订（优先于早期独立设置页描述）

图像服务配置统一放入原有供应商设置页；模型/工作流目标管理放在创作输入区的目标设置中。取消独立图像设置导航和工作台右上角图像设置按钮，沿用应用原设置入口。连接与目标使用现有同一后端配置，不重新迁移数据；切换和关闭保留未保存修改保护。实际修改与验证见[入口收拢记录](../../worklog/2026-10-14-image-settings-consolidation.md)。

## 全局约束

设置按目标能力渲染，不把vision当image output。前端不能执行供应商请求、节点脚本或认证签名。UI中文，错误可操作，未知usage不显示0元。无真实进度使用阶段与不确定动画。共享逻辑放agent-ui，不复制桌面/WebUI两个实现。

## 文件地图

新增 `crates/agent-ui/src/features/image-studio/ImageStudioPage.tsx`、`ImageProjectRail.tsx`、`ImageComposer.tsx`、`TargetParameterForm.tsx`、`ResultGallery.tsx`、`ImageDetailPane.tsx`、`ImageCompareView.tsx`、`useImageStudio.ts`、`studioModel.ts`、`parameterModel.ts`、`drafts.ts`。

设置新增 `crates/agent-ui/src/pages/settings/ImageSettings.tsx`、`imageSettingsAdapter.ts`。修改 `crates/agent-gui/src/App.tsx`、`crates/agent-gateway/web/src/app/GatewayApp.tsx`及各自实际settings导航。共享应用壳 `crates/agent-ui/src/application/AppWorkbenchChrome.tsx`当前依赖ChatHeader，设计页复用AppHeaderFrame，不强塞ChatHeader的会话props。

测试新增 `crates/agent-gui/test/image-studio/parameter-model.test.mjs`、`studio-model.test.mjs`、`drafts.test.mjs`；WebUI新增 `test/image-studio-ui.test.mjs`。沿已有测试装载TS方法，无需额外框架。

## Task 1：图像设置与目标配置

**Consumes：**ImageStudioClient getSettings/saveSettings/writeSecret/listTargets。

**Produces：**独立图像设置页，公开配置编辑与owner级写秘密流程。

- [ ] 实现新增连接：引用现有provider或独立连接；选择供应商与协议是不同字段。保存先写secret取得ref，再提交公开配置，失败回滚未引用secret或进入可清理状态。
- [ ] 能力只在验证后开启；目标可手动录入模型，也可录入工作流remoteId与已声明字段映射。验证状态显示“未验证/契约已验证/实际调用已验证”。
- [ ] 删除依赖提示具体target，revision冲突刷新后保留用户draft并展示冲突，不覆盖远端更新。
- [ ] 连接测试区分无费用的认证/目录查询与实际生成。实际测试清楚显示模型、次数和可能收费，按授权执行。
- [ ] secret输入保存后清空，历史返回只有configured状态；不放localStorage，不复制到诊断面板。
- [ ] 运行桌面/WebUI现有settings测试与新ImageSettings测试，至少覆盖已有provider复用和工作流配置。

## Task 2：能力表单与参数迁移

**Produces：**纯函数 `validateParameters(target: ImageTarget, params: Record<string,unknown>): FieldError[]`、`migrateParameters(from:ImageTarget,to:ImageTarget,params:Record<string,unknown>): {values:Record<string,unknown>; dropped:string[]}`。

- [ ] 按受限schema构建枚举、数字、boolean和text；单独显示单位，mandatory先验证，后端仍二次验证。
- [ ] 切换target保留兼容值；不兼容值展示调整列表，不静默删除后立即执行。工作流node ID只在设置页，创作区显示字段label。
- [ ] 操作选择只显示operations；source/reference/mask明确标签，mask只有支持时出现。首版允许导入遮罩文件，不要求实现画笔。
- [ ] 测试target切换：1:1→支持1:1保留，4K→不支持显示dropped；bool不能被string真值替代，缺必填不能提交。

```ts
const source = { size: "4K", quality: "high" };
const migrated = migrateParameters(targetA, targetB, source);
assert.deepEqual(migrated.dropped, ["size"]);
assert.equal(migrated.values.quality, "high");
assert.ok(validateParameters(targetB, { size: "4K" }).length > 0);
```

targetA/targetB由测试内定义：A的size枚举1K/4K、B仅1K，二者quality均支持high；不能借助真实平台能力假设。

- [ ] 运行 `node --test crates/agent-gui/test/image-studio/parameter-model.test.mjs`。

## Task 3：任务模型与草稿

**Produces：**`applyImageEvent(state:StudioState,event:ImageEvent): StudioState`；`draftKey(ownerId,backendId,projectId):string`。

- [ ] StudioState至少有projects、jobs、assets、selectedAssetId、lastSeqByJob；事件revision/seq较旧则忽略，snapshot恢复保持选中图。
- [ ] 点生成时冻结输入+key，双击复用key，响应未知保留提交状态。明确“重新生成”才创建新key；不能上传成功后失败就丢草稿。
- [ ] draft只存prompt、targetId、公开参数和已保存资产ID，不存secret/下载URL/全尺寸图片；schema version=1，恢复先验证资产可用。
- [ ] owner/backend/project切换隔离草稿和订阅，项目删除清理本地draft；失效输入提示重传。
- [ ] 测试重复事件不重复图卡、partial保持成功图、unknown允许核对/明确重试、切后端不混历史。
- [ ] 运行 `node --test crates/agent-gui/test/image-studio/studio-model.test.mjs crates/agent-gui/test/image-studio/drafts.test.mjs`。

## Task 4：工作台与编辑版本

- [ ] 页面布局左项目/素材、中画廊、右详情、底创作区；窄屏收起侧栏。生成不中断用户查看已有图。
- [ ] 图片卡显示阶段、完成项数和可用操作；计数是实际结果数量，不是虚假百分比。
- [ ] 选择图片→继续修改：source绑定assetId、parentAssetId同该asset；native续接由backend决定。跨target提示新的参考/编辑方式，不宣称继承原上下文。
- [ ] 版本详情展示实际prompt/target/参数快照和父图片；原图不覆盖。比较只读缩放和左右对照，不引入编辑器。
- [ ] 失败项展示脱敏错误与具体动作：401配置、429等待、参数错误修改、unknown核对或明确重新生成；部分成功可选择成功图继续。
- [ ] 导出菜单由host capability决定；调用exportAsset返回saved后才提示保存成功。
- [ ] 入口旧后端不支持时显示升级提示；工作台异常由独立error boundary隔离。

## Task 5：双端验收

- [ ] 运行 `pnpm --dir crates/agent-gui typecheck`、`pnpm --dir crates/agent-gui test:frontend`、`pnpm --dir crates/agent-gateway/web test`、`pnpm --dir crates/agent-gateway/web build`、`node scripts/check-mirror.mjs`。
- [ ] fake backend验证生成→选第二图→编辑→对比→导出；刷新找回项目，草稿也恢复。
- [ ] 人工测试窄屏、键盘聚焦、中文输入法、拖图、无图片响应、参数切换和用户取消导出。

**验收：**两个host只提供I/O，核心表单和工作台共用。任意平台秘密不出现在UI结果、草稿、导出。真实平台可用性不由mock测试宣告，07单独核对。
