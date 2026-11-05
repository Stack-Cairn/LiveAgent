import { AnimatePresence, domAnimation, LazyMotion, useReducedMotion } from "motion/react";
import * as m from "motion/react-m";
import {
  memo,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { UI_MOTION_TRANSITION } from "../../lib/shared/motion";
import { cn } from "../../lib/shared/utils";
import { type CollapseBodySource, createCollapseBodySource } from "./collapseBodySource";

// Retained-closed bodies exist to keep inner state (running tool output)
// alive, not to stay visually fresh: while closed the subtree is invisible,
// yet streaming props would otherwise keep re-rendering it on every flush.
// The memo comparator claims equality whenever the body is frozen, so React
// bails out of the whole hidden subtree; reopening compares unequal and
// renders fresh content immediately.
//
// While open, new children arrive through `source` instead of props. The
// motion wrappers between LazyCollapse and the body (LazyMotion, the presence
// child) hand their context a fresh object on every render, and a changed
// context makes React walk the whole subtree below it looking for consumers —
// for a streaming work trace that is the entire Markdown tree, on every flush.
// Publishing through the source re-renders only the body and leaves the motion
// shell (and its context values) untouched.
const CollapseBody = memo(
  function CollapseBody(props: { frozen: boolean; source: CollapseBodySource }) {
    const { source } = props;
    useSyncExternalStore(source.subscribe, source.getVersion, source.getVersion);
    return source.render();
  },
  (_previous, next) => next.frozen,
);

const CollapseMotionShell = memo(function CollapseMotionShell(props: {
  open: boolean;
  shouldRenderBody: boolean;
  prefersReducedMotion: boolean;
  source: CollapseBodySource;
}) {
  const { open, shouldRenderBody, prefersReducedMotion, source } = props;
  const transition = prefersReducedMotion
    ? UI_MOTION_TRANSITION.instant
    : UI_MOTION_TRANSITION.collapse;
  return (
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
              <CollapseBody frozen={!open} source={source} />
            </m.div>
          </m.div>
        ) : null}
      </AnimatePresence>
    </LazyMotion>
  );
});

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
  const [source] = useState(createCollapseBodySource);
  // A closed body is frozen: it neither takes new children nor re-renders.
  if (open) source.publish(children);
  useLayoutEffect(() => {
    if (open) source.flush();
  });

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
      <CollapseMotionShell
        open={open}
        shouldRenderBody={shouldRenderBody}
        prefersReducedMotion={prefersReducedMotion === true}
        source={source}
      />
    </div>
  );
}
