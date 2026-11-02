# 图像平台协议证据矩阵

日期：2026-10-11。本表汇总同目录五份研究记录，未进行新的协议核对或真实调用。文档证据、静态测试和真实接入分别登记；表中的操作仅指文档支持。

| 平台记录 | 所选产品 | 执行方式 | 文档支持的操作 | 收窄契约完整 | 真实验证 | 剩余证据与验证 |
| --- | --- | --- | --- | --- | --- | --- |
| [OpenAI](openai.md) | Images API / GPT Image 2 | direct | generate、reference、edit、mask | true | false | 请求/响应 fixture、模型权限、usage、遮罩实际效果 |
| [Google](google.md) | Gemini Developer API generateContent | direct | generate、reference、edit | false | false | 输出格式枚举、模型级 MIME/候选数限制、地区与模型信息 |
| [火山](volcengine.md) | Ark Images API / Seedream 5.0 pro | direct | generate、reference、edit | true | false | fixture、账号权限、真实单图生成与编辑 |
| [即梦](jimeng.md) | 图片生成4.0 / Visual OpenAPI | async | generate、reference、edit | true | false | CV 专用官方固定签名向量、fixture、提交与轮询实测 |
| [RunningHub](runninghub.md) | 国内站 ComfyUI Workflow API | workflow | 尚无具体工作流可确认 | false | false | 用户工作流 ID、revision、输入输出映射、新查询接口适用性 |

`contractComplete=true` 仅适用于各记录的 `contractScope`，不代表全部计划完成。五个平台的静态 Adapter 测试均未运行，`liveVerified` 均为 false；生产目标尚不能启用。`index.json` 保存研究记录中的证据对象，必须与各 Markdown 文件完全一致。

用户已授权改为基于 LiveAgent 的 `v2-kbrian` 接入基础继续当前 Goal。此前等待 main 的暂停决定已撤销；K-Brain 源码目录授权仍需实际生效。平台证据缺口单独保留，不通过更换实施基线消除。

恢复双仓实施后，先冻结配置与 wire contract，再以 fake Adapter 和脱敏 fixture 验证引擎。真实平台验证另行记录模型/工作流、授权、预算及调用结果。当前矩阵没有真实调用收据，也没有实现功能的验收结果。
