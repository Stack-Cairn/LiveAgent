// Compact breakpoints are container queries against the composer card (it is
// an `@container`), not viewport media queries: a conversation pane in a
// split window must collapse its toolbar labels even on a wide screen.
export const COMPOSER_CONTROL_TRIGGER_CLASS =
  "composer-model-trigger inline-flex h-8 min-w-8 max-w-[10.5rem] shrink-0 items-center justify-start gap-1.5 overflow-hidden rounded-full px-2 text-xs font-medium text-foreground shadow-none transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 disabled:opacity-40 @max-[480px]:w-8 @max-[480px]:px-0";

export const COMPOSER_CONTROL_LABEL_CLASS =
  "composer-model-label min-w-0 truncate @max-[480px]:hidden";

export const COMPOSER_CONTROL_CHEVRON_CLASS =
  "h-3 w-3 shrink-0 text-muted-foreground transition-transform duration-200 @max-[480px]:hidden";
