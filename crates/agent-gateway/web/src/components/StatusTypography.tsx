import type { ReactNode } from "react";

export function StatusLabel({ children }: { children: ReactNode }) {
  return (
    <p className="status-board-label m-0 text-(--ui-color-rgba-186-216-246-0p6) text-10px tracking-0p18em uppercase">
      {children}
    </p>
  );
}

export function StatusHeading({ children }: { children: ReactNode }) {
  return (
    <h3 className="m-0 text-(--ui-color-rgba-255-255-255-0p96) tracking-minus-0p035em mt-2px text-18px">
      {children}
    </h3>
  );
}

export function StatusSectionHeader({ children }: { children: ReactNode }) {
  return (
    <div className="status-board-section-head flex-none justify-between gap-10px mb-10px">
      {children}
    </div>
  );
}
