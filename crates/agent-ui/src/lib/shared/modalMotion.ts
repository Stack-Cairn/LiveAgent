import { useCallback, useEffect, useRef, useState } from "react";

export const MODAL_MOTION_MS = 180;

export type ModalMotionState = "open" | "closed";

export function useModalMotion(onExited: () => void) {
  const [isVisible, setIsVisible] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frameRef = useRef<number | null>(null);
  const closingRef = useRef(false);
  const onExitedRef = useRef(onExited);

  useEffect(() => {
    onExitedRef.current = onExited;
  }, [onExited]);

  useEffect(() => {
    frameRef.current = window.requestAnimationFrame(() => {
      setIsVisible(true);
    });

    return () => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
      }
      if (closeTimerRef.current !== null) {
        clearTimeout(closeTimerRef.current);
      }
    };
  }, []);

  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setIsClosing(true);
    setIsVisible(false);
    closeTimerRef.current = setTimeout(() => {
      onExitedRef.current();
    }, MODAL_MOTION_MS);
  }, []);

  return {
    isClosing,
    modalState: (isVisible ? "open" : "closed") as ModalMotionState,
    requestClose,
  };
}

export function useAnimatedPresence(isPresent: boolean) {
  const [shouldRender, setShouldRender] = useState(isPresent);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    let frame: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    if (isPresent) {
      setShouldRender(true);
      frame = window.requestAnimationFrame(() => {
        setIsVisible(true);
      });
    } else {
      setIsVisible(false);
      timer = setTimeout(() => {
        setShouldRender(false);
      }, MODAL_MOTION_MS);
    }

    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      if (timer !== null) clearTimeout(timer);
    };
  }, [isPresent]);

  return {
    motionState: (isVisible ? "open" : "closed") as ModalMotionState,
    shouldRender,
  };
}
