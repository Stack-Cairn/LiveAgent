# 2026-10-14 图像设置入口收拢

用户07:39修订：图像设置并入供应商配置；图像目标放入输入框设置；去除工作台右上角图像设置按钮，统一原有设置按钮。继续原任务，不另建分支、不覆盖用户配置、不提交。

## 实际修改

- SettingsPage的providers页新增ProviderImageServices，共用原供应商设置入口，子页为对话模型/图像服务；图像服务只管理连接地址、认证、凭据、代理和并发。
- 删除设置导航中的独立image-studio项，旧initialSection=image-studio兼容跳转providers。工作台导航本身继续保留，不能误删用户工作台入口。
- ImageSettings增加panel=connections/targets/all显示模式，复用原配置读取、revision冲突、秘密写入、依赖删除和离开保护。未迁移或重建后端数据。
- ImageComposer输入区新增目标设置，通过既有共享Dialog打开目标配置：模型/工作流、参数schema、能力和验证，选择已配置连接；无密码输入，无新增连接。没有连接时指向原设置→供应商设置→图像服务。
- 移除ImageStudioPage右上角图像设置按钮。目标选择与生成参数仍在输入区；输入区未选择项目时也可打开目标设置，避免初始化死路。
- 图像服务切回对话模型前检查未保存guard；目标Dialog关闭/Escape遵同一guard。使用现有Dialog处理焦点/Portal/键盘，不另造全局悬浮菜单。确认放弃才关闭，取消保留草稿。设置保存通知刷新当前工作台目标，保留项目/输入/历史。

## 验证

GUI/WebUI typecheck和build通过，GUI构建8.61s，WebUI5.24s；UI boundary通过。桌面+共享图像99/99通过，WebUI图像/身份16/16通过；新增真实React测试：供应商页只连接不目标，目标面板只目标无凭据，未保存目标Dialog关闭取消仍保留。

旧composer交易测试使用简化React mock，不具备createContext；新Dialog依赖导致1项失败。只在该测试边界隔离ImageTargetSettings，Dialog另用真实DOM测试，原双击/幂等行为继续测试并通过，不放宽产品逻辑。

实际Tauri复核：工作台标题区域无图像设置按钮；输入目标设置Dialog正常加载目标remoteId/连接选择/参数/验证，无password；原有设置按钮打开完整设置，nav=[system,providers,agents,skills,mcp,cron,planning,memory,hooks,systemTools,stt,ssh,remote,shortcuts,backup,about]无独立image-studio配置；providers→图像服务显示两个既有连接，无新增目标按钮。

验收中SettingsPage曾报t is not defined：Vite实际模块残留t依赖引用，完整reload仍复现。恢复明确useLocale翻译上下文，用于供应商子页导航label并列入memo依赖；修复后原生刷新error=false，providers导航/连接正常。没有将错误窗口作为成功证据。当前源码类型/构建及真实UI都通过。

## 范围

本轮没有后端协议修改、收费调用或秘密回显；RollDek账本仍9/50保守占用，RunningHub仍1次未知生成。原有配置、项目及实际资产保留。此记录是界面修订交付，不代表原计划全部平台/PR/CI完成。未提交/推送/PR，继续原实施任务。
