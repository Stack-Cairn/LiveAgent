import { UI_MOTION_TRANSITION } from "@liveagent/ui/lib/shared/motion";
import {
  AnimatePresence,
  domAnimation,
  type HTMLMotionProps,
  LazyMotion,
  useReducedMotion,
} from "motion/react";
import * as m from "motion/react-m";
import { forwardRef } from "react";

export const MotionPopover = forwardRef<
  HTMLDivElement,
  Omit<HTMLMotionProps<"div">, "animate" | "exit" | "initial"> & { open: boolean }
>(function MotionPopover({ open, children, ...surfaceProps }, ref) {
  const prefersReducedMotion = useReducedMotion();
  const enterTransition = prefersReducedMotion
    ? UI_MOTION_TRANSITION.instant
    : UI_MOTION_TRANSITION.popover;
  const exitTransition = prefersReducedMotion
    ? UI_MOTION_TRANSITION.instant
    : UI_MOTION_TRANSITION.popoverExit;

  return (
    <LazyMotion features={domAnimation} strict>
      <AnimatePresence>
        {open ? (
          <m.div
            ref={ref}
            initial={{ opacity: 0, scale: prefersReducedMotion ? 1 : 0.98 }}
            animate={{ opacity: 1, scale: 1, transition: enterTransition }}
            exit={{
              opacity: 0,
              scale: prefersReducedMotion ? 1 : 0.97,
              pointerEvents: "none",
              transition: exitTransition,
            }}
            {...surfaceProps}
          >
            {children}
          </m.div>
        ) : null}
      </AnimatePresence>
    </LazyMotion>
  );
});
