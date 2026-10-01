import { Check, Copy } from "@liveagent/ui/components/IconSet";
import type { ComponentProps } from "react";
import { copyTextToClipboard } from "../../lib/shared/clipboard";
import { COPY_FEEDBACK_DURATION, useCopyFeedback } from "../../lib/shared/useCopyFeedback";
import { cn } from "../../lib/shared/utils";

/** Native settings copy button; keeps the existing compact and regular surfaces. */
export function SettingsCopyButton({
  value,
  size = "default",
  className,
  ...props
}: Omit<ComponentProps<"button">, "value" | "onClick"> & {
  value: string;
  size?: "default" | "compact";
}) {
  const { copied, showCopied } = useCopyFeedback(false, COPY_FEEDBACK_DURATION.settings);

  async function handleCopy() {
    if (value && (await copyTextToClipboard(value))) showCopied(true);
  }

  return (
    <button
      {...props}
      type="button"
      onClick={() => void handleCopy()}
      className={cn(
        "flex shrink-0 items-center justify-center text-muted-foreground transition-colors",
        size === "compact" ? "size-7 rounded-md" : "size-8 rounded-lg",
        "hover:bg-muted/60 hover:text-foreground",
        className,
      )}
    >
      {copied ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
    </button>
  );
}
