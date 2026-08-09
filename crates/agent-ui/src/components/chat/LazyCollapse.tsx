import { type ReactNode, useState } from "react";
import { cn } from "../../lib/shared/utils";

// 内容首次展开时才挂载；运行中的内容可在折叠后保留状态，结束后则立即释放。
export function LazyCollapse(props: {
  open: boolean;
  retainWhileClosed?: boolean;
  className?: string;
  children: () => ReactNode;
}) {
  const { open, retainWhileClosed = false, className, children } = props;
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) {
    setMounted(true);
  }
  const shouldRenderBody = open || (mounted && retainWhileClosed);

  return (
    <div
      aria-hidden={!open}
      className={cn(
        "grid",
        open ? "grid-rows-[1fr]" : "pointer-events-none grid-rows-[0fr]",
        className,
      )}
    >
      <div className="min-h-0 overflow-hidden">
        {shouldRenderBody ? (
          <div className={open ? "lazy-collapse-reveal" : "invisible"}>{children()}</div>
        ) : null}
      </div>
    </div>
  );
}
