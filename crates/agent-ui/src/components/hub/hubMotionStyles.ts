export const HUB_PAGE_ENTER_CLASS =
  "animate-[hubPageIn_var(--ui-duration-260ms)_var(--ease-ui-enter)_both] motion-reduce:animate-none! [&_.hub-header]:animate-[hubPanelIn_var(--ui-duration-360ms)_var(--ease-ui-enter)_both] motion-reduce:[&_.hub-header]:animate-none! [&_.hub-content-stage]:animate-[hubPanelIn_var(--ui-duration-420ms)_var(--ease-ui-enter)_var(--ui-duration-70ms)_both] motion-reduce:[&_.hub-content-stage]:animate-none!";

export const SKILL_CARD_ENTER_CLASS =
  "animate-[skillCardIn_var(--ui-duration-350ms)_var(--ease-ui-enter)_both] motion-reduce:animate-none! [&:nth-child(1)]:[animation-delay:0ms] [&:nth-child(2)]:[animation-delay:var(--ui-duration-50ms)] [&:nth-child(3)]:[animation-delay:var(--ui-duration-100ms)] [&:nth-child(4)]:[animation-delay:var(--ui-duration-150ms)] [&:nth-child(5)]:[animation-delay:var(--ui-duration-200ms)] [&:nth-child(6)]:[animation-delay:var(--ui-duration-250ms)] [&:nth-child(n+7)]:[animation-delay:var(--ui-duration-300ms)]";

export const SKILLS_SCAN_DOTS_CLASS =
  "[&>span]:animate-[bounce_var(--ui-duration-1000ms)_infinite] motion-reduce:[&>span]:animate-none! [&>span:nth-child(2)]:[animation-delay:var(--ui-duration-150ms)] [&>span:nth-child(3)]:[animation-delay:var(--ui-duration-300ms)]";
