import type { KBrainSession } from "./types";

type MutationSync = {
  isHealthy(): boolean;
  confirm(id: string, epoch: string, revision: string): Promise<KBrainSession | undefined>;
  reconcile(): void;
};

let active: MutationSync | undefined;

export function setKBrainMutationSync(sync: MutationSync | undefined): void {
  active = sync;
}

export function hasKBrainMutationSync(): boolean {
  return active?.isHealthy() === true;
}

export async function confirmKBrainMutation(
  id: string,
  result: { sync_epoch?: string; sync_revision?: string },
  requireVisible = false,
): Promise<KBrainSession | undefined> {
  if (!active?.isHealthy()) return undefined;
  if (!result.sync_epoch || !result.sync_revision) {
    active.reconcile();
    throw new Error("K-brain mutation response is missing its synchronization watermark");
  }
  const confirmed = await active.confirm(id, result.sync_epoch, result.sync_revision);
  if (requireVisible && !confirmed) {
    throw new Error("K-brain conversation was removed while its mutation was being confirmed");
  }
  return confirmed;
}
