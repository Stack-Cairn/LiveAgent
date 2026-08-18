import type { TrajectoryEvent, TrajectorySection } from "@liveagent/ui/lib/trajectory/types";

export type TrajectoryPersistencePorts = {
  persist: (conversationId: string, segmentIndex: number, eventsJson: string) => Promise<unknown>;
  persistSections: (
    conversationId: string,
    sections: readonly TrajectorySection[],
  ) => Promise<unknown>;
};

type BufferedEvent = {
  segmentIndex: number;
  event: TrajectoryEvent;
};

export type TrajectoryPersistenceQueue = {
  pushEvent: (segmentIndex: number, event: TrajectoryEvent) => void;
  pushSections: (sections: readonly TrajectorySection[]) => void;
  flush: () => Promise<void>;
  hasPending: () => boolean;
  discard: () => void;
};

/**
 * Loss-resistant, serial persistence queue.
 *
 * Events capture their segment at emit time. Failed writes are put back ahead of
 * events that arrived while the write was in flight, so an optional diagnostic
 * channel cannot silently lose or reorder durable data.
 */
export function createTrajectoryPersistenceQueue(params: {
  conversationId: string;
  ports: TrajectoryPersistencePorts;
  warn: (error: unknown) => void;
}): TrajectoryPersistenceQueue {
  let events: BufferedEvent[] = [];
  let sections = new Map<string, TrajectorySection>();
  let draining: Promise<void> | null = null;

  const restoreSections = (snapshot: readonly TrajectorySection[]) => {
    const restored = new Map<string, TrajectorySection>();
    for (const section of snapshot) restored.set(section.sectionId, section);
    for (const section of sections.values()) restored.set(section.sectionId, section);
    sections = restored;
  };

  const drain = async () => {
    while (events.length > 0 || sections.size > 0) {
      const eventSnapshot = events;
      const sectionSnapshot = [...sections.values()];
      events = [];
      sections = new Map();

      if (sectionSnapshot.length > 0) {
        try {
          await params.ports.persistSections(params.conversationId, sectionSnapshot);
        } catch (error) {
          restoreSections(sectionSnapshot);
          events = [...eventSnapshot, ...events];
          params.warn(error);
          return;
        }
      }

      const groups = new Map<number, TrajectoryEvent[]>();
      for (const buffered of eventSnapshot) {
        const group = groups.get(buffered.segmentIndex);
        if (group === undefined) groups.set(buffered.segmentIndex, [buffered.event]);
        else group.push(buffered.event);
      }
      const orderedGroups = [...groups.entries()];
      for (let index = 0; index < orderedGroups.length; index += 1) {
        const [segmentIndex, segmentEvents] = orderedGroups[index];
        try {
          await params.ports.persist(
            params.conversationId,
            segmentIndex,
            JSON.stringify(segmentEvents),
          );
        } catch (error) {
          const remaining = orderedGroups
            .slice(index)
            .flatMap(([remainingSegment, entries]) =>
              entries.map((event) => ({ segmentIndex: remainingSegment, event })),
            );
          events = [...remaining, ...events];
          params.warn(error);
          return;
        }
      }
    }
  };

  return {
    pushEvent: (segmentIndex, event) => {
      events.push({ segmentIndex, event });
    },
    pushSections: (next) => {
      for (const section of next) sections.set(section.sectionId, section);
    },
    flush: async () => {
      if (draining !== null) {
        await draining;
        return;
      }
      draining = drain();
      try {
        await draining;
      } finally {
        draining = null;
      }
    },
    hasPending: () => events.length > 0 || sections.size > 0,
    discard: () => {
      events = [];
      sections = new Map();
    },
  };
}
