import { onDemand } from "@liveagent/ui/components/OnDemand";
import { type ComponentProps, useCallback, useRef, useState } from "react";
import type {
  RemotePathPickerModal as RemotePathPickerModalComponent,
  RemotePathPickerMode,
} from "./RemotePathPickerModal";

// The picker (tree view and remote file system browsing) loads the first time
// a path is picked, not with the chat app.
const RemotePathPickerModal = onDemand<ComponentProps<typeof RemotePathPickerModalComponent>>(
  async () => (await import("./RemotePathPickerModal")).RemotePathPickerModal,
);

type PickPathOptions = {
  mode: RemotePathPickerMode;
  initialPath?: string;
  title?: string;
  description?: string;
};

type PendingPick = PickPathOptions & {
  resolve: (path: string | null) => void;
};

/**
 * Promise-based entry point: `pickPath()` resolves with the chosen remote
 * path, or null when the picker is dismissed. Render `pathPickerElement`
 * once near the caller's root.
 */
export function useRemotePathPicker() {
  const [pending, setPending] = useState<PendingPick | null>(null);
  const selectedPathRef = useRef<string | null>(null);

  const pickPath = useCallback(
    (options: PickPathOptions) =>
      new Promise<string | null>((resolve) => {
        selectedPathRef.current = null;
        setPending({ ...options, resolve });
      }),
    [],
  );

  const pathPickerElement = pending ? (
    <RemotePathPickerModal
      mode={pending.mode}
      initialPath={pending.initialPath}
      title={pending.title}
      description={pending.description}
      onSelect={(path) => {
        selectedPathRef.current = path;
      }}
      onClose={() => {
        // Resolve only after the picker finishes its exit transition so a
        // suspended parent modal cannot reopen underneath the closing picker.
        pending.resolve(selectedPathRef.current);
        selectedPathRef.current = null;
        setPending(null);
      }}
    />
  ) : null;

  return { pickPath, pathPickerElement };
}
