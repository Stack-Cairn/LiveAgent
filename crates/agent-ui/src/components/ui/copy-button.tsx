import { Check, Copy } from "@liveagent/ui/components/IconSet";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../../lib/shared/utils";
import { Button } from "./button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

const COPY_FEEDBACK_MS = 1600;

function fallbackCopyText(text: string) {
  let textarea: HTMLTextAreaElement | null = null;
  try {
    textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "-9999px";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea?.remove();
  }
}

export async function copyTextToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return fallbackCopyText(text);
    }
  }
  return fallbackCopyText(text);
}

export function CopyButton(props: {
  value: string;
  label: string;
  copiedLabel: string;
  className?: string;
  iconClassName?: string;
}) {
  const { value, label, copiedLabel, className, iconClassName } = props;
  const [copied, setCopied] = useState(false);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const resetTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    };
  }, []);

  const handleCopy = useCallback(async () => {
    if (!value || !(await copyTextToClipboard(value))) return;
    setCopied(true);
    setTooltipOpen(true);
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    resetTimerRef.current = window.setTimeout(() => {
      setCopied(false);
      setTooltipOpen(false);
      resetTimerRef.current = null;
    }, COPY_FEEDBACK_MS);
  }, [value]);

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
              size="icon"
              disabled={disabled}
              aria-label={activeLabel}
              title={activeLabel}
              className={cn(
                "h-7 w-7 shrink-0 text-muted-foreground hover:bg-muted hover:text-foreground",
                className,
              )}
              onClick={() => void handleCopy()}
            >
              {copied ? (
                <Check className={cn("h-3.5 w-3.5", iconClassName)} />
              ) : (
                <Copy className={cn("h-3.5 w-3.5", iconClassName)} />
              )}
            </Button>
          }
        />
        <TooltipContent>
          <span className="flex items-center gap-1.5">
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : null}
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
