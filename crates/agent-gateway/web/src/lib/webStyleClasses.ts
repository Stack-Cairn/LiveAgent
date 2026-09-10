export const GATEWAY_SHELL_CLASS =
  "gateway-shell relative flex h-100vh min-h-100vh w-full min-w-0 overflow-hidden bg-background text-foreground [height:var(--spacing-100dvh)] [min-height:var(--spacing-100dvh)] max-820:h-100svh max-820:min-h-100svh max-820:[height:var(--spacing-100dvh)] max-820:[min-height:var(--spacing-100dvh)] [&_button]:text-13px [&_button]:leading-1p2 [&_button]:font-normal";

export const GATEWAY_MAIN_SHELL_CLASS =
  "gateway-main-shell relative flex h-full min-w-0 flex-1 flex-col items-stretch overflow-hidden max-820:size-full max-820:min-h-0 max-820:[&_[data-app-workbench-chrome]]:z-(--layer-raised) max-640:[&_[data-app-workbench-chrome]>header]:gap-6px max-640:[&_[data-app-workbench-chrome]>header]:px-10px max-640:[&_[data-app-workbench-chrome]>header]:py-8px max-380:[&_[data-app-workbench-chrome]>header]:px-8px";

export const GATEWAY_MAIN_BACKDROP_CLASS =
  "gateway-main-backdrop pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,hsl(var(--background))_0%,hsl(var(--background)/0.88)_100%),radial-gradient(circle_at_85%_0%,hsl(var(--primary)/0.06),transparent_26%)]";

export const GATEWAY_CHAT_FRAME_CLASS =
  "gateway-chat-frame z-(--layer-content) max-380:[&_.composer-toolbar-action]:px-8px [&_.composer-toolbar-action]:text-11px [&_.composer-toolbar-action]:leading-1rem [&_.composer-toolbar-action]:font-medium max-640:[&_.mention-composer]:min-h-58px max-640:[&_.mention-composer]:max-h-[min(var(--spacing-34dvh),var(--spacing-132px))] max-640:[&_.mention-composer]:text-14px max-640:[&_.mention-composer]:leading-1p5";

export const GATEWAY_TRANSCRIPT_SHELL_CLASS =
  "gateway-transcript-shell grid w-full min-w-0 grid-cols-[minmax(var(--gateway-chat-column-gutter,var(--spacing-16px)),1fr)_minmax(0,min(calc(var(--chat-transcript-content-width,var(--spacing-768px))-var(--spacing-40px)),100%))_minmax(var(--gateway-chat-column-gutter,var(--spacing-16px)),1fr)] pt-18px [overflow-anchor:none] max-820:pt-12px";

export const GATEWAY_CHAT_COLUMN_CLASS = "gateway-chat-column w-full min-w-0";

export const GATEWAY_EMPTY_STATE_CLASS =
  "gateway-empty-state min-h-[calc(var(--spacing-100vh)-var(--spacing-220px))] max-640:min-h-[calc(var(--spacing-100dvh)-var(--gateway-chat-composer-overlay-height,var(--spacing-176px))-var(--spacing-96px))]";

export const GATEWAY_TRANSCRIPT_ROW_CLASS = "gateway-transcript-row flex min-w-0 justify-start";

export const GATEWAY_TRANSCRIPT_SCROLL_CLASS =
  "gateway-transcript-scroll h-full [overflow-anchor:none] [overscroll-behavior:contain] [&_[data-scroll-viewport]]:[overflow-anchor:none] [&_[data-scroll-viewport]>div]:block! [&_[data-scroll-viewport]>div]:w-full! [&_[data-scroll-viewport]>div]:min-w-0! [&_[data-scroll-viewport]>div]:[overflow-anchor:none]";

export const GATEWAY_SCROLL_TO_BOTTOM_CLASS =
  "gateway-scroll-to-bottom layer-raised absolute right-18px bottom-[calc(var(--gateway-chat-composer-overlay-height,var(--spacing-176px))+var(--spacing-12px))] inline-flex size-42px items-center justify-center rounded-full border border-border/72 bg-[linear-gradient(180deg,hsl(var(--card)/0.98),hsl(var(--background)/0.94))] text-foreground shadow-[0_var(--spacing-14px)_var(--spacing-34px)_var(--ui-color-hsl-220-22-10-0p12),inset_0_var(--spacing-1px)_0_hsl(var(--background)/0.9)] backdrop-blur-16px transition-[transform,box-shadow,background,border-color] duration-180 ease-default hover:-translate-y-1px hover:border-primary/34 hover:bg-[linear-gradient(180deg,hsl(var(--card)),hsl(var(--primary)/0.08))] hover:shadow-[0_var(--spacing-18px)_var(--spacing-42px)_var(--ui-color-hsl-220-22-10-0p18),inset_0_var(--spacing-1px)_0_hsl(var(--background)/0.94)] focus-visible:outline-none focus-visible:shadow-[0_0_0_var(--spacing-3px)_hsl(var(--primary)/0.18),0_var(--spacing-18px)_var(--spacing-42px)_var(--ui-color-hsl-220-22-10-0p18)] max-820:right-12px max-820:bottom-[calc(var(--gateway-chat-composer-overlay-height,var(--spacing-176px))+var(--spacing-10px))] max-820:size-38px";

export const GATEWAY_SETTINGS_OVERLAY_CLASS =
  "gateway-settings-overlay layer-panel absolute inset-0 min-h-full translate-y-24px opacity-0 transition-[opacity,transform] duration-220 ease-default max-820:h-100svh max-820:min-h-100svh max-820:[height:var(--spacing-100dvh)] max-820:[min-height:var(--spacing-100dvh)] [&_aside>div:last-child>button]:text-12px [&_aside>div:last-child>button]:leading-1p2";
