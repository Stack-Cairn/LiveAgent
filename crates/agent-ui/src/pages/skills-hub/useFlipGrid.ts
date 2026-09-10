import {
  DEFAULT_INSTALLED_SKILL_SORT,
  type InstalledSkillSort,
  isInstalledSkillSort,
} from "@liveagent/ui/lib/skills/installedSort";
import { useCallback, useLayoutEffect, useRef } from "react";

export const INSTALLED_SORT_STORAGE_KEY = "skillsHub.installedSort";
const FLIP_HERO_DURATION_MS = 380;
const FLIP_BATCH_HERO_DELAY_MS = 90;
const FLIP_BATCH_STAGGER_LIMIT = 8;
const FLIP_WAVE_DURATION_MS = 280;
const FLIP_WAVE_DELAY_MS = 30;
const FLIP_WAVE_MAX_DELAY_MS = 400;
const FLIP_HERO_TRANSITION = `translate ${FLIP_HERO_DURATION_MS}ms var(--ease-ui-curve-3)`;
const FLIP_WAVE_TRANSITION = `translate ${FLIP_WAVE_DURATION_MS}ms var(--ease-ui-enter)`;

export type FlipMode = "single" | "wave" | "batch";
type FlipPosition = { left: number; top: number };
type FlipRequest = {
  mode: FlipMode;
  heroKeys: ReadonlySet<string>;
  followKeys: ReadonlySet<string>;
};

export function readInstalledSortPreference(): InstalledSkillSort {
  if (typeof window === "undefined") return DEFAULT_INSTALLED_SKILL_SORT;
  try {
    const stored = window.localStorage.getItem(INSTALLED_SORT_STORAGE_KEY);
    return isInstalledSkillSort(stored) ? stored : DEFAULT_INSTALLED_SKILL_SORT;
  } catch {
    return DEFAULT_INSTALLED_SKILL_SORT;
  }
}

function resetFlipStyles(element: HTMLElement) {
  element.style.transition = "";
  element.style.translate = "";
  element.style.willChange = "";
  element.style.zIndex = "";
}

function measureFlipRects(grid: HTMLElement, elements: readonly HTMLElement[]) {
  const gridRect = grid.getBoundingClientRect();
  const rects = new Map<string, FlipPosition>();
  for (const element of elements) {
    const key = element.dataset.flipKey;
    if (!key) continue;
    const rect = element.getBoundingClientRect();
    rects.set(key, {
      left: rect.left - gridRect.left,
      top: rect.top - gridRect.top,
    });
  }
  return rects;
}

export function useFlipGrid() {
  const gridRef = useRef<HTMLDivElement>(null);
  const previousRectsRef = useRef<Map<string, FlipPosition>>(new Map());
  const previousOrderRef = useRef<string[]>([]);
  const pendingRequestRef = useRef<FlipRequest | null>(null);
  const frameRef = useRef<number | null>(null);
  const phaseTimerRef = useRef<number | null>(null);
  const cleanupTimerRef = useRef<number | null>(null);
  const activeElementsRef = useRef<HTMLElement[]>([]);

  const requestFlip = useCallback(
    (mode: FlipMode, heroKeys: readonly string[], followKeys: readonly string[] = heroKeys) => {
      // 契约：必须在触发重排的 setState 之前调用。此处同步捕获「变更前」布局，
      // 主 effect 只在存在 pending 请求的那次渲染里测量「变更后」布局并做 FLIP —
      // 其余渲染完全不碰 getBoundingClientRect（技能多时曾是主要强制回流来源）。
      const grid = gridRef.current;
      if (grid) {
        const elements = Array.from(grid.querySelectorAll<HTMLElement>("[data-flip-key]"));
        previousRectsRef.current = measureFlipRects(grid, elements);
        previousOrderRef.current = elements.map((element) => element.dataset.flipKey ?? "");
      } else {
        previousRectsRef.current = new Map();
        previousOrderRef.current = [];
      }
      pendingRequestRef.current = {
        mode,
        heroKeys: new Set(heroKeys),
        followKeys: new Set(followKeys),
      };
    },
    [],
  );

  const captureVisibleKey = useCallback(() => {
    const grid = gridRef.current;
    if (!grid) return null;
    let scrollParent = grid.parentElement;
    while (scrollParent) {
      const overflowY = window.getComputedStyle(scrollParent).overflowY;
      if (/auto|scroll|overlay/.test(overflowY)) break;
      scrollParent = scrollParent.parentElement;
    }
    const viewport = scrollParent?.getBoundingClientRect();
    const viewportTop = viewport?.top ?? 0;
    const viewportBottom = viewport?.bottom ?? window.innerHeight;
    const elements = grid.querySelectorAll<HTMLElement>("[data-flip-key]");
    for (const element of elements) {
      const rect = element.getBoundingClientRect();
      if (rect.bottom > viewportTop && rect.top < viewportBottom) {
        return element.dataset.flipKey ?? null;
      }
    }
    return null;
  }, []);

  const clearAnimation = useCallback(() => {
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    if (phaseTimerRef.current !== null) {
      window.clearTimeout(phaseTimerRef.current);
      phaseTimerRef.current = null;
    }
    if (cleanupTimerRef.current !== null) {
      window.clearTimeout(cleanupTimerRef.current);
      cleanupTimerRef.current = null;
    }
    for (const element of activeElementsRef.current) {
      resetFlipStyles(element);
    }
    activeElementsRef.current = [];
  }, []);

  useLayoutEffect(() => {
    // 无 pending 请求的渲染不做任何测量/清理：变更前布局已在 requestFlip 时捕获，
    // 进行中的动画也不因无关重渲被打断。
    const request = pendingRequestRef.current;
    if (!request) return;
    pendingRequestRef.current = null;
    clearAnimation();
    const grid = gridRef.current;
    if (!grid) {
      previousRectsRef.current.clear();
      previousOrderRef.current = [];
      return;
    }

    const elements = Array.from(grid.querySelectorAll<HTMLElement>("[data-flip-key]"));
    const nextOrder = elements.map((element) => element.dataset.flipKey ?? "");
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const followElement = elements.find((element) => {
      const key = element.dataset.flipKey;
      return key ? request.followKeys.has(key) : false;
    });

    followElement?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: reducedMotion ? "auto" : "smooth",
    });

    const nextRects = measureFlipRects(grid, elements);

    const previousRects = previousRectsRef.current;
    const previousOrder = previousOrderRef.current;
    const orderChanged =
      previousOrder.length !== nextOrder.length ||
      nextOrder.some((key, index) => key !== previousOrder[index]);
    previousRectsRef.current = nextRects;
    previousOrderRef.current = nextOrder;

    if (previousRects.size === 0 || previousOrder.length === 0 || !orderChanged || reducedMotion) {
      return;
    }

    const movedElements: Array<{ element: HTMLElement; hero: boolean }> = [];
    for (const element of elements) {
      const key = element.dataset.flipKey;
      const previousRect = key ? previousRects.get(key) : undefined;
      const nextRect = key ? nextRects.get(key) : undefined;
      if (!previousRect || !nextRect) continue;
      const deltaX = previousRect.left - nextRect.left;
      const deltaY = previousRect.top - nextRect.top;
      if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) continue;
      element.style.transition = "none";
      element.style.translate = `${deltaX}px ${deltaY}px`;
      element.style.willChange = "translate";
      const hero = key ? (request?.heroKeys.has(key) ?? false) : false;
      if (hero) element.style.zIndex = "30";
      movedElements.push({ element, hero });
    }

    if (movedElements.length === 0) return;
    activeElementsRef.current = movedElements.map(({ element }) => element);
    void grid.offsetWidth;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      const mode = request?.mode ?? "wave";
      const heroElements = movedElements.filter(({ hero }) => hero);
      const waveElements = movedElements.filter(({ hero }) => !hero);
      const maxWaveDelay = Math.min(
        Math.max(0, waveElements.length - 1) * FLIP_WAVE_DELAY_MS,
        FLIP_WAVE_MAX_DELAY_MS,
      );
      const startWave = () => {
        waveElements.forEach(({ element }, index) => {
          const delay = Math.min(index * FLIP_WAVE_DELAY_MS, FLIP_WAVE_MAX_DELAY_MS);
          element.style.transition = `${FLIP_WAVE_TRANSITION} ${delay}ms`;
          element.style.translate = "0 0";
        });
      };
      const scheduleCleanup = (delay: number) => {
        cleanupTimerRef.current = window.setTimeout(() => {
          for (const { element } of movedElements) {
            resetFlipStyles(element);
          }
          activeElementsRef.current = [];
          cleanupTimerRef.current = null;
        }, delay + 40);
      };

      if (mode === "batch") {
        const staggerHeroes = (request?.heroKeys.size ?? 0) <= FLIP_BATCH_STAGGER_LIMIT;
        heroElements.forEach(({ element }, index) => {
          const delay = staggerHeroes ? index * FLIP_BATCH_HERO_DELAY_MS : 0;
          element.style.transition = `${FLIP_HERO_TRANSITION} ${delay}ms`;
          element.style.translate = "0 0";
        });
        const lastHeroDelay =
          staggerHeroes && heroElements.length > 0
            ? (heroElements.length - 1) * FLIP_BATCH_HERO_DELAY_MS
            : 0;
        const heroPhaseDuration =
          heroElements.length > 0 ? lastHeroDelay + FLIP_HERO_DURATION_MS : 0;
        if (waveElements.length > 0) {
          if (heroPhaseDuration > 0) {
            phaseTimerRef.current = window.setTimeout(() => {
              phaseTimerRef.current = null;
              startWave();
            }, heroPhaseDuration);
          } else {
            startWave();
          }
        }
        const wavePhaseDuration =
          waveElements.length > 0 ? FLIP_WAVE_DURATION_MS + maxWaveDelay : 0;
        scheduleCleanup(heroPhaseDuration + wavePhaseDuration);
        return;
      }

      heroElements.forEach(({ element }) => {
        element.style.transition = FLIP_HERO_TRANSITION;
        element.style.translate = "0 0";
      });
      startWave();
      const heroDuration = heroElements.length > 0 ? FLIP_HERO_DURATION_MS : 0;
      const waveDuration = waveElements.length > 0 ? FLIP_WAVE_DURATION_MS + maxWaveDelay : 0;
      scheduleCleanup(Math.max(heroDuration, waveDuration));
    });
  });

  useLayoutEffect(
    () => () => {
      clearAnimation();
      previousRectsRef.current.clear();
      previousOrderRef.current = [];
      pendingRequestRef.current = null;
    },
    [clearAnimation],
  );

  return { captureVisibleKey, gridRef, requestFlip };
}
