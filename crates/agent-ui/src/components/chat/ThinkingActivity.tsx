import { ChevronRight, Lightbulb } from "@liveagent/ui/components/IconSet";
import { useLocale } from "@liveagent/ui/i18n/index";
import { useEffect, useRef, useState } from "react";
import type { ChatFileLink } from "../../lib/chat/chatFileLinks";
import { Markdown } from "../Markdown";
import { AssistantStatus } from "./AssistantStatus";
import { LazyCollapse } from "./LazyCollapse";

export function ThinkingActivity(props: {
  text: string;
  open?: boolean;
  isRunning?: boolean;
  renderMode: "streaming" | "static";
  workdir?: string;
  onOpenFileLink?: (link: ChatFileLink) => void;
}) {
  const { text, open, isRunning = false, renderMode, workdir, onOpenFileLink } = props;
  const { t } = useLocale();
  const [isOpen, setIsOpen] = useState(typeof open === "boolean" ? open : false);
  const userInteractedRef = useRef(false);
  const hasText = /\S/.test(text);

  useEffect(() => {
    if (!userInteractedRef.current && typeof open === "boolean") {
      setIsOpen(open);
    }
  }, [open]);

  if (!hasText) return null;

  return (
    <div className="group/think w-full">
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={() => {
          userInteractedRef.current = true;
          setIsOpen((previous) => !previous);
        }}
        className="thinking-block-toggle flex w-full cursor-pointer select-none items-center gap-2 py-1.5 text-left text-[calc(13px*var(--zone-font-scale,1))] font-normal text-muted-foreground/80 hover:text-foreground"
      >
        {isRunning ? (
          <AssistantStatus className="min-h-0">{t("chat.thinking")}</AssistantStatus>
        ) : (
          <>
            <Lightbulb className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
            <span className="thinking-block-label">{t("chat.thinkingProcess")}</span>
          </>
        )}
        <ChevronRight
          className={`ml-auto h-3.5 w-3.5 text-muted-foreground/60 transition-transform duration-200 ease-out motion-reduce:transition-none ${isOpen ? "rotate-90" : ""}`}
        />
      </button>
      <LazyCollapse open={isOpen}>
        {() => (
          <div className="pb-1 pt-1.5">
            <Markdown
              content={text}
              className="thinking-markdown space-y-1.5"
              renderMode={renderMode}
              showCaret={false}
              workdir={workdir}
              onOpenFileLink={onOpenFileLink}
            />
          </div>
        )}
      </LazyCollapse>
    </div>
  );
}
