import type { ClawHubListResponse } from "./skills/clawHub";
import type { SystemManageSkillResponse } from "./skills/index";

export type SkillsResourceSettings = { enabled: boolean; selected: string[] };

export type SkillsResourceAdapter = {
  list: (
    workdir?: string,
  ) => Promise<SystemManageSkillResponse & { settings: SkillsResourceSettings }>;
  manage: (body: Record<string, unknown>) => Promise<SystemManageSkillResponse>;
  settings: (
    body: SkillsResourceSettings & { workdir?: string },
  ) => Promise<{ settings: SkillsResourceSettings }>;
  read: (
    path: string,
    offset?: number,
    length?: number,
  ) => Promise<{ content: string; truncated: boolean }>;
  storeSearch: (params: {
    query?: string;
    cursor?: string;
    ownerHandle?: string;
    limit?: number;
    sort?: string;
  }) => Promise<ClawHubListResponse>;
  storeInstall: (body: Record<string, unknown>) => Promise<SystemManageSkillResponse>;
};

export type ResourceHostCapabilities = {
  isKbrain: boolean;
  memoryBackendManaged: boolean;
  skillsBackendManaged: boolean;
  skillsAdapter?: SkillsResourceAdapter;
};

export const nativeResourceHostCapabilities: ResourceHostCapabilities = {
  isKbrain: false,
  memoryBackendManaged: false,
  skillsBackendManaged: false,
};

export const kbrainResourceHostCapabilities: ResourceHostCapabilities = {
  isKbrain: true,
  memoryBackendManaged: false,
  skillsBackendManaged: false,
};

let currentResourceHostCapabilities = nativeResourceHostCapabilities;

export function configureResourceHostCapabilities(capabilities: ResourceHostCapabilities): void {
  currentResourceHostCapabilities = capabilities;
}

export function getResourceHostCapabilities(): ResourceHostCapabilities {
  return currentResourceHostCapabilities;
}

export function isUnsupportedResourceError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unavailable in K-brain mode|unavailable in K-brain browser mode|WebUI shim does not implement invoke\("(?:memory_|system_)/i.test(
    message,
  );
}
