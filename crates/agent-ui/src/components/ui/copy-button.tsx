import { Check, Copy } from "@liveagent/ui/components/IconSet";
import { copyTextToClipboard } from "@liveagent/ui/lib/shared/clipboard";
import { COPY_FEEDBACK_DURATION, useCopyFeedback } from "@liveagent/ui/lib/shared/useCopyFeedback";
import { useCallback, useState } from "react";
import { cn } from "../../lib/shared/utils";
import { Button } from "./button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

export { copyTextToClipboard } from "@liveagent/ui/lib/shared/clipboard";

export function CopyButton(props: {
  value: string;
  label: string;
  copiedLabel: string;
  className?: string;
  iconClassName?: string;
}) {
  const { value, label, copiedLabel, className, iconClassName } = props;
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const { copied, showCopied } = useCopyFeedback(false, COPY_FEEDBACK_DURATION.tooltip, () =>
    setTooltipOpen(false),
  );

  const handleCopy = useCallback(async () => {
    if (!value || !(await copyTextToClipboard(value))) return;
    showCopied(true);
    setTooltipOpen(true);
  }, [value, showCopied]);

  const activeLabel = copied ? copiedLabel : label;
  const disabled = !value;

  return (
    <>
      <Tooltip
        open={tooltipOpen}
        disabled={disabled}
        onOpenChange={(open) => {
          if (!copied || open) setTooltipOpen(open);
        }}
      >
        <TooltipTrigger
          delay={300}
          closeOnClick={false}
          disabled={disabled}
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={disabled}
              aria-label={activeLabel}
              title={activeLabel}
              className={cn(
                "shrink-0 text-muted-foreground hover:bg-muted hover:text-foreground",
                className,
              )}
              onClick={() => void handleCopy()}
            >
              {copied ? (
                <Check className={cn("size-3.5", iconClassName)} />
              ) : (
                <Copy className={cn("size-3.5", iconClassName)} />
              )}
            </Button>
          }
        />
        <TooltipContent>
          <span className="flex items-center gap-1.5">
            {copied ? <Check className="size-3.5 text-emerald-600" /> : null}
            <span>{activeLabel}</span>
          </span>
        </TooltipContent>
      </Tooltip>
      <span className="sr-only" role="status" aria-live="polite">
        {copied ? copiedLabel : ""}
      </span>
    </>
  );
}
