# 2026-10-14 原生图像工作台隔离与实际验收

继续原用户授权，未收费调用、提交、推送或PR。运行机制显示原Goal在50轮后停止，不能据此称Goal完成；用户07:06继续授权用于推进已有实现。

## 原生隔离实现

新增runtime/data_home.rs。调试构建显式LIVEAGENT_DEV_HOME使用绝对目录；无override保持OS home；空/相对override返回None，不访问个人fallback；release不接收开发override。配置、历史、引擎、浏览器profile/扩展、skills、memory、MCP OAuth文件、托管进程、上传和checkpoint持久化入口采用该方法，未批量改变所有dirs调用或假称系统级访问隔离。默认运行行为不变。

隔离模式禁用个人浏览器扩展桥接，OAuth不接触系统keyring，使用隔离文件fallback。Tauri验收覆盖配置指定独立应用identifier=com.xiaofei.liveagent.image-studio-acceptance。开发脚本允许透传--config，仍先编译当前KB源码，失败拒绝启动；本地脚本不纳入提交。

测试cargo test --lib runtime::data_home::tests：3/3通过，分别测试隔离不调用系统home、无效override不fallback、默认保持系统home；初次运行编译1m02。随后新增OAuth/bridge隔离已由真实原生dev构建成功证明编译，尚未运行其专门行为测试。

## 原生窗口实际收据

通过当前工作区.liveagent/dev-run.sh，KBRAIN_REPO显式指当前授权子仓.liveagent/subprojects/K-brain，源码构建后接LA。日志记录dev构建1m31完成，运行当前target/debug/liveagent.exe，MCP插件identifier为隔离标识；CDP 9222发现page=http://localhost:1420/，不把其他浏览器fixture当Tauri。

- CDP读取真正原生body：初始无个人模型/历史；打开图像工作台，后端连接正常，没有供应商目标时生成禁用。
- 真实输入/点击创建Native isolated acceptance项目，界面列出项目；Page.reload后重新进入工作台，projectRestored=true。
- 打开实际图像设置，初始版本0。新增无凭据连接，名称Native acceptance no-credential，保存后显示已同步版本1/已保存；凭据尚未配置、passwordEmpty=true。不向个人或测试服务写真实Key。
- 实际目录观测：home/.liveagent下config.sqlite、chat-history.sqlite3、memory-index.sqlite3、gateway-chat-sync.sqlite3；home/.liveagent/kbrain/imaging/transactions.wal含项目，KB config在该根。未读取个人数据库内容。
- WebView实际user-data-dir为Windows LocalAppData/com.xiaofei.liveagent.image-studio-acceptance/EBWebView，而非覆盖JSON中的工作区webview路径。独立identifier与日常客户端缓存分离，但不能说缓存全部位于workspace。仅通过进程参数观测，本报告不保留其他应用的参数。

工具初次background命令600秒寿命导致退出，最后热更新页面复核连接拒绝，未算通过。重启尝试中误重复显式timeout已停止；最终用不含timeout字段的background shell f304af33-4c22-485f-9480-8e26a6080856继续dev-run，运行寿命不设上限；重启后日志确认source=working tree feat-image-studio @7308d71，包含origin/main，构建包含14个已跟踪未提交文件和本任务新模块；未回落到clean上游。dev构建28.40s完成，当前CDP9222重新可用，进程保持运行。实际最终复核结果见下段。

## 原生操作发现与修复

无目标时保存连接，工作台误提示“当前目标已删除”。新增公共controller回归先失败，再修refreshTargets：只有draft.targetId非空且目标不存在时提示删除；从未选目标时不发误报。删除原已选目标仍保留输入与冻结提交记录。

review7和settings-invalidation联合22/22通过，定向Biome通过。最终在重新编译启动的真实原生窗口操作：打开图像工作台、设置、读取最新设置；emptyTargetDeletionNotice=false，savedConnectionPresent=true，projectPresent=true，syncedVersionOne=true，alerts=[]。这同时验证客户端完整重启后的项目与公开连接恢复，不仅Page.reload或模型测试。

## 未完成与下一步

此收据覆盖真实Tauri工作台导航、项目创建/刷新、无凭据配置保存，不是全部人工矩阵。原生图片生成/导出、同机单用户生产Gateway完整联调、RunningHub模型真实成功与工作流graph条件、即梦签名及异步验证范围仍待完成。当前无新增收费，RollDek/RunningHub账本分别读取，不清零原unknown。

用户未明确人工反馈通过，commit/PR/requiredCI不执行。已有用户修改全部保留，不复用旧源码binary进行验收。

## 07:21 后续通知与真实原生生成

读取b6d3a503与fb306312退出收据：两者已结束、stdout/stderr空、exit1、timedOut=false，是此前主动停止的限时尝试；不当产品崩溃。后续无寿命上限shell f304af33保持running。

用户允许RollDek累计50张，本轮额外仅1张，用当前Tauri管理的K-Brain实例和隔离配置进行验证，不重复使用独立临时后端。凭据从用户已配置连接只在内存与该隔离secret API使用，无回显。保留原无凭据连接，新增Native RollDek验收目标；验证成功后显式公开配置启用该最小目标，未对个人配置写证据。

第九请求rolldek-native-acceptance-ninth：receipt verified、job succeeded、asset ia_080a778b383fcf6bf76848b532217aab、project ip_b92e83e4-b32d-4d7a-bfb8-dc39963a4bbe。账本9/50保守占用、3张确认生成、剩余41；RunningHub仍1次unknown，无追加。

实际Tauri Page.reload后打开工作台，选Native RollDek real image acceptance：完成1图，缩略图实际解码307x512；选结果后显示实际prompt、目标revision、未知费用、两个原生导出目的地和启用导出按钮。详情当前也是缩略预览，未伪称原图预览。

直接通过Tauri-managed backend原图接口认证读取并核验PNG：866629字节、971x1619、SHA256 f359a0af968bd00cb782fefa721fe11c5055e3ed3c46eb7c0a05da1eaf6322a8。证据保存[原图](../testing/rolldek-native-acceptance-2026-10-14.png)与[原图收据](rolldek-native-original-receipt.json)。该下载是原图接口证据，不冒称系统保存对话框通过。

Rust commands::image_export::tests 8/8通过，42.17s编译；认证原图、拒绝redirect、显式覆盖、原子发布、大小/类型、路径设备名及失败保留旧文件均测到。computer-use技能明确不支持Windows，未用全局SendKeys抢焦点；原生保存对话框仍待用户操作验收。没有PR/提交。