import { type ReactNode, useEffect, useState } from "react";
import { cn } from "../../lib/shared/utils";

const COLLAPSE_ANIMATION_MS = 220;

// 内容首次展开时才挂载；收起时保留到退出动画结束，运行中的内容还可继续
// 保留内部状态。这样大块工具结果不会常驻 DOM，同时展开和收缩都有完整动画。
export function LazyCollapse(props: {
  open: boolean;
  retainWhileClosed?: boolean;
  className?: string;
  children: () => ReactNode;
}) {
  const { open, retainWhileClosed = false, className, children } = props;
  const [bodyMounted, setBodyMounted] = useState(open);

  useEffect(() => {
    if (open) {
      setBodyMounted(true);
      return;
    }
    if (!bodyMounted || retainWhileClosed) return;

    const timer = window.setTimeout(() => setBodyMounted(false), COLLAPSE_ANIMATION_MS);
    return () => window.clearTimeout(timer);
  }, [bodyMounted, open, retainWhileClosed]);

  const shouldRenderBody = open || bodyMounted;

  return (
    <div
      aria-hidden={!open}
      className={cn(
        // h-min: open `1fr` must size to the content. Nested collapses and
        // virtualized rows otherwise stretch this track to leftover parent
        // height, leaving a large blank gap under the last tool chip.
        //
        // -mx-3/px-3: the collapse clips (overflow-hidden below, plus
        // `contain: paint` that callers may add on this root). Disclosure
        // headers inside bleed 6px sideways so their hover background and
        // rounded corners sit outside the text box; without this outdent the
        // clip lands exactly on the text edge and erases them. Outdent equals
        // padding, so content position is unchanged.
        "-mx-3 grid h-min origin-top content-start px-3 transition-[grid-template-rows] duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none",
        open ? "grid-rows-[1fr]" : "pointer-events-none grid-rows-[0fr]",
        className,
      )}
    >
      <div className="-mx-3 min-h-0 overflow-hidden px-3">
        {shouldRenderBody ? (
          <div
            data-lazy-collapse-content=""
            className={cn(
              "origin-top transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transform-none motion-reduce:transition-none",
              open ? "translate-y-0 opacity-100" : "-translate-y-1 opacity-0",
            )}
          >
            {children()}
          </div>
        ) : null}
      </div>
    </div>
  );
}
