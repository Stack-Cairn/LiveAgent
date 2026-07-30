import { useCallback, useMemo, useState } from "react";
import type { ImportPreviewSession } from "./chatHistory";

export function useImportSelection(sessions: ImportPreviewSession[]) {
  const [selected, setSelected] = useState<Set<string>>(() => {
    const set = new Set<string>();
    for (const session of sessions) {
      if (!session.alreadyImported) set.add(session.id);
    }
    return set;
  });

  const importable = useMemo(
    () => sessions.filter((session) => !session.alreadyImported),
    [sessions],
  );

  const toggleSession = useCallback((session: ImportPreviewSession) => {
    if (session.alreadyImported) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(session.id)) next.delete(session.id);
      else next.add(session.id);
      return next;
    });
  }, []);

  const toggleGroup = useCallback(
    (group: ImportPreviewSession[]) => {
      const importableGroup = group.filter((session) => !session.alreadyImported);
      if (importableGroup.length === 0) return;
      const allSelected = importableGroup.every((session) => selected.has(session.id));
      setSelected((prev) => {
        const next = new Set(prev);
        if (allSelected) {
          for (const session of importableGroup) next.delete(session.id);
        } else {
          for (const session of importableGroup) next.add(session.id);
        }
        return next;
      });
    },
    [selected],
  );

  const selectAll = useCallback(() => {
    setSelected(new Set(importable.map((session) => session.id)));
  }, [importable]);

  const selectNone = useCallback(() => {
    setSelected(new Set());
  }, []);

  const isAllSelected =
    importable.length > 0 && importable.every((session) => selected.has(session.id));

  const isGroupAllSelected = useCallback(
    (group: ImportPreviewSession[]) => {
      const importableGroup = group.filter((session) => !session.alreadyImported);
      return (
        importableGroup.length > 0 && importableGroup.every((session) => selected.has(session.id))
      );
    },
    [selected],
  );

  return {
    selected,
    toggleSession,
    toggleGroup,
    selectAll,
    selectNone,
    isAllSelected,
    isGroupAllSelected,
  };
}
