import { RemotePathPickerModal } from "../../components/RemotePathPickerModal";

// Thin wrapper kept for existing call sites (workspace project selection);
// the actual browser lives in components/RemotePathPickerModal.tsx.

type WorkdirPickerModalProps = {
  initialWorkdir: string;
  onClose: () => void;
  onSelect: (path: string) => void;
};

export function WorkdirPickerModal(props: WorkdirPickerModalProps) {
  const { initialWorkdir, onClose, onSelect } = props;
  return (
    <RemotePathPickerModal
      mode="directory"
      initialPath={initialWorkdir}
      onClose={onClose}
      onSelect={onSelect}
    />
  );
}
