import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useLocale } from "../../i18n";
import type { ImageStudioClient } from "../../lib/imaging/types";
import type { DraftStorage } from "./drafts";
import { ImageStudioController } from "./studioController";

export function useImageStudio(
  client: ImageStudioClient,
  ownerId: string,
  backendId: string,
  storage?: DraftStorage,
) {
  const { t } = useLocale();
  const controller = useMemo(
    () => new ImageStudioController(client, ownerId, backendId, storage),
    [client, ownerId, backendId, storage],
  );
  const view = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  // Declared before start() so the first notices already use the interface language.
  useEffect(() => controller.setTranslator(t), [controller, t]);
  useEffect(() => {
    void controller.start();
    return () => controller.dispose();
  }, [controller]);
  return { controller, view };
}
