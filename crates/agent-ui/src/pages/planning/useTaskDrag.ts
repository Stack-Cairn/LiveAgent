import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { taskDescendants } from "../../lib/planning/taskLists";
import type { Todo } from "../../lib/planning/types";
import type { PlanningDragStart } from "./TimeGrid";

export function useTaskDrag({
  todos,
  onDrag,
  onFinish,
  onMove,
}: {
  todos: Todo[];
  onDrag(drag: PlanningDragStart): void;
  onFinish(): void;
  onMove(task: Todo, target: Todo, edge: "before" | "after"): void;
}) {
  const callbacks = useRef({ todos, onDrag, onFinish, onMove });
  callbacks.current = { todos, onDrag, onFinish, onMove };
  const pending = useRef<{
    todo: Todo;
    id: number;
    x: number;
    y: number;
    active: boolean;
    touch: boolean;
    timer?: ReturnType<typeof setTimeout>;
  } | null>(null);
  const [dragged, setDragged] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; edge: "before" | "after" } | null>(null);
  const dropRef = useRef<typeof drop>(null);
  const suppressUntil = useRef(0);
  useEffect(() => {
    const activate = () => {
      const p = pending.current;
      if (!p || p.active) return;
      p.active = true;
      setDragged(p.todo.id);
      callbacks.current.onDrag({ todo: p.todo, pointerId: p.id, x: p.x, y: p.y });
    };
    const locate = (x: number, y: number) => {
      const p = pending.current;
      if (!p?.active) return;
      const row = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-task-row]");
      const id = row?.dataset.taskRow;
      const forbidden = taskDescendants(callbacks.current.todos, p.todo.id);
      const sameStatus = callbacks.current.todos.find((t) => t.id === id)?.status === p.todo.status;
      const next =
        row && id && sameStatus && !forbidden.has(id)
          ? {
              id,
              edge:
                y < row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2
                  ? ("before" as const)
                  : ("after" as const),
            }
          : null;
      dropRef.current = next;
      setDrop(next);
    };
    const move = (e: PointerEvent) => {
      const p = pending.current;
      if (!p || e.pointerId !== p.id) return;
      if (!p.active && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 6) {
        if (p.touch) {
          clearTimeout(p.timer);
          pending.current = null;
          return;
        }
        activate();
      }
      if (p.active) {
        e.preventDefault();
        locate(e.clientX, e.clientY);
      }
    };
    const clear = () => {
      const p = pending.current;
      if (p) clearTimeout(p.timer);
      if (p?.active) {
        suppressUntil.current = Date.now() + 250;
        callbacks.current.onFinish();
      }
      pending.current = null;
      dropRef.current = null;
      setDrop(null);
      setDragged(null);
    };
    const end = (e: PointerEvent) => {
      const p = pending.current;
      if (!p || e.pointerId !== p.id) return;
      if (p.active) {
        locate(e.clientX, e.clientY);
        const d = dropRef.current;
        const target = callbacks.current.todos.find((t) => t.id === d?.id);
        if (target && d) callbacks.current.onMove(p.todo, target, d.edge);
      }
      clear();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && pending.current) {
        e.preventDefault();
        clear();
      }
    };
    const click = (e: MouseEvent) => {
      if (Date.now() < suppressUntil.current) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const touch = (e: TouchEvent) => {
      if (pending.current?.active) e.preventDefault();
    };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", clear);
    window.addEventListener("keydown", key);
    document.addEventListener("click", click, true);
    window.addEventListener("touchmove", touch, { passive: false });
    return () => {
      if (pending.current) clearTimeout(pending.current.timer);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", clear);
      window.removeEventListener("keydown", key);
      document.removeEventListener("click", click, true);
      window.removeEventListener("touchmove", touch);
    };
  }, []);
  useEffect(() => {
    if (!dragged) return;
    let frame = 0;
    const scroll = () => {
      const d = dropRef.current;
      const row = d
        ? document.querySelector<HTMLElement>(`[data-task-row="${CSS.escape(d.id)}"]`)
        : null;
      const area = row?.closest<HTMLElement>("[data-task-scroll]");
      if (area && row && pending.current?.active) {
        const r = row.getBoundingClientRect(),
          a = area.getBoundingClientRect();
        if (r.top < a.top + 32) area.scrollTop -= 8;
        else if (r.bottom > a.bottom - 32) area.scrollTop += 8;
      }
      frame = requestAnimationFrame(scroll);
    };
    frame = requestAnimationFrame(scroll);
    return () => cancelAnimationFrame(frame);
  }, [dragged]);
  return {
    dragged,
    drop,
    start: (event: ReactPointerEvent<HTMLElement>, todo: Todo) => {
      if (
        event.button !== 0 ||
        (event.target as HTMLElement).closest("[data-task-control],input,textarea,select,a")
      )
        return;
      const p = {
        todo,
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        active: false,
        touch: event.pointerType === "touch",
        timer: undefined as ReturnType<typeof setTimeout> | undefined,
      };
      pending.current = p;
      if (p.touch)
        p.timer = setTimeout(() => {
          if (pending.current === p) {
            p.active = true;
            setDragged(todo.id);
            callbacks.current.onDrag({ todo, pointerId: p.id, x: p.x, y: p.y });
          }
        }, 350);
    },
  };
}
