# 2026-10-13 23:42 授权后续作

## 用户明确授权

- Gateway：单人使用。先前单/多用户选择阻塞解除，不宣称多用户支持。
- URL图片下载：按此前限定范围重新审核；本轮工具写入实现成功，没有再次拒绝。
- 浏览器：允许测试工具访问隔离夹具127.0.0.1:18473，仅此端口，无生产账号。
- 真实验证：仅RollDek供应商，累计最多50张图片。图片数量预算不是50元，不跨供应商调用，不在日志/聊天回显秘密。

## 已执行的代码修改

K-Brain新增internal/imaging/assets_download.go、assets_download_test.go。SaveOutput接入URL输出：仅HTTPS/443，拒绝userinfo、fragment及本机/内网/元数据/特殊地址；DNS结果必须全部公网，实际Dial绑定已验证IP；每跳重新检查并重新解析；跳转最多3次；60秒截止；不继承proxy、cookie、供应商client/认证；禁止压缩传输；按已有图片byte/pixel上限解码PNG/JPEG/WebP，复用原有原子落盘和事务发布。

旧资产和调度测试期待所有URL unsupported，更新为拒绝私有输出地址，任务失败且不发布结果；unknown输出kind仍unsupported。新测试覆盖合法PNG解码、私有跳转未进入transport、3次跳转预算、Content-Length超限、非法bytes、IPv4-mapped与特殊地址、无Authorization/Cookie/Referer。没有访问这些测试地址或公网下载。

运行隔离命令：go test ./internal/imaging/... ./internal/backend -run 'ImageOutput|Asset|Download|Verification|Scheduler|Recover' -count=1，全部所选用例通过；async包显示no tests to run，不算异步新覆盖。imaging1.045s、direct0.019s、backend0.505s；git diff --check通过。Go环境清空LIVEAGENT_HOME/K_BRAIN_HOME及backend token，HOME/USERPROFILE指工作区隔离目录。

仍需额外专项审查TLS/IPv6转换地址策略、下载重试与真实CDN响应，然后真实平台验收；测试通过不等于全部安全或生产通过。

## 实际浏览器证据

- Vite隔离夹具启动，已成功在Alma侧栏通过alma iab goto打开，随后BrowserOpen创建受授权的独立测试浏览器。未修改全局allowPrivateUrls设置，未访问其他私有地址。
- 初次服务误设1000ms timeout，已超时退出；随后重启为后台运行（工具shell ID 9653b593-de61-491e-b51c-193b111f92e1），该工具配置600000ms寿命，不能宣称无运行期限。若继续测试时过期，重新启动而不重复已有验收。
- BrowserClick的text参数不是可靠定位，第一次没有提交项目；根据DOM实际选择控件，通过真实React输入事件/目标按钮DOM click完成，不把工具success当产品动作成功。
- 项目fixture-project创建：audit有POST /v1/image/projects；填入blue poster、选fake-enabled，POST /v1/image/jobs仅1次，带同一Idempotency-Key、count=1。SSE从0订阅，job snapshot completed，两个thumbnail GET，实际document.images两张naturalWidth=320且已解码，界面显示已完成/2张可用结果。
- 夹具故意总返回2张，即使count=1；这是夹具限制，不是产品真实批量保证或RollDek输出。浏览器基本生成路径已实际验证，其他场景、手机视口、原生Tauri及生产双端验收仍未完成。

## RollDek图片调用账本

| 累计授权上限 | 已发真实收费请求 | 已确认生成图片 | 不确定占用图片额度 |
| --- | --- | --- | --- |
| 50张 | 0 | 0 | 0 |

此表按实际请求更新，不把fake图算收费额度；真实调用前先确定RollDek连接、模型和协议。任何提交结果未知按请求可能生成上限计入保守占用；不自动换key重发。必要时保留剩余额度不执行。

## 后续及限制

单人Gateway生产装配仍未完成；RollDek连接识别与真实调用尚未开始。本轮专项代理依旧spawn cmd.exe ENOENT失败，父执行者直接完成以上工作，未调用编码CLI绕过。现有用户修改不暂存、不恢复、不删除。未提交/推送/PR；用户人工验收与requiredCI仍未完成。
