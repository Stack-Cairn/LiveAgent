# 对话页与系统设置之间切换时的高度跳变

分支：develop，HEAD `cb0cf518`

## 现象

在 Windows 桌面端点开「系统设置」，再点「返回对话」，整页内容会上下位移一次。Web 端在 820px 以下的窄屏也能复现类似抖动。

## 根因

### 设置浮层打开时，多插了一条 32px 的标题栏

问题出在 `crates/agent-gui/src/App.tsx`。设置浮层的开合状态被直接接到了标题栏的渲染开关上：

```tsx
const visible = settingsOpen;
...
<AppChrome standaloneTitleBar={visible}>
```

而 `AppChrome` 的结构是一个纵向 flex 列：

```tsx
<div className="relative flex size-full flex-col overflow-hidden bg-background">
  {props.standaloneTitleBar ? <WindowsTitleBar /> : null}
  <div className="relative min-h-0 flex-1 overflow-hidden bg-background">{props.children}</div>
  {menu}
</div>
```

设置关闭时 `standaloneTitleBar` 是 false，这里不渲染标题栏，窗口控件由 `ChatPage` 内部的 `AppWorkbenchChrome` 提供（`crates/agent-gui/src/pages/ChatPage.tsx:3972` 传入 `windowControls={<WindowsTitleBar controlsOnly />}`）。设置打开时它变成 true，外层额外插入一个完整的 `WindowsTitleBar`——`crates/agent-gui/src/components/WindowsTitleBar.tsx:229` 上写着 `h-8 shrink-0`，也就是 32px 且不可压缩。

关键在于这个标题栏是 flex 列里的第一个兄弟节点，不是绝对定位。它一出现，下面那个 `flex-1` 的内容容器立刻少掉 32px。此时 `ChatPage` 并没有卸载，只是被压扁，整棵子树在同一帧内重新布局。点「返回对话」时 32px 又还回去，内容再弹一次。

### 高度变化和淡入淡出不同步，所以用户看得见

这才是它显眼的原因。`crates/agent-ui/src/lib/settings/useSettingsOverlay.ts` 里，`visible`（`overlay !== "closed"`）在第一帧就为 true，`active`（`overlay === "open"`）要等两个 `requestAnimationFrame` 之后才为 true：

```tsx
{visible && (
  <div className={cn("absolute inset-0 z-50 transition-all duration-300 ease-out",
    active ? "opacity-100 translate-y-0" : "opacity-0 translate-y-6")}
```

打开时的顺序是：第一帧标题栏插入、布局塌 32px，而设置层还停在 `opacity-0`，完全透明。第二到第三帧 `active` 才置位，设置层开始淡入。中间这一小段，用户看到的是一个没有任何东西遮挡的聊天页在跳。

关闭时更明显。`closeSettingsOverlay` 把状态置为 `leaving`，设置层开始 300ms 淡出，但 `visible` 此刻仍是 true，标题栏还在原位；要等 `transitionend` 或者 350ms 兜底把状态推到 `closed`，标题栏才被移除。也就是说聊天页那一下 32px 的下坠，发生在淡出动画播完之后、视野完全清晰的时刻。

### macOS 上还有第二个高度来源

`crates/agent-ui/src/application/AppWorkbenchChrome.tsx:16` 的高度写法是：

```tsx
style={{ height: "var(--app-header-height, 48px)" }}
```

`--app-header-height` 只由 `MacOsTitleBarToggle` 的 effect 写入（`crates/agent-gui/src/components/MacOsTitleBarSpacer.tsx:115`），值是红绿灯中心坐标的两倍，并且在组件卸载时调用了 `removeProperty`。这个组件挂在 `ChatPage` 子树里。Windows 下变量从来不存在，一直走 48px 的兜底，暂时看不出问题；macOS 下一旦这个子树重挂，变量被摘掉，header 高度就会从红绿灯算出来的值跳回 48px。

### Web 端的视口单位打架

`crates/agent-gateway/web/src/lib/webStyleClasses.ts:29` 的 `GATEWAY_SETTINGS_OVERLAY_CLASS` 里，`max-820:h-100svh`、`max-820:[height:var(--spacing-100dvh)]` 和 `min-h-full` 同时存在。`svh` 按地址栏展开时的最小视口算，`dvh` 跟着地址栏实时变，两者在移动端浏览器里不是一个数。同一个断点下写了两遍高度，后者覆盖前者，但 `min-h-full` 又参照父级——而父级 `GATEWAY_SHELL_CLASS`（同文件第 2 行）里同样叠了一遍 `h-100vh`、`[height:var(--spacing-100dvh)]` 和 `max-820:h-100svh`。地址栏收起的瞬间，这几层各自按不同基准重算，抖动会被放大。

Web 端的设置层是 `GATEWAY_SHELL_CLASS` 那个根容器的直接子节点（`GatewayAppView.tsx:2089`），用 `absolute inset-0` 定位，并不嵌在 `data-app-workbench-body` 里。所以桌面端那条"父容器被压扁"的路径在这里不成立，Web 端的抖动只来自上面那组视口单位。

## 解决方案

核心一句话：标题栏在两个视图之间必须是同一个 DOM 节点、同一个高度，不因为视图切换而增删。

### 桌面端方案 A：标题栏上提为常驻壳层（推荐）

让 `WindowsTitleBar` 始终渲染在 `AppChrome` 里，不再受 `settingsOpen` 控制：

```tsx
function AppChrome(props: { children: ReactNode }) {
  const { onRootContextMenu, onRootMouseDownCapture, menu } = useNativeInputContextMenu();
  return (
    <div className="relative flex size-full flex-col overflow-hidden bg-background" ...>
      <WindowsTitleBar />
      <div className="relative min-h-0 flex-1 overflow-hidden bg-background">{props.children}</div>
      {menu}
    </div>
  );
}
```

调用处删掉 `standaloneTitleBar={visible}` 这个 prop，`AppChrome` 的 props 类型里也一并移除。`ChatPage` 侧去掉 `windowControls={<WindowsTitleBar controlsOnly />}`，窗口控件由常驻栏统一提供；`AppWorkbenchChrome` 在 Windows 下不再预留控件位置。

这样切换设置时 DOM 高度完全不变，跳变从源头消失。代价是 `ChatPage` 的顶栏布局要调一轮，工作量主要在这里。

### 桌面端方案 B：用等高占位补偿（改动最小）

如果短期内不想动 `ChatPage` 的顶栏结构，至少要让两种状态下 flex 列的总高度相同：

```tsx
{props.standaloneTitleBar ? <WindowsTitleBar /> : <TitleBarPlaceholder />}
```

`TitleBarPlaceholder` 复用 `WindowsTitleBar` 里那个 `isWindowsTauriRuntime()` 判定，非 Windows 直接返回 null，Windows 下渲染一个 `h-8 shrink-0` 的空 div。注意 `isWindowsTauriRuntime` 目前是模块内私有函数，需要 export 出来，两处共用同一份判定逻辑，不要各写一遍。

这个方案能消掉跳变，但会在对话页顶部留一条 32px 的空白，视觉上要和设计确认。

### 桌面端方案 C：让设置层脱离受影响的容器

把设置浮层从 `AppChrome` 的 children 里拿出来，提到 `AppChrome` 外层，改用 `fixed inset-0`。它现在是 `absolute inset-0`，参照的正是那个被压扁的内容容器；改成 fixed 之后直接覆盖整个窗口，`standaloneTitleBar` 这个开关也就不需要了。

三个方案里 A 最干净，C 次之，B 是应急。

### macOS

把 `--app-header-height` 的写入从 `MacOsTitleBarToggle` 上提到 App 根组件的 effect，让它的生命周期和 `ChatPage` 解绑。同时在 `crates/agent-ui/src/styles/tokens.css` 的 `:root` 给一个静态默认值：

```css
:root { --app-header-height: 48px; }
```

卸载时的 `removeProperty` 改成写回默认值，避免摘掉变量的那一帧高度回落。

红绿灯位置在全屏切换时会变，`useMacOsTrafficLightMetrics` 重算后写入新值——这是预期内的高度变化，但要确认它不会和设置层的过渡撞在一起。

### Web 端

三件事：

统一视口单位。`GATEWAY_SETTINGS_OVERLAY_CLASS` 和 `GATEWAY_SHELL_CLASS` 里同一断点下的重复高度声明只留一条，统一用 `dvh`。`dvh` 跟随地址栏连续变化，不会在收起瞬间产生一次 `svh` 到 `dvh` 的阶跃。

设置层改 `fixed inset-0`。让它不再参照会被压扁的 flex 容器——不过实际核对后发现 Web 端的浮层本来就是根容器的直接子节点，这条无需改动。

给 `html` 加 `scrollbar-gutter: stable`。设置页的内容区是 `overflow-auto`（`SettingsShell.tsx` 非 fill 模式），聊天页的滚动容器在更深层，两者切换时滚动条的出现和消失会带来一次横向位移。

## 实施记录

最终落地的不是原方案 A 的"标题栏上提为常驻壳层"，而是一个改动面更小、效果等价的变体：**让浮层自带标题栏，外层永不增删**。

`AppChrome` 里那个条件渲染整条删掉，`standaloneTitleBar` prop 一并从类型签名移除。标题栏改到设置浮层内部：浮层本身加 `flex flex-col`，第一个子节点是 `<WindowsTitleBar />`，下面再套一层 `relative min-h-0 flex-1 overflow-hidden` 收住 `SettingsShell` 的 `h-full`（`AppErrorBoundary` 无错时直接透传 children，不加这层的话设置内容会按整个浮层高度算、顶穿标题栏）。

这样对话页所在的那个 `flex-1` 容器在开关设置时高度恒定，跳变从源头消失，而 `ChatPage` 的顶栏结构一行没动。

macOS 侧新增 `useMacOsAppHeaderHeight()`，把 `--app-header-height` 的写入从 `MacOsTitleBarToggle` 里抽出来挂到 App 根，卸载时写回 48px 默认值而不是 `removeProperty`。`tokens.css` 的 `:root` 也补了静态默认值。

Web 端引入 `--app-viewport-height`：`:root` 下是 `100vh`，`@supports (height: 100dvh)` 里覆盖成 `100dvh`。`GATEWAY_SHELL_CLASS` 和 `GATEWAY_SETTINGS_OVERLAY_CLASS` 里堆叠的 `h-100vh`/`h-100svh`/`[height:100dvh]` 全部替换成这一个变量。构建产物核对过，`100svh` 只剩 token 定义本身，没有任何选择器再引用。

### 验证结果

`tsc --noEmit` 桌面端和 Web 端均通过；biome lint 无告警（仓库存量的 CRLF 格式噪声除外，改动文件的行尾已保持 CRLF 不变）。`test/settings/` 下三个设置浮层测试全绿，其中 `settings-overlay.test.mjs` 直接覆盖了重复打开时的浮层状态机。

`test/chat/standard-overlays.test.mjs` 失败，但在 stash 掉全部改动的干净基线上同样失败，原因是 `load-ts-module.mjs` 在 Windows 下解析 `virtual-core/src/index.ts` 的路径有问题，与本次改动无关。

Web 端 `vite build` 通过，CSS 产物里 `--app-viewport-height` 的两条定义和 `@supports` 块都正确生成。



Windows：开关设置各十次，用 DevTools 的 Rendering 面板打开 Layout Shift Regions，切换过程中不应出现高亮区域。

macOS：分别在全屏和非全屏下各测一轮，重点看红绿灯位置变化时 header 高度是否稳定。

Web：Chrome 移动模拟 390×844，滚到页面底部再打开设置，观察地址栏收起时是否还有跳变。

改完记得跑一遍 `pnpm check:fast`（含 lint 与 typecheck）。
