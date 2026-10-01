# 全局 Toast

桌面 App 和 Gateway App 各挂一个 `Toaster`，位于语言上下文内，通过 Portal 渲染到 body。
保留各处原有位置：普通通知和导入结果在右上角，Skill 扫描结果在右下角，批量撤销在底部居中。
页面不再挂 Provider/Viewport，也不维护通知数组和倒计时。

```tsx
import { toast } from "@liveagent/ui/components/ui/toast-manager";

toast.success("操作完成");
toast.error("操作失败");
const id = toast.warning("需要注意的情况");
toast.dismiss(id);
```

结果提示保留无阴影卡片：

```tsx
toast.success("扫描完成", {
  id: "skill-scan",
  position: "bottom-right",
  appearance: "notice",
  description: "共发现 3 个 Skill，列表已是最新",
  duration: 6500,
});
```

- `position` 支持 `top-right`、`bottom-right`、`bottom-center`；新通知默认右上角，同 ID 更新省略位置时保留原位置。
- 默认 `notification` 外观延续聊天通知配色，默认 5000ms。
- `notice` 使用普通背景、细边框、无阴影；有标题时描述区支持滚动。
- `duration: 0` 表示常驻；同 ID 再调用会更新内容并重新计时。
- `action: { label, onClick }` 提供撤销等操作，执行成功后关闭；异常不会被吞掉。
- `onDismiss` 在通知关闭时调用；根挂载前触发的通知会缓冲，挂载前 dismiss 可取消。
- `toast.dismiss()` 关闭所有通知，用于退出登录等全局清理。
- 页面专属操作可用 `useId()` 作为 ID 前缀，并在卸载时 dismiss；不要用共享固定 ID 让多个实例互相覆盖。
- 普通页面切换不卸载 Toaster。业务仍需自己决定撤销等操作离开页面后是否有效。

原聊天通知、图片预览反馈、Skill 扫描、导入结果和批量撤销均已接入。
页面内校验错误、连接状态和批量选择工具栏继续使用各自的内联组件。
