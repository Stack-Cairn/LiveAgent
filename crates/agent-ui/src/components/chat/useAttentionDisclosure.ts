import { useEffect, useState } from "react";

/**
 * Keeps disclosure ownership with the user after its initial state is chosen.
 * A new blocking interaction may open it once; completion never closes it and
 * a still-pending interaction does not fight a later manual collapse.
 */
export function useAttentionDisclosure(attentionRequired: boolean, defaultOpen = false) {
  const [open, setOpen] = useState(() => defaultOpen || attentionRequired);

  useEffect(() => {
    if (attentionRequired) setOpen(true);
  }, [attentionRequired]);

  return [open, setOpen] as const;
}
