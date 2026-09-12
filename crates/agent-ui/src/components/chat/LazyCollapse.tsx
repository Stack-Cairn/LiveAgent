import { AnimatePresence, domAnimation, LazyMotion, useReducedMotion } from "motion/react";
import * as m from "motion/react-m";
import { type ReactNode, useEffect, useState } from "react";
import { UI_MOTION_TRANSITION } from "../../lib/shared/motion";
import { cn } from "../../lib/shared/utils";

// 内容首次展开时才挂载；AnimatePresence 负责等退出动画完成后再卸载。
// 运行中的内容可在收起后继续保留内部状态。
export function LazyCollapse(props: {
  open: boolean;
  retainWhileClosed?: boolean;
  className?: string;
  children: () => ReactNode;
}) {
  const { open, retainWhileClosed = false, className, children } = props;
  const [hasOpened, setHasOpened] = useState(open);
  const prefersReducedMotion = useReducedMotion();

  useEffect(() => {
    if (open) setHasOpened(true);
  }, [open]);

  const shouldRenderBody = open || (retainWhileClosed && hasOpened);
  const transition = prefersReducedMotion
    ? UI_MOTION_TRANSITION.instant
    : UI_MOTION_TRANSITION.collapse;

  return (
    <div
      aria-hidden={!open}
      className={cn(
        // -mx-3/px-3: the collapse clips (overflow-hidden below, plus
        // `contain: paint` that callers may add on this root). Disclosure
        // headers inside bleed 6px sideways so their hover background and
        // rounded corners sit outside the text box; without this outdent the
        // clip lands exactly on the text edge and erases them. Outdent equals
        // padding, so content position is unchanged.
        "-mx-3 h-min origin-top px-3",
        !open && "pointer-events-none",
        className,
      )}
    >
      <LazyMotion features={domAnimation} strict>
        <AnimatePresence initial={false}>
          {shouldRenderBody ? (
            <m.div
              key="content"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: open ? "auto" : 0, opacity: open ? 1 : 0 }}
              exit={{ height: 0, opacity: 0 }}
              transition={transition}
              className="-mx-3 min-h-0 overflow-hidden px-3"
            >
              <m.div
                data-lazy-collapse-content=""
                initial={{ y: prefersReducedMotion ? 0 : -4 }}
                animate={{ y: open || prefersReducedMotion ? 0 : -4 }}
                exit={{ y: prefersReducedMotion ? 0 : -4 }}
                transition={transition}
                className="origin-top"
              >
                {children()}
              </m.div>
            </m.div>
          ) : null}
        </AnimatePresence>
      </LazyMotion>
    </div>
  );
}
